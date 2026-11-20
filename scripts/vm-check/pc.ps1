<#
.SYNOPSIS
  witness's Windows check, the PC side (row 246, issue #76). Run it on the PC that hosts the VM,
  never inside the VM.

.DESCRIPTION
  -Host
    Hyper-V only (W2). Logs Hyper-V's host setting (Get-VMHost).EnableEnhancedSessionMode, which
    must be False. It needs an administrator PowerShell (or membership in Hyper-V Administrators).
    On a PC without Hyper-V, or without the rights to read it, it logs "unknown" and says why.

  -WatchFocus -Minutes <n>
    For <n> minutes, logs every change of the window in front (a WinEvent hook on
    EVENT_SYSTEM_FOREGROUND) as { at, process }: the program's process name only, never a
    window title (W5). Run it in a normal PowerShell; it needs no administrator rights.

  Every run first logs a "start" line with how the PC is set up: memory integrity, whether a
  hypervisor runs, and the plugged-in sleep timeout. Each line goes to the log as JSON and to the
  screen. It changes no setting.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\pc.ps1 -WatchFocus -Minutes 90
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\pc.ps1 -Host
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  # $Host is PowerShell's own read-only variable, so the switch is named HyperVHost; -Host works.
  [Alias('Host')][switch]$HyperVHost,
  [switch]$WatchFocus,
  [ValidateRange(1, 1440)][int]$Minutes = 90,
  [string]$Log = (Join-Path $env:USERPROFILE 'witness-pc-check.jsonl')
)

$ErrorActionPreference = 'Stop'
$Log = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Log)
$utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false

if (-not $HyperVHost -and -not $WatchFocus) {
  Write-Host 'Say what to check:'
  Write-Host '  pc.ps1 -WatchFocus -Minutes 90   log every program that comes to the front (W5)'
  Write-Host '  pc.ps1 -Host                     Hyper-V only: is enhanced session mode off? (W2)'
  exit 2
}

# ---------------------------------------------------------------------------------------------
# Helpers

function Get-Why($record) {
  $e = $record.Exception
  while ($null -ne $e.InnerException) { $e = $e.InnerException }
  return $e.Message
}

function Get-Now { return (Get-Date).ToString('o') }

function Write-Line($fields) {
  $line = ConvertTo-Json -InputObject $fields -Compress -Depth 4
  try { [System.IO.File]::AppendAllText($script:Log, $line + "`n", $script:utf8) }
  catch { Write-Warning ('could not write the log: ' + (Get-Why $_)) }
  Write-Host $line
}

# powercfg's plugged-in (AC) value of one setting of the active power plan.
function Get-PowerValue([string]$subgroup, [string]$setting) {
  $text = (& powercfg.exe /query SCHEME_CURRENT $subgroup $setting) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw ('powercfg /query exited ' + $LASTEXITCODE + ': ' + $text.Trim()) }
  $values = [regex]::Matches($text, '0x([0-9a-fA-F]+)')
  if ($values.Count -lt 2) { throw 'powercfg printed no setting values' }
  # In every language the last two hex values are the AC (plugged in) and DC (battery) settings.
  return [Convert]::ToInt64($values[$values.Count - 2].Groups[1].Value, 16)
}

# ---------------------------------------------------------------------------------------------
# Start: how the PC is set up

$principal = New-Object System.Security.Principal.WindowsPrincipal -ArgumentList ([System.Security.Principal.WindowsIdentity]::GetCurrent())
$elevated = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
$mode = @()
if ($HyperVHost) { $mode += 'host' }
if ($WatchFocus) { $mode += 'watch-focus' }

$startLine = [ordered]@{
  at = Get-Now; event = 'start'; script = 'pc.ps1'; mode = $mode; minutes = $Minutes; log = $Log
  elevated = $elevated; powershell = $PSVersionTable.PSVersion.ToString(); computer = $env:COMPUTERNAME
}
$setup = [ordered]@{}
$why = [ordered]@{}
try {
  $guard = Get-CimInstance -Namespace 'root\Microsoft\Windows\DeviceGuard' -ClassName 'Win32_DeviceGuard' -ErrorAction Stop
  # 2 among the running security services is memory integrity (HVCI).
  $setup['memoryIntegrity'] = $(if (@($guard.SecurityServicesRunning) -contains 2) { 'on' } else { 'off' })
} catch { $setup['memoryIntegrity'] = $null; $why['memoryIntegrity'] = Get-Why $_ }
try { $setup['hypervisorPresent'] = (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop).HypervisorPresent } catch { $setup['hypervisorPresent'] = $null; $why['hypervisorPresent'] = Get-Why $_ }
try { $setup['sleepTimeoutS'] = Get-PowerValue 'SUB_SLEEP' 'STANDBYIDLE' } catch { $setup['sleepTimeoutS'] = $null; $why['sleepTimeoutS'] = Get-Why $_ }
$startLine['setup'] = $setup
if ($why.Count -gt 0) { $startLine['error'] = $why }
Write-Line $startLine

# ---------------------------------------------------------------------------------------------
# -Host: Hyper-V's enhanced session mode (W2)

