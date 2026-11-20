# Prompt: set up and run witness's Windows check

You are helping a developer prove, on their own Windows PC, that **witness** (a CLI they build;
npm package `@popovych.co/witness`) can run entirely inside a Windows VM on that PC. Their app,
**LowPro** (a Tauri desktop app in their `wot-mod-manager` repo), has a client test suite that
installs a test build (`lowpro-test.exe`) and drives its window, tray icon, toasts and installer.
Today those tests open on the developer's own screen while witness works (issue #76 in
`popovych-co/witness`). The plan: the clone, witness, the agent harness and every test run live
in a VM, so the app opens on the VM's screen and never on theirs. This check measures whether
that holds. Nothing is set up yet: no VM, and possibly no VirtualBox.

Your job: set things up with the developer, walk them through the measurements, and collect the
results. You do not change witness, LowPro, or the design. A failed measurement is a result, not
a problem to work around.

This folder holds:

- `README.md`: the steps in plain words, for the developer. Its numbered steps 1 to 8 are the
  measurements; Part 7 below fills them in.
- `vm.ps1`: runs inside the VM. Every 2 s it logs the console session, the input desktop, the
  screen size, input idle time, powercfg's display timeout and whether a screenshot is all black;
  `-RunAfter "120,3600" -Command "<cmd>"` also runs a command at those delays (seconds) and logs
  each run's exit code and output tail. Log: `%USERPROFILE%\witness-vm-check.jsonl`.
- `pc.ps1`: runs on the PC. `-WatchFocus -Minutes <n>` logs every program that comes to the front
  (process name only); `-Host` logs Hyper-V's enhanced session setting. Log:
  `%USERPROFILE%\witness-pc-check.jsonl`.

Run either script as
`powershell -NoProfile -ExecutionPolicy Bypass -File <script> <options>`: that bypasses the
execution policy (and the downloaded-file mark) for that one process and changes no setting. (If
the machine's policy is already RemoteSigned, `Unblock-File` on the two `.ps1` files works too.)
Do not change the machine's execution policy.

## Where you are

You may be running on the PC, or (later) inside the VM. Check:
`(Get-CimInstance Win32_ComputerSystem).Model` reads `VirtualBox` in a VirtualBox VM and
`Virtual Machine` in a Hyper-V VM.

- **On the PC** you do Parts 1, 2 (or 2H), 4, and the PC side of Part 7.
- **Inside the VM** you do Parts 3, 5, 6, and the VM side of Part 7.

The VM's shared clipboard and drag-and-drop stay off (part of what is checked), so nothing typed
on the PC reaches the VM. For the in-VM parts, either the developer types the commands, or, once
the VM has a browser, they install Claude Code there (witness's gates need it in the VM anyway,
Part 5) and give it this file from the shared folder. An agent in the VM runs in a terminal on
the VM's own desktop, never over SSH.

## Ground rules

**The developer acts here; you prepare and wait:**

- every administrator (UAC) prompt, on the PC and in the VM;
- the memory integrity choice (Part 2.1);
- Windows setup in the VM: its license key and activation (the VM needs its own license), and
  its user account;
- the VM account's password, typed by them into Autologon (Part 3). Never ask for it, never put
  it in a command, a file or the registry;
- every sign-in: GitHub (`gh auth login`), the agent harness's model provider, Claude Code;
- opening and closing the VM's window, and starting `vm.ps1` and `pc.ps1 -WatchFocus` in their
  own PowerShell windows;
- playing the online match, and noting frame rate, ping and sound;
- which ignored files to copy into the VM (they may hold secrets);
- whether to run step 8 at all (drive runs paid agent sessions).

**Ask first, saying what and why in plain words, and wait for a yes:** installing anything;
enabling a Windows feature; a reboot; a big download (the Windows 11 ISO is about 7 GB, the
Visual Studio build tools several GB); creating the VM or changing its settings; changing a PC
setting (sleep); deleting the app's build folder; running `witness init` in the clone (it may
restamp and commit); turning autonomy on (a committed config change); starting `witness drive`.

**Administrator steps this setup names** (each still needs the developer's yes and their UAC
click): installing VirtualBox and its Visual C++ runtime; enabling the Windows Hypervisor Platform
(Part 2.1); on the Hyper-V route, enabling Hyper-V, creating and configuring the VM,
`Set-VMHost`, `pc.ps1 -Host`, `Copy-VMFile`; in the VM, the Guest Additions, Autologon,
`DisableAutomaticRestartSignOn`, and the developer tools' installers (Part 5); PresentMon, if
used. Any other step that needs administrator rights: stop, explain why it is needed, and ask.

