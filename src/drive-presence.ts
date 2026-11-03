import { lstatSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAlive, pause, pidOf, releaseIfMine, takeStale } from './lock.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { psArg, shellArg } from './toon.js'

// Row 180. What a process knows about the drive it runs under. Drive marks every child
// session with WITNESS_DRIVE=<target>: the marker is the recursion guard (a marked session's
// `witness drive` refuses) and the child's scope (its `next` answers for that target alone).
export const DRIVE_ENV = 'WITNESS_DRIVE'
export const TARGETLESS = '-'     // the marker's value for work with no target
// Final review F14: when drive will kill this session (epoch ms). A reviewer inside it never
// waits past that — a wait drive kills mid-way leaves an orphaned gate and a stuck target.
export const DRIVE_DEADLINE_ENV = 'WITNESS_DRIVE_DEADLINE'

// unset → undefined · '-' → { target: undefined } · else → { target: <value> }
export function driveChild(env: Record<string, string | undefined>): { target: string | undefined } | undefined {
  const marker = env[DRIVE_ENV]
  if (marker === undefined || marker === '') return undefined
  return { target: marker === TARGETLESS ? undefined : marker }
}

// Row 217. Is this process a reviewer, or started by one? Read on its own: a reviewer spawned
// inside a drive session carries both markers, and `sessionMarker` names the drive's first.
export function isReviewer(env: Record<string, string | undefined>): boolean {
  return (env.WITNESS_REVIEWER ?? '') !== ''
}

// Rows 173 and 207. A session acts for the human only through the chat it answers to: one
// drive spawned, or a reviewer, never grants trust or un-sticks a target. Names the marker.
export function sessionMarker(env: Record<string, string | undefined>): 'WITNESS_DRIVE' | 'WITNESS_REVIEWER' | undefined {
  if (driveChild(env) !== undefined) return DRIVE_ENV
  if (env.WITNESS_REVIEWER !== undefined && env.WITNESS_REVIEWER !== '') return 'WITNESS_REVIEWER'
  return undefined
}

// Row 180. One drive per repo: `.witness/drive.lock` names the live drive's pid and, for a
// background drive, its log — so a second drive, or `next` under autonomy, can say where to
// watch the one that runs and how to stop it.
export const DRIVE_LOCK = '.witness/drive.lock'
export const DRIVE_LOG = '.witness/drive.log'
// How a background drive learns its own log path, set by `detachDrive` on its child alone.
export const DRIVE_LOG_ENV = 'WITNESS_DRIVE_LOG'

export interface DriveHolder { pid: number; log?: string }

// Row 222 (#69). The drive lock is a lease. A pid alone outlives its drive: a drive stopped
// hard (`taskkill /F`, `kill -9`, a reboot) never runs its `finally`, and once that pid is
// reused the lock read as a running drive and its printed stop aimed at an unrelated tree. The
// running drive renews the lock's mtime every DRIVE_RENEW_MS; a lock not renewed for
// DRIVE_LEASE_MS is no drive, whatever its pid. A drive whose host slept renews within a
// renewal of waking, so a new drive takes over a live pid's expired lease only after
// DRIVE_TAKEOVER_GRACE_MS without a renewal — never one that wakes in time.
export const DRIVE_LEASE_MS = 120_000
export const DRIVE_RENEW_MS = 10_000
export const DRIVE_TAKEOVER_GRACE_MS = 25_000

type Held = DriveHolder & { renewed: number }

