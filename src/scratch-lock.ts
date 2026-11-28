import { closeSync, constants, lstatSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Ctx } from './cli.js'
import { liveFolder, sessionToken } from './deadline.js'
import { isAlive, pause, takeStale } from './lock.js'
import { refuse, v, type Result } from './refusal.js'

// Row 258. The scratch checkout has one user at a time, and its lock says who. Row 279 (correction
// C40): held while its holder lives, as the test turn is (row 218) — live = the pid is alive.
// Row 258 leased it in wall time instead (`until`, written once at the take), so a host that slept
// past the lease's slack read a live holder as stale and a waiter took the scratch from under it; on
// a sleeping host nothing else runs, so sleep never lapses a holder. Drive's sweep frees a dead
// holder's lock before Windows can hand its pid on. A written lock keeps `until = since +
// MAX_LEASE_MS` only so an older witness, which reads the lease, still reads a live holder as live;
// nothing here reads it, nor `since` (slice 1 review M1). A job's hold names its kind (`job`, as the
// turn's lock does, row 256). A live holder is waited for, never refused (the test turn's rule, row
// 181). Lock order is test turn → scratch → repo lock: a turn is never taken
// while this process holds the scratch (`takeTurn` throws), since a step that took the turn inside
// the scratch could deadlock against a session holding the turn and waiting for the scratch.
//
// Machine-local, under `.witness/live/` (state commits exempt it, row 203), in a folder that is no
// link, created O_CREAT | O_EXCL | O_NOFOLLOW. This module imports neither the runner nor
// `scratch.ts`, so `runner-lock.ts` can import it without a cycle.
//
// What this process holds is kept in memory, never read back from the file's pid (slice 1 review):
// a leftover lock naming a pid the OS handed to this process is no hold it took. Re-entry and
// `takeTurn`'s lock-order check ask `holdsScratch`; the file is only the signal to other processes.

export const SCRATCH_LOCK = '.witness/live/scratch/lock.json'
export interface ScratchHolder { pid: number; since: number; until?: number; job?: string }
// Row 279. A process waiting for the scratch: `.witness/live/scratch/wait-<pid>.json`, written once
// before its first pause and removed when it takes the lock or returns. `session` is drive's token
// for the session it runs in (`sessionToken`), so drive can see that session waiting behind a job
// (`behindJob`) and leave the wait out of its clock, as it does a wait for the turn (row 256).
export interface ScratchWaiter { pid: number; since: number; session?: string }

const SCRATCH_SUB = 'scratch'
const POLL_MS = 200
// The `until` a written lock carries, for older readers only (row 279).
const MAX_LEASE_MS = 7 * 86_400_000
// An empty or unparseable file is a write in progress for this long (lock.ts's grace).
const UNREADABLE_GRACE_MS = 1_000
// Windows: a scanner or the indexer can hold a fresh file for a moment (busy.ts's rule).
const RETRY_MS = 1_000
const RETRY_PAUSE_MS = 50
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])

const lockFile = (root: string) => join(root, SCRATCH_LOCK)
const WAIT_RE = /^wait-([1-9][0-9]*)\.json$/

// This process's holds, by the root's real path: a depth, so a re-entered hold releases once.
const holds = new Map<string, number>()
const holdKey = (root: string): string => {
  try { return realpathSync(root) } catch { return resolve(root) }
}
export function holdsScratch(root: string): boolean {
  return (holds.get(holdKey(root)) ?? 0) > 0
}

function parse(text: string): ScratchHolder | 'unreadable' | 'malformed' {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return 'unreadable' }
  const r = raw as Partial<Record<keyof ScratchHolder, unknown>>
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0
  if (!(Number.isInteger(r?.pid) && (r.pid as number) > 0 && num(r.since))) return 'malformed'
  if (r.until !== undefined && !num(r.until)) return 'malformed'
  if (r.job !== undefined && typeof r.job !== 'string') return 'malformed'
  return {
    pid: r.pid as number, since: r.since as number,
    ...(r.until !== undefined ? { until: r.until as number } : {}),
    ...(r.job !== undefined ? { job: r.job as string } : {}),
  }
}

