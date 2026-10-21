import { lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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

// `unlinkSync`, not `rmSync`: Node's `rmSync({ force })` follows a dangling symlink, meets
// ENOENT and silently leaves the link in place. A lock path that is a directory fails here,
// and the caller refuses instead of looping.
const steal = (p: string): boolean => {
  try {
    unlinkSync(p)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

export function acquireLock(root: string, pid = process.pid, waitMs = LOCK_WAIT_MS): Result<() => void> {
  mkdirSync(join(root, '.witness'), { recursive: true })
  const p = lockPath(root)
  const release = () => rmSync(p, { force: true })
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
        if (!steal(p)) return unwritable('the unreadable lock could not be removed')
        unreadableSince = undefined
        continue
      }
    } else if (typeof holder === 'number' && !isAlive(holder)) {
      if (!steal(p)) return unwritable(`the dead holder's lock could not be removed`)
      continue
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
