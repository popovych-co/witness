import { spawnSync, spawn } from 'node:child_process'

export type OpenOutcome = 'spawned' | 'failed'

// Platform default openers. `start` is a cmd builtin, hence the shell wrapper.
function platformOpener(): string[] {
  if (process.platform === 'darwin') return ['open']
  if (process.platform === 'win32') return ['cmd', '/c', 'start', '']
  return ['xdg-open']
}

// win32 has no `sh`, so a POSIX probe there would report every opener missing and
// make approve permanently unreachable. `where` is the cmd equivalent.
function resolves(cmd: string): boolean {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [cmd], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' })
  return probe.status === 0
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
    const child = spawn(cmd, [...pre, absPath], { detached: true, stdio: 'ignore' })
    child.unref()
    return { outcome: 'spawned', command: cmd }
  } catch {
    return { outcome: 'failed', command: cmd }
  }
}