**Never:**

- run `vm.ps1` elevated, or from your own tool calls: the developer starts it in its own
  PowerShell window on the VM's desktop (your tool calls time out and would end it; and the check
  is about the normal signed-in user). The same for `pc.ps1 -WatchFocus` on the PC;
- reach into the VM over SSH or Remote Desktop, or run its tests from a remote shell (SSH runs
  programs in Session 0, which has no desktop; Remote Desktop disconnects the console);
- turn the VM's clipboard, drag-and-drop, audio or USB on for convenience;
- push to any remote, or edit LowPro's or witness's code;
- work around a measurement that fails: report it as it happened.

## Part 1: what this PC has (on the PC)

```powershell
Get-ComputerInfo -Property OsName, OsVersion, CsNumberOfLogicalProcessors, CsTotalPhysicalMemory, HyperVisorPresent, HyperVRequirementVirtualizationFirmwareEnabled
Get-PSDrive C
Get-CimInstance -Namespace root\Microsoft\Windows\DeviceGuard -ClassName Win32_DeviceGuard | Select-Object SecurityServicesRunning
```

`SecurityServicesRunning` containing `2` means memory integrity is running. (If that query is
refused, read it in Windows Security → Device security → Core isolation details.)

- **Windows Home:** VirtualBox, Part 2. (The developer's PC is Home.)
- **Windows Pro, Enterprise or Education:** VirtualBox works too; Hyper-V is Part 2H. Ask which.
- The VM needs about 120 GB free on disk (Rust build output is large). Firmware virtualization
  must be on; if it is off, tell the developer: it is a BIOS/UEFI setting only they can change.

Report these facts in plain words before going on.

## Part 2: the VM, with VirtualBox (on the PC)

### 2.1 Memory integrity, the developer's choice, made first

Windows 11 turns memory integrity on by default. With it on, VirtualBox "might fall back to a
slower, emulated mode": it runs on the Windows Hypervisor Platform. Explain both choices and let
the developer pick:

- **Off** (Windows Security → Device security → Core isolation details → Memory integrity; a
  reboot): VirtualBox runs at full speed. Updates can turn it back on, so it is checked again
  after them.
- **On:** VirtualBox runs on the Windows Hypervisor Platform, slower. That needs the optional
  feature, if `HyperVisorPresent` is true:
  `Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All` (administrator,
  reboot).
- Some games' anti-cheat wants memory integrity on (W6). If neither choice is fast enough
  (W11), the fallback is Windows 11 Pro with Hyper-V.

Record the choice: it is the first thing the developer brings back.

### 2.2 Install VirtualBox 7

`winget install --id Oracle.VirtualBox -e` (administrator prompt). If the installer asks for the
Visual C++ runtime: `winget install --id Microsoft.VCRedist.2015+.x64 -e`. Below,
`$vbox = "$env:ProgramFiles\Oracle\VirtualBox\VBoxManage.exe"`.

In the VirtualBox Manager: File → Preferences → Update → untick the update check. The Manager
stays closed from then on, except where a step says to open it.

### 2.3 Create the VM

1. Ask, then download the Windows 11 ISO from https://www.microsoft.com/software-download/windows11
   ("Download Windows 11 Disk Image (ISO) for x64 devices").
2. Manager → Machine → New: name `witness-vm` (used below), the ISO, type Windows 11 (64-bit),
   and tick **Skip Unattended Installation** so the developer goes through Windows setup
   themselves. VirtualBox 7 gives a Windows 11 VM EFI, a TPM 2.0 and Secure Boot; check them in
   Settings → System afterwards. Disk: 120 GB, dynamically allocated.
3. Agree the VM's fixed share with the developer, from Part 1's facts: enough cores and memory
   for a Rust build, while the game keeps its frame rate. A start: 4 virtual CPUs and 8 GB on a
   PC with 16 logical processors and 32 GB.
4. With the VM powered off:
   ```powershell
   & $vbox modifyvm witness-vm --cpus 4 --memory 8192 --nic1 nat --audio-enabled off --clipboard-mode disabled --drag-and-drop disabled --usb-ohci off --usb-ehci off --usb-xhci off --graphicscontroller vboxsvga --vram 128 --accelerate-3d off
   & $vbox setextradata witness-vm GUI/AutoresizeGuest false
   & $vbox setextradata witness-vm GUI/Scale true
   ```
   These are VirtualBox 7 spellings; if one is refused, `& $vbox modifyvm --help` has this
   version's, or set it in Settings (Audio; General → Advanced; USB; Display; Network). The VM
   has no USB controller, so no USB filters. 3D acceleration stays off, so the VM never touches
   the GPU the game uses; WebView2 renders in software there, as the design expects.
5. Optional, only if the VM's downloads hurt the developer's ping: a bandwidth group,
   `& $vbox bandwidthctl witness-vm add net --type network --limit 20m` and
   `& $vbox modifyvm witness-vm --nic-bandwidth-group1 net`.

### 2.4 Windows in the VM

Start it with a window for setup: `& $vbox startvm witness-vm`. The developer goes through
Windows setup: license key, account. Prefer a local account with a password (automatic sign-in,
Part 3, is simplest with one). If setup insists on a Microsoft account, tell the developer and
let them decide.

Then the Guest Additions: in the VM's window, Devices → Insert Guest Additions CD image; in the
VM, run `VBoxWindowsAdditions.exe` from that drive (administrator prompt in the VM), and restart
the VM.

### 2.5 The shared folder for this check

With the VM powered off:

```powershell
& $vbox sharedfolder add witness-vm --name witness-vm-check --hostpath "<this folder's full path>" --automount
```

In the VM it is `\\VBoxSvr\witness-vm-check` (and a drive letter). The scripts go to
`C:\witness-vm-check`, and the logs come back the same way, with these run in the VM:

```powershell
New-Item -ItemType Directory -Force C:\witness-vm-check | Out-Null
Copy-Item \\VBoxSvr\witness-vm-check\* C:\witness-vm-check\
# at the end:
Copy-Item $env:USERPROFILE\witness-vm-check.jsonl \\VBoxSvr\witness-vm-check\
```

### 2.6 Start it headless, and pin its screen

From now on the VM runs headless, so no VirtualBox window exists on the PC (VirtualBox's
detachable start is experimental; do not use it):

```powershell
& $vbox startvm witness-vm --type headless
# once Windows in the VM has signed in, about two minutes later:
& $vbox controlvm witness-vm setvideomodehint 1920 1080 32
```

Make the developer a small `.cmd` or `.ps1` on their desktop that does both, with a wait between,
and say the size is set again after every start. To look at the VM: Manager → the VM → **Show**;
to close the window, its **X** → **Continue running in the background**; then close the Manager.
In the window's View menu, Scaled Mode is on and Auto-resize Guest Display is off.

Find VirtualBox's engine (W11):

```powershell
Select-String -Path "$env:USERPROFILE\VirtualBox VMs\witness-vm\Logs\VBox.log" -Pattern 'HMR3Init|NEM:' | Select-Object -First 8
```

Lines about falling back to NEM mean it runs on the Windows Hypervisor Platform (the window's
status bar shows a green turtle then).

## Part 2H: the VM, with Hyper-V (on a Pro PC, if the developer chose it)

All administrator steps:

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All   # reboot
New-VM -Name witness-vm -Generation 2 -MemoryStartupBytes 8GB -NewVHDPath "$env:PUBLIC\Documents\Hyper-V\Virtual hard disks\witness-vm.vhdx" -NewVHDSizeBytes 120GB -SwitchName 'Default Switch'
Set-VMMemory -VMName witness-vm -DynamicMemoryEnabled $false -StartupBytes 8GB
Set-VMProcessor -VMName witness-vm -Count 4
Set-VMKeyProtector -VMName witness-vm -NewLocalKeyProtector
Enable-VMTPM -VMName witness-vm
Add-VMDvdDrive -VMName witness-vm -Path '<the Windows 11 ISO>'
Set-VMFirmware -VMName witness-vm -FirstBootDevice (Get-VMDvdDrive -VMName witness-vm)
Set-VMVideo -VMName witness-vm -ResolutionType Single -HorizontalResolution 1920 -VerticalResolution 1080
Set-VM -Name witness-vm -AutomaticCheckpointsEnabled $false
Set-VMHost -EnableEnhancedSessionMode $false
```

- A basic session on the Default Switch. Enhanced sessions stay off on the host: an enhanced
  session is Remote-Desktop-based, and closing its window disconnects Windows inside, so the app
  tests lose their screen (W2). Never Remote Desktop into the guest, for the same reason.
- Look at the VM with VMConnect (Hyper-V Manager → Connect). It must open straight onto the
  screen, with no display-size dialog first. Closing it leaves the VM running.
- Copy the check in: `Enable-VMIntegrationService -VMName witness-vm -Name 'Guest Service Interface'`,
  then for each file
  `Copy-VMFile -Name witness-vm -SourcePath '<this folder>\vm.ps1' -DestinationPath 'C:\witness-vm-check\vm.ps1' -CreateFullPath -FileSource Host`.
  Hyper-V has no copy back out: ask the developer how the VM's log should reach the PC (a share
  on the PC, or their own way).
- Memory integrity and `VBox.log` do not apply.

## Part 3: inside the VM, it never locks and signs in by itself (in the VM)

- **Display never off, no lock on idle:**
  ```powershell
  powercfg /change monitor-timeout-ac 0
  powercfg /change monitor-timeout-dc 0
  powercfg /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
  powercfg /setdcvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
  powercfg /setactive SCHEME_CURRENT
  ```
  and in Settings → Accounts → Sign-in options: "If you've been away, when should Windows require
  you to sign in again?" → Never; Dynamic lock off.
- **No screen saver:** `control desk.cpl,,@screensaver` → (None).
- **Automatic sign-in** (AutoAdminLogon): Microsoft's Sysinternals Autologon
  (https://learn.microsoft.com/sysinternals/downloads/autologon, or
  `winget install --id Microsoft.Sysinternals.Autologon -e`). The developer runs it (administrator
  prompt), types the user name and password themselves, and clicks Enable; it stores the password
  encrypted. With a Microsoft account, first turn off Settings → Accounts → Sign-in options →
  "For improved security, only allow Windows Hello sign-in for Microsoft accounts".
- **No sign-in-and-lock after an update restart** (administrator):
  ```powershell
  reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v DisableAutomaticRestartSignOn /t REG_DWORD /d 1 /f
  ```
  An update restart's own sign-in leaves the session locked; this turns it off, and Autologon
  signs in unlocked instead (W7).
- **Active hours:** Settings → Windows Update → Advanced options → Active hours → Manually, set
  to cover the hours drive will work (ask; at most 18 hours), so updates restart it outside them.
- The VM's sleep: witness's keep-awake holds it while drive works (never the display), and
  `vm.ps1` holds it the same way during the check. Leave the VM's sleep setting alone.
- Check: run `vm.ps1 -Minutes 1` (the developer starts it). Its `start` line's `setup` should
  read `autoAdminLogon` `"1"`, `disableAutomaticRestartSignOn` 1, `inactivityLockS` null or 0,
  `screenSaver` null, `signInOnWake` 0; its samples `displayTimeoutS` 0 and `width`/`height`
  1920/1080. (`screenSaverActive` can read `"1"` with no screen saver set; `screenSaver` is what
  counts.)

## Part 4: the PC stays awake (on the PC)

Witness's keep-awake runs inside the VM and cannot hold the PC, and VirtualBox pauses its VMs
when the PC sleeps. With the developer's yes, for the check and the hours drive works:

```powershell
powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE   # note the current value, to restore later
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

## Part 5: what the VM holds (in the VM)

Ask before each install; most raise an administrator prompt in the VM. If a winget id has moved,
`winget search` finds it.

1. **Tools LowPro's suite needs.** Read the clone's README, `package.json` (`packageManager`,
   `engines`), `.nvmrc` / `.node-version` and `rust-toolchain.toml` once it is cloned, and match
   the versions on the developer's PC (issue #76: Node 26.8.1).
   ```powershell
   winget install --id Git.Git -e
   winget install --id GitHub.cli -e
   winget install --id OpenJS.NodeJS -e          # or the version the repo pins
   npm install -g pnpm@<the packageManager version>   # Node 25+ ships no corepack
   winget install --id Rustlang.Rustup -e
   winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```
   WebView2 comes with Windows 11; check it is there (Settings → Apps → "Microsoft Edge WebView2
   Runtime").
2. **git and GitHub.** `git config --global user.name` / `user.email` with the developer's values
   (the same as on their PC). Then `gh auth login` (the developer signs in, in the VM's browser)
   and `gh auth setup-git`, so git uses gh's token and never raises a login dialog: nobody is there
   to answer one, and witness's git calls wait without a timeout.
3. **The clone.** Ask for the repo's URL (or read it from the PC's clone:
   `git -C <the PC's clone> remote get-url origin`). Clone to a short path:
   `gh repo clone <owner>/wot-mod-manager C:\src\wot-mod-manager`. Then whatever its suite reads
   that git does not carry: `git lfs pull` if it uses LFS; `git submodule update --init --recursive`
   if it has submodules; ignored files such as `.env.test`, which the developer copies through
   the shared folder (`git status --ignored --short` in the PC's clone lists candidates; ask
   which). Then `pnpm install`.
4. **The agent harness and Claude Code.** wot-mod-manager runs witness on Pi (issue #76; confirm
   in its witness setup). Install the harness the way it is installed on the PC; the developer
   signs in to its model provider. Install Claude Code as well: witness's gates spawn the `claude`
   CLI for every reviewer, whatever the harness. The developer signs in.
5. **witness**, at npm's `latest`:
   ```powershell
   npm install -g @popovych.co/witness
   $v = npm view @popovych.co/witness version
   npx skills@latest add "https://registry.npmjs.org/@popovych.co/witness/-/witness-$v.tgz"
   # choose the harness, then GLOBAL scope
   ```
   Then the harness's add-on: on Pi, the witness extension, which `witness init --agent pi`
   installs (run in the clone; ask first, since it may restamp files and commit; never push); on
   Claude Code, the witness-context plugin:
   `claude plugin marketplace add popovych-co/witness` then
   `claude plugin install witness-context@witness`. Finish with `witness check` in the clone and
   report what it says.
6. Optional: `notify:` in the clone's `.witness/config.local.yaml` can send drive's summary to the
   developer's phone instead of a notification inside the VM. Ask.

How witness will run there, for the developer: drive starts from a terminal on the VM's own
desktop (`witness drive`, or `witness drive --detach` to close the terminal; detach needs
autonomy on and refuses `detach-needs-autonomy` otherwise); never over SSH; a restart of the VM
ends drive, and they start it again; they talk to witness in the VM's window when they choose.
One clone drives: a clone on the PC may read the repo but never drives it.

## Part 6: the app's test command (in the VM)

- Find LowPro's client test command in the clone (its README, the root and client
  `package.json` scripts): the suite that installs `lowpro-test.exe` and drives its window, tray,
  toasts and installer. **Confirm it with the developer** before step 3 of README.
- It must run once and exit. `vm.ps1` gives it an empty stdin, so vitest does not start watching,
  but prefer an explicit `vitest run` form if the scripts offer one.
- `vm.ps1` runs it as `cmd /d /s /c "<command>"` in the folder `vm.ps1` was started from (or
  `-WorkDir`). If it needs a build first (`lowpro-test.exe`), or quotes, or several commands, put
  them in `C:\witness-vm-check\client-tests.cmd` and pass that path as `-Command`.
- The cold build for README step 3: find the build output the suite reuses (the Tauri crate's
  `target` folder; `cargo clean` there) and, with the developer's yes, empty it just before step 3.

## Part 7: the measurements

README's steps, filled in. The developer starts each script in its own PowerShell window; you
tell them what to type and when.

1. **Setup (W11, W6).** Parts 1 to 5. Record memory integrity on/off and the VM's cores and
   memory.
2. **First build, timed (W11).** In the VM, in the clone's folder:
   `powershell -NoProfile -ExecutionPolicy Bypass -File C:\witness-vm-check\vm.ps1 -Minutes 1 -RunAfter 0 -Command "<the test command>"`.
   It stops when the run ends; its `run-end` line has `seconds` and `exit`. Then, on the PC, the
   `VBox.log` lines (Part 2.6).
3. **The long check (W1, W4).** Empty the build output (Part 6). In the VM, in the clone's
   folder:
   `powershell -NoProfile -ExecutionPolicy Bypass -File C:\witness-vm-check\vm.ps1 -Minutes 90 -RunAfter "120,3600" -Command "<the test command>"`.
   The developer closes the VM's window within 2 minutes (X → Continue running in the
   background) and closes the Manager. The tests run at 2 and at 60 minutes; sampling continues
   every 2 s throughout, and past 90 minutes if the second run is still going.
