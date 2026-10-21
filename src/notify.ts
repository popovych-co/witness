import { spawnSync } from 'node:child_process'
import { resolves } from './opener.js'

// Row 184. The desktop notification an autonomous run ends with (design B6). A machine-local
// `notify:` command receives the run summary as its one argument; otherwise the platform
// notifier, and none on Windows.
export function notifyArgv(
  platform: NodeJS.Platform, configured: string | undefined, title: string, message: string,
): string[] | undefined {
  if (configured !== undefined && configured !== '') return [configured, message]
  const q = (s: string) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  if (platform === 'darwin') return ['osascript', '-e', `display notification ${q(message)} with title ${q(title)}`]
  if (platform === 'linux') return ['notify-send', title, message]
  return undefined
}

// Probed first, on openArtifact's precedent. Run to completion, bounded, rather than
// detached: a notifier answers at once, and drive is about to exit — waiting a moment is what
// makes the notification land before the report's caller reads anything.
const NOTIFY_TIMEOUT_MS = 10_000

export function notify(
  configured: string | undefined, title: string, message: string, platform: NodeJS.Platform = process.platform,
): { outcome: 'sent' | 'failed' | 'none'; command?: string } {
  const argv = notifyArgv(platform, configured, title, message)
  if (argv === undefined) return { outcome: 'none' }
  const [cmd, ...args] = argv as [string, ...string[]]
  if (!resolves(cmd)) return { outcome: 'failed', command: cmd }
  const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: NOTIFY_TIMEOUT_MS })
  return r.error !== undefined && (r.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT'
    ? { outcome: 'failed', command: cmd }
    : { outcome: 'sent', command: cmd }
}
