<#
.SYNOPSIS
  witness's Windows check, the VM side (row 246, issue #76). Run it INSIDE the VM, on the VM's own
  desktop, as the signed-in user, in a normal PowerShell window (not "Run as administrator").

.DESCRIPTION
  Every 2 seconds, for -Minutes, it writes one JSON line (event "sample") to the log and to the
  screen:
    at               the time
    session          this script's Windows session
    console          the session that owns the VM's screen (WTSGetActiveConsoleSessionId);
                     on a live screen it equals session
    inputDesktop     the desktop that takes input (OpenInputDesktop + GetUserObjectInformation):
                     "Default" when the screen is live; "Winlogon", or null with an error, while
                     the screen is locked or a UAC prompt is up
    width, height    the screen's size in pixels (GetSystemMetrics 0 and 1)
    idleMs           how long since the last keyboard or mouse input (GetLastInputInfo)
    displayTimeoutS  powercfg's "turn off the display after", plugged in; 0 means never
    black            whether a screenshot of the whole screen is all black
  A field that cannot be read is null, and the line's "error" says why; sampling goes on.

  -RunAfter "120,3600" -Command "<cmd>"
    runs <cmd> through cmd.exe, in -WorkDir, once at each of those delays (seconds from the
    start), while sampling goes on. Each run writes a "run-start" line and a "run-end" line with
    its start, end, seconds, exit code and the last lines it printed; its whole output is kept in
    files beside the log. A run still going when the next delay comes due is waited for, then the
    next run starts. When -Minutes end with a run still going, sampling goes on until it ends.
    The command's stdin is an empty file, so a test runner does not start in watch mode.

  While it runs it holds the VM's sleep the way witness's drive does (SetThreadExecutionState with
  ES_CONTINUOUS | ES_SYSTEM_REQUIRED), never its display: whether the display stays on is left to
  the VM's own settings, which is what the check measures.

  It writes only its log and the runs' output files, and changes no setting. It never reads a
  password.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\witness-vm-check\vm.ps1 -Minutes 90 -RunAfter "120,3600" -Command "<the app's client tests>"
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\witness-vm-check\vm.ps1 -Minutes 5
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [ValidateRange(1, 1440)][int]$Minutes = 90,
  # Seconds from the start: -RunAfter "120,3600" (quoted, so powershell -File passes it whole).
  [string[]]$RunAfter = @(),
  [string]$Command = '',
  [string]$WorkDir = (Get-Location -PSProvider FileSystem).ProviderPath,
  [string]$Log = (Join-Path $env:USERPROFILE 'witness-vm-check.jsonl')
)

$ErrorActionPreference = 'Stop'
$Log = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Log)
$utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
# A screenshot whose brightest red, green or blue value is at most this counts as all black.
$BlackAt = 16

# ---------------------------------------------------------------------------------------------
# Usage

$delays = @()
foreach ($part in @($RunAfter)) {
  foreach ($piece in ([string]$part -split '[,\s]+')) {
    if ($piece -eq '') { continue }
    $seconds = 0
    if (-not [int]::TryParse($piece, [ref]$seconds) -or $seconds -lt 0) {
      throw ("-RunAfter takes whole seconds, like -RunAfter ""120,3600""; got '" + $piece + "'")
    }
    $delays += $seconds
  }
}
$delays = @($delays | Sort-Object)
if ($Command -eq '' -and $delays.Count -gt 0) { throw '-RunAfter needs -Command "<what to run>"' }
if ($Command -ne '' -and $delays.Count -eq 0) { $delays = @(0) }
if ($Command -ne '' -and -not (Test-Path -LiteralPath $WorkDir -PathType Container)) {
  throw ("-WorkDir is not a folder: " + $WorkDir)
}

# ---------------------------------------------------------------------------------------------
# Windows calls

