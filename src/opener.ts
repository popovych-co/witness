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
// caller can journal WHAT was run — a degenerate opener (`WITNESS_OPENER=/usr/bin/true`)
// then reads as a degenerate opener in the record instead of as a human looking at a
// screen. `WITNESS_OPENER` overrides the binary: test seam, and the real escape hatch
// for nonstandard desktops, so it accepts a bare name off PATH as well as a path.
export function openArtifact(
  env: Record<string, string | undefined>, absPath: string,
): { outcome: OpenOutcome; command: string } {
  const argv = env.WITNESS_OPENER ? [env.WITNESS_OPENER] : platformOpener()
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
