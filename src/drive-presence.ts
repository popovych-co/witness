import { lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAlive } from './lock.js'
import { ok, refuse, v, type Result } from './refusal.js'

// Row 180. What a process knows about the drive it runs under. Drive marks every child
// session with WITNESS_DRIVE=<target>: the marker is the recursion guard (a marked session's
// `witness drive` refuses) and the child's scope (its `next` answers for that target alone).
export const DRIVE_ENV = 'WITNESS_DRIVE'
export const TARGETLESS = '-'     // the marker's value for work with no target

// unset → undefined · '-' → { target: undefined } · else → { target: <value> }
export function driveChild(env: Record<string, string | undefined>): { target: string | undefined } | undefined {
  const marker = env[DRIVE_ENV]
  if (marker === undefined || marker === '') return undefined
  return { target: marker === TARGETLESS ? undefined : marker }
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
    if (typeof h.pid !== 'number' || !Number.isInteger(h.pid)) return 'unreadable'
    return { pid: h.pid, ...(typeof h.log === 'string' ? { log: h.log } : {}) }
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
  const release = () => {
    const h = readHolder(root)
    if (typeof h === 'object' && h.pid === pid) rmSync(p, { force: true })
  }
  for (let attempt = 0; attempt < 3; attempt++) {
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
    // dead, unreadable or a symlink: the lock of a drive that is gone
    try { unlinkSync(p) } catch { /* raced away */ }
  }
  return refuse([v(DRIVE_LOCK, 'drive-running', 'the lock changed hands while it was being taken', 'run this again')])
}

export function watchLine(h: DriveHolder): string {
  return h.log !== undefined
    ? `tail -f ${h.log} · stop it: kill ${h.pid}`
    : `the terminal running witness drive · pid ${h.pid}`
}
