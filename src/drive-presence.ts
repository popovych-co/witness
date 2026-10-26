import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAlive, pause, pidOf, releaseIfMine, takeStale } from './lock.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { shellArg } from './toon.js'

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

function readHolder(root: string): DriveHolder | 'absent' | 'unreadable' {
  const p = join(root, DRIVE_LOCK)
  let text: string
  try {
    if (lstatSync(p).isSymbolicLink()) return 'unreadable'
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
    return { pid: h.pid, ...(h.log !== undefined ? { log: join(root, DRIVE_LOG) } : {}) }
  } catch {
    return 'unreadable'
  }
}

// A live holder only: a dead one (a drive killed with SIGKILL) reads as none.
export function driveHolder(root: string): DriveHolder | undefined {
  const h = readHolder(root)
  return typeof h === 'object' && isAlive(h.pid) ? h : undefined
}

export function acquireDriveLock(root: string, info: { log?: string }, pid = process.pid): Result<() => void> {
  const p = join(root, DRIVE_LOCK)
  mkdirSync(join(root, '.witness'), { recursive: true })
  const release = () => releaseIfMine(p, pid)
  const t0 = Date.now()
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
    if (typeof h === 'object' && isAlive(h.pid)) {
      return refuse([v(DRIVE_LOCK, 'drive-running', `pid ${h.pid}`, `one drive per repo — ${watchLine(h)}`)])
    }
    if (Date.now() - t0 > 5_000) {
      return refuse([v(DRIVE_LOCK, 'drive-running', 'the lock changed hands while it was being taken', 'run this again')])
    }
    // `wx` creates the file empty before the pid lands: an unreadable lock gets the repo
    // lock's grace before it counts as a dead drive's. A dead one is taken atomically
    // (F15), so of several drives started at once exactly one gets in.
    if (h === 'unreadable') {
      pause(50)
      if (Date.now() - t0 < 1_000) continue
    }
    try {
      const took = takeStale(p, (text) => typeof h === 'object' ? pidOf(text) === h.pid : pidOf(text) === undefined)
      if (took === 'busy') pause(50)
    } catch (e) {
      return refuse([v(DRIVE_LOCK, 'drive-lock-unwritable', (e as NodeJS.ErrnoException).code ?? String(e), 'a writable .witness directory')])
    }
  }
}


// Row 201: `kill` is not a Windows command, and PowerShell's alias ends drive alone.
export function watchLine(h: DriveHolder, platform: NodeJS.Platform = process.platform): string {
  const stop = platform === 'win32' ? `taskkill /PID ${h.pid} /T /F` : `kill ${h.pid}`
  return h.log !== undefined
    ? `tail -f ${shellArg(h.log)} · stop it: ${stop}`
    : `the terminal running witness drive · pid ${h.pid}`
}
