# The Windows check: witness inside a VM

This check proves one thing before witness's docs promise it: that all of witness's work on
wot-mod-manager can run inside a Windows VM on your PC, so LowPro's test windows, tray icon,
toasts and installer show up on the VM's screen and never on yours (issue #76).

It changes nothing in witness or in LowPro. Two small scripts watch and write logs; you do the
steps below and bring the results back.

You'll use **VirtualBox**, because your PC runs Windows Home. On Windows Pro, Hyper-V can be
used instead: see [With Hyper-V](#with-hyper-v) at the end.

**Nothing set up yet?** Give `AGENT.md` to an AI agent on your PC (for example, a Claude Code
session opened in this folder). It sets everything up with you, one step at a time, and asks
before it installs or changes anything.

## What's in this folder

| File | What it is |
| --- | --- |
| `README.md` | this guide |
| `AGENT.md` | the same check, written for an AI agent on your PC |
| `vm.ps1` | runs **inside the VM**: every 2 seconds it writes down whether the VM's screen is live, and it runs the app's tests at set times |
| `pc.ps1` | runs **on your PC**: it writes down every program that comes to the front of your screen (its name only, never a window title) |

## How to start a script

Windows won't run a downloaded script on its own. Start each one like this: it lets that one
PowerShell window run the script, and changes no setting on the computer.

```
powershell -NoProfile -ExecutionPolicy Bypass -File <the script> <its options>
```

In the VM the folder is `C:\witness-vm-check`. On your PC it's wherever you unzipped it.

Each script writes its log to your user folder (`C:\Users\<you>`): `witness-vm-check.jsonl` in
the VM, `witness-pc-check.jsonl` on your PC. Starting a script again adds to its log, so nothing
is lost. Ctrl+C stops a script early.

## The steps

### 1. Set the VM up (once)

1. **Memory integrity, first.** On your PC open Windows Security → Device security → Core
   isolation details, and write down whether **Memory integrity** is On or Off. It's your call:
   - **Off:** VirtualBox runs at full speed. Big Windows updates can turn it back on, so look
     again after them.
   - **On:** VirtualBox still works, but slower (it runs on the Windows Hypervisor Platform).
   - Some games' anti-cheat wants it On.

   If neither way is fast enough (step 2 tells you), the fallback is Windows 11 Pro with Hyper-V.
2. **The VM.** The agent sets it up with you so that:
   - it's a Windows 11 VM in VirtualBox 7, with its own Windows license (VirtualBox gives it the
     TPM 2.0 and Secure Boot Windows 11 needs);
   - it starts **headless**: no VirtualBox window on your screen. The VirtualBox Manager stays
     closed, with its update check off;
   - its screen is **pinned at 1920×1080**: the Guest Additions are installed, auto-resize is
     off, the size is set again after every start, and when you open its window it shows the
     screen scaled to fit;
   - its audio, shared clipboard, drag-and-drop and USB are off;
   - its network is NAT;
   - it gets a fixed number of processor cores and a fixed amount of memory, so your game keeps
     its share. (Its disk and network aren't capped by that; if its downloads hurt your ping, the
     agent can cap its download speed.)
3. **Inside the VM:**
   - it signs in by itself after any restart, unlocked: automatic sign-in is on, and Windows'
     "sign in and lock after an update" is off;
   - it never locks and never turns its display off: no lock when idle, no screen saver, and
     "turn off my screen after" set to Never;
   - its Windows Update **active hours** cover the hours witness will work, so updates restart it
     outside them.
4. **On your PC:** set sleep to **Never** for the check (and later, for the hours witness works
   in the VM): Settings → System → Power → "put my device to sleep after" → Never. When your PC
   sleeps, the VM stops too.

**Bring back:** memory integrity On or Off; how many cores and how much memory the VM got.

### 2. Put the app in the VM, and time its first build

