import { randomBytes } from 'node:crypto'
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { DRIVE_DEADLINE_ENV } from './drive-presence.js'
import { isAlive } from './lock.js'
import { ensureExcluded } from './worktree.js'

// Row 256. A drive session's deadline can move. Drive stops counting a session's time while the
// session waits behind a job for the test turn (`sessionClock`'s held time), so the earliest
// moment drive may stop it moves later by as much. `WITNESS_DRIVE_DEADLINE` is fixed at spawn and
// keeps its meaning (row 210: the earliest drive may stop the session); the moved one lives in a
// file drive names to the session in `WITNESS_DRIVE_DEADLINE_FILE`, an absolute path to
// `.witness/live/deadline/<drive pid>-<spawn n>.json` holding `{"deadline": <epoch ms>}`. Drive
// writes it only once the session first waits behind a job, rewrites it as the wait grows, and
// removes it when the session ends. Readers take the later of the two (`driveDeadline`).
// Machine-local, under the folder state commits exempt, like `.witness/live/busy`.
export const DRIVE_DEADLINE_FILE_ENV = 'WITNESS_DRIVE_DEADLINE_FILE'
export const DEADLINE_DIR = '.witness/live/deadline'

const TOKEN = /^[1-9][0-9]*-[1-9][0-9]*$/
// A deadline file is one small JSON object; anything bigger is not drive's.
const MAX_BYTES = 1_024
// A temp file a write killed mid-way leaves behind goes after this long.
const TEMP_STALE_MS = 60_000

// Row 255. The session a test run belongs to, as its turn ticket names it, so drive can see the
// session waiting behind a job. Read from the file's name alone, never its contents: a name that is
// not `<drive pid>-<spawn n>.json` names no session.
export function sessionToken(env: Record<string, string | undefined>): string | undefined {
  const file = env[DRIVE_DEADLINE_FILE_ENV]
  if (file === undefined) return undefined
  const name = basename(file)
  if (!name.endsWith('.json')) return undefined
  const token = name.slice(0, -'.json'.length)
  return TOKEN.test(token) ? token : undefined
}

// A folder under `.witness/live`, or undefined when it cannot be used. A link anywhere on the way
// is refused, never followed (busy.ts's `busyDir`): a repo can commit files inside a real
// `.witness/live/`, and a linked folder would aim witness's writes anywhere.
export function liveFolder(root: string, sub: string, create: boolean): string | undefined {
  const live = join(root, '.witness', 'live')
  const dir = join(live, sub)
  for (const p of [live, dir]) {
    try {
      if (!lstatSync(p).isDirectory()) return undefined
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || !create) return undefined
      try { mkdirSync(p, { recursive: true }) } catch { return undefined }
    }
  }
  return dir
}

const deadlineFolder = (root: string, create: boolean) => liveFolder(root, 'deadline', create)

export function deadlineFile(root: string, token: string): string {
  return resolve(root, DEADLINE_DIR, `${token}.json`)
}

// Written to a temp name and renamed, so a reader never sees half a file (live.ts's `put`): the
// temp is created O_EXCL | O_NOFOLLOW, and the rename replaces whatever entry holds the final name,
// a link included, never its target. Best effort: a session with no file keeps its spawn deadline.
export function writeDeadline(root: string, token: string, deadline: number): void {
  if (!TOKEN.test(token) || !Number.isFinite(deadline)) return
  try { ensureExcluded(root) } catch { /* not a git checkout we can write to */ }
  const dir = deadlineFolder(root, true)
  if (dir === undefined) return
  const tmp = join(dir, `.${token}.${randomBytes(8).toString('hex')}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
    writeSync(fd, JSON.stringify({ deadline }))
    closeSync(fd)
    fd = undefined
    renameSync(tmp, join(dir, `${token}.json`))
  } catch {
    if (fd !== undefined) try { closeSync(fd) } catch { /* closed */ }
    rmSync(tmp, { force: true })
  }
}

const spawnDeadline = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

// The file's deadline, read without following a link (O_NOFOLLOW, then the descriptor's own stat),
// and only when the file is at most MAX_BYTES.
function fileDeadline(p: string | undefined): number | undefined {
  if (p === undefined || p === '') return undefined
  let fd: number | undefined
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW)
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > MAX_BYTES) return undefined
    const buf = Buffer.alloc(MAX_BYTES + 1)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n > MAX_BYTES) return undefined
    const d = (JSON.parse(buf.subarray(0, n).toString('utf8')) as { deadline?: unknown } | null)?.deadline
    return typeof d === 'number' && Number.isFinite(d) ? d : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* closed */ }
  }
}

// The earliest moment drive may stop this session: the later of the spawn deadline and the one
// drive moved. Undefined outside a drive session.
export function driveDeadline(env: Record<string, string | undefined>): number | undefined {
  const spawned = spawnDeadline(env[DRIVE_DEADLINE_ENV])
  const moved = fileDeadline(env[DRIVE_DEADLINE_FILE_ENV])
  if (spawned === undefined) return moved
  if (moved === undefined) return spawned
  return Math.max(spawned, moved)
}

// Drive's cleanup: every deadline file not in `keep` whose drive (the token's first number) is this
// process or no longer alive, so a killed drive's files go before Windows hands its pid on. The
// count. Temp files a killed write left behind go too, uncounted.
export function sweepDeadlines(root: string, keep: ReadonlySet<string>): number {
  const dir = deadlineFolder(root, false)
  if (dir === undefined) return 0
  let names: string[]
  try { names = readdirSync(dir) } catch { return 0 }
  let n = 0
  for (const name of names) {
    const p = join(dir, name)
    if (name.startsWith('.') && name.endsWith('.tmp')) {
      try { if (Date.now() - lstatSync(p).mtimeMs > TEMP_STALE_MS) unlinkSync(p) } catch { /* gone */ }
      continue
    }
    if (!name.endsWith('.json')) continue
    const token = name.slice(0, -'.json'.length)
    if (!TOKEN.test(token) || keep.has(token)) continue
    const pid = Number(token.split('-')[0])
    if (pid !== process.pid && isAlive(pid)) continue
    try { unlinkSync(p); n++ } catch { /* gone, or left to the next sweep */ }
  }
  return n
}