if (-not ('WitnessVmCheck' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WitnessVmCheck
{
    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [DllImport("kernel32.dll")] private static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("kernel32.dll")] private static extern uint GetTickCount();
    [DllImport("kernel32.dll")] private static extern uint SetThreadExecutionState(uint esFlags);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

    public static uint ConsoleSession() { return WTSGetActiveConsoleSessionId(); }

    // The name of the desktop that takes input now. DESKTOP_READOBJECTS is all it asks for.
    public static string InputDesktop()
    {
        IntPtr desk = OpenInputDesktop(0, false, 0x0001);
        if (desk == IntPtr.Zero)
        {
            int code = Marshal.GetLastWin32Error();
            string hint = code == 5 ? " (access denied: the lock screen or a UAC prompt holds the screen)" : "";
            throw new InvalidOperationException("OpenInputDesktop failed with Windows error " + code + hint);
        }
        try
        {
            StringBuilder name = new StringBuilder(256);
            int needed;
            if (!GetUserObjectInformation(desk, 2, name, name.Capacity * 2, out needed))
                throw new InvalidOperationException("GetUserObjectInformation failed with Windows error " + Marshal.GetLastWin32Error());
            return name.ToString();
        }
        finally { CloseDesktop(desk); }
    }

    public static int Metric(int index)
    {
        int value = GetSystemMetrics(index);
        if (value == 0) throw new InvalidOperationException("GetSystemMetrics(" + index + ") returned 0");
        return value;
    }

    public static long IdleMs()
    {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref info))
            throw new InvalidOperationException("GetLastInputInfo failed with Windows error " + Marshal.GetLastWin32Error());
        return (long)unchecked(GetTickCount() - info.dwTime);
    }

    // Physical pixels from GetSystemMetrics and the screenshot, whatever the display scale.
    public static bool DpiAware() { return SetProcessDPIAware(); }

    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, as witness's keep-awake: the sleep only, never the display.
    public static bool HoldSleep(bool hold)
    {
        return SetThreadExecutionState(hold ? 0x80000001u : 0x80000000u) != 0;
    }

    // The brightest red, green or blue value in 32-bit BGRA pixels.
    public static int Brightest(byte[] bgra)
    {
        int max = 0;
        for (int i = 0; i + 2 < bgra.Length; i += 4)
        {
            if (bgra[i] > max) max = bgra[i];
            if (bgra[i + 1] > max) max = bgra[i + 1];
            if (bgra[i + 2] > max) max = bgra[i + 2];
            if (max == 255) break;
        }
        return max;
    }
}
'@
}

$drawingError = $null
try { Add-Type -AssemblyName System.Drawing } catch { $drawingError = $_ }

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

# A registry value, or null when it is not set. Never used for a password.
function Get-Reg([string]$path, [string]$name) {
  try { return (Get-ItemProperty -LiteralPath $path -Name $name -ErrorAction Stop).$name } catch { return $null }
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

function Test-Black($width, $height) {
  if ($null -ne $script:drawingError) { throw ('System.Drawing did not load: ' + (Get-Why $script:drawingError)) }
  if (-not $width -or -not $height) { throw 'no screen size to capture' }
  $w = [int]$width
  $h = [int]$height
  $bitmap = New-Object System.Drawing.Bitmap -ArgumentList $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try { $graphics.CopyFromScreen(0, 0, 0, 0, $bitmap.Size) } finally { $graphics.Dispose() }
    $rect = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $w, $h
    $data = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $bytes = New-Object byte[] ([Math]::Abs($data.Stride) * $h)
      [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
    } finally { $bitmap.UnlockBits($data) }
  } finally { $bitmap.Dispose() }
  return ([WitnessVmCheck]::Brightest($bytes) -le $script:BlackAt)
}

function New-Sample {
  $s = [ordered]@{}
  $why = [ordered]@{}
  $s['at'] = Get-Now
  $s['event'] = 'sample'
  $s['session'] = $script:session
  try { $s['console'] = [WitnessVmCheck]::ConsoleSession() } catch { $s['console'] = $null; $why['console'] = Get-Why $_ }
  try { $s['inputDesktop'] = [WitnessVmCheck]::InputDesktop() } catch { $s['inputDesktop'] = $null; $why['inputDesktop'] = Get-Why $_ }
  try { $s['width'] = [WitnessVmCheck]::Metric(0) } catch { $s['width'] = $null; $why['width'] = Get-Why $_ }
  try { $s['height'] = [WitnessVmCheck]::Metric(1) } catch { $s['height'] = $null; $why['height'] = Get-Why $_ }
  try { $s['idleMs'] = [WitnessVmCheck]::IdleMs() } catch { $s['idleMs'] = $null; $why['idleMs'] = Get-Why $_ }
  try { $s['displayTimeoutS'] = Get-PowerValue 'SUB_VIDEO' 'VIDEOIDLE' } catch { $s['displayTimeoutS'] = $null; $why['displayTimeoutS'] = Get-Why $_ }
  try { $s['black'] = Test-Black $s['width'] $s['height'] } catch { $s['black'] = $null; $why['black'] = Get-Why $_ }
  if ($why.Count -gt 0) { $s['error'] = $why }
  return $s
}