// The file's text, or undefined for a link, a missing file or one that cannot be read.
function readText(p: string): string | undefined {
  try {
    return lstatSync(p).isSymbolicLink() ? undefined : readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

// Row 279: the pid rule, as the turn's. `until` is never read.
// `since` only as a week's bound either way (push security review): a forged lock, or one whose pid
// the OS handed on, wedges the scratch a week at most, while no host sleep and no clock step a person
// meets reaches it (slice 1 review M1 dropped the minute's bound that one did).
const withinWeek = (since: number): boolean => Math.abs(Date.now() - since) <= MAX_LEASE_MS
const live = (l: ScratchHolder): boolean => withinWeek(l.since) && isAlive(l.pid)

const olderThanGrace = (p: string, now: number): boolean => {
  try { return now - lstatSync(p).mtimeMs >= UNREADABLE_GRACE_MS } catch { return true }
}

// Stale: no live holder by the pid rule. A link at the file, a malformed file, or one left
// unreadable past the grace is stale too, and so is one naming this process, which holds nothing
// here (its holds are in memory: a reused pid's leftover).
function stale(p: string, text: string | undefined, now: number): boolean {
  if (text === undefined) {
    try { if (lstatSync(p).isSymbolicLink()) return true } catch { return true }
    return olderThanGrace(p, now)
  }
  const parsed = parse(text)
  if (parsed === 'unreadable') return olderThanGrace(p, now)
  if (parsed === 'malformed') return true
  return parsed.pid === process.pid || !live(parsed)
}

// The live holder, by the pid rule.
export function scratchHolder(root: string): ScratchHolder | undefined {
  const text = readText(lockFile(root))
  const parsed = text === undefined ? undefined : parse(text)
  return typeof parsed === 'object' && live(parsed) ? parsed : undefined
}

const unusable = (got: string) => refuse<never>([v('.witness/live/scratch', 'scratch-unusable', got,
  'a writable .witness/live/scratch folder, not a link — witness keeps the scratch lock there')])

function create(p: string, text: string): void {
  const fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
  try { writeSync(fd, text) } finally { closeSync(fd) }
}

// The lock is removed by its taker only, and only while it still holds what the taker wrote.
function releaseIf(p: string, text: string): void {
  const t0 = Date.now()
  for (;;) {
    try {
      if (lstatSync(p).isSymbolicLink()) return
      if (readFileSync(p, 'utf8') !== text) return
      unlinkSync(p)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === undefined || !TRANSIENT.has(code) || Date.now() - t0 >= RETRY_MS) return
      pause(RETRY_PAUSE_MS)
    }
  }
}

function parseWaiter(text: string, pid: number): ScratchWaiter | undefined {
  let r: Partial<Record<keyof ScratchWaiter, unknown>>
  try { r = JSON.parse(text) as typeof r } catch { return undefined }
  if (r?.pid !== pid || typeof r.since !== 'number' || !Number.isFinite(r.since) || r.since < 0) return undefined
  if (r.session !== undefined && typeof r.session !== 'string') return undefined
  return { pid, since: r.since, ...(r.session !== undefined ? { session: r.session } : {}) }
}

// Every marker file in the folder, by name: its path, the pid its name gives, its text (undefined
// for a link or one that cannot be read).
function markerFiles(root: string): Array<{ p: string; pid: number; text: string | undefined }> {
  const dir = liveFolder(root, SCRATCH_SUB, false)
  if (dir === undefined) return []
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  return names.flatMap((name) => {
    const m = WAIT_RE.exec(name)
    if (!m) return []
    const p = join(dir, name)
    return [{ p, pid: Number(m[1]), text: readText(p) }]
  })
}

// Row 279. The live waiters: a marker whose pid is alive, written within the week's bound.
export function scratchWaiters(root: string): ScratchWaiter[] {
  return markerFiles(root).flatMap(({ pid, text }) => {
    const w = text === undefined ? undefined : parseWaiter(text, pid)
    return w !== undefined && withinWeek(w.since) && isAlive(w.pid) ? [w] : []
  })
}

// Row 279. Drive's sweep: the markers of dead pids, and any a link or a broken write left past the
// grace. How many it removed.
export function sweepScratchWaiters(root: string): number {
  const now = Date.now()
  let n = 0
  for (const { p, pid, text } of markerFiles(root)) {
    const w = text === undefined ? undefined : parseWaiter(text, pid)
    const gone = w !== undefined ? !(withinWeek(w.since) && isAlive(w.pid)) : olderThanGrace(p, now)
    if (!gone) continue
    try { if (takeStale(p, (t) => t === text) === 'taken') n++ } catch { /* left to the next sweep */ }
  }
  return n
}

// This waiter's own marker, best effort: a marker it cannot write leaves the wait unheld, as before
// row 279. A leftover at its name is a dead process's whose pid this one reuses: replaced once.
function writeMarker(dir: string, ctx: Ctx): { p: string; text: string } | undefined {
  const session = sessionToken(ctx.env)
  const p = join(dir, `wait-${process.pid}.json`)
  const text = JSON.stringify({ pid: process.pid, since: Date.now(), ...(session !== undefined ? { session } : {}) })
  for (let i = 0; i < 2; i++) {
    try {
      create(p, text)
      return { p, text }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i > 0) return undefined
      try { if (!lstatSync(p).isSymbolicLink()) unlinkSync(p) } catch { return undefined }
    }
  }
  return undefined
}

