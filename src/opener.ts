import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { spawnSync, spawn, system32 } from './spawn.js'

export type OpenOutcome = 'spawned' | 'failed'

type Env = Record<string, string | undefined>

// Platform default openers. `start` is a cmd builtin, hence the shell wrapper — System32's
// cmd.exe by absolute path (row 201), never a bare name another cmd.exe on PATH answers to.
export function platformOpener(platform: NodeJS.Platform = process.platform, env: Env = process.env): string[] {
  if (platform === 'darwin') return ['open']
  if (platform === 'win32') return [system32(env, 'cmd.exe'), '/c', 'start', '']
  return ['xdg-open']
}

// win32 has no `sh`, so a POSIX probe there would report every opener missing and make approve
// permanently unreachable. System32's `where` is the cmd equivalent, but it matches name
// patterns, never paths, so an absolute opener there is probed by existence.
export function probeArgv(cmd: string, platform: NodeJS.Platform = process.platform, env: Env = process.env):
  { file: string; args: string[] } | { exists: string } {
  if (platform !== 'win32') return { file: 'sh', args: ['-c', `command -v ${cmd}`] }
  return win32.isAbsolute(cmd) ? { exists: cmd } : { file: system32(env, 'where.exe'), args: [cmd] }
}

export function resolves(cmd: string): boolean {
  const probe = probeArgv(cmd)
  return 'exists' in probe ? existsSync(probe.exists) : spawnSync(probe.file, probe.args, { encoding: 'utf8' }).status === 0
}

// Show a file to the human. Returns the resolved command alongside the outcome so the
// caller can journal WHAT was run — a degenerate opener (`opener: /usr/bin/true` in
// .witness/config.local.yaml) then reads as a degenerate opener in the record instead
// of as a human looking at a screen. `opener` is the machine-config value (row 90 —
// nonstandard desktops declare it there; tests inject it as a parameter), a bare name
// off PATH or a path.
export function openArtifact(
  opener: string | undefined, absPath: string,
): { outcome: OpenOutcome; command: string } {
  const argv = opener !== undefined && opener !== '' ? [opener] : platformOpener()
  const [cmd, ...pre] = argv as [string, ...string[]]

  // Probe before spawning: a detached spawn reports ENOENT asynchronously, and the
  // caller needs the outcome synchronously to journal it in the same transaction.
  if (!resolves(cmd)) return { outcome: 'failed', command: cmd }

  try {
    // The one window witness means to show: never hidden, even from a background drive (row 201).
    const child = spawn(cmd, [...pre, absPath], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return { outcome: 'spawned', command: cmd }
  } catch {
    return { outcome: 'failed', command: cmd }
  }
}