function Get-Tail([string]$path, [int]$lines) {
  if (-not (Test-Path -LiteralPath $path)) { return '' }
  $text = (Get-Content -LiteralPath $path -Tail $lines -Encoding UTF8) -join "`n"
  # Colour codes make the tail hard to read; the full output keeps them.
  return ($text -replace '\x1b\[[0-9;?]*[ -/]*[@-~]', '')
}

function Start-Run([int]$n, [int]$delay) {
  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $out = Join-Path $script:runDir ('{0}-run{1}.out.txt' -f $stamp, $n)
  $err = Join-Path $script:runDir ('{0}-run{1}.err.txt' -f $stamp, $n)
  $began = Get-Date
  $line = [ordered]@{ at = $began.ToString('o'); event = 'run-start'; run = $n; delayS = $delay; command = $script:Command; workDir = $script:WorkDir; out = $out; err = $err }
  try {
    # cmd /s /c "<cmd>" runs the command line as written, && and all.
    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList ('/d /s /c "' + $script:Command + '"') `
      -WorkingDirectory $script:WorkDir -NoNewWindow -PassThru `
      -RedirectStandardInput $script:emptyIn -RedirectStandardOutput $out -RedirectStandardError $err
    # Reading the handle now keeps ExitCode readable after the process exits (a Start-Process quirk).
    $null = $proc.Handle
    Write-Line $line
    return @{ n = $n; delay = $delay; 'process' = $proc; start = $began; out = $out; err = $err }
  } catch {
    $why = 'could not start: ' + (Get-Why $_)
    $line['error'] = $why
    Write-Line $line
    $ended = Get-Date
    Write-Line ([ordered]@{ at = $ended.ToString('o'); event = 'run-end'; run = $n; delayS = $delay; start = $began.ToString('o'); 'end' = $ended.ToString('o'); seconds = 0; 'exit' = $null; tail = ''; errTail = ''; out = $out; err = $err; error = $why })
    return $null
  }
}

function Complete-Run($run) {
  $ended = Get-Date
  $line = [ordered]@{
    at = $ended.ToString('o'); event = 'run-end'; run = $run.n; delayS = $run.delay
    start = $run.start.ToString('o'); 'end' = $ended.ToString('o')
    seconds = [Math]::Round(($ended - $run.start).TotalSeconds, 1)
    'exit' = $null; tail = $null; errTail = $null; out = $run.out; err = $run.err
  }
  $why = [ordered]@{}
  try {
    $line['exit'] = $run.process.ExitCode
    if ($null -eq $line['exit']) { $why['exit'] = 'the exit code could not be read' }
  } catch { $why['exit'] = Get-Why $_ }
  try { $line['tail'] = Get-Tail $run.out 40 } catch { $why['tail'] = Get-Why $_ }
  try { $line['errTail'] = Get-Tail $run.err 20 } catch { $why['errTail'] = Get-Why $_ }
  if ($why.Count -gt 0) { $line['error'] = $why }
  Write-Line $line
}

# ---------------------------------------------------------------------------------------------
# Start

$session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$principal = New-Object System.Security.Principal.WindowsPrincipal -ArgumentList ([System.Security.Principal.WindowsIdentity]::GetCurrent())
$elevated = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

$runDir = Join-Path (Split-Path -Parent $Log) 'witness-vm-check-runs'
$emptyIn = Join-Path $runDir 'empty-stdin.txt'
if ($delays.Count -gt 0) {
  $null = New-Item -ItemType Directory -Force -Path $runDir
  [System.IO.File]::WriteAllText($emptyIn, '', $utf8)
}

