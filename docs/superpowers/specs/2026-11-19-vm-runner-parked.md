# Parked: the VM test runner (not built)

Date: 2026-11-20 · Status: **parked** by the user's decision 12, before any code · From revision 6 of [the remaining-issues design](2026-11-19-remaining-issues-design.md) (commit 13b621f), where it was §4.4 and DESIGN.md row 246. Section numbers below refer to that design.

## Why it is parked

The user's goal turned out to be playing games on the PC while witness works, without the tests ever pulling them out of a game. Running all of witness inside the VM (the design's §4.4 since revision 7) meets that goal with no witness code.

The runner suits a different goal: keeping witness, the editor and the conversations on the PC while only the test runs go to a VM. If that goal comes up, start here. The text below passed six review passes, and its probes are in the design's §6 (P6, P12, P20, P29, P30, P39, P46, P54–P60).

Before building it, re-check:
- the DESIGN.md rows it amended (90, 97, 202, 203) and touched (71, 154, 164, 181, 205, 218), as they stand then;
- the Windows measurements it owed (below);
- the guard of row 243, which ships without it and which its snapshot builder was to read.

## The design (revision 6's §4.4, verbatim)

### 4.4 Row 246 — tests in a VM on the user's PC (#76)

#### 4.4.1 The VM and the runner (R13) *(the user's decisions 3–5 and 10; the mechanism is my call, from the verification pass and passes 1–6)*

- **The VM** is a Windows virtual machine on the user's own PC.
  - **Hyper-V** (Windows Pro) runs in a basic session.
    - An enhanced session is Remote-Desktop-based: closing its window disconnects Windows inside, and while it is open the guest's display follows the window's size. Either way the tests would break (W-R).
    - Enhanced sessions are turned off **on the host**, once, as admin on the PC: Hyper-V Settings → Enhanced Session Mode Policy off (`Set-VMHost -EnableEnhancedSessionMode $false`).
    - Turning Remote Desktop off inside the guest would not stop them, since VMConnect's enhanced mode needs the Remote Desktop *service* (W-R). So `runner install` never touches Remote Desktop.
  - **VirtualBox** (Home) runs slowly while Windows' virtualization-based security (memory integrity) is on.
  - **Its network:**
    - Hyper-V: the Default Switch (NAT).
    - VirtualBox: NAT with a port forward bound to `127.0.0.1` (a forward with no host IP listens on every host interface), or host-only plus a NAT adapter for the VM's own downloads (host-only alone has no outside access).
    - Never bridged, so the link never leaves the PC.
  - **Its display** is at least 1920×1080, so a 1280×800 window fits.
  - **It never locks.** It signs in automatically, never locks (also after the PC wakes), and never sleeps its display.
  - **What it holds:** its own Windows license, the repo's tools (node, pnpm, Rust) and witness.
- **The runner** is `witness runner serve` inside the VM.
  - **It never runs elevated.** A process an elevated one starts inherits its token, and a test app at high integrity checks something other than what a player gets: UIPI drops lower-integrity messages such as the tray's callbacks, and a per-machine installer meets no UAC prompt. `runner serve` refuses to run elevated, and `runner check` reports elevation (W14).
  - **How it starts.** A `.cmd` in the VM's Startup folder starts it at sign-in, hidden through row 201's detach wrapper, so no console window sits on the test screen. `runner install` starts it through the shell (the unelevated, sign-in environment route), even when install itself was run from an elevated terminal. It reuses `resolveSpawn` (row 164) and the job host (row 218).
  - **Where it listens:** on TCP, on every interface of the VM. Hyper-V's Default Switch renumbers on reboot, so it never binds one address.
  - **How the PC reaches it:** by the guest's computer name (`<computer>.mshome.net` on the Default Switch) or by address. For a VirtualBox forward, that is `127.0.0.1:<host port>`.
  - **The firewall:** one inbound rule, on every profile, limited to the runner's port and `LocalSubnet`, made at install by one elevated child behind one UAC prompt. That is the only elevated step.
  - **Windows only:** the runner ships for Windows only. The client side is OS-neutral.
- **Connecting.** Every connect and handshake, probes included, runs under one 30 s deadline.
  - A name that does not resolve, no route, or no answer within the deadline is `unreachable`. Its remedy names both "start the VM" and "start `runner serve` in it": Windows Firewall's stealth mode drops refusals for a port no one listens on, so a stopped runner looks exactly like a stopped VM (W-R).
  - Behind a VirtualBox forward bound to `127.0.0.1`, a refused connect is `unreachable` (VirtualBox itself is down). A connection closed or silent before the runner's hello is `refused` (start `runner serve`).
  - The runner drops a handshake older than 30 s and caps the unauthenticated connections it holds.