1. In the VM, the agent installs what LowPro's client tests need (git, the GitHub CLI, Node,
   pnpm, Rust with the Visual Studio build tools; WebView2 comes with Windows 11). It sets git
   up with your name and your GitHub sign-in, so git never pops up a login window that nobody
   is there to answer. It clones wot-mod-manager and adds what git doesn't carry (files like
   `.env.test`, LFS files, submodules). It installs witness, its skills and its add-on for your
   agent, and Claude Code (witness's reviewers run on it). You sign in to GitHub and to your
   agent yourself.
2. Open the VM's window (VirtualBox Manager → the VM → **Show**). In PowerShell in the VM, in the
   clone's folder, run:
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File C:\witness-vm-check\vm.ps1 -Minutes 1 -RunAfter 0 -Command "<LowPro's client tests>"
   ```
   The agent tells you the test command to put in. This first run builds the app from scratch
   and then runs the suite. The script stops by itself when the tests end.
3. When it's done, look at the `run-end` line it printed: `exit` is `0` if the tests passed,
   and `seconds` is how long the build plus the suite took.
4. On your PC, in PowerShell, run this and copy what it prints (put your VM's name for `<vm>`):
   ```
   Select-String -Path "$env:USERPROFILE\VirtualBox VMs\<vm>\Logs\VBox.log" -Pattern 'HMR3Init|NEM:' | Select-Object -First 8
   ```
   It shows whether VirtualBox fell back to the slower Windows Hypervisor Platform. (You can see
   it in the VM's window too: a green turtle in its bottom bar means the slow way.)

**Bring back:** `seconds` and `exit` from the `run-end` line, and the lines step 4 printed (W11).

### 3. Start the long check in the VM

1. Just before this, the agent empties the app's build folder, so the first run builds from
   scratch again. That's the cold build you'll play through in step 4.
2. In the VM, in PowerShell in the clone's folder, run:
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File C:\witness-vm-check\vm.ps1 -Minutes 90 -RunAfter "120,3600" -Command "<LowPro's client tests>"
   ```
   It writes a line every 2 seconds for 90 minutes, and runs the tests twice by itself: 2
   minutes from now, and 60 minutes from now. Like witness, it keeps the VM from going to sleep,
   but not its display: whether the display stays on is up to the VM's own settings, and that's
   what it checks.
3. Within those 2 minutes, close the VM's window with its **X** and choose **Continue running in
   the background**. Close the VirtualBox Manager too. Nothing of the VM is on your screen now.

### 4. On your PC: watch your screen, and play

1. In PowerShell on your PC, in this folder, run:
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File .\pc.ps1 -WatchFocus -Minutes 90
   ```
   It writes down the name of every program that comes to the front.
2. Play an online match while the VM builds and runs the tests. (Task Manager on your PC shows
   the VM's CPU use: high while it builds and tests, near zero when it's idle.)
3. While you play, notice: does anything pop up, take the focus, or make a sound? Note the game's
   frame rate and ping (the game can show both) while the VM is busy, and again once it's idle.
4. If you have PresentMon, record about a minute of frame times with the VM busy, and a minute
   with it idle.

**Bring back:** did the match run normally (W6); anything that popped up or made a sound; frame
rate and ping, busy and idle; PresentMon's files if you made them (W5).

### 5. Midway: open the VM's window for one minute

After your match, open the VirtualBox Manager, pick the VM and click **Show**. The VM's screen
should appear scaled to the window. (If not: in the window's View menu, turn **Scaled Mode** on
and **Auto-resize Guest Display** off.) Don't click or move the mouse over the VM's screen.
After about a minute, close it again with its **X** → **Continue running in the background**,
and close the Manager.

**Bring back:** roughly when you opened and closed it (W12).

### 6. Leave the VM alone

Don't open the VM for the rest of the 90 minutes. One hour after step 3 the script runs the tests
again by itself, after an hour in which nobody touched the VM. That's the check that its screen
stays live with no window open (W1). Use your PC however you like meanwhile.

### 7. Collect the logs, then two later checks

1. When the 90 minutes are over (the PC's script prints a `focus-end` line, and the VM's script's
   last line has `"event":"end"`), collect both logs:
   - from the VM, `C:\Users\<you>\witness-vm-check.jsonl`: copy it into the shared folder the
     agent set up, and it lands on your PC;
   - from your PC, `C:\Users\<you>\witness-pc-check.jsonl`.
2. The next time **Windows Update restarts the VM** by itself (outside active hours; pressing
   "Restart now" on the VM's Windows Update page counts too), open the VM's window. Is it at the
   desktop, signed in and unlocked, without you typing anything? While it's open, run
   `vm.ps1 -Minutes 1` once (started the same way as above), then close the window.
3. Once, **put your PC to sleep** yourself (Start → Power → Sleep), wake it, and open the VM's
   window. Desktop, or a lock screen?

**Bring back:** both answers, and the VM's log again (W7).

### 8. witness drive, detached

This one runs real agent sessions (they use your plan's usage), and needs autonomy on in
wot-mod-manager and some work for drive to do. The agent asks you first; it's fine to leave it
for later.

1. Open the VM's window. In PowerShell on the VM's desktop, start the screen log on its own:
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File C:\witness-vm-check\vm.ps1 -Minutes 60
   ```
2. Open a second terminal on the VM's desktop (never over SSH or Remote Desktop), go to the
   clone's folder, run `witness drive --detach`, and close that terminal.
3. Close the VM's window.
4. Later, open it again and read `.witness\drive.log` in the clone: did drive keep working after
   its terminal closed, and did the app tests it ran pass on the VM's screen?

**Bring back:** yes or no, and the last 30 or so lines of `drive.log` (W8).

## What to bring back, all together

1. Memory integrity On or Off; the VM's cores and memory (step 1).
2. The first build: `seconds` and `exit`, and the `VBox.log` lines (step 2).
3. `witness-vm-check.jsonl` from the VM, whole.
4. `witness-pc-check.jsonl` from your PC, whole.
5. The match: did it run; anything that popped up or made a sound; frame rate and ping, busy and
   idle; PresentMon's files if any (step 4).
6. When you opened the VM's window (step 5).
7. After an update restart, and after your PC slept: signed in and unlocked, or not (step 7).
8. drive after its terminal closed: kept going or not, and the end of `drive.log` (step 8).
9. Anything else that looked wrong, and at which step.

## What decides

The plan holds only if all six of these hold. If any fails, the route changes before witness's
setup guide for VMs is written.

- **W1 – the VM's screen stays live.** In the VM's log, from step 3's start to the end of the
  second test run, every `sample` line taken with the window closed reads: `inputDesktop`
  `"Default"`; `console` the same number as `session`; `width` 1920 and `height` 1080;
  `displayTimeoutS` 0 (never); `black` false; and no `error`.
- **W4 – the tests pass.** Both of step 3's `run-end` lines show `"exit":0`.
- **W5 – your screen stays yours.** The PC's log names only your game and the windows you
  switched to yourself: nothing from VirtualBox, the VM or LowPro. Nothing popped up or made a
  sound, and the game kept its frame rate and ping while the VM was busy.
- **W6 – your game runs.** The online match ran, with VirtualBox installed, memory integrity as
  you set it, and the VM running.
- **W11 – it's fast enough.** The first build plus the suite (step 2) took a time you can live
  with.
- **W12 – the size holds.** While the window was open in step 5, the samples still read `width`
  1920 and `height` 1080.

Checked too, and what they should show:

- **W7:** after an update restart, and after your PC slept, the VM is at its desktop, signed in
  and unlocked.
- **W8:** drive keeps running the app tests on the VM's screen after its terminal closes.
- **W2** (Hyper-V only): see below.

A few more words in the VM's log:

- `idleMs` is how long since anyone touched the VM's keyboard or mouse. It should climb to
  about an hour by the second run.
- `error` says why a field couldn't be read; that field is then `null`.
- In a `run-end` line, `tail` holds the last lines the tests printed; the whole output is in
  the files named by `out` and `err`.

## With Hyper-V

On Windows Pro, Hyper-V takes VirtualBox's place. What changes:

- **Step 1:** the VM uses a basic session on the Default Switch. Turn enhanced sessions off on
  the PC, once: in an administrator PowerShell, `Set-VMHost -EnableEnhancedSessionMode $false`
  (or Hyper-V Settings → Enhanced Session Mode Policy → untick it). Then, still as
  administrator, in this folder:
  ```
  powershell -NoProfile -ExecutionPolicy Bypass -File .\pc.ps1 -Host
  ```
  It should log `"enhancedSessionMode":false` (W2). Never connect to the VM with Remote Desktop.
- **Memory integrity and `VBox.log`** don't apply: skip those parts of steps 1 and 2.
- **"The VM's window"** is Hyper-V's VMConnect (Hyper-V Manager → Connect). It should open
  straight onto the VM's screen. If it first asks you for a display size, enhanced sessions are
  still on (W2). Closing it leaves the VM running; there is no Manager to close.
- Everything else is the same.

**Bring back** also: the `-Host` line, and whether VMConnect opened straight onto the screen.
