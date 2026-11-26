import { randomBytes } from 'node:crypto'
import {
  closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync,
  writeFileSync, writeSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './cli.js'
import { loadConfig } from './config.js'
import { liveFolder, liveIo, sessionToken } from './deadline.js'
import { isId } from './dsl.js'
import { primaryRoot } from './gitio.js'
import { isAlive, pause, pidOf, releaseIfMine, takeStale } from './lock.js'
import { holdsScratch, scratchHolder, scratchWaiters } from './scratch-lock.js'
import { ensureExcluded } from './worktree.js'

// Row 181 (Task 3b). Every command witness runs takes turns across the worktrees of one
// repo: evidence, gate checks, regression and ship lanes all pass through `execCommand`.
// fewhats's e2e boots a web server and a browser per suite, so two suites at once collide on
// a port or a profile, and each collision costs a round. With a filtered runner a turn costs
// seconds. `drive.parallelSuites: true` relaxes it.
//
// Row 255: lint is the exception and takes no turn (ship's lint lane, `execCommand`'s `turn:
// false`). It boots no server or browser, so it cannot collide on a port or a profile, and cargo's
// own build-directory lock already serializes clippy with a test build. A lint run waiting behind a
// suite would only spend the session's time.
//
// A turn waits while its holder lives and never refuses: the holder is a live process running
// one command, and its session's `drive.sessionTimeoutMs` bounds it. Refusing would have to
// fake a run outcome, and a fake failed run journals a false red.
//
// Row 255. Waiters queue: each holds a leased ticket in `.witness/live/turn/` while it waits, and
// only the ticket at the head may take a free turn, so turns go in the order they were asked for
// rather than to whichever poll lands first. A ticket names the drive session it waits for, and a
// job holding the turn names its kind in the lock, so drive can tell a session waiting behind a
// job (whose time it does not count, row 256) from one waiting behind another session's run.
// Tickets are machine-local scheduling hints, never a trust boundary. A ticket's lease is renewed
// while its waiter polls, so a waiter that died — or whose pid Windows handed to another process —
// stops counting once the lease lapses. An older CLI takes the turn unqueued until the floor
// refuses it.
const POLL_MS = 200
const UNREADABLE_GRACE_MS = 1_000

export const runnerLockPath = (root: string) => join(root, '.witness', 'runner.lock')
// The holder hands its turn to the command it runs: a witness invoked by that command (a
// criterion `cmd:` that runs witness) would otherwise wait on its own parent forever.
export const RUNNER_TURN_ENV = 'WITNESS_RUNNER_TURN'

export const TURN_DIR = '.witness/live/turn'
// A ticket's lease, and how often its waiter renews it.
export const TURN_LEASE_MS = 60_000
export const TURN_RENEW_MS = 10_000

export interface TurnTicket { pid: number; since: number; until: number; session?: string; job?: string; gated?: boolean }
export interface TurnHolder { pid: number; since?: number; job?: string }
// Who takes a turn when it is not a session's run: a job of `job`'s kind, which `gated` says a gate
// reads (an ungated job yields its place to plan work).
export interface TurnWho { job: string; gated: boolean }

// A clock this far ahead of a ticket's own claims is a tampered ticket or a clock set wrong.
const SLACK_MS = 60_000
// Windows: a scanner or the indexer can hold a fresh file for a moment (busy.ts's rule).
const CREATE_RETRY_MS = 1_000
const RETRY_PAUSE_MS = 50
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])

