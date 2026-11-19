import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { DRIVE_DEADLINE_ENV } from './drive-presence.js'
import { isId } from './dsl.js'
import { LOCK_WAIT_MS, isAlive, pause, takeStale } from './lock.js'
import { v, type Violation } from './refusal.js'
import { ensureExcluded } from './worktree.js'

// Row 240 (design §4.1.2). Lean busy locks. A settle lock per stop's target and a ship marker per
// plan say "a witness process is acting on this now", so a second settler asks no second model
// call and a second `witness ship` runs no second ship. They only spare work: the journal stays
// right through the settled-since token alone, so a lock that misses costs a call or a run, never
// a wrong record. Nobody ever waits for one, and none is ever renewed: the taker writes `until`,
// the time past which its lock is stale, so no reader computes a bound from its own config.
//
// Machine-local, under the folder state commits exempt (`gitio.ts`), and written without
// following a link: the folder is refused when it is a link (as `live.ts` refuses one), and the
// file is created with O_CREAT | O_EXCL | O_NOFOLLOW.

export type BusyKind = 'settle' | 'ship'
export interface BusyLock { pid: number; since: number; until: number }

export const BUSY_DIR = '.witness/live/busy'
// A lock whose `until` lies more than this after its `since` is stale, whatever it claims.
export const BUSY_MAX_MS = 86_400_000

// An empty or unparseable file is a write in progress for this long (`lock.ts`'s grace).
const UNREADABLE_GRACE_MS = 1_000
// Windows: a scanner or the indexer can hold a fresh file for a moment (EPERM, EBUSY, EACCES).
const CREATE_RETRY_MS = 1_000
const RETRY_PAUSE_MS = 50
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])

// The one seam for file errors, so a test can stand in for a Windows scanner.
export const busyIo = {
  create(p: string, text: string): void {
    const fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
    try { writeSync(fd, text) } finally { closeSync(fd) }
  },
}

const unwritable = (why: string): Violation => v(BUSY_DIR, 'lock-unwritable', why,
  'a writable .witness/live/busy folder, not a link — witness writes its busy locks there')

// The folder, or why it cannot be used. A link anywhere on the way is refused, never followed.
function busyDir(root: string, create: boolean): string | { refused: Violation } | undefined {
  const live = join(root, '.witness', 'live')
  const dir = join(root, BUSY_DIR)
  for (const p of [live, dir]) {
    try {
      if (!lstatSync(p).isDirectory()) return { refused: unwritable(`${p === live ? '.witness/live' : BUSY_DIR} is not a folder`) }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { refused: unwritable((e as NodeJS.ErrnoException).code ?? String(e)) }
      if (!create) return undefined
      try { mkdirSync(p, { recursive: true }) } catch (err) { return { refused: unwritable((err as NodeJS.ErrnoException).code ?? String(err)) } }
    }
  }
  return dir
}

const lockName = (kind: BusyKind, target: string) => `${target}.${kind}.json`

type Read = { lock: BusyLock } | 'absent' | 'unreadable' | 'malformed' | 'link'

function parseLock(text: string): BusyLock | 'unreadable' | 'malformed' {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return 'unreadable' }
  const r = raw as Partial<Record<keyof BusyLock, unknown>>
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0
  if (!(Number.isInteger(r?.pid) && (r.pid as number) > 0 && num(r.since) && num(r.until))) return 'malformed'
  return { pid: r.pid as number, since: r.since as number, until: r.until as number }
}

function readLock(p: string): Read {
  try {
    if (lstatSync(p).isSymbolicLink()) return 'link'
    const text = readFileSync(p, 'utf8')
    const parsed = parseLock(text)
    return typeof parsed === 'string' ? parsed : { lock: parsed }
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable'
  }
}

// Live: its pid is alive, its `until` has not passed, and it claims no more than the cap.
const live = (l: BusyLock, now: number): boolean =>
  l.until >= l.since && l.until - l.since <= BUSY_MAX_MS && now <= l.until && isAlive(l.pid)

const olderThanGrace = (p: string, now: number): boolean => {
  try { return now - lstatSync(p).mtimeMs >= UNREADABLE_GRACE_MS } catch { return true }
}

// Stale to `pid`: not live, or its own (no lock nests: a lock naming the reader is never busy to it).
function stale(p: string, text: string | undefined, pid: number, now: number): boolean {
  if (text === undefined) {
    try { if (lstatSync(p).isSymbolicLink()) return true } catch { return true }
    return olderThanGrace(p, now)
  }
  const parsed = parseLock(text)
  if (parsed === 'unreadable') return olderThanGrace(p, now)
  if (parsed === 'malformed') return true
  return parsed.pid === pid || !live(parsed, now)
}

export type TakeBusy =
  | { taken: true; release: () => void }
  | { taken: false; holder: BusyLock }
  | { taken: false; refused: Violation[] }

