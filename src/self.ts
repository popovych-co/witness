import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Ctx } from './cli.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { resolveSpawn, spawn, treeStop, type ResolvedSpawn } from './spawn.js'

// This CLI as a child, and how drive stops a child it started — a session (drive.ts) or a job
// (drive-jobs.ts, row 257). Moved out of drive.ts unchanged in behavior.

// How long a SIGTERMed child gets before SIGKILL, and how long a dead session's pipes
// get to drain before drive stops waiting on the grandchildren that inherited them.
export const TERM_GRACE_MS = 5_000
// The process groups of the children now running (F11): a second signal to drive kills them
// before drive itself goes, so nothing a session or a job started outlives the run.
export const LIVE_GROUPS = new Set<number>()

const ownBin = (): string => join(dirname(fileURLToPath(import.meta.url)), 'bin.js')

// This CLI, for the child. A spawned session shells out to `witness` through
// ${WITNESS_BIN:-npx …} in every stage skill, and an unset value means the child resolves
// the PUBLISHED version while its parent runs an unpublished one — which the state floor
// then refuses (cli-behind-state). An explicitly set value wins: a session that already
// knows its bin is stating a fact drive has no better answer for.
export function localBin(ctx: Ctx): string {
  return ctx.env.WITNESS_BIN ?? `node ${ownBin()}`
}

// How drive stops a child it started: its process group (F11), or on Windows, which has no
// groups to signal, its process tree (row 201).
export function signalSession(
  child: ReturnType<typeof spawn>, grouped: boolean, env: Record<string, string | undefined>, sig: NodeJS.Signals,
): void {
  try {
    if (grouped && child.pid !== undefined) process.kill(-child.pid, sig)
    else if (child.pid === undefined) child.kill(sig)
    else if (child.exitCode === null && child.signalCode === null) {
      // Only while it runs: Node closes the handle before it reports the exit, and from then on
      // the pid may name another process, which a tree kill would take down with its own.
      const stop = treeStop(child.pid, env)
      spawn(stop.file, stop.args, { stdio: 'ignore' }).on('error', () => {})
    }
  } catch { /* already gone */ }
}

// Row 223. This CLI as a child running `args` — `witness drive …` detached (`detachArgv`), or a
// job's `witness job …` (row 257). With no WITNESS_BIN it is this very file's bin under this
// node. On posix a WITNESS_BIN runs through `/bin/sh -c 'exec <bin> "$@"'`, so the printed pid
// is the CLI's own and no shell sits between it and a `kill`. Windows has no /bin/sh: the bin
// is split as a command line (a quoted first word may carry spaces — an install under Program
// Files) and its first word resolved like every other spawn, an npm `.cmd` shim through
// System32's cmd.exe (row 201). A bin nothing answers to is refused here, not at the spawn.
export function selfArgv(
  bin: string | undefined, args: readonly string[], env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): Result<ResolvedSpawn> {
  if (bin === undefined) {
    return ok({ file: process.execPath, args: [ownBin(), ...args], env, windowsVerbatimArguments: false })
  }
  if (platform !== 'win32') {
    return ok({ file: '/bin/sh', args: ['-c', `exec ${bin} "$@"`, 'witness', ...args], env, windowsVerbatimArguments: false })
  }
  const [first, ...rest] = splitArgv(bin)
  if (first === undefined) {
    return refuse([v('WITNESS_BIN', 'bin-empty', JSON.stringify(bin), 'the command that runs witness, e.g. node C:\\path\\to\\bin.js — or unset it')])
  }
  return resolveSpawn(first, [...rest, ...args], env, 'win32')
}

// Split a WITNESS_BIN command line into argv, honoring double quotes: on Windows `selfArgv`
// starts the bin it names with no shell, and a first word quoted for its spaces (an install
// under Program Files) is one word. Row 239: its one use. A printed decision is never read back
// through it, and a typed answer at `decide>` reads by `shellWords`.
export function splitArgv(command: string): string[] {
  const argv: string[] = []
  let cur = ''
  let quoted = false
  let started = false
  for (const ch of command) {
    if (ch === '"') { quoted = !quoted; started = true; continue }
    if (ch === ' ' && !quoted) {
      if (started) { argv.push(cur); cur = ''; started = false }
      continue
    }
    cur += ch
    started = true
  }
  if (started) argv.push(cur)
  return argv
}