function readHolder(root: string): Held | 'absent' | 'unreadable' {
  const p = join(root, DRIVE_LOCK)
  let text: string
  let renewed: number
  try {
    const st = lstatSync(p)
    if (st.isSymbolicLink()) return 'unreadable'
    renewed = st.mtimeMs
    text = readFileSync(p, 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable'
  }
  try {
    const h = JSON.parse(text) as { pid?: unknown; log?: unknown }
    if (typeof h.pid !== 'number' || !Number.isInteger(h.pid) || h.pid < 1) return 'unreadable'
    // The lock says only WHETHER a background log exists; its path is always derived. What
    // the file says is never printed: `watch:` is a line the engine acts on, and a path read
    // from a file could carry a newline and a forged `launch:` or `run:` line.
    return { pid: h.pid, renewed, ...(h.log !== undefined ? { log: join(root, DRIVE_LOG) } : {}) }
  } catch {
    return 'unreadable'
  }
}

const leaseLive = (h: Held, now: number): boolean => now - h.renewed < DRIVE_LEASE_MS

// A live holder only: a dead one (a drive killed with SIGKILL) reads as none, and so does a
// live pid whose lease expired (row 222).
export function driveHolder(root: string, now = Date.now()): DriveHolder | undefined {
  const h = readHolder(root)
  if (typeof h !== 'object' || !isAlive(h.pid) || !leaseLive(h, now)) return undefined
  return { pid: h.pid, ...(h.log !== undefined ? { log: h.log } : {}) }
}

// Row 222. The running drive's renewal: the lock's mtime set to now when the lock is this
// pid's. A link at the lock path is never followed (utimes would touch what it points at).
// `false` says the lease is no longer this drive's — taken over, or removed — and the drive
// that held it stops.
export function renewDriveLock(root: string, pid = process.pid): boolean {
  const h = readHolder(root)
  if (typeof h !== 'object' || h.pid !== pid) return false
  try {
    const p = join(root, DRIVE_LOCK)
    if (lstatSync(p).isSymbolicLink()) return false
    const now = new Date()
    utimesSync(p, now, now)
    return true
  } catch {
    return false
  }
}

// Row 222. The lock holder's renewal, from the moment it holds the lock to its release, so a
// drive waiting on a session, a usage pause or a human's answer alike keeps its lease. The
// timer never keeps the process alive. `onLost` runs once, when the lease is no longer this
// pid's, and the renewal stops.
export function holdLease(root: string, onLost: () => void, everyMs = DRIVE_RENEW_MS, pid = process.pid): () => void {
  const timer = setInterval(() => {
    if (renewDriveLock(root, pid)) return
    clearInterval(timer)
    onLost()
  }, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}

export function acquireDriveLock(
  root: string, info: { log?: string }, pid = process.pid, graceMs = DRIVE_TAKEOVER_GRACE_MS,
): Result<() => void> {
  const p = join(root, DRIVE_LOCK)
  mkdirSync(join(root, '.witness'), { recursive: true })
  const release = () => releaseIfMine(p, pid)
  let t0 = Date.now()
  // Row 222. When this drive first saw a live pid's lease expired, and how renewed it was then.
  let expired: { pid: number; renewed: number; since: number } | undefined
  for (;;) {
    try {
      writeFileSync(p, JSON.stringify({ pid, ...(info.log !== undefined ? { log: info.log } : {}) }), { flag: 'wx' })
      return ok(release)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        return refuse([v(DRIVE_LOCK, 'drive-lock-unwritable', (e as NodeJS.ErrnoException).code ?? String(e),
          'a writable .witness directory')])
      }
    }
    const h = readHolder(root)
    if (typeof h === 'object' && h.pid === pid) return ok(release)
    const alive = typeof h === 'object' && isAlive(h.pid)
    if (typeof h === 'object' && alive) {
      const running: Result<() => void> = refuse([v(DRIVE_LOCK, 'drive-running', `pid ${h.pid}`, `one drive per repo — ${watchLine(h)}`)])
      if (leaseLive(h, Date.now())) return running
      // Expired, but the pid lives: a reused pid, a frozen drive — or a drive whose host just
      // woke, which renews within DRIVE_RENEW_MS. Watched for the grace; a renewal refuses.
      if (expired === undefined || expired.pid !== h.pid) expired = { pid: h.pid, renewed: h.renewed, since: Date.now() }
      else if (h.renewed !== expired.renewed) return running
      if (Date.now() - expired.since < graceMs) { pause(Math.min(250, graceMs)); continue }
      t0 = Math.max(t0, expired.since + graceMs)
    }
    if (Date.now() - t0 > 5_000) {
      return refuse([v(DRIVE_LOCK, 'drive-running', 'the lock changed hands while it was being taken', 'run this again')])
    }
    // `wx` creates the file empty before the pid lands: an unreadable lock gets the repo
    // lock's grace before it counts as a dead drive's. A dead one is taken atomically
    // (F15), so of several drives started at once exactly one gets in; an expired lease is
    // taken only while it stays as the grace saw it (same pid, not renewed).
    if (h === 'unreadable') {
      pause(50)
      if (Date.now() - t0 < 1_000) continue
    }
    try {
      const stale = (text: string | undefined): boolean => {
        if (typeof h !== 'object') return pidOf(text) === undefined
        if (pidOf(text) !== h.pid) return false
        if (!alive) return true
        const now = readHolder(root)
        return typeof now === 'object' && now.pid === h.pid && now.renewed === h.renewed
      }
      const took = takeStale(p, stale)
      if (took === 'busy') pause(50)
    } catch (e) {
      return refuse([v(DRIVE_LOCK, 'drive-lock-unwritable', (e as NodeJS.ErrnoException).code ?? String(e), 'a writable .witness directory')])
    }
  }
}


// Row 201: `kill` is not a Windows command, and PowerShell's alias ends drive alone.
//
// Row 214: nor is `tail -f`. PowerShell's reader is `Get-Content -Wait`, with `-LiteralPath`
// because `-Path` reads `[ ]` in a path as a wildcard, `-Tail 50` so it starts at the end rather
// than replaying the whole log, and `-Encoding UTF8` because Windows PowerShell 5.1 reads a
// BOM-less file as ANSI and would garble drive's `·` and `—`.
export function watchLine(h: DriveHolder, platform: NodeJS.Platform = process.platform): string {
  if (h.log === undefined) return `the terminal running witness drive · pid ${h.pid}`
  return platform === 'win32'
    ? `Get-Content -LiteralPath ${psArg(h.log)} -Wait -Tail 50 -Encoding UTF8 · stop it: taskkill /PID ${h.pid} /T /F`
    : `tail -f ${shellArg(h.log)} · stop it: kill ${h.pid}`
}