if ($HyperVHost) {
  $line = [ordered]@{ at = Get-Now; event = 'host'; enhancedSessionMode = 'unknown' }
  if ($null -eq (Get-Command -Name 'Get-VMHost' -ErrorAction SilentlyContinue)) {
    $line['why'] = 'the Hyper-V PowerShell module is not on this PC (Windows Home has no Hyper-V; with VirtualBox this check does not apply)'
  } else {
    try {
      $vmHost = Get-VMHost -ErrorAction Stop
      $line['enhancedSessionMode'] = [bool]$vmHost.EnableEnhancedSessionMode
    } catch {
      $reason = Get-Why $_
      if (-not $elevated) { $reason += ' (Get-VMHost needs an administrator PowerShell, or membership in Hyper-V Administrators)' }
      $line['why'] = $reason
    }
  }
  Write-Line $line
  if ($line['enhancedSessionMode'] -is [bool]) {
    if ($line['enhancedSessionMode']) {
      Write-Host 'Enhanced session mode is ALLOWED. Turn it off: Hyper-V Settings > Enhanced Session Mode Policy, or Set-VMHost -EnableEnhancedSessionMode $false (as administrator).'
    } else {
      Write-Host 'Enhanced session mode is off: VMConnect can open only the basic view.'
    }
  } else {
    Write-Host 'Enhanced session mode: unknown (see "why" above).'
  }
}

# ---------------------------------------------------------------------------------------------
# -WatchFocus: every program that comes to the front (W5)

if ($WatchFocus) {
  if (-not ('WitnessFocusWatch' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class WitnessFocusWatch
{
    private delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

    [DllImport("user32.dll")]
    private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc, WinEventProc proc, uint idProcess, uint idThread, uint dwFlags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint filterMin, uint filterMax, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")]
    private static extern uint MsgWaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds, uint wakeMask);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

    private const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    private const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    private const uint PM_REMOVE = 0x0001;
    private const uint QS_ALLINPUT = 0x04FF;

    private static WinEventProc callback;   // held here so the collector never frees it
    private static IntPtr hook = IntPtr.Zero;
    private static uint hookThread;
    private static readonly List<string[]> seen = new List<string[]>();

    public static void Start()
    {
        if (hook != IntPtr.Zero) return;
        callback = new WinEventProc(OnForeground);
        hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, callback, 0, 0, WINEVENT_OUTOFCONTEXT);
        if (hook == IntPtr.Zero) throw new InvalidOperationException("SetWinEventHook failed");
        hookThread = GetCurrentThreadId();
    }

    public static void Stop()
    {
        if (hook == IntPtr.Zero) return;
        UnhookWinEvent(hook);
        hook = IntPtr.Zero;
    }

    // The hook's events arrive only while the thread that set it pumps messages.
    public static void Pump(int milliseconds)
    {
        if (hook != IntPtr.Zero && GetCurrentThreadId() != hookThread)
            throw new InvalidOperationException("the message pump runs on another thread than the hook's");
        int end = Environment.TickCount + milliseconds;
        while (true)
        {
            MSG msg;
            while (PeekMessage(out msg, IntPtr.Zero, 0, 0, PM_REMOVE)) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
            int left = end - Environment.TickCount;
            if (left <= 0) return;
            MsgWaitForMultipleObjects(0, null, false, (uint)Math.Min(left, 100), QS_ALLINPUT);
        }
    }

    // Each event as { time, process name }, oldest first; the list is emptied.
    public static string[][] Drain()
    {
        string[][] all = seen.ToArray();
        seen.Clear();
        return all;
    }

    public static string ForegroundProcess() { return NameOf(GetForegroundWindow()); }

    private static void OnForeground(IntPtr h, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        try { seen.Add(new string[] { DateTime.Now.ToString("o"), NameOf(hwnd) }); }
        catch (Exception) { }
    }

    // The process name only, never the window's title.
    private static string NameOf(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return "(no window)";
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0) return "(unknown)";
        try { using (Process p = Process.GetProcessById((int)pid)) { return p.ProcessName; } }
        catch (Exception) { return "(pid " + pid + ", name unreadable)"; }
    }
}
'@
  }

  $count = 0
  $finished = $false
  $first = [ordered]@{ at = Get-Now; event = 'focus-start'; minutes = $Minutes; 'process' = $null }
  try {
    [WitnessFocusWatch]::Start()
  } catch {
    # Without the hook there is nothing to measure: say so and stop.
    $first['error'] = 'could not watch: ' + (Get-Why $_)
    Write-Line $first
    exit 1
  }
  try { $first['process'] = [WitnessFocusWatch]::ForegroundProcess() } catch { $first['error'] = Get-Why $_ }
  Write-Line $first
  Write-Host ('Watching the window in front for ' + $Minutes + ' minutes. Ctrl+C stops it early.')
  $until = (Get-Date).AddMinutes($Minutes)
  try {
    $broken = $false
    while (-not $broken -and (Get-Date) -lt $until) {
      try {
        [WitnessFocusWatch]::Pump(1000)
        foreach ($e in [WitnessFocusWatch]::Drain()) {
          Write-Line ([ordered]@{ at = $e[0]; event = 'focus'; 'process' = $e[1] })
          $count++
        }
      } catch {
        # The hook or its message pump failed: the watch cannot go on, and the end line says so.
        Write-Line ([ordered]@{ at = Get-Now; event = 'watch-error'; error = (Get-Why $_) })
        $broken = $true
      }
    }
    $finished = -not $broken
  } finally {
    try { [WitnessFocusWatch]::Stop() } catch { }
    try {
      foreach ($e in [WitnessFocusWatch]::Drain()) {
        Write-Line ([ordered]@{ at = $e[0]; event = 'focus'; 'process' = $e[1] })
        $count++
      }
    } catch { }
    $last = [ordered]@{ at = Get-Now; event = 'focus-end'; how = $(if ($finished) { 'done' } else { 'stopped early (Ctrl+C, or an error above)' }); changes = $count; 'process' = $null }
    try { $last['process'] = [WitnessFocusWatch]::ForegroundProcess() } catch { $last['error'] = Get-Why $_ }
    Write-Line $last
  }
}