// A symlink is never a holder: `wx` refuses it while a read follows it, so a dangling one
// would read `absent` forever (the repo lock's fix, src/lock.ts).
function holderOf(p: string): number | 'absent' | 'unreadable' {
  let text: string
  try {
    if (lstatSync(p).isSymbolicLink()) return 'unreadable'
    text = readFileSync(p, 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable'
  }
  try {
    const pid = (JSON.parse(text) as { pid?: unknown }).pid
    return typeof pid === 'number' && Number.isInteger(pid) ? pid : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

// The lock's holder while its pid lives, for readers other than the steal guard. `since` and `job`
// are read only when well-typed, so an older CLI's `{pid}` reads as `{ pid }`.
export function turnHolder(root: string): TurnHolder | undefined {
  const p = runnerLockPath(root)
  let raw: { pid?: unknown; since?: unknown; job?: unknown }
  try {
    if (lstatSync(p).isSymbolicLink()) return undefined
    raw = JSON.parse(readFileSync(p, 'utf8')) as typeof raw
  } catch {
    return undefined
  }
  const pid = raw?.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return undefined
  const holder: TurnHolder = { pid }
  if (typeof raw.since === 'number' && Number.isFinite(raw.since)) holder.since = raw.since
  if (typeof raw.job === 'string' && isId(raw.job)) holder.job = raw.job
  return holder
}

// The queue's folder, or undefined when it cannot be used (a link on the way is refused).
const turnDir = (root: string, create: boolean) => liveFolder(root, 'turn', create)

function parseTicket(text: string): TurnTicket | 'unreadable' | 'malformed' {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return 'unreadable' }
  const r = raw as Partial<Record<keyof TurnTicket, unknown>> | null
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x)
  if (!(r !== null && typeof r === 'object' && Number.isInteger(r.pid) && (r.pid as number) > 0 && num(r.since) && num(r.until))) {
    return 'malformed'
  }
  const t: TurnTicket = { pid: r.pid as number, since: r.since as number, until: r.until as number }
  if (typeof r.session === 'string') t.session = r.session
  if (typeof r.job === 'string' && isId(r.job)) t.job = r.job
  if (typeof r.gated === 'boolean') t.gated = r.gated
  return t
}

const liveTicket = (t: TurnTicket, now: number): boolean =>
  t.since <= now + SLACK_MS && now <= t.until && t.until <= now + TURN_LEASE_MS + SLACK_MS && isAlive(t.pid)

const olderThanGrace = (p: string, now: number): boolean => {
  try { return now - lstatSync(p).mtimeMs >= UNREADABLE_GRACE_MS } catch { return true }
}

// A ticket file read: live, stale (a link, a malformed file, an unreadable one past the grace, a
// lapsed lease or a dead pid), or neither (a write in progress, inside the grace).
function readTicket(p: string, now: number): { live: TurnTicket } | 'stale' | 'pending' {
  let text: string
  try {
    if (lstatSync(p).isSymbolicLink()) return 'stale'
    text = readFileSync(p, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'pending'   // gone meanwhile: nothing to sweep
    return olderThanGrace(p, now) ? 'stale' : 'pending'
  }
  const t = parseTicket(text)
  if (t === 'unreadable') return olderThanGrace(p, now) ? 'stale' : 'pending'
  if (t === 'malformed') return 'stale'
  return liveTicket(t, now) ? { live: t } : 'stale'
}

const ticketNames = (dir: string): string[] => {
  try { return readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')) } catch { return [] }
}

// Head order: an ungated job yields to plan work while any is queued, then the earliest, then the
// lowest pid. The tickets are taken as live.
export function headTicket(tickets: readonly TurnTicket[]): TurnTicket | undefined {
  const plan = tickets.some((t) => t.job === undefined)
  const yields = (t: TurnTicket) => (plan && t.job !== undefined && t.gated === false ? 1 : 0)
  let head: TurnTicket | undefined
  for (const t of tickets) {
    if (head === undefined) { head = t; continue }
    const d = yields(t) - yields(head) || t.since - head.since || t.pid - head.pid
    if (d < 0) head = t
  }
  return head
}

// The live tickets, in head order.
export function turnTickets(root: string, now = Date.now()): TurnTicket[] {
  const dir = turnDir(root, false)
  if (dir === undefined) return []
  const live: TurnTicket[] = []
  for (const name of ticketNames(dir)) {
    const r = readTicket(join(dir, name), now)
    if (typeof r === 'object') live.push(r.live)
  }
  const order: TurnTicket[] = []
  const rest = [...live]
  while (rest.length > 0) {
    const head = headTicket(rest)!
    order.push(head)
    rest.splice(rest.indexOf(head), 1)
  }
  return order
}

// Removes the stale tickets (the count), and temp files a renewal killed mid-write left behind.
export function sweepTurnQueue(root: string, now = Date.now()): number {
  const dir = turnDir(root, false)
  if (dir === undefined) return 0
  let n = 0
  let names: string[]
  try { names = readdirSync(dir) } catch { return 0 }
  for (const name of names) {
    const p = join(dir, name)
    if (name.startsWith('.') && name.endsWith('.tmp')) {
      try { if (now - lstatSync(p).mtimeMs > TURN_LEASE_MS) unlinkSync(p) } catch { /* gone */ }
      continue
    }
    if (!name.endsWith('.json')) continue
    if (readTicket(p, now) !== 'stale') continue
    try { unlinkSync(p); n++ } catch { /* gone, or left to the next sweep */ }
  }
  return n
}

// The job holding the turn while a live ticket names `session` as waiting — undefined when the
// session is not queued, or the holder is a session's run or an older CLI's lock (row 256). Row
// 279: else the job holding the scratch while a live waiter's marker names `session` (a lint guard
// waits for the scratch with no turn, C43).
export function behindJob(root: string, session: string, now = Date.now()): string | undefined {
  const holder = turnHolder(root)
  if (holder?.job !== undefined && turnTickets(root, now).some((t) => t.session === session)) return holder.job
  const scratch = scratchHolder(root, now)
  if (scratch?.job === undefined) return undefined
  return scratchWaiters(root, now).some((w) => w.session === session) ? scratch.job : undefined
}

// One waiter's own ticket: written with O_CREAT | O_EXCL | O_NOFOLLOW (busy.ts's flags), put back
// with the same `since` when it is removed, its lease renewed through a temp file renamed over it.
// Every write is best effort: a transient Windows error is retried within a second, never fatal.
interface OwnTicket { since: number; keep(now: number): void; remove(): void }

function writeExclusive(p: string, text: string): 'written' | 'exists' | 'failed' {
  const t0 = Date.now()
  for (;;) {
    try {
      const fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
      try { writeSync(fd, text) } finally { closeSync(fd) }
      return 'written'
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return 'exists'
      if (code !== undefined && TRANSIENT.has(code) && Date.now() - t0 < CREATE_RETRY_MS) { pause(RETRY_PAUSE_MS); continue }
      return 'failed'
    }
  }
}

function openTicket(root: string, ctx: Ctx, who: TurnWho | undefined): OwnTicket | undefined {
  try { ensureExcluded(root) } catch { /* not a git checkout we can write to */ }
  const dir = turnDir(root, true)
  if (dir === undefined) return undefined
  const pid = process.pid
  const since = Date.now()
  const session = sessionToken(ctx.env)
  const p = join(dir, `${since}-${pid}.json`)
  const body = (until: number) => JSON.stringify({
    pid, since, until, ...(session !== undefined ? { session } : {}), ...(who ? { job: who.job, gated: who.gated } : {}),
  })
  if (writeExclusive(p, body(since + TURN_LEASE_MS)) !== 'written') return undefined
  let renewed = since
  const renew = (now: number) => {
    const tmp = join(dir, `.${since}-${pid}.${randomBytes(8).toString('hex')}.tmp`)
    if (writeExclusive(tmp, body(now + TURN_LEASE_MS)) !== 'written') return
    // A temp a scanner still holds fails its removal the way it failed the rename: left to the sweep.
    try { liveIo.rename(tmp, p); renewed = now } catch { try { liveIo.rm(tmp) } catch { /* the sweep removes it */ } }
  }
  return {
    since,
    keep(now) {
      let present = true
      try { lstatSync(p) } catch { present = false }
      if (!present) { if (writeExclusive(p, body(now + TURN_LEASE_MS)) === 'written') renewed = now; return }
      if (now - renewed >= TURN_RENEW_MS) renew(now)
    },
    remove() {
      const t0 = Date.now()
      for (;;) {
        try { unlinkSync(p); return } catch (e) {
          const code = (e as NodeJS.ErrnoException).code
          if (code === undefined || !TRANSIENT.has(code) || Date.now() - t0 >= CREATE_RETRY_MS) return
          pause(RETRY_PAUSE_MS)
        }
      }
    },
  }
}

// A stale turn is taken atomically (the repo lock's `takeStale`): of several waiters that
// meet one dead holder, exactly one gets the turn.
const drop = (p: string, stale: (text: string | undefined) => boolean): 'taken' | 'busy' | 'error' => {
  try {
    return takeStale(p, stale)
  } catch {
    return 'error'
  }
}

// The release a turn hands back, or undefined when this process did not take one (a
// re-entry, an inherited turn, a path it cannot write). Only the process that wrote the file
// removes it, and only while it still names that process.
function takeTurn(root: string, ctx: Ctx, label: string, who: TurnWho | undefined): (() => void) | undefined {
  const p = runnerLockPath(root)
  const pid = process.pid
  try {
    mkdirSync(join(root, '.witness'), { recursive: true })
  } catch {
    return undefined                                     // no .witness to hold a turn in: run unturned
  }
  // Re-entry and an inherited turn first, unchanged: neither queues.
  const first = holderOf(p)
  if (first === pid) return undefined
  if (typeof first === 'number' && ctx.env[RUNNER_TURN_ENV] === String(first)) return undefined
  // Row 258. Lock order is test turn → scratch → repo lock: a turn taken while this process holds
  // the scratch could deadlock against a session that holds the turn and waits for the scratch.
  if (holdsScratch(root)) {
    throw new Error('lock order: this process holds the scratch — take the test turn before the scratch (row 258)')
  }
  sweepTurnQueue(root)
  // A queue folder that cannot be used leaves the turn as it was before row 255: unqueued.
  const ticket = openTicket(root, ctx, who)
  const settle = (release: (() => void) | undefined) => { ticket?.remove(); return release }
  const lockBody = () => JSON.stringify({ pid, since: Date.now(), ...(who ? { job: who.job } : {}) })
  let said = false
  let unreadableSince: number | undefined
  for (;;) {
    const now = Date.now()
    ticket?.keep(now)
    const head = ticket ? headTicket(turnTickets(root, now)) : undefined
    const atHead = head === undefined || (head.pid === pid && head.since === ticket!.since)
    if (atHead) {
      try {
        writeFileSync(p, lockBody(), { flag: 'wx' })
        return settle(() => { releaseIfMine(p, pid); ticket?.remove() })
      } catch (e) {
        // A turn that cannot be written cannot be waited for either; the command still runs.
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return settle(undefined)
      }
    }
    const holder = holderOf(p)
    if (holder === 'absent') {
      if (atHead) continue
    } else if (holder === pid) {
      return settle(undefined)                           // re-entry: the outer turn releases
    } else if (typeof holder === 'number' && ctx.env[RUNNER_TURN_ENV] === String(holder)) {
      return settle(undefined)                           // inherited
    } else if (holder === 'unreadable') {
      unreadableSince ??= Date.now()
      if (Date.now() - unreadableSince >= UNREADABLE_GRACE_MS) {
        const took = drop(p, (text) => pidOf(text) === undefined)
        if (took === 'error') return settle(undefined)   // a path it cannot clear: run unturned
        if (took === 'taken') { unreadableSince = undefined; continue }
      }
    } else if (!isAlive(holder)) {
      const took = drop(p, (text) => pidOf(text) === holder)
      if (took === 'error') return settle(undefined)
      if (took === 'taken') continue
    } else {
      unreadableSince = undefined
      if (!said) { ctx.err(`runner: waiting for pid ${holder} · ${label}`); said = true }
    }
    pause(POLL_MS)
  }
}

// Row 218. A holder killed mid-run skips its `finally` and leaves its pid behind. The next taker
// steals such a turn anyway, but Windows reuses pids within minutes, and a reused pid reads as a
// live holder that every later run waits on. Drive calls this when it starts and after every
// session, so the leftover goes before its pid is likely to name another process. Only a dead
// holder's turn goes: a live one, one being written, or none at all is left alone.
export function releaseDeadTurn(root: string): boolean {
  const p = runnerLockPath(root)
  const holder = holderOf(p)
  if (typeof holder !== 'number' || isAlive(holder)) return false
  return drop(p, (text) => pidOf(text) === holder) === 'taken'
}

function suitesMayOverlap(root: string): boolean {
  const cfg = loadConfig(root)
  return cfg.ok && cfg.value.drive.parallelSuites
}

// `who` names a job taking the turn (row 255); a session's run passes none.
export function withRunnerTurn<T>(runRoot: string, ctx: Ctx, label: string, fn: (env: Ctx['env']) => T, who?: TurnWho): T {
  const pr = primaryRoot(runRoot)
  if (!pr.ok || suitesMayOverlap(pr.value)) return fn(ctx.env)
  const release = takeTurn(pr.value, ctx, label, who)
  if (!release) return fn(ctx.env)
  try {
    return fn({ ...ctx.env, [RUNNER_TURN_ENV]: String(process.pid) })
  } finally {
    release()
  }
}