4. **The PC side (W5, W6).** On the PC, in this folder:
   `powershell -NoProfile -ExecutionPolicy Bypass -File .\pc.ps1 -WatchFocus -Minutes 90`.
   The developer plays an online match while the first run builds and tests (from 2 minutes),
   noting pop-ups, focus changes, sound, frame rate and ping busy and idle. PresentMon, if they
   have it (it needs administrator rights): about a minute busy and a minute idle, for example
   `PresentMon.exe --process_name <game>.exe --output_file busy.csv --timed 60 --terminate_after_timed`
   (flag spellings differ between PresentMon versions; `--help` lists them).
5. **The window, opened once (W12).** After the match: Manager → Show, about a minute, no mouse
   over the VM's screen, then X → Continue running in the background, Manager closed.
6. **Hands off (W1).** Nobody touches the VM until the end; the second run (60 minutes) comes
   after an hour without input.
7. **Logs and later checks (W7).** Copy the VM's log out (Part 2.5) and take the PC's. After the
   VM's next Windows Update restart, and after the PC sleeps (Start → Power → Sleep) and wakes:
   open the VM's window, see whether it is at the desktop, signed in and unlocked; after the
   update restart, run `vm.ps1 -Minutes 1` once (its `bootedAt` shows the restart).
8. **drive, detached (W8).** Only with the developer's yes: autonomy must be on in wot-mod-manager
   (a committed setting; ask before changing it), and drive needs work to do; it runs paid agent
   sessions. In the VM: `vm.ps1 -Minutes 60` in one PowerShell window; in a second terminal on the
   VM's desktop, in the clone, `witness drive --detach`, then close that terminal and the VM's
   window. Later, read `.witness\drive.log`: drive kept working, and the app tests it ran passed.

