import { existsSync } from 'node:fs'
import { crtQuote, envGet, spawnSync, system32, type ResolvedSpawn } from './spawn.js'

// Row 218. On Windows witness stopped what it started by ancestry — `taskkill /T` walks parent-pid
// links, libuv's own job holds only a direct child (every grandchild may break away silently, and
// a detached child is never assigned) — and a test suite's app leaves that ancestry: started
// detached by a starter that already exited, or by an installer that exits, it is linked to
// nothing, so it outlived every stop and every run that ended normally.
//
// The answer is a job object the host enters BEFORE it starts the command, so everything the
// command starts is born in it and dies when its last handle closes: when the host exits after
// the command, or when the host itself is killed — by a stop, or with its parent's libuv job.
// Assigning after spawn would race the shim, which starts the agent within milliseconds; a native
// addon or a compiled helper on disk would add what row 211's System32 PowerShell + `Add-Type`
// already gives. The limits are KILL_ON_JOB_CLOSE | BREAKAWAY_OK (0x2800), never silent breakaway
// (0x1000): a program that explicitly asks to leave still leaves, as it does today, and nothing
// else can — libuv's nested silent breakaway stops at this job (measured).
//
// A host that cannot enter a job costs containment, never the run: the probe runs once per
// process and a drive hands its answer down (`WITNESS_JOB_HOST`), so a machine where `Add-Type`
// is blocked (Constrained Language Mode) or `powershell.exe` is absent runs everything as before,
// and a job lost after a good probe prints `witness: no job (…)` and runs the command anyway.

export const JOB_HOST_ENV = 'WITNESS_JOB_HOST'
export const JOB_PROBE_EXIT = 86

export type JobHost = { ok: true; file: string } | { ok: false; why: string }

// One line of C#: the members Add-Type compiles into [Witness.Job].
const JOB_MEMBERS = [
  '[StructLayout(LayoutKind.Sequential)] public struct Basic { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;',
  ' public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity;',
  ' public uint PriorityClass; public uint SchedulingClass; }',
  ' [StructLayout(LayoutKind.Sequential)] public struct Extended { public Basic Basic; public ulong ReadOps; public ulong WriteOps;',
  ' public ulong OtherOps; public ulong ReadBytes; public ulong WriteBytes; public ulong OtherBytes; public UIntPtr ProcessMemoryLimit;',
  ' public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }',
  ' [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);',
  ' [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length);',
  ' [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);',
  ' [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();',
].join('')

// The host. The command arrives only through the environment (row 211: never in the script's
// text) and leaves it before the command starts, with the caller's PSModulePath and PATHEXT,
// both of which PowerShell rewrites for itself at startup: PATHEXT gains `.CPL`, and where the
// caller had none it becomes `PathEXT=.CPL`, which left cmd.exe unable to find `node` (measured).
// Every other variable reaches the command as the caller set it. No `-ExecutionPolicy` on the host's command line:
// PowerShell would hand the command `PSExecutionPolicyPreference=Bypass`, and inline `-Command`
// text is not subject to execution policy anyway. Its own words are ASCII — Windows PowerShell
// writes a pipe in the OEM code page.
export const JOB_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$held = $false',
  'try {',
  `  Add-Type -Name Job -Namespace Witness -MemberDefinition '${JOB_MEMBERS}'`,
  '  $j = [Witness.Job]::CreateJobObject([IntPtr]::Zero, $null)',
  "  if ($j -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }",
  '  $e = New-Object Witness.Job+Extended',
  '  $b = $e.Basic; $b.LimitFlags = 0x2800; $e.Basic = $b',
  "  if (-not [Witness.Job]::SetInformationJobObject($j, 9, [ref]$e, [Runtime.InteropServices.Marshal]::SizeOf($e))) { throw 'SetInformationJobObject failed' }",
  "  if (-not [Witness.Job]::AssignProcessToJobObject($j, [Witness.Job]::GetCurrentProcess())) { throw 'AssignProcessToJobObject failed' }",
  '  $held = $true',
  '} catch {',
  "  [Console]::Error.WriteLine('witness: no job (' + $_.Exception.Message + ')')",
  '}',
  `if ($env:WITNESS_JOB_PROBE) { if ($held) { exit 0 } else { exit ${JOB_PROBE_EXIT} } }`,
  '$psi = New-Object System.Diagnostics.ProcessStartInfo',
  '$psi.FileName = $env:WITNESS_JOB_FILE',
  '$psi.Arguments = $env:WITNESS_JOB_ARGS',
  '$psi.UseShellExecute = $false',
  "if ($env:WITNESS_JOB_PSMODULEPATH) { $psi.EnvironmentVariables['PSModulePath'] = $env:WITNESS_JOB_PSMODULEPATH } else { $psi.EnvironmentVariables.Remove('PSModulePath') }",
  "if ($env:WITNESS_JOB_PATHEXT) { $psi.EnvironmentVariables['PATHEXT'] = $env:WITNESS_JOB_PATHEXT } else { $psi.EnvironmentVariables.Remove('PATHEXT') }",
  "foreach ($n in 'WITNESS_JOB_FILE', 'WITNESS_JOB_ARGS', 'WITNESS_JOB_PSMODULEPATH', 'WITNESS_JOB_PATHEXT') { $psi.EnvironmentVariables.Remove($n) }",
  '$p = [System.Diagnostics.Process]::Start($psi)',
  '$p.WaitForExit()',
  'exit $p.ExitCode',
].join('\n')

