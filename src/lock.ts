import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ok, refuse, v, type Result } from './refusal.js'

const lockPath = (root: string) => join(root, '.witness', 'lock')

// Row 181. A state write waits for the holder instead of refusing at once: the write window
// is ~100 ms (D76), so under parallel flows a refusal would throw away a whole battery for a
// wait of milliseconds. 30 s covers the longest legitimate holder, `sync`'s pull and push.
export const LOCK_WAIT_MS = 30_000
const POLL_MS = 50
// `wx` creates the file empty before the pid lands, so an unreadable lock is a write in
// progress. Stealing it at once would make two holders; it is taken only after this grace.
const UNREADABLE_GRACE_MS = 1_000

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Synchronous, so no caller turns async: every lock user is a sync transaction.
export function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// A symlink at the lock path is never a holder: `wx` refuses it (EEXIST) while a read
// follows it, so a dangling one would read `absent` forever. It counts as unreadable and is
// replaced after the grace — the link itself, never what it points at.
export function pidOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  try {
    const pid = (JSON.parse(text) as { pid?: unknown }).pid
    return typeof pid === 'number' && Number.isInteger(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

function readHolder(p: string): number | 'absent' | 'unreadable' {
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

const readText = (p: string): string | undefined => {
  try {
    return lstatSync(p).isSymbolicLink() ? undefined : readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

// Final review F15. Take a stale lock file. Several waiters meet one dead holder at once
// after a crash, and "read it, then delete it" let a slow one delete the lock a faster one
// had just written — two holders. One stealer at a time holds `<lock>.steal` (created with
// `wx`) and re-reads the lock under it, so a live lock written in between is never removed.
// A guard older than 2 s is a stealer that died mid-steal. `undefined` text is an unreadable
// file. Returns 'taken' when the stale lock is gone and 'busy' when it is not (a live holder,
// or another stealer at work): the caller re-reads, waits and tries again. A path that cannot
// be cleared (a directory) throws to the caller's refusal.
const STEAL_GUARD_STALE_MS = 2_000
export function takeStale(p: string, stale: (text: string | undefined) => boolean): 'taken' | 'busy' {
  const guard = `${p}.steal`
  try {
    writeFileSync(guard, String(process.pid), { flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    try { if (Date.now() - lstatSync(guard).mtimeMs > STEAL_GUARD_STALE_MS) unlinkSync(guard) } catch { /* gone */ }
    return 'busy'
  }
  try {
    let exists = true
    try { lstatSync(p) } catch { exists = false }
    if (!exists) return 'taken'
    if (!stale(readText(p))) return 'busy'
    unlinkSync(p)
    return 'taken'
  } finally {
    try { unlinkSync(guard) } catch { /* gone */ }
  }
}

// The live pid holding the repo lock, if any (F3: a transaction marker is in flight, not a
// crash, while its writer holds this).
export function lockHolder(root: string): number | undefined {
  const pid = pidOf(readText(lockPath(root)))
  return pid !== undefined && isAlive(pid) ? pid : undefined
}

// A lock is released by its owner only: one taken over by another process stays theirs.
export function releaseIfMine(p: string, pid: number): void {
  const text = readText(p)
  try {
    if (text !== undefined && (JSON.parse(text) as { pid?: unknown }).pid === pid) unlinkSync(p)
  } catch { /* gone already, or not ours */ }
}

const steal = (p: string, stale: (text: string | undefined) => boolean): 'taken' | 'busy' | 'refused' => {
  try {
    return takeStale(p, stale)
  } catch {
    return 'refused'
  }
}

export function acquireLock(root: string, pid = process.pid, waitMs = LOCK_WAIT_MS): Result<() => void> {
  mkdirSync(join(root, '.witness'), { recursive: true })
  const p = lockPath(root)
  const release = () => releaseIfMine(p, pid)
  const unwritable = (why: string): Result<() => void> => refuse([v('.witness/lock', 'lock-unwritable', why,
    'a writable .witness directory — witness writes its lock there before any state write')])
  const t0 = Date.now()
  let unreadableSince: number | undefined
  for (;;) {
    try {
      writeFileSync(p, JSON.stringify({ pid }), { flag: 'wx' })
      return ok(release)
    } catch (e) {
      // Only an existing file is a holder. Anything else (a read-only dir, a full disk) would
      // read back `absent` and spin: no wait can fix it, so it refuses now.
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') return unwritable(code ?? String(e))
    }
    const holder = readHolder(p)
    if (holder === pid) return ok(release)
    if (holder === 'unreadable') {
      unreadableSince ??= Date.now()
      if (Date.now() - unreadableSince >= UNREADABLE_GRACE_MS) {
        const took = steal(p, (text) => typeof pidOf(text) !== 'number')
        if (took === 'refused') return unwritable('the unreadable lock could not be removed')
        if (took === 'taken') { unreadableSince = undefined; continue }
      }
    } else if (typeof holder === 'number' && !isAlive(holder)) {
      const took = steal(p, (text) => pidOf(text) === holder)
      if (took === 'refused') return unwritable(`the dead holder's lock could not be removed`)
      if (took === 'taken') continue
    } else if (typeof holder === 'number') {
      unreadableSince = undefined
    }
    // `absent` (released between our write and our read) retries at once — but under the
    // same deadline, so no shape of the lock path can spin past the wait.
    if (Date.now() - t0 >= waitMs) {
      const by = typeof holder === 'number' ? `pid ${holder}` : 'a write in progress'
      return refuse([v('.witness/lock', 'locked', `held by ${by} · waited ${waitMs}ms`,
        'one clone one writer — the other witness invocation held it past the wait · run this again when it finishes')])
    }
    if (holder !== 'absent') pause(POLL_MS)
  }
}
