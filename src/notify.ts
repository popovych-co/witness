import { win32 } from 'node:path'
import { resolves } from './opener.js'
import { envGet, spawn, spawnSync } from './spawn.js'

// Row 184. The desktop notification an autonomous run ends with (design B6). A machine-local
// `notify:` command receives the message as its one argument; otherwise the platform notifier.
// Row 203 (issue #56): Windows gets a toast by default, and drive notifies each new item.

// Windows PowerShell 5.1 ships with Windows (PowerShell 7 need not be installed), and its own
// AppUserModelID shows a toast with no registration. The text arrives through the environment
// and is never interpolated into the script, so a repo-derived message cannot become code.
export const TOAST_SCRIPT = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$t = $xml.GetElementsByTagName('text')",
  '$t.Item(0).AppendChild($xml.CreateTextNode($env:WITNESS_NOTIFY_TITLE)) > $null',
  '$t.Item(1).AppendChild($xml.CreateTextNode($env:WITNESS_NOTIFY_TEXT)) > $null',
  "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
].join('\n')

export interface NotifyArgv { argv: string[]; env?: Record<string, string> }

export function notifyArgv(
  platform: NodeJS.Platform, configured: string | undefined, title: string, message: string,
  env: Record<string, string | undefined> = process.env,
): NotifyArgv | undefined {
  if (configured !== undefined && configured !== '') return { argv: [configured, message] }
  const q = (s: string) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  if (platform === 'darwin') return { argv: ['osascript', '-e', `display notification ${q(message)} with title ${q(title)}`] }
  if (platform === 'linux') return { argv: ['notify-send', title, message] }
  if (platform === 'win32') {
    // Row 201's doctrine: a System32 binary by its absolute path, never one PATH could shadow.
    const ps = win32.join(envGet(env, 'SYSTEMROOT') ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return {
      argv: [ps, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', TOAST_SCRIPT],
      env: { WITNESS_NOTIFY_TITLE: title, WITNESS_NOTIFY_TEXT: message },
    }
  }
  return undefined
}

// Probed first, on openArtifact's precedent — except Windows' default, named by an absolute
// path the probe would only re-walk. The end-of-run notification runs to completion, bounded:
// drive is about to exit, and waiting a moment is what makes it land. A notification inside a
// run (`wait: false`) starts in the background and is never waited for: a synchronous call
// stalled every round by up to its timeout.
const NOTIFY_TIMEOUT_MS = 10_000

export function notify(
  configured: string | undefined, title: string, message: string, platform: NodeJS.Platform = process.platform,
  opts: { wait: boolean } = { wait: true },
): { outcome: 'sent' | 'started' | 'failed' | 'none'; command?: string } {
  const r = notifyArgv(platform, configured, title, message)
  if (r === undefined) return { outcome: 'none' }
  const [cmd, ...args] = r.argv as [string, ...string[]]
  const builtIn = platform === 'win32' && (configured === undefined || configured === '')
  if (!builtIn && !resolves(cmd)) return { outcome: 'failed', command: cmd }
  const env = r.env !== undefined ? { ...process.env, ...r.env } : process.env
  if (!opts.wait) {
    try {
      // Not detached: on Windows that opens a console of its own. Row 201: the spawn wrapper
      // decides the window, hidden under a background drive.
      const child = spawn(cmd, args, { stdio: 'ignore', env })
      child.on('error', () => {})                          // a notifier that fails is not drive's crash
      child.unref()
      return { outcome: 'started', command: cmd }
    } catch {
      return { outcome: 'failed', command: cmd }
    }
  }
  const run = spawnSync(cmd, args, { stdio: 'ignore', timeout: NOTIFY_TIMEOUT_MS, env })
  return run.error !== undefined && (run.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT'
    ? { outcome: 'failed', command: cmd }
    : { outcome: 'sent', command: cmd }
}
