import { randomBytes } from 'node:crypto'
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { KEPT_STOP_NAMES, type KeptStop } from './autonomy.js'
import type { AsideKind } from './drive.js'
import { TARGETLESS, driveHolder } from './drive-presence.js'
import type { Canon } from './scan.js'
import { GATE_NAMES } from './settings.js'

// Row 203. Drive's set-asides — stuck and capped above all — live only in its memory (D145),
// and a chat waiting beside it must know them. So drive publishes what needs the human here,
// machine-local and never committed (excluded the three ways the drafts are). Row 145: a killed
// drive leaves no cleanup, so a reader trusts the file only while the drive it names holds the
// drive lock. And it is display data at most: only ids and kinds survive the read, never text,
// and every line a reader prints is rendered by the CLI (`drive-presence.ts`'s doctrine).
export const LIVE_DIR = '.witness/live'
const DRIVE_FILE = 'drive.json'
const WAITER_FILE = 'waiter.json'

export type EndReason = 'done' | 'idle-limit' | 'ceiling' | 'usage' | 'autonomy-off' | 'spawn-failed' | 'signal'
const END_REASONS: readonly EndReason[] = ['done', 'idle-limit', 'ceiling', 'usage', 'autonomy-off', 'spawn-failed', 'signal']
const ASIDE_KINDS: readonly AsideKind[] = ['kept', 'decision', 'conversation', 'merge', 'stuck', 'capped']

export interface LiveAside { target: string; kind: AsideKind; gate?: string; stop?: KeptStop }
export interface LiveState { pid: number; asides: LiveAside[]; ended?: EndReason }

// A folder a repo committed as a symlink would aim drive's writes anywhere: refused, as
// `detachDrive` refuses a linked log. Absent is fine — the first write makes it.
function liveDir(root: string, create: boolean): string | undefined {
  const dir = join(root, LIVE_DIR)
  try {
    if (!lstatSync(dir).isDirectory()) return undefined
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || !create) return undefined
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

// Written to a temp name and renamed, so a reader never sees half a file. The temp name is
// random and created exclusively without following a link: a repo can commit files inside a
// real .witness/live/, and a link at a name drive would write through could aim it anywhere.
// The rename replaces whatever entry holds the final name, a link included, never its target.
function put(root: string, file: string, value: unknown): void {
  const dir = liveDir(root, true)
  if (dir === undefined) return
  const tmp = join(dir, `.${file}.${randomBytes(8).toString('hex')}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
    writeSync(fd, JSON.stringify(value))
    closeSync(fd)
    fd = undefined
    renameSync(tmp, join(dir, file))
  } catch {
    // best effort: a reader with no file reads "unknown", never a wrong answer
    if (fd !== undefined) closeSync(fd)
    rmSync(tmp, { force: true })
  }
}

function get(root: string, file: string): unknown {
  const dir = liveDir(root, false)
  if (dir === undefined) return undefined
  try {
    const p = join(dir, file)
    if (!lstatSync(p).isFile()) return undefined
    return JSON.parse(readFileSync(p, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

const isPid = (x: unknown): x is number => Number.isInteger(x) && (x as number) > 0

export function writeLive(root: string, state: LiveState): void {
  put(root, DRIVE_FILE, state)
}

// Every field is checked against what this CLI knows: a target that is no canon id, a kind,
// gate or stop this CLI does not name, is dropped whole. No free text is kept.
export function readLive(root: string, canon: Canon): LiveState | undefined {
  const raw = get(root, DRIVE_FILE) as { pid?: unknown; asides?: unknown; ended?: unknown } | undefined
  if (raw === undefined || raw === null || typeof raw !== 'object' || !isPid(raw.pid)) return undefined
  const ids = new Set(canon.docs.map((d) => String(d.meta.id)))
  const stops = Object.keys(KEPT_STOP_NAMES)
  const asides: LiveAside[] = []
  for (const a of Array.isArray(raw.asides) ? raw.asides as Array<Record<string, unknown>> : []) {
    if (a === null || typeof a !== 'object') continue
    const { target, kind, gate, stop } = a
    if (typeof target !== 'string' || (target !== TARGETLESS && !ids.has(target))) continue
    if (!ASIDE_KINDS.includes(kind as AsideKind)) continue
    if (gate !== undefined && !(GATE_NAMES as readonly unknown[]).includes(gate)) continue
    if (stop !== undefined && !stops.includes(stop as string)) continue
    asides.push({
      target, kind: kind as AsideKind,
      ...(gate !== undefined ? { gate: gate as string } : {}), ...(stop !== undefined ? { stop: stop as KeptStop } : {}),
    })
  }
  const ended = END_REASONS.includes(raw.ended as EndReason) ? { ended: raw.ended as EndReason } : {}
  return { pid: raw.pid, asides, ...ended }
}

// The live drive's state: only while the drive the file names holds the drive lock.
export function liveDrive(root: string, canon: Canon): LiveState | undefined {
  const state = readLive(root, canon)
  return state !== undefined && driveHolder(root)?.pid === state.pid ? state : undefined
}

// How the last drive ended, once it no longer holds the lock — read even while its process is
// still on its way out, which is when a waiter first sees the lock gone.
export function lastEnd(root: string, canon: Canon): EndReason | undefined {
  const state = readLive(root, canon)
  return state !== undefined && driveHolder(root)?.pid !== state.pid ? state.ended : undefined
}

// Row 204. One waiting chat per repo: the newest takes over, and the one it displaced learns so
// on its next poll.
export function takeWaiter(root: string, pid: number): void {
  put(root, WAITER_FILE, { pid })
}

export function waiterIs(root: string, pid: number): boolean {
  const raw = get(root, WAITER_FILE) as { pid?: unknown } | undefined
  return raw !== undefined && raw !== null && raw.pid === pid
}