// Takes `kind`'s lock on `target` until `until`, or names the live holder. Never waits on a
// holder: the only pauses are for a write in progress and a scanner holding a fresh file.
export function takeBusy(
  root: string, kind: BusyKind, target: string, until: number, opts: { now?: number; pid?: number } = {},
): TakeBusy {
  if (!isId(target)) return { taken: false, refused: [v('target', 'unknown-id', target, 'an artifact id — lowercase letters, digits and dashes')] }
  const pid = opts.pid ?? process.pid
  const now = () => opts.now ?? Date.now()
  // Spec c2: a repo whose ignore rules predate this folder must never show it. Best effort.
  try { ensureExcluded(root) } catch { /* not a git checkout we can write to */ }
  const dir = busyDir(root, true)
  if (dir === undefined) return { taken: false, refused: [unwritable('the folder could not be made')] }
  if (typeof dir !== 'string') return { taken: false, refused: [dir.refused] }
  const p = join(dir, lockName(kind, target))
  const since = now()
  const text = JSON.stringify({ pid, since, until })
  const t0 = Date.now()
  for (;;) {
    try {
      busyIo.create(p, text)
      return { taken: true, release: () => releaseIf(p, text) }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        if (code !== undefined && TRANSIENT.has(code) && Date.now() - t0 < CREATE_RETRY_MS) { pause(RETRY_PAUSE_MS); continue }
        return { taken: false, refused: [unwritable(code ?? String(e))] }
      }
    }
    const held = readLock(p)
    if (typeof held === 'object' && held.lock.pid !== pid && live(held.lock, now())) return { taken: false, holder: held.lock }
    let took: 'taken' | 'busy'
    try {
      took = takeStale(p, (t) => stale(p, t, pid, now()))
    } catch (e) {
      return { taken: false, refused: [unwritable(`the stale lock could not be removed (${(e as NodeJS.ErrnoException).code ?? String(e)})`)] }
    }
    if (took === 'taken') continue
    // a write in progress, or another stealer at work: re-read shortly, within the same budget
    if (Date.now() - t0 >= CREATE_RETRY_MS + UNREADABLE_GRACE_MS) {
      const again = readLock(p)
      if (typeof again === 'object') return { taken: false, holder: again.lock }
      return { taken: false, refused: [unwritable('the lock is being written by another process')] }
    }
    pause(RETRY_PAUSE_MS)
  }
}

// A lock is released by its taker only, and only while it still holds what the taker wrote.
function releaseIf(p: string, text: string): void {
  try {
    if (lstatSync(p).isSymbolicLink()) return
    if (readFileSync(p, 'utf8') === text) unlinkSync(p)
  } catch { /* gone already; an unlink that keeps failing is left to the dead-pid rule */ }
}

// The live holder of `kind`'s lock on `target`, when it is a process other than `opts.pid`.
export function busyHolder(root: string, kind: BusyKind, target: string, opts: { now?: number; pid?: number } = {}): BusyLock | undefined {
  if (!isId(target)) return undefined
  const dir = busyDir(root, false)
  if (typeof dir !== 'string') return undefined
  const held = readLock(join(dir, lockName(kind, target)))
  if (typeof held !== 'object') return undefined
  const pid = opts.pid ?? process.pid
  return held.lock.pid !== pid && live(held.lock, opts.now ?? Date.now()) ? held.lock : undefined
}

// Drive's cleanup (`releaseDeadTurn`'s pattern, row 218): the locks of dead pids, and the
// caller's own leftovers, before Windows can hand a dead pid to another process. The count.
export function sweepDeadBusy(root: string, opts: { pid?: number } = {}): number {
  const dir = busyDir(root, false)
  if (typeof dir !== 'string') return 0
  const pid = opts.pid ?? process.pid
  let n = 0
  let names: string[]
  try { names = readdirSync(dir) } catch { return 0 }
  for (const name of names) {
    if (!/\.(settle|ship)\.json$/.test(name)) continue
    const p = join(dir, name)
    // Asked again under the steal guard, so a live lock written meanwhile is never removed. A
    // write in progress (an empty file) is not dropped: its taker is mid-create.
    const droppable = (t: string | undefined): boolean => {
      if (t === undefined) { try { return lstatSync(p).isSymbolicLink() } catch { return false } }
      const l = parseLock(t)
      return l === 'malformed' || (typeof l === 'object' && (l.pid === pid || !isAlive(l.pid)))
    }
    const text = readLock(p) === 'link' ? undefined : (() => { try { return readFileSync(p, 'utf8') } catch { return '' } })()
    if (!droppable(text)) continue
    try { if (takeStale(p, droppable) === 'taken') n++ } catch { /* left to the next sweep */ }
  }
  return n
}

// The bound a taker writes: the estimate, or inside a drive session the session's deadline when
// later — a reviewer there may wait out a usage limit until then (reviewer.ts) — and never more
// than the cap after now. The cap goes last (pass 6, P20), so no bound is stale at birth.
function bound(estimateMs: number, env: Ctx['env'], now: number): number {
  const deadline = Number(env[DRIVE_DEADLINE_ENV]) || 0
  return Math.min(Math.max(now + estimateMs, deadline), now + BUSY_MAX_MS)
}

// A self-repair reroll is a second arbitration, each of up to three timed attempts, then the
// door's lock wait — twice when `parkRefused` follows — and two minutes of slack.
const settleEstimate = (cfg: Config): number => 2 * 3 * cfg.gates.reviewerTimeoutMs + 2 * LOCK_WAIT_MS + 120_000

export function settleUntil(cfg: Config, env: Ctx['env'], now: number): number {
  return bound(settleEstimate(cfg), env, now)
}

// The ship gate's battery, the CI watch, both settles, and ten minutes for git and gh.
export function shipUntil(cfg: Config, env: Ctx['env'], now: number): number {
  return bound(3 * cfg.gates.reviewerTimeoutMs + cfg.ship.ciSettleMs + 1_800_000 + 2 * settleEstimate(cfg) + 600_000, env, now)
}