- **Security** *(passes 2–6)*. The runner runs what it is sent, and what it sends back becomes journaled evidence.
  - **Proofs.** Each side proves the shared secret with HMAC-SHA256(secret, label ‖ role ‖ protocol version ‖ client nonce ‖ server nonce).
    - The hello, the answer, the deny and both proofs keep one layout across every protocol version. The runner speaks exactly one version and never negotiates, so nothing can be downgraded.
    - The answer and the deny carry a fixed-width runner id, which `runner connect` pins. Another runner at a reused address reads as the wrong runner, not as a wrong secret.
    - The runner verifies the client's proof over the client's announced version before it answers. A rejected proof gets a fixed-layout deny (`unauthenticated`).
    - A skew answer carries the runner's own version and its proof over that version, and the client verifies it before it reports a skew.
    - Proofs compare in constant time.
  - **Frames.** The session keys are HMAC-SHA256(secret, label ‖ direction ‖ version ‖ both nonces), one per direction.
    - Every frame's MAC covers every byte before it: its type, length, direction, sequence number and payload. Every field is fixed-width or length-prefixed, with distinct labels.
    - Each receiver computes the MAC with its own frame count, never the wire's. A length is capped before anything is buffered.
  - **The run's frames, in order:**
    1. The client's first authenticated frame is its run request: a run id it chose (128 random bits), the pool key, the plan (or `primary` for a run with no plan), the report glob the PC merges (`rc.reportGlob`), and the PC's `info/exclude` and `core.excludesFile` lines (§4.4.3).
    2. The runner's first authenticated frame is that pool's tips, followed by its name. The name is what `on:` records.
    3. Bundles, the command's output (stdout and stderr tagged apart) and returned files travel only inside authenticated frames, chunked. Nothing is used before the frame that ends it verifies.
    4. A run ends only with the runner's authenticated final frame, which carries its status. That is either the exit code plus the count and byte length of each returned file, or `prepare-failed` with its output's tail, or `runner-run-failed` or `unavailable` with its cause. A link lost before the final frame is a lost link, and the run is void, so a partial report set never merges.
  - **Heartbeat.** Each side sends one every 10 s. After 60 s of silence the VM closes the run's job, and the PC reads the outcome per §4.4.4.
  - **A probe after a loss** names the run id it stops, and only that run is stopped.
  - **No encryption.** The link stays on the PC's virtual network (§7).
  - **Returned files.**
    - **In the VM:** returned files are collected with lstat, never following a link. The VM applies the PC's name rules and leaves out, with a warning on the run's output, any match that fails them, so one odd file never voids every run.
    - **The name rules:** the path must be relative, with no `..`, and must match the report glob or lie under the screens folder. Names containing `\` or `:`, a drive letter, a trailing dot or space, or a reserved device name are refused. So is any component equal to `.git` or `node_modules` ignoring case, or containing `~` (8.3 short names), whatever the glob.
    - **On the PC:** every component of the destination is lstat'ed. A missing one is made, one level at a time, and lstat'ed again, so a fresh worktree's report folder never voids a run. Every component must then be a real directory under the run's root. An existing entry is unlinked without following it, and the file is written to a fresh temp name in that directory (`O_CREAT|O_EXCL`) and renamed onto its name, as `live.ts`'s `put` does. On Windows `O_NOFOLLOW` is a no-op (libuv defines it as 0, P46), so the component walk is the protection there.
    - **Limits:** at most N files and M MiB come back per run; more is its own cause (`files`). A path that fails validation on the PC, or a file that cannot be written, voids the run (`runner-run-failed`, cause: files).
  - **The secret goes from the PC to the VM.**
    - `runner connect` makes it in the user's folder: 64 lowercase hex characters. It refuses a path inside the repo, so the secret never lives in a repo.
    - A second `runner connect` keeps an existing secret file; `--new-secret` makes a new one, which must then be typed into the VM again.
    - The user types it into the VM through VMConnect's Clipboard → Type clipboard text. A basic session has no clipboard out of the VM, and that route types keystrokes on the VM's keyboard layout.
    - `witness runner install --secret-stdin` reads it without echo. It refuses any character outside 0–9 and a–f, saying to switch the VM to English (US) and type it again.
    - `connect` and `install` both print an 8-hex fingerprint of the secret, so a mistype shows at once.
    - `install --secret-stdin` replaces the stored secret; a plain `runner install` keeps it. There is no `--new-secret` in the VM.
- **Install and skew.** `runner install` (re)starts `runner serve` as above. The protocol is versioned. A skew is a machine cause, and its remedy is to update witness in the VM, then run `witness runner install` there.
- **Settings** live in `.witness/runner.local.yaml` at the primary root: the runner's id, address, port, secret path and prepare command.
  - It is its own file, because a new key in `config.local.yaml` makes every older CLI refuse `unknown-local-key` (`src/config.ts:437-441`).
  - The prepare command is the VM's setup, like its toolchain, not a repo fact (row 90's split).
  - The file joins `LOCAL_STATE_FILES` (`src/gitio.ts:124-147`), without which every state write refuses `unrelated-dirty`, and init's gitignore block. `runner connect` also adds it to `.git/info/exclude` for existing consumers.
  - `check` validates it, and drive's `watchSignature` watches it.

#### 4.4.2 What goes there (R14) *(my call, from passes 2–6)*

- **Every test or check** witness runs in that repo on that PC goes there: `runCommand` (criteria, suites, the ship gate's lanes, drift) and `witness turn`.
  - Both spawn a local client, `witness runner exec`, through `spawnSync`, with output piped for `runCommand` and inherited for `witness turn`. Every caller keeps its synchronous shape, and `withRunnerTurn`'s turn holds for the whole remote run (P29: an async body would run unturned).
  - The runner turn (row 181) and the trust check (rows 154, 205) stay on the PC.
- **The result file is the run's only outcome** (P39).
  - The parent creates it in the OS temp folder and passes its path. The client writes exactly one of `{exit: <32-bit code>}`, `{unavailable: <cause>}`, `{runFailed: <cause>}` or `{prepareFailed: <output tail>}`. The parent reads it and deletes it.
  - A missing, partial or unreadable file is `runner-run-failed` (cause: client): the client was killed, crashed or never started.
  - The client's own exit status is never read.
- **`witness turn`'s exit.** It exits with the recorded code, except that a non-zero code whose low byte is 0 exits 1, on every OS. A shell that keeps only the low byte, such as Git Bash, would otherwise read exit 256 as success (P39; W12). On an outcome it prints the refusal's rule on stderr and exits 3 for `unavailable` and `runner-run-failed`, and 2 for `prepare-failed`.
- **Environment.** The command gets the VM's own environment plus the run's witness variables, with host paths mapped or dropped:
  - `WITNESS_SCREENS_DIR` → the VM checkout's `.witness/screens/<plan>`, and its PNGs come back (row 71's captures; without them every UI plan refuses `screens-matched-nothing`);
  - `WITNESS_BIN`, `WITNESS_RUNNER_TURN`, `WITNESS_JOB_HOST` and `WITNESS_DRIVE*` are not sent.
- **Paths.** `witness turn`'s working directory is mapped relative to the run's root. Absolute PC paths inside its arguments are not mapped.
- **Prepare's output** is never part of `RunOutcome.output`. It reaches the caller only as `prepare-failed`'s tail, and under `witness turn` it streams to stderr.
- **Needs.** `env` and `cmd` needs are judged on the PC (`src/needs.ts:30-58`). A `cmd:` criterion that itself runs witness runs in the VM without the PC's state (§7).

#### 4.4.3 Each run (R15) *(my call; P6, P20, P30, P39, P58–P60)*

- **On the PC:**
  1. **The guard** (§4.1.2).
  2. **The snapshot** of the run's root (the worktree, or the primary root for drift):
     - It is built from a temporary copy of the real index; `git rev-parse --git-path index` gives that index's path.
     - It is `git add -A -- . ':(exclude,top)<each state dir>'`: canon and `.witness/` travel only as committed, so a hidden stray file never makes git fail and machine-local files never travel.
     - For a plan's worktree, the state dirs then leave the temp index (`git rm -r --cached --sparse --ignore-unmatch -q --`), so the VM's files are the worktree's.
     - It captures tracked, staged, intent-to-add and untracked non-ignored files under a per-run ref, `refs/witness/snapshot/<run-id>`, deleted after the run. The next run sweeps the refs of runs that are no longer live.
     - Every git step must exit 0 (add, write-tree, commit-tree, update-ref, the bundle), or the run is void before anything is sent: `runner-run-failed`, cause `snapshot`, quoting git's first line (P58). One unreadable file would otherwise leave the old index and test the base tree.
     - A snapshot whose sha the VM already holds sends no bundle (P39).
  3. **The bundle.**
     - The VM's tips come in its first authenticated frame. The PC excludes the tips it still holds and sends the bundle against them.
     - It sends a full one when it holds none of them, cannot make the bundle, or the VM cannot verify it (P30, P39).
     - A shallow PC repo cannot feed a fresh VM, so it is a `config` cause naming `git fetch --unshallow` (P58).
     - Full-history bundles are 3.8 MB for witness and 10 MB for fewhats.
- **In the VM** (every child it starts, and every walk and read it makes, runs asynchronously, so the heartbeat never stops; P12):
  1. **Space.** The runner reads free space before the fetch. Below the floor (§10), the run is `unavailable` (cause: space), found before the run. Idle checkouts are pruned first, least recently used.
  2. **Checkouts.** There is one store per pool key (the snapshot's smallest root-commit sha), with its checkouts as linked worktrees (default 2, set at install).
     - A run gets the checkout it last used for that plan (or `primary`), else the least recently used.
     - A run holds its checkout from sync until its files are returned. Waiters are served in arrival order.
     - Checkouts are re-targeted, never deleted, when a plan ends, and pruned only to free disk.
  3. **Sync.**
     - The PC's exclude lines from the run request are written into the store's `info/exclude` before anything is cleaned. Otherwise `node_modules` or `target` ignored only on the PC would be deleted on every sync (P60).
     - Then a forced fetch, `checkout --detach -f` to the named sha, and `git clean -fd`, which keeps ignored `node_modules`/`target`.
     - A failed fetch, checkout or clean is retried once after 5 s before it counts. Typical causes: a file the last run's app still locks, an LFS filter with no remote, a long path.
     - While another run holds the screen, sync runs at below-normal priority, so it never starves that run's UI suite.
  4. **Prepare.** The prepare command runs inside the run's job, outside the screen lock, at below-normal priority while another run holds the screen.
     - `CI=true` is added to its environment (never to the command's). Without a terminal, pnpm aborts a modules purge that `CI=true` lets through (P59).
     - A prepare that fails on a checkout another plan used last is retried once after `git clean -fdx` there, before it counts.
     - A non-zero prepare is `prepare-failed`. Prepare, or the suite, must build every artifact the suite reads; the README says so.
  5. **Old results.** Right before the command, every report-glob match and the screens folder are deleted. Otherwise a suite that crashes before writing its report would send back the last run's passes, which full-suite evidence would journal as green (P20; `src/evidence.ts:83-98`).
  6. **The run.** Every command holds the VM's screen lock: one run at a time across repos, whatever `drive.parallelSuites` says (row 181). Each repo's host turn is independent (`src/runner-lock.ts:20`).
     - A run waiting for the lock prints one line naming the holder and since when. The wait is the session's time, as row 181's turn is.
     - The command runs in a job with `resolveSpawn`, its output streaming back.
     - **The screen check** runs before and throughout the run. It requires the console session (never a remote one) and a display of at least 1920×1080, and it also hears the desktop switching (a lock or a UAC prompt between polls). A screen not live before the run is `unavailable`. A screen lost during it voids the result (§4.4.4).
     - After any failed sync step, prepare or command, the runner reads free space again. Below the floor, the run is void and `unavailable` (cause: space), a loss.
  7. **Stops.** A dropped connection, a stop frame naming its run id, or 60 s of silence (Ctrl+C on `witness turn`, drive stopping a session) closes the run's job before the screen goes to the next run.
  8. **What comes back:** the final frame's status, every report-glob match and every file under the screens folder present when the command ends.
- **Back on the PC:** the returned files are written into the run's root (§4.4.1), where `mergeReports`, `collectCaptures` and `resolveDesignCaptures` read them.

#### 4.4.4 Three outcomes that are never a test result (R16) *(my call, from passes 1–6)*

`RunOutcome` (`src/runner.ts:42-45`, today `{exitZero, output}`) becomes a discriminated union. Its three new outcomes carry no `exitZero`, so the compiler names every reader. Each is carried in the result file (§4.4.2) and the final frame:

| Outcome | Causes | Exit | Drive |
| --- | --- | --- | --- |
| `unavailable` | **machine** causes the probe can see: unreachable; `refused` (behind a VirtualBox forward); unauthenticated; the wrong runner; version skew; the screen not live (locked, display asleep, a UAC prompt, not the console session, too small); free space below the floor; `config` (the PC's settings or secret unreadable, a shallow repo) | 3 | the runner hold (§4.4.5) |
| `runner-run-failed` | **run** causes: a sync that failed twice; a snapshot the PC could not build; the screen or link lost during the run when the probe right after finds the machine fine; a client that died; returned files refused or over the caps; a run the PC slept through (`slept`) | 3 | no hold; counted per §4.4.5's two-strike rule (`slept` never counts) |
| `prepare-failed` | a non-zero prepare command, after its retry | 2 | no hold; a normal lane; the session's to fix |

- **A lost screen or link.** The run is void either way, and it is stopped before anything is probed:
  - on a lost screen, the runner stops the run and closes its job at once;
  - after a lost link, the probe's new connection names the lost run's id, and the runner stops it and confirms its job closed.

  Only then does the client run the hold's probe, once, under the 30 s deadline. By then something the run itself took away (an installer's UAC prompt, a starved VM) has had its chance to come back. The outcome:
  - a probe that fails for a machine cause gives `unavailable` with that cause, and the lane is caught;
  - otherwise `runner-run-failed`.

  The client's record notes the loss (`loss: screen` or `loss: link`) for §4.4.5's counting.
- **A run the PC slept through.** The client detects its own sleep with row 210's lateness rule. Such a run is `runner-run-failed` (cause: slept): void, never counted, no hold.
- **Every reader that would otherwise swallow them** refuses before anything journals (passes 2–6):
  - `runFullSuite` (`src/runner.ts:130-133`) returns the outcome before `mergeReports`, so an outage never reads as `no-reports`;
  - `runSpecTests` (`src/evidence.ts:63-67`, `:87-89`) refuses before it computes `allOk`, so test-evidence's red and green, verify-red's red and green (`:231`, `:256-258`) and `runRegression`'s per-spec runs journal nothing;
  - `runCriteria`'s three sites, suite, filtered and `cmd:` (`src/criteria.ts:56-65`, `:97-102`, `:125-126`), stop at the first outcome;
  - `laneCheck` (`:149-168`), `runRegression` (`src/evidence.ts:306-339`; amends row 97, which had it never return a refusal) and `commandLane` (`src/gates/ship.ts:26-30`) pass it out of `resolve`;
  - `driftSweep` and `deepDrift` (`src/drift.ts:104-108`, `:129-160`) refuse before journaling;
  - `witness adopt` (`src/verbs/adopt.ts:79-81`);
  - the exits: gate's resolve-refusal mapping (`src/gate.ts:381`), test-evidence's `exitOf` (`src/verbs/evidence.ts:17`), `adopt`, `check --drift [--deep]` and `witness turn` give 3 for `unavailable` and `runner-run-failed`, and 2 for `prepare-failed`.
- **What none of them is:** red evidence, a failed check, or a flip that turns changed-nothing into a cached round (P11).
- **One accepted case.** verify-red can journal its red and then meet an outcome above on its green. The step stays open, and a re-run closes it.

#### 4.4.5 Drive's runner hold (R17) *(the user's decision 4; the shape is my call, from passes 1–6; amends rows 202 and 203)*

- **Starting and lifting.**
  - Machine causes start the hold; `runner-run-failed` never does.
  - With `runner.local.yaml` present, drive also probes once when its fill first meets a spawn. So a VM that is off at start holds drive before any session is spent.
  - The hold lifts only when the whole probe passes twice in a row: reachable, the right runner, authenticated, same protocol, screen live, free space above the floor.
  - While the probe fails, the hold's cause is the probe's current one.
  - One probe is in flight at a time.
- **What it pauses.**
  - A spawn the hold blocks adds its target to the round's held set. `admits` skips that set as it skips `busySeen` (`src/drive.ts:720`), and the fill goes on, so later targets' trust grants, needs and conversations still surface.
  - The hold pauses only a round whose fill it blocked (the held set is non-empty). Otherwise drive ends idle, or pauses for the human, as today, and its report names a standing hold.
  - While it stands, drive starts no session, and settles continue, since they run no tests.
  - It is a pause condition beside `forHuman`, in **both modes** (today `src/drive.ts:1291-1292` pauses only under autonomy). It is checked in the fill loop before `capped` (`:1267`), and before the busy poll (`:1286-1289`) in the pause block (`:1279-1299`).
  - Without autonomy, drive takes its round signature too (today only under autonomy, `src/drive.ts:1199`, which would make `pauseForHuman` return at once and spin). It gets one hold branch after the usage wait and before the busy poll, waiting in `pauseForHuman` with the runner item alone.
  - `pauseForHuman` also wakes on the probe every `PAUSE_POLL_MS` (row 202). The probe runs beside the lane race too, so with `drive.parallel > 1` the hold lifts while lanes still run.
  - The hold is no drive timer, so the idle limit keeps running.
- **What the human sees.**
  - **Drive's log:** `drive: runner hold — <cause> · <remedy>` when the hold starts or its cause changes, and `drive: runner hold lifted`.
  - **Notifications:** the hold notifies only once a probe fails, whatever started it, so a blip or a booting VM never notifies. A changed cause notifies again only after it has stood a minute. The runner item's key leaves `notified` when the hold lifts. The text is `runner · <cause> — <remedy>`.
  - **The remedies:**
    - start the VM, or `runner serve` in it;
    - sign in or unlock;
    - answer the UAC prompt with No (a Yes elevates an installer outside the run's job);
    - turn display sleep off in the VM;
    - update witness in the VM and run `runner install`;
    - copy the secret again;
    - free space;
    - fix the file `witness check` names;
    - turn Hyper-V's enhanced session mode off.
  - **needsYou** takes the hold as an input (drive's own, or a validated `runner` field on `LiveState`, `src/live.ts:31`). Its new item kind joins the wait tally (`WAIT_KINDS`), `next`'s `waiting:` line (`HELD_KINDS`) and the labels (`WAIT_LABEL`). It is exempt from the busy filter (`src/drive.ts:1277`), never enters `named`, and is named by the report, the summary and the final notification. Without autonomy, drive prints and notifies the runner item alone and publishes nothing.
- **Records.** Each run writes its own record for a machine cause, a run cause or a loss at the primary root: `.witness/live/runner/<run>.json`, under `LOCAL_STATE_DIRS` (`src/gitio.ts:154`).
  - **What a record holds:** `{cause, class, loss?, at, target, version}`, from a closed set of causes.
    - `target` is the drive target the run was for: the client's `WITNESS_DRIVE`, absent outside drive.
    - `version` is the writing witness's version. A record from a version other than drive's own ends drive as `superseded`, beside the state floor's check. Without this, sessions spawned after the user updates witness on the PC would meet a skew that drive's older probe never sees, and loop (P56).
  - **The writer** is its own, beside `live.ts`'s `put`, whose temp name for a file in a subfolder lands in a folder that never exists and swallows the failure (P54).
    - It lstats `.witness/live` and `.witness/live/runner/` as real directories (made if absent, refused if a link), and excludes the folder from git as `put` does.
    - It writes a temp file inside the folder and renames it.
    - A failed write is said on stderr, never silently; drive then judges that lane normally (a residual, §7).
  - **Who writes:** the client writes its record before its result file. For cause `client`, the parent writes it. Clients delete records older than a day when they write.
  - **When drive reads:** every round, when a lane ends, and on each probe tick.
    - It reads only finished record names, each lstat'ed as a regular file.
    - It keeps every record it reads for the whole run, and judges lanes against those kept records, never the files.
    - It deletes only files it has read.
  - **Which lanes a record catches:**
    - A machine-class record catches every lane alive at its `at`, and starts the hold.
    - A run-class record catches only its own target's lane.
    - A record with no target, or one from before drive started, catches no lane. Such a record starts the hold silently: it notifies only once a probe fails.
  - **A caught lane** ends like a usage-limited lane: its progress cleared, no cap counted, never stuck. A run-class catch's time still counts toward `drive.caps`.
- **The two-strike rule**, per target, read after `limited`, counts:
  - its run-class records, `slept` excepted;
  - its losses whose probe then passed, or failed for a cause a run can raise (a UAC prompt, unreachable, refused, low space);
  - and, as a backstop, a machine-class catch whose hold lifted without any probe failing. That probe never saw its cause.

  It does not count:
  - a loss whose probe finds the VM locked or its display asleep. That is an outage: held, never counted;
  - an `unavailable` found before a run.

  Neither of those resets the count. Any lane of that target that is not caught does reset it.

  A second counted catch in a row, on an unchanged key, sets the target aside as stuck (`runner: <cause>`). Drive keeps each target's key at its last counted catch, and a human release (`src/drive.ts:762-770`) clears it.
- **The skills and the router:** on `runner-unavailable`, `runner-run-failed` or `prepare-failed`, end the turn (after `prepare-failed`, fix it first), and never run the test outside `$WITNESS turn`. Give `witness turn` the harness's longest tool timeout, since a run may wait for the VM's screen.

#### 4.4.6 Setup (R18) *(my call)*

- **On the PC, once, as admin (Hyper-V only):** turn enhanced sessions off: Hyper-V Settings → Enhanced Session Mode Policy off, or `Set-VMHost -EnableEnhancedSessionMode $false`. `runner connect` prints this step.
- **`witness runner connect <host>[:port]`**, on the user's PC:
  - makes the secret in the user's folder, or keeps the existing one;
  - writes `.witness/runner.local.yaml` and the exclude line;
  - pins the runner's id at the first successful handshake;
  - prints the secret and its fingerprint for the user to type into the VM.
- **`witness runner install --secret-stdin`**, inside the VM, as the signed-in user:
  - one elevated child, behind one UAC prompt, makes the firewall rule;
  - the rest runs unelevated: it stores the secret and prints its fingerprint, creates the hidden Startup `.cmd`, sets the pool size, and starts or restarts `runner serve` through the shell.

  The VM's checkouts are its own, so git's dubious-ownership check never fires.
- **`witness runner check`** reports:
  - **the link:** a real round trip, the runner's id, whether `runner serve` is up (nothing restarts it if it crashes, §7), and that it runs unelevated and windowless;
  - **tools:** versions on both sides (node, pnpm, cargo/rustc), with a warning on mismatch;
  - **the screen:** whether it is live, the console session, its size and DPI, and whether a UAC prompt (the secure desktop) is up;
  - **sleep and sign-in:** display sleep, lock, automatic sign-in after the PC restarts or updates, and sign-in when the PC wakes;
  - **the network:** the VM's network kind (never bridged) and a VirtualBox forward's host IP;
  - **warnings:** VirtualBox under virtualization-based security, and `drive.parallelSuites: true`, which no longer overlaps runs;
  - **disk:** free space against the floor;
  - **the repo:** its submodules (they do not travel), skip-worktree and assume-unchanged files (they travel as committed), LFS filters (objects do not travel), ignore rules that live only on the PC (they travel in the run request), a shallow clone, and `core.autocrlf`, `core.symlinks` and long paths on both sides;
  - **prepare:** what the prepare command costs when nothing changed.
- **Audit.** Evidence recorded through the runner carries `on: <runner name>`, the name from the runner's authenticated frame.

## Its residuals (from revision 6's §7)

- **Tests outside `witness turn`.** A test a session runs outside `witness turn` runs on the user's machine and opens the app there (row 218, D133). The skills make the rule stricter; nothing enforces it.
- **What the VM needs set up.**
  - Ignored files a suite reads (e.g. `.env.test`) must exist in the VM, and `runner check` cannot see them.
  - Skip-worktree and assume-unchanged files travel as committed. LFS objects and submodules do not travel. `runner check` lists these.
- **The link is not encrypted.** Source and test output cross the PC's own virtual network in clear, and never leave the PC while the VM's network is not bridged and a VirtualBox forward is bound to `127.0.0.1`.
- **`cmd:` criteria.** One that itself runs witness runs in the VM without the PC's state.
- **A crashed `runner serve`** is not restarted. Drive holds and notifies until the human starts it; on Hyper-V it reads `unreachable` (stealth mode), and `refused` only behind a VirtualBox forward.
- **Waiting for the VM's screen.** A run waiting for another repo's run to free the VM's screen spends the session's time; nothing in witness times it out, and a harness tool timeout can cut the call. The skills give `witness turn` the longest tool timeout.
- **A record that cannot be written** (a full disk on the PC, a link where the records folder should be) is said on stderr, and drive then judges that lane as a normal one.

## The Windows measurements it owed (revision 6's W1–W15)

**Windows measurements owed** (the human, before the row says MEASURED):
- W1. The runner's live-screen check with the VM locked, at a UAC prompt, or with its display off.
- W2. A Hyper-V basic session keeps the guest's screen live with VMConnect closed, and with Enhanced Session Mode Policy off on the host VMConnect never opens an enhanced one; VirtualBox headless does the same.
- W3. WebView2 renders inside the VM, without a real GPU.
- W4. The hidden Startup `.cmd` (no runner window on the test screen), the firewall rule, a host → guest TCP connect, a stopped `runner serve` reading `unreachable` (stealth mode) and, behind a VirtualBox forward, `refused`, and the guest's name resolving across a PC reboot (`<computer>.mshome.net`).
- W5. The carry on git 2.56.0.windows.1, including a file held open (Git for Windows retries an unlink for about 71 ms).
- W6. The job host in the VM kills the app tree on a stop, a dropped connection and 60 s of silence.
- W7. #80's stop after the grace, through the job host, and the status it leaves.
- W8. LowPro's suite in the VM: tray, toasts (a new account's first-hour quiet time), bring-to-front, 1280×800 and restore.
- W9. Automatic sign-in after the PC restarts or updates, and no lock when the PC wakes.
- W10. A cold first run's time (full bundle, install, Tauri build) and a warm run's.
- W11. VirtualBox's speed with Windows' virtualization-based security on.
- W12. `witness turn -- cmd /c exit 256` from Git Bash on the PC exits non-zero.
- W13. A returned file over a planted link or junction on the Windows PC is refused.
- W14. Runs through `runner serve` are at medium integrity (unelevated), and `runner serve` refuses to start elevated.
- W15. The screen check reads the console session, the display's size and desktop switches (a lock, a UAC prompt) correctly inside the VM.

## Its tests (from revision 6's §8)

- **The runner** is tested through an in-process loopback runner on localhost, with a fake screen probe, a fake prepare command and a report-writing fake suite. It covers every cause of §4.4.4:
  - unreachable, refused, unauthenticated, skew, low space, config;
  - the screen lost before, during and after; a failed sync, retried and failed twice; a failed prepare;
  - a dropped connection, a silent link, a killed client;
  - a returned path outside the allowed ones; an unchanged snapshot; a bundle the PC cannot make;
  - a snapshot the PC cannot build, a shallow PC repo, free space below the floor before and after a step, a prepare retried after `git clean -fdx`, and PC-only ignore rules surviving a sync;
  - every reader of §4.4.4 with a fake client writing each outcome, filtered mode with no report glob included, journaling nothing.
- **Drive** is tested for:
  - the hold in both modes, lifting only after two passing probes, and a changed cause notifying again;
  - a lost link resolving to a hold when the VM is down;
  - a run cause ending stuck after two sessions;
  - a lane ending after the hold lifted still being caught;
  - a run-class record catching only its own target's lane;
  - a loss the run itself caused (a UAC prompt) not looping;
  - the busy poll never starving the probe;
  - a standing hold that blocked nothing letting drive end idle;
  - a record from another witness version ending drive as `superseded`;
  - a hold notifying only after a probe failed, and once per cause;
  - the two-strike rule per target: a lock-screen loss never counting, a UAC loss counting, a slept run never counting, another target's lanes never resetting it;
  - a drive without autonomy waiting on the hold as the clock advances, without spinning.

## What it left to the builder (from revision 6's §10)

- The exact byte layout of frames, nonces and labels. The rules are fixed in §4.4.1.
- How the VM hears that a plan ended (carried on a run).
- The file and size caps for returned files (N, M).
- The free-space floor (at least a cold build's growth for the repo, e.g. a Tauri `target/`).

## The calls the user was asked to check (revision 6's §11, calls 6, 7, 9 and 10)

6. **While the VM is down, locked, out of date or out of space, drive starts no new session at all,** even ones that run no tests. It keeps deciding stops, and a drive without autonomy waits too. If the VM goes down mid-run, that counts as the VM being down. A problem inside one run that the VM recovers from (a failed git sync, the screen lost mid-run) is not a pause: that session doesn't count, and if it happens twice in a row the plan ends stuck (§4.4.4–4.4.5).
7. **Every witness test run in that repo on your PC goes to the VM,** including your own `witness test-evidence` and `witness turn`. Environment variables you set on your PC don't reach it, and its first run is slow: a full copy, an install and a build (§4.4.2, W10).
9. **The runner's settings get their own file,** `.witness/runner.local.yaml`.
   - You make the shared secret on your PC (64 characters of 0–9 and a–f) and type it into the VM once, with VMConnect's "Type clipboard text". Both sides show a short fingerprint so you can see they match, and the VM refuses a mistyped character.
   - It lives in your user folder on each machine, never in a repo.
   - The runner in the VM never runs as admin; setup in the VM asks for admin once, only for the firewall rule.
   - With Hyper-V you also turn enhanced sessions off once on your PC (Hyper-V Settings → Enhanced Session Mode Policy), so the VM's window can only open the basic view, which keeps its screen live and at its own size.
   - The link to the VM is signed but not encrypted, and it stays on your PC (§4.4.1, §4.4.6).
10. **A failed install step in the VM** (say, a lockfile the plan broke) stops the run with the install output. It is never a red test and never a pause (§4.4.3–4.4.4).

## Also from revision 6

**Its anti-goals (§2):**
- A run on an unavailable or locked VM, or one whose setup step failed, journaled as red, green or a failed check.
- A file the VM sends back landing outside the run's report and screen paths.
- Drive respawning a target forever on a failure its probe cannot see, or ending one stuck for an outage.

**Its docs and skills lines (§4.5):**
- **The ship skill:** both conflict step sets, the CI-red bullet without a hand force-push (§4.1.3), the hand-back line, and the runner lines.
- **The implement, decompose, plan and design skills, and the router command:** the hand-back line, the runner lines, and lines for the new refusals. `tests/command.test.ts` pins the router's text.
- **Every skill:** "every test through `$WITNESS turn`" made stricter, since with a VM an unturned run opens the app on the user's screen (§7).
- **README:** the VM's setup (§4.4.1, §4.4.6), Hyper-V's host step (Enhanced Session Mode Policy off), and that prepare, or the suite, builds every artifact the suite reads.

**Its row amendments and touches (§5):**
| 90 | 246 | a third local file, `.witness/runner.local.yaml` |
| 97 | 246 | `runRegression` returns the runner's three outcomes as refusals |
| 202 | 246 | the runner hold pauses drive in both modes, before the busy poll, and wakes on its own probe |
| 203 | 246 | a machine-level needs-you item, notified once per outage |
- 71 (captures from the VM);
- 154 and 205 (trust on the PC);
- 164 and 218 (in the VM);
- 181 (the turn holds the remote run, and the VM's screen lock serializes runs);

**Its residual on older CLIs (§7):**
- **Older witness still running.** An older drive keeps 0.29 behaviour until restarted (c3). An older CLI ignores `runner.local.yaml` and runs tests on the user's PC until the floor rises.

**Its probe-to-test map, pins and Windows note (§8):**
  - runner tests: P20, P29, P30, P39, P54, P57–P60;
  - drive tests: P55, P56.
  - `tests/runner-exec.test.ts` and `tests/runner-full.test.ts`;
- **Windows:** the job host and `resolveSpawn` in the VM take the existing tests' paths. W1–W15 are the human's.

**Its build order (§9):**
5. **#76's core:**
   - the client and its result file;
   - the runner;
   - the protocol and its security;
   - snapshots and bundles;
   - the three outcomes through every reader;
   - the settings and secret files.
6. **#76's rest:**
   - drive's hold and records;
   - the setup verbs;
   - docs and skills.

**Its DESIGN.md row 246:**

| 246 ⊜ | Tests can run in a VM on the user's PC, whose live screen is not the user's | Fixes issue #76; amends 90, 97, 202 and 203; touches 71, 154, 164, 181, 205 and 218 (the design's §4.4). **The VM.** A Windows VM on the user's own PC (the user's decision: never a separate machine), with its own license, the repo's tools and witness. On Hyper-V it runs a basic session on the Default Switch, with enhanced sessions turned off on the host once (`Set-VMHost -EnableEnhancedSessionMode $false`); turning Remote Desktop off inside the guest would not stop them. On VirtualBox it uses NAT with a port forward bound to `127.0.0.1`, or host-only plus a NAT adapter. Never bridged; at least 1920×1080; it signs in automatically and never locks. `witness runner serve` starts at sign-in from a hidden Startup `.cmd` (install starts it through the shell, unelevated, in the sign-in environment). It never runs elevated, listens on every interface, and sits behind a firewall rule limited to its port and `LocalSubnet`, the only elevated step. **The link.** Every connect and handshake runs under a 30 s deadline. An unanswered connect is `unreachable`, whose remedy names the VM and `runner serve` (stealth mode hides a stopped runner); `refused` exists only behind a VirtualBox forward. Each side proves a shared secret with a labelled HMAC-SHA256 over role, version and both nonces. The hello, answer, deny and proofs keep one layout across versions, the runner speaks one version and never negotiates, and the answer carries a runner id that `runner connect` pins. The session keys, one per direction, are keyed by the secret; every frame's MAC covers every byte before it, each receiver counts frames itself, and lengths are capped before buffering. The client's first frame is its run request (a random run id, pool key, plan, report glob, the PC's exclude lines); the runner's first is that pool's tips and its name. Bundles, tagged output and returned files travel only inside authenticated frames, and a run ends only with the runner's authenticated final frame carrying its status. A heartbeat runs every 10 s; a probe after a loss names the run id it stops. The link is unencrypted but stays on the PC. The secret is 64 lowercase hex characters with an 8-hex fingerprint printed on both sides: made on the PC by `runner connect` (which keeps an existing one), typed into the VM once, and stored by `runner install --secret-stdin`, which replaces the stored one and refuses any other character. Returned files are collected without following links, filtered by the PC's name rules (no `..`, `.git`, `node_modules` or `~` names), and written on the PC through real directories (missing ones made) via a temp name and a rename, within caps. Settings live in `.witness/runner.local.yaml`, a file older CLIs never read (in `LOCAL_STATE_FILES`, init's gitignore block and `.git/info/exclude`); the secret lives in each user folder (90). **The run.** Every command witness runs as a test or a check in that repo on that PC — `runCommand` and `witness turn` — spawns a local client, `witness runner exec`, through `spawnSync`, so callers keep their shape and the runner turn (181) holds. Its only outcome is a result file the parent creates and reads; a missing one is a run failure. `witness turn` exits 1 for a non-zero code whose low byte is 0, and 3/3/2 on the three outcomes. The snapshot excludes the state dirs (`git add -A -- . ':(exclude,top)…'`; a plan worktree drops them from the temp index), every git step must exit 0, and a shallow PC repo is a `config` cause. In the VM: free space checked before the fetch and after a failed step (idle checkouts pruned first); one store per pool key with linked-worktree checkouts served in arrival order; the PC's exclude lines written before `clean -fd`; a failed sync retried once; sync and prepare at below-normal priority while another run holds the screen; the prepare command with `CI=true`, retried once after `git clean -fdx` on a checkout another plan used; old results deleted right before the command. The command runs under a VM-wide screen lock (a wait line names the holder), with the screen checked before and throughout: the console session, at least 1920×1080, desktop switches heard (164, 218). Every report-glob match and screen file present when it ends comes back. **Three outcomes, never a test result.** `RunOutcome` becomes a union. `unavailable` (exit 3) covers machine causes: unreachable, `refused`, unauthenticated, the wrong runner, skew, the screen not live, low space, `config`. `runner-run-failed` (exit 3) covers run causes: a sync that failed twice, a snapshot the PC could not build, the screen or link lost while the machine is fine, a dead client, refused files, a run the PC slept through. `prepare-failed` (exit 2) is the session's to fix. After a lost screen or link the run is stopped first, then probed. Each outcome passes through every reader (`runFullSuite`, `runSpecTests`, `runCriteria`, `laneCheck`, `runRegression` (97), `commandLane`, drift, `adopt`, `check --drift`, `witness turn`) and refuses before anything journals. **The hold** starts on machine causes (drive also probes once at its first spawn) and lifts after two passing probes, one probe in flight at a time. A spawn it blocks joins a held set the fill skips, and it pauses only a round whose fill it blocked, in both modes, before caps, no-progress and the busy poll. Drive logs its start, cause change and lift. It notifies only once a probe fails, again for a cause that stood a minute, with a remedy per cause, as one `needsYou` item (203); `pauseForHuman` and the lane race are woken by the probe (202); no session starts while it stands, and settles continue. Each run writes a record `{cause, class, loss?, at, target, version}` under `.witness/live/runner/` through a writer of its own. A record from another witness version ends drive as `superseded`. A machine-class record catches every live lane; a run-class one only its own target's; a targetless or old one none. A caught lane ends like a usage-limited lane. The two-strike rule is per target: it counts run-class records (`slept` excepted), losses whose probe passed or found a cause a run can raise, and a machine catch whose hold lifted with no failed probe. A lock-screen loss is an outage, held and never counted. `witness runner connect`, `install` and `check` set up and prove the link. | Research (the design's §6, W-R): a switched-away second account has no input desktop ("If the calling process is running in a disconnected session, the function returns a handle to the desktop that becomes active when the user restores the connection"), so bring-to-front, tray menus and toast banners cannot be tested there, and Windows inside a VM has its own live screen; enhanced session mode is a host setting ("Indicates whether users can use enhanced mode when they connect to virtual machines on this server by using Virtual Machine Connection"); stealth mode "blocks the outgoing ICMP unreachable packet and TCP RST messages" for ports no one listens on. Probe: a temp-index snapshot and bundles carry the uncommitted tree exactly (P6); a VM's ignored reports survive a checkout and would read as this run's passes (P20); an async body runs outside the turn (P29); a killed client reads as a failed run and a relayed 256 as green (P39); `O_NOFOLLOW` is 0 on Windows (P46); `put` cannot write a record in a subfolder (P54); a session runs `WITNESS_BIN` read at spawn, so an update mid-drive reaches it (P56); an unreadable file makes the snapshot test the base tree (P58); pnpm aborts a purge without a terminal (P59); PC-only ignore rules are lost to the VM's clean (P60). Windows behaviour is owed (W1–W15). |

**Where the rest is:**
- the plan's Slices 6–7 (Tasks 19–31), with their interfaces: `git show 3ae38f9:docs/superpowers/plans/2026-11-19-remaining-issues.md`, from `## Slice 6`;
- the build ledger's interface notes: `.superpowers/sdd/2026-11-19-remaining-issues/interfaces.txt` in the worktree (local, not in git).
