import { spawn, system32 } from './spawn.js'

// Row 182. Drive keeps the machine awake for its own lifetime (design B4): sleep kills long
// runs (the README's operator note). On macOS `caffeinate -ims` holds off idle, disk and AC
// system sleep, and `-w <pid>` ends it with drive even when drive is killed.
//
// Row 211 (issue #59). On Windows, System32's Windows PowerShell 5.1 (it ships with Windows)
// P/Invokes kernel32's SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) and holds it
// in `Wait-Process` on drive's pid: the request lives exactly as long as the helper's thread, and
// the helper as long as drive. No elevation, no `powercfg`. The pid reaches the script through
// the environment, never its text (notify's TOAST_SCRIPT precedent). `-WindowStyle Hidden` is
// never passed: a foreground drive's helper shares the terminal's console, and the flag can hide
// that console; under --detach the spawn wrapper already hides it (row 201).
//
// `2147483649` is 0x80000001 written in decimal: PowerShell parses the hex literal as a
// negative Int32, which will not cast to [uint32]. `Stop` comes first because a blocked
// `Add-Type` (Constrained Language Mode, AppLocker, a failed compile) only ends its own statement
// by default: the helper would reach `Wait-Process` holding nothing and never exit, so drive
// could not say `keep-awake: lost`. With it, any error ends `-Command` with exit 1;
// `Wait-Process`'s own `-ErrorAction` keeps a pid already gone a quiet end.
export const AWAKE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `$k = Add-Type -Name Awake -Namespace Witness -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'`,
  'if ($k::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 3 }',
  'Wait-Process -Id ([int]$env:WITNESS_AWAKE_PID) -ErrorAction SilentlyContinue',
].join('\n')

// STATUS_CONTROL_C_EXIT: how a console process the terminal's Ctrl+C ended reports its exit.
export const CTRL_C_EXIT = 0xC000013A

export interface AwakeArgv { file: string; args: string[]; env?: Record<string, string>; shown: string }

export function awakeArgv(env: Record<string, string | undefined>, platform: NodeJS.Platform, pid: number): AwakeArgv | undefined {
  // Test seam, on WITNESS_DRIVE_AGENT_BIN's precedent: never documented.
  const seam = env.WITNESS_KEEP_AWAKE_BIN
  if (platform === 'win32') {
    return {
      file: seam ?? system32(env, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', AWAKE_SCRIPT],
      env: { WITNESS_AWAKE_PID: String(pid) },
      shown: `SetThreadExecutionState via powershell.exe until pid ${pid} — an explicit sleep (Start › Sleep, a closed lid) still sleeps`,
    }
  }
  const file = seam ?? (platform === 'darwin' ? 'caffeinate' : undefined)
  if (file === undefined) return undefined
  return { file, args: ['-ims', '-w', String(pid)], shown: `${file} -ims -w ${pid} — a closed lid on battery still sleeps` }
}

const nameOf = (file: string): string => file.split(/[\\/]/).pop() ?? file

// Why a helper that ended before drive let go of it no longer holds the host, or undefined when
// its end is no news: a signal (drive's own group stop, the terminal's Ctrl+C), a clean exit
// (caffeinate's `-w` pid ended), or win32's Ctrl+C status. The cause is named: exit 3 is
// AWAKE_SCRIPT's own, and otherwise `said` — the helper's first stderr line, which in Windows
// PowerShell 5.1's error view is the message of the error that stopped it, ahead of its
// `At line`, `~~~`, `+ CategoryInfo` and `+ FullyQualifiedErrorId` lines.
export function lostWhy(
  platform: NodeJS.Platform, file: string, code: number | null, signal: NodeJS.Signals | null, said = '',
): string | undefined {
  if (signal !== null || code === null || code === 0) return undefined
  if (platform === 'win32' && code === CTRL_C_EXIT) return undefined
  if (platform === 'win32' && code === 3) return `${nameOf(file)} exited 3 — SetThreadExecutionState refused the request`
  return said ? `${nameOf(file)} exited ${code}: ${said}` : `${nameOf(file)} exited ${code}`
}

// The first non-empty line a helper wrote to stderr, capped: one row's worth for the warning.
const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0]?.trim().slice(0, 200) ?? ''

export interface Awake { shown?: string; stop(): void }

export function keepAwake(
  env: Record<string, string | undefined>, platform: NodeJS.Platform, pid: number, onLost: (why: string) => void = () => {},
): Awake {
  const a = awakeArgv(env, platform, pid)
  if (a === undefined) return { stop: () => {} }
  let done = false                                     // stopped, or already reported lost
  const lost = (why: string | undefined) => {
    if (done || why === undefined) return
    done = true
    onLost(why)
  }
  const child = spawn(a.file, a.args, { stdio: ['ignore', 'ignore', 'pipe'], ...(a.env ? { env: { ...env, ...a.env } } : {}) })
  // A helper that cannot hold the host costs the guard, never the run — but it says so, and why.
  let said = ''
  child.stderr?.setEncoding('utf8').on('data', (d: string) => { if (said.length < 4096) said += d })
  ;(child.stderr as { unref?: () => void } | null)?.unref?.()    // the pipe never holds drive open
  child.on('error', (e: NodeJS.ErrnoException) => lost(`${nameOf(a.file)} failed to start (${e.code ?? e.message})`))
  // 'close', not 'exit': the helper's stderr has been read in full only once its pipe closed.
  child.on('close', (code, signal) => lost(lostWhy(platform, a.file, code, signal, firstLine(said))))
  child.unref()
  return {
    shown: a.shown,
    stop: () => {
      done = true
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    },
  }
}
