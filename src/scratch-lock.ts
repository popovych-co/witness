import { closeSync, constants, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Ctx } from './cli.js'
import { liveFolder } from './deadline.js'
import { isAlive, pause, takeStale } from './lock.js'
import { refuse, v, type Result } from './refusal.js'

// Row 258. The scratch checkout has one user at a time, and its lock says who. Leased, as busy.ts's
// locks are: the taker writes `until` once, at the take, and a lock past it is stale whatever its
// pid — so a holder whose pid Windows handed on, or that slept past its lease, stops counting. A
// live holder is waited for, never refused (the test turn's rule, row 181): it is one process
// running one bounded run. Lock order is test turn → scratch → repo lock: a turn is never taken
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
export interface ScratchHolder { pid: number; since: number; until: number }

const SCRATCH_SUB = 'scratch'
const POLL_MS = 200
// A `since` this far ahead of now is a tampered lock or a clock set wrong, never a live holder.
const SINCE_SLACK_MS = 60_000
// A lease longer than this is stale, whatever it claims.
const MAX_LEASE_MS = 7 * 86_400_000
// An empty or unparseable file is a write in progress for this long (lock.ts's grace).
const UNREADABLE_GRACE_MS = 1_000
// Windows: a scanner or the indexer can hold a fresh file for a moment (busy.ts's rule).
const RETRY_MS = 1_000
const RETRY_PAUSE_MS = 50
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])

const lockFile = (root: string) => join(root, SCRATCH_LOCK)

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
  if (!(Number.isInteger(r?.pid) && (r.pid as number) > 0 && num(r.since) && num(r.until))) return 'malformed'
  return { pid: r.pid as number, since: r.since as number, until: r.until as number }
}

// The file's text, or undefined for a link, a missing file or one that cannot be read.
function readText(p: string): string | undefined {
  try {
    return lstatSync(p).isSymbolicLink() ? undefined : readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

const live = (l: ScratchHolder, now: number): boolean =>
  l.until >= l.since && l.until - l.since <= MAX_LEASE_MS && l.since <= now + SINCE_SLACK_MS && now <= l.until && isAlive(l.pid)

const olderThanGrace = (p: string, now: number): boolean => {
  try { return now - lstatSync(p).mtimeMs >= UNREADABLE_GRACE_MS } catch { return true }
}

// Stale: no live holder by the lease's rule. A link at the file, a malformed file, or one left
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
  return parsed.pid === process.pid || !live(parsed, now)
}

// The live holder, by the lease's rule.
export function scratchHolder(root: string, now: number = Date.now()): ScratchHolder | undefined {
  const text = readText(lockFile(root))
  const parsed = text === undefined ? undefined : parse(text)
  return typeof parsed === 'object' && live(parsed, now) ? parsed : undefined
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

// Runs `fn` holding the scratch for `leaseMs`. Re-entered by a process that holds it (nothing taken,
// nothing released); a live holder is waited for, said once on stderr; a dead or lapsed holder's
// lock, or a leftover naming this process, is taken over. The lock goes in a `finally`, so a throw
// in `fn` releases it too.
export function withScratchLock<T>(root: string, ctx: Ctx, leaseMs: number, fn: () => Result<T>): Result<T> {
  if (holdsScratch(root)) return fn()
  const dir = liveFolder(root, SCRATCH_SUB, true)
  if (dir === undefined) return unusable('a link, or a folder that could not be made')
  const p = lockFile(root)
  const key = holdKey(root)
  let said = false
  let t0 = Date.now()
  for (;;) {
    const now = Date.now()
    const text = JSON.stringify({ pid: process.pid, since: now, until: now + leaseMs })
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
    if (typeof parsed === 'object' && parsed.pid !== process.pid && live(parsed, Date.now())) {
      if (!said) { ctx.err(`scratch: waiting for pid ${parsed.pid}`); said = true }
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

// Drive's sweep (row 218's pattern): a dead holder's lock, or one whose lease passed, goes before
// Windows can hand its pid to another process. Whether it removed one.
export function releaseDeadScratch(root: string): boolean {
  const p = lockFile(root)
  const text = readText(p)
  if (text === undefined) return false
  const parsed = parse(text)
  if (typeof parsed !== 'object' || (live(parsed, Date.now()) && !(parsed.pid === process.pid && !holdsScratch(root)))) return false
  try {
    return takeStale(p, (t) => t === text) === 'taken'
  } catch {
    return false
  }
}