// Runs `fn` holding the scratch while this process lives. Re-entered by a process that holds it
// (nothing taken, nothing released); a live holder is waited for, said once on stderr; a dead
// holder's lock, or a leftover naming this process, is taken over. `who` names a job's kind on the
// lock. The lock goes in a `finally`, so a throw in `fn` releases it too. A waiter's marker (row
// 279) is written before its first pause and goes when it takes the lock, and in a `finally`.
export function withScratchLock<T>(root: string, ctx: Ctx, fn: () => Result<T>, who?: { job: string }): Result<T> {
  if (holdsScratch(root)) return fn()
  const dir = liveFolder(root, SCRATCH_SUB, true)
  if (dir === undefined) return unusable('a link, or a folder that could not be made')
  let marker: { p: string; text: string } | undefined
  let tried = false
  const unmark = () => {
    if (marker !== undefined) releaseIf(marker.p, marker.text)
    marker = undefined
  }
  try {
    return holding(root, ctx, fn, who, {
      waiting: () => { if (!tried) { tried = true; marker = writeMarker(dir, ctx) } },
      took: unmark,
    })
  } finally {
    unmark()
  }
}

function holding<T>(
  root: string, ctx: Ctx, fn: () => Result<T>, who: { job: string } | undefined,
  on: { waiting: () => void; took: () => void },
): Result<T> {
  const p = lockFile(root)
  const key = holdKey(root)
  let said = false
  let t0 = Date.now()
  for (;;) {
    const now = Date.now()
    const text = JSON.stringify({ pid: process.pid, since: now, until: now + MAX_LEASE_MS, ...(who !== undefined ? { job: who.job } : {}) })
    let created = false
    try {
      create(p, text)
      created = true
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? String(e)
      if (code !== 'EEXIST') {
        if (TRANSIENT.has(code) && Date.now() - t0 < RETRY_MS) { pause(RETRY_PAUSE_MS); continue }
        return unusable(code)
      }
    }
    if (created) {
      on.took()
      holds.set(key, (holds.get(key) ?? 0) + 1)
      try {
        return fn()
      } finally {
        const left = (holds.get(key) ?? 1) - 1
        if (left > 0) holds.set(key, left)
        else holds.delete(key)
        releaseIf(p, text)
      }
    }
    t0 = Date.now()
    const held = readText(p)
    const parsed = held === undefined ? undefined : parse(held)
    if (typeof parsed === 'object' && parsed.pid !== process.pid && live(parsed)) {
      if (!said) { ctx.err(`scratch: waiting for pid ${parsed.pid}`); said = true }
      on.waiting()
      pause(POLL_MS)
      continue
    }
    let took: 'taken' | 'busy'
    try {
      took = takeStale(p, (t) => stale(p, t, Date.now()))
    } catch (e) {
      return unusable(`the stale lock could not be removed (${(e as NodeJS.ErrnoException).code ?? String(e)})`)
    }
    if (took === 'busy') pause(RETRY_PAUSE_MS)
  }
}

// Drive's sweep (row 218's pattern): a dead holder's lock goes before Windows can hand its pid to
// another process. A live holder's never does, drive's own job child included (row 279: a host
// sleep lapses nothing). Whether it removed one.
export function releaseDeadScratch(root: string): boolean {
  const p = lockFile(root)
  const text = readText(p)
  if (text === undefined) return false
  const parsed = parse(text)
  if (typeof parsed !== 'object' || (live(parsed) && !(parsed.pid === process.pid && !holdsScratch(root)))) return false
  try {
    return takeStale(p, (t) => t === text) === 'taken'
  } catch {
    return false
  }
}