$startLine = [ordered]@{
  at = Get-Now; event = 'start'; script = 'vm.ps1'; minutes = $Minutes; runAfter = $delays
  command = $Command; workDir = $WorkDir; log = $Log; session = $session; elevated = $elevated
  powershell = $PSVersionTable.PSVersion.ToString(); computer = $env:COMPUTERNAME
}
$why = [ordered]@{}
try { $startLine['dpiAware'] = [WitnessVmCheck]::DpiAware() } catch { $startLine['dpiAware'] = $null; $why['dpiAware'] = Get-Why $_ }
try { $startLine['holdsSleep'] = [WitnessVmCheck]::HoldSleep($true) } catch { $startLine['holdsSleep'] = $null; $why['holdsSleep'] = Get-Why $_ }
try { $startLine['bootedAt'] = (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToString('o') } catch { $startLine['bootedAt'] = $null; $why['bootedAt'] = Get-Why $_ }

# How the VM is set up (design 4.4.2). Informational: the samples are what the check reads.
$setup = [ordered]@{
  autoAdminLogon = Get-Reg 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' 'AutoAdminLogon'
  disableAutomaticRestartSignOn = Get-Reg 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' 'DisableAutomaticRestartSignOn'
  inactivityLockS = Get-Reg 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' 'InactivityTimeoutSecs'
  screenSaverActive = Get-Reg 'HKCU:\Control Panel\Desktop' 'ScreenSaveActive'
  screenSaver = Get-Reg 'HKCU:\Control Panel\Desktop' 'SCRNSAVE.EXE'
  screenSaverSecure = Get-Reg 'HKCU:\Control Panel\Desktop' 'ScreenSaverIsSecure'
}
try { $setup['signInOnWake'] = Get-PowerValue 'SUB_NONE' 'CONSOLELOCK' } catch { $setup['signInOnWake'] = $null; $why['signInOnWake'] = Get-Why $_ }
try { $setup['sleepTimeoutS'] = Get-PowerValue 'SUB_SLEEP' 'STANDBYIDLE' } catch { $setup['sleepTimeoutS'] = $null; $why['sleepTimeoutS'] = Get-Why $_ }
$startLine['setup'] = $setup
if ($why.Count -gt 0) { $startLine['error'] = $why }
Write-Line $startLine

if ($elevated) {
  Write-Warning 'This PowerShell runs as administrator. The check is meant for the normal signed-in user: close it and start a normal PowerShell.'
}
if ($session -eq 0) {
  Write-Warning 'Session 0 has no desktop (an SSH or service session). Run this on the VM''s own desktop.'
}
foreach ($d in $delays) {
  if ($d -ge $Minutes * 60) { Write-Warning ('-RunAfter ' + $d + ' comes after -Minutes ' + $Minutes + ' end, so that run will not start.') }
}

# ---------------------------------------------------------------------------------------------
# Sample every 2 seconds; start each run when its delay comes due

$t0 = Get-Date
$deadline = $t0.AddMinutes($Minutes)
$nextTick = $t0
$nextRun = 0
$current = $null
$dueNoted = -1
$overNoted = $false
$finished = $false

try {
  while ($true) {
    $stop = $false
    try {
      $now = Get-Date
      $elapsed = ($now - $t0).TotalSeconds
      if ($null -ne $current -and $current.process.HasExited) {
        Complete-Run $current
        $current = $null
      }
      $over = $now -ge $deadline
      if ($over -and $null -eq $current) {
        $stop = $true
      } else {
        if ($over -and -not $overNoted) {
          Write-Line ([ordered]@{ at = Get-Now; event = 'overtime'; note = ('-Minutes have ended; sampling goes on until run ' + $current.n + ' ends') })
          $overNoted = $true
        }
        if (-not $over -and $nextRun -lt $delays.Count -and $elapsed -ge $delays[$nextRun]) {
          if ($null -eq $current) {
            $current = Start-Run ($nextRun + 1) $delays[$nextRun]
            $nextRun++
          } elseif ($dueNoted -ne $nextRun) {
            Write-Line ([ordered]@{ at = Get-Now; event = 'run-due'; run = ($nextRun + 1); waitingFor = $current.n })
            $dueNoted = $nextRun
          }
        }
        Write-Line (New-Sample)
      }
    } catch {
      Write-Line ([ordered]@{ at = Get-Now; event = 'loop-error'; error = (Get-Why $_) })
    }
    if ($stop) { break }
    $nextTick = $nextTick.AddSeconds(2)
    $waitMs = [int](($nextTick - (Get-Date)).TotalMilliseconds)
    if ($waitMs -gt 0) { Start-Sleep -Milliseconds $waitMs } else { $nextTick = Get-Date }
  }
  while ($nextRun -lt $delays.Count) {
    Write-Line ([ordered]@{ at = Get-Now; event = 'run-skipped'; run = ($nextRun + 1); delayS = $delays[$nextRun]; why = 'its delay came after -Minutes ended' })
    $nextRun++
  }
  $finished = $true
} finally {
  try { $null = [WitnessVmCheck]::HoldSleep($false) } catch { }
  $endLine = [ordered]@{ at = Get-Now; event = 'end'; how = $(if ($finished) { 'done' } else { 'stopped early (Ctrl+C, or an error above)' }) }
  if ($null -ne $current) { $endLine['runStillGoing'] = $current.n; $endLine['out'] = $current.out }
  Write-Line $endLine
}
