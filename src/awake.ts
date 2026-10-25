import { spawn } from './spawn.js'

// Row 182. Drive keeps the machine awake for its own lifetime (design B4): macOS sleep kills
// long runs (the README's operator note). `caffeinate -ims` holds off idle, disk and AC
// system sleep, and `-w <pid>` ends it with drive even when drive is killed.
export interface Awake { command?: string; stop(): void }

export function keepAwake(env: Record<string, string | undefined>, platform: NodeJS.Platform, pid: number): Awake {
  // Test seam, on WITNESS_DRIVE_AGENT_BIN's precedent: never documented.
  const bin = env.WITNESS_KEEP_AWAKE_BIN ?? (platform === 'darwin' ? 'caffeinate' : undefined)
  if (bin === undefined) return { stop: () => {} }
  const args = ['-ims', '-w', String(pid)]
  const child = spawn(bin, args, { stdio: 'ignore' })
  child.on('error', () => {})                          // a missing binary costs the guard, never the run
  child.unref()
  return {
    command: [bin, ...args].join(' '),
    stop: () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') },
  }
}
