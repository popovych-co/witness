import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function readHolder(p: string): number | 'absent' | 'unreadable' {
  let text: string
  try {
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

export function acquireLock(root: string, pid = process.pid, waitMs = LOCK_WAIT_MS): Result<() => void> {
  mkdirSync(join(root, '.witness'), { recursive: true })
  const p = lockPath(root)
  const release = () => rmSync(p, { force: true })
  const t0 = Date.now()
  let unreadableSince: number | undefined
  for (;;) {
    try {
      writeFileSync(p, JSON.stringify({ pid }), { flag: 'wx' })
      return ok(release)
    } catch { /* held */ }
    const holder = readHolder(p)
    if (holder === 'absent') continue                       // released between our write and our read
    if (holder === pid) return ok(release)
    if (holder === 'unreadable') {
      unreadableSince ??= Date.now()
      if (Date.now() - unreadableSince >= UNREADABLE_GRACE_MS) {
        rmSync(p, { force: true })
        unreadableSince = undefined
        continue
      }
    } else if (!isAlive(holder)) {
      rmSync(p, { force: true })
      continue
    } else {
      unreadableSince = undefined
    }
    if (Date.now() - t0 >= waitMs) {
      const by = holder === 'unreadable' ? 'a write in progress' : `pid ${holder}`
      return refuse([v('.witness/lock', 'locked', `held by ${by} · waited ${waitMs}ms`,
        'one clone one writer — the other witness invocation held it past the wait · run this again when it finishes')])
    }
    pause(POLL_MS)
  }
}