const HOST_ARGS = ['-NoProfile', '-NonInteractive', '-Command', JOB_SCRIPT]

// libuv's quote_cmd_arg: an argument is quoted only when it is empty or holds a space, a tab
// or a quote, and then by the C runtime's rules.
export function winArg(arg: string): string {
  return arg === '' || /[ \t"]/.test(arg) ? crtQuote(arg) : arg
}

// The command line after the program name, as libuv would have built it: verbatim for a batch
// run (resolveSpawn already quoted it for cmd.exe), libuv's quoting for an image.
export function jobTail(run: ResolvedSpawn): string {
  return run.windowsVerbatimArguments ? run.args.join(' ') : run.args.map(winArg).join(' ')
}

// `run`, started through the host — or `run` itself where there is no host.
export function contained(run: ResolvedSpawn, host: JobHost): ResolvedSpawn {
  if (!host.ok) return run
  return {
    file: host.file,
    args: [...HOST_ARGS],
    env: {
      ...run.env,
      WITNESS_JOB_FILE: run.file,
      WITNESS_JOB_ARGS: jobTail(run),
      WITNESS_JOB_PSMODULEPATH: envGet(run.env, 'PSMODULEPATH') ?? '',
      WITNESS_JOB_PATHEXT: envGet(run.env, 'PATHEXT') ?? '',
    },
    windowsVerbatimArguments: false,
  }
}

let probed: JobHost | undefined

// Whether this process can start commands inside a job: a parent's answer as given, else this
// process's own probe, run once. Off win32 there are no job objects and nothing is probed.
export function jobHost(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): JobHost {
  if (platform !== 'win32') return { ok: false, why: `no job objects on ${platform}` }
  const file = system32(env, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (env[JOB_HOST_ENV] === 'job') return { ok: true, file }
  if (env[JOB_HOST_ENV] === 'none') return { ok: false, why: 'the drive that started this run found none' }
  if (probed !== undefined) return probed
  if (!existsSync(file)) {
    probed = { ok: false, why: `${file} not found` }
    return probed
  }
  const r = spawnSync(file, HOST_ARGS, {
    env: { ...env, WITNESS_JOB_PROBE: '1' }, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000,
  })
  probed = r.status === 0
    ? { ok: true, file }
    : { ok: false, why: ((r.stderr ?? '').split(/\r?\n/u)[0] ?? '').trim().slice(0, 200) || r.error?.message || `exit ${r.status}` }
  return probed
}

// Drive's opening line beside `keep-awake:` — what ends a session's work on this machine.
export function containmentLine(host: JobHost, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return 'containment: process groups — what a session starts ends with it, unless it leaves the group'
  return host.ok
    ? "containment: job objects — what drive's work starts ends with it"
    : `containment: none — ${host.why} · a stopped session's tree is still stopped`
}