On a Hyper-V PC, also: `pc.ps1 -Host` in an administrator PowerShell on the PC (W2), and whether
VMConnect opened straight onto the screen.

## Part 8: what to bring back, and how to read it

Give the developer one message to paste back, with:

1. Part 1's facts; memory integrity on or off; the VM's cores and memory.
2. The first build: `seconds` and `exit`; the `VBox.log` lines.
3. `witness-vm-check.jsonl` from the VM and `witness-pc-check.jsonl` from the PC, whole.
4. The match: ran or not; pop-ups, focus changes, sound; frame rate and ping busy and idle;
   PresentMon's numbers if any.
5. When the window was opened in step 5.
6. W7's two answers; W8's answer and the end of `drive.log` (or "not run").
7. On Hyper-V: the `-Host` line and the VMConnect answer.
8. Anything that went wrong, step by step.
9. Your reading of each W against README's "What decides", quoting the log lines that show it.

Reading the VM's log:

- `sample` lines: `console` should equal `session` (4294967295 means no console session at all);
  `inputDesktop` `"Default"` is a live screen, and null with "Windows error 5" in `error` means
  the lock screen or a UAC prompt held it; `width`/`height` 1920/1080; `displayTimeoutS` 0;
  `black` false. A null field has its reason in `error`; a screenshot that fails with "The handle
  is invalid" means the VM had no live screen: that is a W1 result, not a script fault.
- `idleMs` at the second run's start should be close to an hour. If it is much lower, something
  touched the VM (the mouse over the window in step 5, or the tests themselves sending input):
  say which.
- `run-start` / `run-end`: one pair per run; `run-due` means a delay came due while the previous
  run was still going (it then starts after); `overtime` means the 90 minutes ended during a run;
  `run-skipped` means a delay came after the end. The full output of each run is in the files its
  `out` and `err` name, under `witness-vm-check-runs\` beside the log.
- `start`: `elevated` must be false; `holdsSleep` true; `dpiAware` true (if it is false and the
  VM's display scale is above 100%, the sizes may read scaled: report the scale).

Reading the PC's log: each `focus` line names the program that came to the front. Only the game
and windows the developer opened themselves may appear. Any `VirtualBox`, `VirtualBoxVM`,
`VBoxHeadless`, `VBoxSVC` or LowPro name, or anything the developer did not open, is a W5
failure. The `start` line records memory integrity, whether a hypervisor runs, and the PC's sleep
timeout.
