# Issue #75 — What a Run Starts Ends With It (row 218) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Windows, nothing a drive session, a test run or a gate reviewer starts outlives it — a process started detached, or orphaned by a parent that already exited, included — whether the work ends normally, times out, or drive is stopped. Elsewhere, a drive session takes its process group with it however it ends. A session's own test runs take the same per-repo turn as witness's own, so under `drive.parallelSuites: false` two worktrees' suites never overlap. This closes issue #75 as row 218.

**Architecture:**
- **The job host.** `src/contain.ts` (new) uses System32's Windows PowerShell 5.1 as a host.
  - The host enters a kill-on-close Job Object *before* it starts the command. It then starts the command inside the job with inherited stdio, waits, and exits with the command's code.
  - Everything the command starts is born in the job. It dies when the job's last handle closes: when the host exits after the command, or when the host is killed (directly, by a tree stop, or by its parent's libuv job when the parent dies).
  - `contained(run, host)` rewrites a `ResolvedSpawn` (row 164) to go through the host.
  - `jobHost(env)` probes once per process; children inherit its answer through `WITNESS_JOB_HOST`.
- **Three sites start through it on win32:** drive's sessions (`spawnSession`), every `execCommand` run (`runCommand`), and the gate reviewer (`prepareInvocation`). How each of them is stopped does not change.
- **Off win32**, drive kills a session's process group on every exit, not only on timeout or stop.
- **Turns.** Drive releases a dead holder's `.witness/runner.lock` when it starts and after every session. A new verb, `witness turn -- <command> [args…]`, runs a session's own test inside the repo's turn and the job. The implement and ship skills route every test run through it.

**Tech Stack:**
- TypeScript (ESM, NodeNext, strict). `node:child_process` is reached only through `src/spawn.ts` (row 201).
- Windows PowerShell 5.1 with `Add-Type` P/Invoke of kernel32 (row 211's precedent).
- Tests: vitest.
- No new dependency, no new setting.

**Spec:** [Issue #75](https://github.com/popovych-co/witness/issues/75) plus the verified evidence base below. Each claim was either read at `origin/main` `35b8a81` (0.27.0) or measured on 2026-10-31 on the reporting machine (Windows 11 10.0.26200, Node 26.8.1). The measurement scripts are in `%TEMP%\witness75\`.

---

## Verified evidence base

### E1 — What happened (the reporting repo's `.witness/drive.log` and a live process tree)

- **Sessions run out of time inside test runs.**
  - Most of a session's time goes to full-suite test runs. Each step costs a red and a green `test-evidence` of about 10–15 min (`still running · … · quiet 10m · in: $ witness test-evidence …`, drive.log:4896–4898 and 5309–5310), and sessions run suites of their own besides.
  - So `drive.sessionTimeoutMs` (2 h at the time) lands mid-suite. Each timeout whose last minutes the log shows died inside a test run:
    - drive.log:5281, inside `witness test-evidence … --phase green --step s4`;
    - 3299, inside the session's own `pnpm vitest run --project unit …`;
    - 5546, inside the session's own `pnpm test`, the whole suite.
  - 8 of the 10 `spawn-timeout`s since 2026-10-25 name a `test-evidence` lane.
- **The live tree at 15:05** (drive pid 15392):
  - `node drive` → `cmd.exe` (the `pi.cmd` shim) → `node` (pi) → `bash` ×3
  - → `node … test-evidence` (pid 7284, the `runner.lock` holder)
  - → `cmd.exe /c pnpm test` → `node` (pnpm) → `cmd.exe /c vitest run` → `node` (vitest) → `node` (worker) → …
- **How the suite starts its app** (in the reporting repo):
  - It starts the app the way the Start menu would: `spawn(exe, { detached: true, stdio: 'ignore' })` plus `unref()` (`apps/client/test/harness/app.ts:66-86`).
  - The installer tests start the NSIS installer the same way (`install.ts:61`). The interactive installer starts the app with NSIS `Exec`, an in-process `CreateProcess`, and then exits (`installer.nsi:963`).
  - The NSIS uninstaller re-runs itself from `%TEMP%` (`install.ts:22`).
  - `cleanSlate()` runs in `beforeEach`/`afterAll`, which a killed suite never reaches.
- **The collision.** The two sessions' test runs overlapped, and most of them were the sessions' own, outside the turn:
  - the `key-manifest-plan-1` ship session ran `timeout 1700 pnpm vitest run --project client …` seven times, a window test and a probe test (drive.log:4995–5077);
  - meanwhile `static-site-plan-1` ran `witness test-evidence … --phase green --step s2` (5026), then the whole suite in the background, `(pnpm test > /tmp/suite.log 2>&1 &)` (5033), then polled for 25 min until no other worktree's vitest ran (5044–5085), then `witness test-evidence` again (5088).
  - The ship session then reported that "the test certificate went missing twice … probably because the static-site session was running tests at the same time" (drive.log:5121).
  - The implement session checked by hand "that no other worktree's client suite is mid-setup" before its evidence runs (drive.log:5172, 5249).

### E2 — Root cause 1: witness stops what it starts by ancestry, and a suite's app leaves that ancestry (read + measured)

- **Drive's stop on Windows** is System32's `taskkill /PID <shim> /T /F` (`src/drive.ts:165`, row 201).
  - It is sent only on `timeout`/`stopped`, and only while the shim still runs.
  - `/T` walks parent-pid links in a snapshot. A process whose parent already exited is linked to nothing.
  - Measured (E5 H1): an app started detached by a starter that had already exited survived the stop. An app whose starter still ran died.
- **libuv's own job holds only a direct child.** `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` lets every grandchild out, and a detached child is never assigned (libuv `src/win/process.c`; row 201's own finding).
- **A session that exits normally gets no stop at all.** The group SIGKILL at exit is sent for `timeout`/`stopped` only (`src/drive.ts:384`). On win32 nothing is sent.
- **Drive stopped by its `watch:` line**, `taskkill /PID <drive> /T /F` (`src/drive-presence.ts:123`), gets the same walk and the same survivors.
- **`runCommand` runs the suite with `execSync`** (`src/runner.ts:54`).
  - `cmd.exe` lands in the turn holder's libuv job, and pnpm and vitest break away from it.
  - A holder killed alone (a tool timeout, or `/F` without `/T`) leaves its run going while the turn reads as free. E5 H3's no-job branch reproduced this.
- **A gate reviewer** is stopped by `child.kill` (`src/reviewer.ts:323`) and by `spawnSync`'s `timeout` (`:232`).
  - Both are a `TerminateProcess` of the `cmd.exe` shim alone, so the agent under it keeps running and spending.
  - DESIGN.md's Open / deferred item "Windows is not a CI platform" (a) already measured this. With a 2 s timeout over a CLI that ran 15 s, the piped `spawnSync` returned only when the CLI exited on its own, so `gates.reviewerTimeoutMs` does not bound a stalled reviewer on Windows.
  - This is row 201's original finding, at the one site row 201 did not touch.
- **The POSIX twin:** a group kill reaches only the group, and Node's `detached: true` calls `setsid`.

### E3 — Root cause 2: the turn is released by a `finally` that a kill skips, and nothing ties the run to its holder (read)

- `withRunnerTurn` releases the turn in a `finally` (`src/runner-lock.ts:104-113`). `TerminateProcess` skips it, so `{ "pid": <dead> }` stays behind — the issue's observation.
- By design, the next taker steals a dead holder's turn (`isAlive`, `src/lock.ts:16`). But the dead holder's run may still be going (E2).
- Windows also reuses pids fast: during E5, pid 6380 came back within minutes. A reused pid reads as a live holder, and a turn "waits while its holder lives and never refuses" (`src/runner-lock.ts:14`).

### E4 — Root cause 3: the turn covers only witness's own runs; a session runs its tests outside it (read + log)

- Turns are taken in `execCommand` alone (`src/runner.ts:45`, row 181).
- The implement skill sends a session to run its inner TDD loop itself (`plugin/skills/witness-implement/SKILL.md:55`). The ship skill sends it to "run the repo's tests locally" (`plugin/skills/witness-ship/SKILL.md:63`).
- So `drive.parallelSuites: false`, which "makes test runs in two worktrees take turns" (README:242), holds only for evidence, gate and lane runs. E1's collision is that gap.

### E5 — Measurements (reporting machine; the stand-ins are `node` processes, so nothing touched the live drive)

- **H1:** the tree stop against an orphan — see E2.
- **H2:** a host that enters a `KILL_ON_JOB_CLOSE` job and only then starts the command.
  - (a) When the command ends normally, both apps die as the host exits. Exit 7 passed through, and stdout reached `execFileSync`.
  - (b) When the host alone is killed (`taskkill /F`, no `/T`), both apps die.
  - Cost: the job is entered 180–250 ms after PowerShell starts, about 0.7 s per run in all.
- **H2b:** with `BREAKAWAY_OK` added, libuv's nested silent breakaway still stops at the job, and both apps die. Per the Job Objects documentation, only an explicit `CREATE_BREAKAWAY_FROM_JOB` leaves.
- **H3:** a holder runs `execFileSync(host)`, and the host runs the command.
  - Force-killing the holder alone kills both apps: libuv's kill-on-close job reaps the host, and the host's job reaps the rest.
  - With the job *not* entered, both apps outlived the holder.
- **H4:** what the host leaks into the command's environment.
  - It leaks its own `WITNESS_JOB_*` variables until they are removed.
  - It leaks `PSExecutionPolicyPreference=Bypass` whenever it runs with `-ExecutionPolicy Bypass`. So the host runs without that flag. Inline `-Command` text is not subject to execution policy, and the job was still entered.
  - With both handled, `set` through the host equals `set` run directly: no name added or missing, no value changed, letter case kept. `PSModulePath` is the caller's.
  - `Add-Type -PassThru` with nested structs returns an array, so the script names the type instead.
  - The host also runs under `fixtureEnv()`'s minimal environment (PATH, HOME): the probe returned 0 and the command's exit passed through.
- **H5:** a reviewer's prompt on stdin. 210 000 bytes crossed the host with the same SHA-256.
- **H6:** the Task 1 script, run verbatim:
  - an orphan dies with the run, and exit 9 passes through;
  - probe mode exits 0;
  - with the job made impossible, it prints `witness: no job (…)` and the command still runs (exit 4);
  - that probe exits 86.
- **H7:** through the plan's script, exit codes 0, 1, 3, 255, 256, `0xC000013A` and -1 crossed the host unchanged. So did a working directory holding spaces, `[x]`, `%` and `=`.
- Node exposes no exclusive-open flag on win32 (`fs.constants` has no `UV_FS_O_EXLOCK`), so the pid-file turn stays.

### E6 — Decisions, and what was rejected

- **D1 — A job object that the host enters before the command starts.** Rejected:
  - a better tree walk, or polling — an orphan's parent link is gone, and a poll races the installer's few seconds;
  - assigning a session to a job after it spawns — the shim starts the agent within milliseconds, before PowerShell could assign it;
  - a native addon or ffi — the package's one dependency is `yaml`;
  - a compiled helper `.exe` cached in the profile — an executable to write, scan and invalidate, while row 211 already relies on System32 PowerShell + `Add-Type`.
- **D2 — `BREAKAWAY_OK`, never `SILENT_BREAKAWAY_OK`** (limits `0x2800`). A program that explicitly asks to leave still starts, and leaves, as it does today; nothing else can (H2b). Without the flag, such a program would fail to start inside a session.
- **D3 — Three sites: sessions, runs, reviewers.** These are what witness stops by signal. Not git, gh, notify, keep-awake or probe, and not the opener: the viewer is meant to outlive witness.
- **D4 — A host that cannot enter a job costs containment, never the run.**
  - `jobHost` probes once per process (`WITNESS_JOB_PROBE`). Drive tells its sessions the answer (`WITNESS_JOB_HOST=job|none`). With no host, `contained` returns the run unchanged.
  - Constrained Language Mode blocks both `Add-Type` and `New-Object`, so on such a machine a host would fail every run; the probe keeps it out.
  - A job lost after a good probe prints `witness: no job (…)`, and the command runs uncontained.
- **D5 — Stops unchanged.** Killing the host is now enough. The tree stop still serves wherever no job was entered.
- **D6 — POSIX: the group dies with the session on every exit,** with SIGKILL, the signal the timeout path already sends. POSIX test runs and reviewers stay as they are: `execSync` runs in witness's own group, and giving a run a group of its own needs the async spawn the synchronous runner does not have (Open / deferred).
- **D7 — A verb, not a guard.**
  - `witness turn -- <command> [args…]` runs argv directly (no shell), resolved by `resolveSpawn` (row 164) so that `npx`/`pnpm` shims start on Windows. It runs inside the turn and the job, and exits with the command's code.
  - It needs no trust grant: the command is the caller's, not the repo config's.
  - Rejected: a PreToolUse guard blocking unturned test runs. The canon guard fails open on ambiguity (D133), and no rule tells a test command from any other across `npx vitest`, `pnpm test -- -t`, `pytest` and `cargo test`.
  - Rejected: serializing sessions under `parallelSuites: false`. An implement session is mostly test runs, so this would be `parallel: 1`.
  - Rejected: the suite taking the lock itself. The lock file would become a public contract.
  - Accepted cost: a quick inner-loop run waits behind another worktree's full suite. `drive.parallelSuites: true` is the setting for suites that share nothing.
- **D8 — Drive releases a dead holder's turn** at its start and after each session. The leftover the issue saw goes within seconds of the session that left it, before Windows is likely to hand that pid to another process. A reused pid reads as a live holder, and no check can tell the two apart (E7). The steal by the next taker stays.
- **D9 — The runner's win32 shell is System32's `cmd.exe /d /s /c "<cmd>"`.** That is Node's own argv, plus row 164's rule that `ComSpec` may name a shell with other syntax.
- **D10 — Help stops at `--`.** `main` reads `--help`/`-h` anywhere in argv (`src/cli.ts:170`, `:209`), which would turn `witness turn -- vitest --help` into turn's usage line. Flags after `--` belong to the command.

### E7 — Found while reading, recorded (Task 8 writes them to Open / deferred)

- **A pid file names a pid, not a process.** A reused pid reads as a live holder of the repo lock, the drive lock and the turn. This is pre-existing; D8 narrows the turn's window.
- **A process that another running process starts is born in that process's job:** Explorer (`explorer.exe <file>`, NSIS's `RunAsUser`), a COM server, a service, the Task Scheduler.
- **Machine state is the suite's to clean.** A killed suite may leave an installed build, registry keys, toasts or a certificate; a job ends processes only.

### E8 — Where the tests run (measured on this machine at `35b8a81`)

- **No test runs on Windows today.** `tests/global-setup.ts` builds with `execFileSync('npm', ['run', 'build'])`. On Windows `npm` is `npm.cmd`, which `execFileSync` cannot start (ENOENT). Building with `tsc` through `process.execPath` instead lets the suite start (Task 0).
- **With that fixed, here is how the touched test files fail on Windows:**
  - `drive.test.ts`: 80 of 106 tests, because its fake agents are `#!/bin/sh` scripts;
  - `runner-exec.test.ts`: 4 tests:
    - the B3 children start `node_modules/.bin/tsx`, which is a `.cmd` on Windows (ENOENT);
    - the re-entry test hands ESM a bare `C:\` path, which is not a URL, and quotes `perl -e '…'` for sh, not cmd.exe;
    - the dangling-symlink test needs a privilege to create a symlink (EPERM);
  - `awake.test.ts`: 1, a fake helper script;
  - `spawn`, `console`, `cli`, `skills` and `verb-usage` pass.
- **ESM children:** `node --import <file:// URL of tsx's ESM loader> -e "import … from '<file:// URL>'"` works on Windows (Node 26). Node 20.19+, CI's version, detects module syntax in `-e`.
- **Linux runs in Docker.** CI is ubuntu with Node 20 (`.github/workflows/ci.yml`). WSL here holds only `docker-desktop`, but Docker 29.8.2 runs `node:20`. Task 0's Linux runner ran `runner-exec.test.ts` and `verb-usage.test.ts` green in 24 s, and in 14 s once its pnpm store volume was warm.

---

## Global Constraints

- **Every child process starts through `src/spawn.ts`'s wrappers** (row 201's scan test). `src/contain.ts` imports `spawnSync`, `system32`, `envGet` and `crtQuote` from `./spawn.js`, never from `node:child_process`.
- **The host's command line** is `system32(env, 'WindowsPowerShell', 'v1.0', 'powershell.exe')` with exactly `['-NoProfile', '-NonInteractive', '-Command', JOB_SCRIPT]`. No `-ExecutionPolicy` (H4), no `-WindowStyle Hidden` (row 211's reason).
- **The command reaches the host only through the environment:** `WITNESS_JOB_FILE`, `WITNESS_JOB_ARGS` and `WITNESS_JOB_PSMODULEPATH`, never the script's text (row 211's rule). The host removes all three before starting the command.
- **Job limits are exactly `0x2800`** (`KILL_ON_JOB_CLOSE | BREAKAWAY_OK`). Never `0x1000` (silent breakaway).
- **Off win32**, `contained` is the identity and nothing probes.
- **The host's own words are ASCII** (`witness: no job (…)`), because Windows PowerShell 5.1 writes to a pipe in the OEM code page.
- **No new dependency, no new setting**, and no `migrate` change.
- **Testing on two kinds of host.** CI is ubuntu-only.
  - Windows behavior is tested in `describe.runIf(process.platform === 'win32')` blocks, and POSIX-only behavior in `it.skipIf(process.platform === 'win32')`.
  - Argv and env construction is tested on every OS, with the platform or host passed explicitly (`tests/spawn.test.ts`'s pattern).
- **Every `Run:` line runs on both hosts**, through Task 0's two runners:
  - Windows: `sh "$TEMP/witness75/win-test.sh" <files>`. "PASS" there means the task's new tests pass and the script prints `no failure beyond the baseline`.
  - Linux: `sh "$TEMP/witness75/linux-test.sh" <files>`. "PASS" there means 0 failed.
  - An "Expected: FAIL" names the host that shows the failure.
  - A Windows failure that comes and goes is rerun once before it counts.
- **New comments name `Row 218`.**

## Review Focus

1. **Arguments special to cmd.exe, the CRT or PowerShell** — `""`, `"`, `\"`, `%PATH%`, `%OS:W=X%`, `!x!`, `^`, `&`, a tab, a trailing backslash, non-ASCII. They must reach the command byte for byte through the host, for both a batch target (verbatim) and an image target (libuv's quoting). Task 1 runs `tests/spawn.test.ts`'s `ADVERSARIAL` set both ways.
2. **Exit codes the host must not change:** 0, 1, 3, 255, and `STATUS_CONTROL_C_EXIT` (`0xC000013A`). Task 1 compares each hosted run against a direct one.
3. **A reviewer's prompt larger than a pipe buffer**, on stdin through the host (H5). Task 6.
4. **A machine where no job can be entered** (Constrained Language Mode, or no `powershell.exe`). Sessions and runs must proceed as before, and drive must say so. Task 1 covers the impossible-job run and probe; Task 3 covers the `containment:` line.
5. **Ctrl+C in a foreground drive**, with the host between drive and the session. The session's processes must end, and drive must report `stopped`. This needs a real console — Task 9's probe.

---

## File Structure

| File | Change |
|---|---|
| `src/contain.ts` | **new** — `JOB_SCRIPT`, `winArg`, `jobTail`, `contained`, `jobHost`, `containmentLine` |
| `src/spawn.ts` | export `crtQuote` |
| `src/runner.ts` | `runCommand` through the host on win32 |
| `src/runner-lock.ts` | `releaseDeadTurn` |
| `src/drive.ts` | session through the host; group SIGKILL on every exit; `containment:` line; dead turn released |
| `src/reviewer.ts` | `prepareInvocation` through the host |
| `src/verbs/turn.ts` | **new** — `witness turn -- <command> [args…]` |
| `src/cli.ts` | register `turn`; help reads only what precedes `--` |
| `plugin/skills/witness-implement/SKILL.md`, `plugin/skills/witness-ship/SKILL.md` | test runs through `witness turn` |
| `DESIGN.md`, `README.md` | row 218, Open / deferred, verbs table, the `drive` paragraph |
| `tests/contain.test.ts` | **new** |
| `tests/helpers.ts` | `writeOrphanStarter`, `orphansIn`, `awaitGone` |
| `tests/global-setup.ts` | build with `tsc` through node, so the suite starts on Windows |
| `tests/spawn.test.ts`, `tests/runner-exec.test.ts`, `tests/drive.test.ts`, `tests/skills.test.ts` | the tests below |

---

### Task 0: Branch, both test runners, the Windows baseline

The worktree `../witness-issue-75` is on branch `issue-75-drive-leftovers` at `origin/main` `35b8a81`, with no upstream. `pnpm install` has run there.

- [ ] **Step 1: Commit the plan**

```bash
git add docs/superpowers/plans/2026-10-31-issue-75-drive-leftovers.md
git commit -m "docs: plan for issue #75 — what a run starts ends with it (row 218)"
```

- [ ] **Step 2: Let the suite start on Windows**

In `tests/global-setup.ts`, with `const root = resolve(import.meta.dirname, '..')`, the build becomes `execFileSync(process.execPath, [resolve(root, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd: root, stdio: 'ignore' })`. That is the `tsc` that `npm run build` runs, minus `npm`, which `execFileSync` cannot start on Windows (E8). The comment above it gains that reason.

Run: `pnpm vitest run tests/verb-usage.test.ts`
Expected: on Windows, `1 passed`. Before this step the run stops in global setup with `spawnSync npm ENOENT`.

```bash
git add tests/global-setup.ts
git commit -m "test: build dist with tsc through node, so the suite starts on Windows (row 218)"
```

- [ ] **Step 3: The two runners, kept outside the repo**

Both scripts sit in `%TEMP%\witness75\` from the planning session, where each was run. If they are gone, write them again from this text.

`$TEMP/witness75/linux-test.sh` runs vitest on Linux, the way CI does:

```sh
#!/bin/sh
# Runs `vitest run <args>` on Linux — node:20, as CI — over this checkout's tracked and new
# files. The files go in through tar, not a bind mount: a worktree's .git names a Windows path.
# The pnpm store lives in a named volume, so a run after the first installs in seconds.
cd "$(git rev-parse --show-toplevel)" || exit 2
git ls-files -co --exclude-standard | tar -cf - -T - |
  docker run --rm -i -e CI=1 -e npm_config_store_dir=/pnpm-store -v witness-pnpm-store:/pnpm-store node:20 bash -c '
    mkdir /w && tar -C /w -xf - && cd /w &&
    git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm base &&
    corepack enable &&
    { pnpm install --frozen-lockfile >/tmp/install.log 2>&1 || { tail -20 /tmp/install.log; exit 9; }; } &&
    pnpm exec vitest run "$@"' bash "$@"
```

`$TEMP/witness75/win-test.sh` runs vitest here, and prints only the failures the Windows baseline lacks:

```sh
#!/bin/sh
# Runs `vitest run <args>` on this Windows checkout and prints every failing test the baseline
# lacks; exit 0 means none. `--baseline <args>` records the failures as the baseline instead.
dir="${TEMP:-/tmp}/witness75"; base="$dir/win-baseline.txt"; log="$dir/win-last.log"; now="$dir/win-now.txt"
mkdir -p "$dir"
record=; [ "$1" = --baseline ] && { record=1; shift; }
cd "$(git rev-parse --show-toplevel)" || exit 2
pnpm exec vitest run "$@" > "$log" 2>&1
sed -e 's/\x1b\[[0-9;]*m//g' "$log" | grep -E '^ +× ' | sed -e 's/^ *× //' -e 's/ [0-9]*ms$//' | sort -u > "$now"
sed -e 's/\x1b\[[0-9;]*m//g' "$log" | grep -E 'Test Files|Tests '
if [ -n "$record" ]; then cp "$now" "$base"; echo "baseline: $(wc -l < "$base") failing"; exit 0; fi
new=$(comm -13 "$base" "$now")
[ -z "$new" ] && { echo "no failure beyond the baseline"; exit 0; }
echo "new failures:"; echo "$new"; exit 1
```

Run: `sh "$TEMP/witness75/linux-test.sh" tests/verb-usage.test.ts`
Expected: `Tests  1 passed (1)`.

- [ ] **Step 4: Record the Windows baseline, before any change to `src/`**

Run: `sh "$TEMP/witness75/win-test.sh" --baseline tests/spawn.test.ts tests/console.test.ts tests/runner-exec.test.ts tests/runner-full.test.ts tests/regression-check.test.ts tests/ship-lanes.test.ts tests/evidence.test.ts tests/drive.test.ts tests/drive-pause.test.ts tests/drive-report.test.ts tests/cli.test.ts tests/verb-usage.test.ts tests/reviewer.test.ts tests/reviewer-guard.test.ts tests/battery.test.ts tests/skills.test.ts tests/settings-docs.test.ts`
Expected: `baseline: <n> failing`. The list includes E8's 80 in `drive.test.ts` and 4 in `runner-exec.test.ts`. Every task's Windows run is compared against it.

### Task 1: The job host

**Files:**
- Create: `src/contain.ts`, `tests/contain.test.ts`
- Modify: `src/spawn.ts` (export `crtQuote`), `tests/helpers.ts`, `tests/spawn.test.ts` (the win32 block)

**Interfaces — Produces:**
- `export const JOB_HOST_ENV = 'WITNESS_JOB_HOST'` — the value is `'job' | 'none'`, a parent's probe answer
- `export const JOB_PROBE_EXIT = 86`
- `export const JOB_SCRIPT: string`
- `export type JobHost = { ok: true; file: string } | { ok: false; why: string }`
- `export function winArg(arg: string): string` — libuv's `quote_cmd_arg`
- `export function jobTail(run: ResolvedSpawn): string` — the command line after the program name
- `export function contained(run: ResolvedSpawn, host: JobHost): ResolvedSpawn`
- `export function jobHost(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): JobHost`
- `export function containmentLine(host: JobHost, platform: NodeJS.Platform = process.platform): string`
- `tests/helpers.ts`:
  - `writeOrphanStarter(dir: string): string` — returns the starter's path
  - `orphansIn(pidFile: string): number[]` — every pid the file names; `[]` when the file is absent
  - `awaitGone(pid: number, ms = 5_000): Promise<boolean>` — polls `process.kill(pid, 0)` every 100 ms

- [ ] **Step 1: Write the failing tests**

`tests/helpers.ts` gains the stand-in every Windows test uses, a suite starting its app and moving on:

```ts
// Row 218. What a suite does with its app: start it detached, unref'd, and move on. Appends
// `orphan <pid>` and `starter <pid>` to the pid file, then exits — or, given `stay`, runs on.
export function writeOrphanStarter(dir: string): string {
  const file = join(dir, 'starter.cjs')
  writeFileSync(file, [
    "const { spawn } = require('node:child_process')",
    "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore', windowsHide: true })",
    'c.unref()',
    "require('node:fs').appendFileSync(process.argv[2], `orphan ${c.pid}\\nstarter ${process.pid}\\n`)",
    "if (process.argv[3] === 'stay') setInterval(() => {}, 1000)",
  ].join('\n'))
  return file
}
```

In `tests/contain.test.ts`, on every OS:

```ts
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const host: JobHost = { ok: true, file: PS }
const batch: ResolvedSpawn = {
  file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/v:off', '/s', '/c', '""C:\\x\\pi.cmd" ^^^"-p^^^""'],
  env: { A: '1', PSModulePath: 'C:\\m' }, windowsVerbatimArguments: true,
}

describe('contained — the job host, built on any OS (row 218)', () => {
  it('a batch run goes through System32 PowerShell, its command line in the environment, verbatim', () => {
    expect(contained(batch, host)).toEqual({
      file: PS, args: ['-NoProfile', '-NonInteractive', '-Command', JOB_SCRIPT],
      env: { A: '1', PSModulePath: 'C:\\m', WITNESS_JOB_FILE: batch.file, WITNESS_JOB_ARGS: batch.args.join(' '), WITNESS_JOB_PSMODULEPATH: 'C:\\m' },
      windowsVerbatimArguments: false,
    })
  })
  it('an image run carries its arguments quoted the way libuv quotes them', () => {
    const run = { file: 'C:\\n\\node.exe', args: ['-e', 'a b', ''], env: {}, windowsVerbatimArguments: false }
    expect(contained(run, host).env).toMatchObject({ WITNESS_JOB_ARGS: '-e "a b" ""', WITNESS_JOB_PSMODULEPATH: '' })
  })
  it('with no host the run is the run', () => {
    expect(contained(batch, { ok: false, why: 'x' })).toBe(batch)
  })
  it('never passes -ExecutionPolicy, and never allows silent breakaway', () => {
    expect(contained(batch, host).args).not.toContain('-ExecutionPolicy')
    expect(JOB_SCRIPT).toContain('$b.LimitFlags = 0x2800')
  })
})

describe("winArg — libuv's quote_cmd_arg", () => {
  it.each([
    ['', '""'], ['hello', 'hello'], ['hello world', '"hello world"'], ['hello\\world', 'hello\\world'],
    ['hello"world', '"hello\\"world"'], ['hello""world', '"hello\\"\\"world"'],
    ['hello\\"world', '"hello\\\\\\"world"'], ['hello world\\', '"hello world\\\\"'], ['a\tb', '"a\tb"'],
  ])('%j → %j', (arg, want) => expect(winArg(arg)).toBe(want))
})

describe('jobHost', () => {
  it('off win32 there is none, and nothing is probed', () => {
    expect(jobHost({}, 'linux')).toEqual({ ok: false, why: 'no job objects on linux' })
  })
  it("a parent's answer is taken as given", () => {
    expect(jobHost({ WITNESS_JOB_HOST: 'job', SystemRoot: 'D:\\W' }, 'win32'))
      .toEqual({ ok: true, file: 'D:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' })
    expect(jobHost({ WITNESS_JOB_HOST: 'none' }, 'win32').ok).toBe(false)
  })
})

describe('containmentLine', () => {
  it('names what ends a session on each platform', () => {
    expect(containmentLine(host, 'win32')).toBe("containment: job objects — what drive's work starts ends with it")
    expect(containmentLine({ ok: false, why: 'Add-Type blocked' }, 'win32'))
      .toBe("containment: none — Add-Type blocked · a stopped session's tree is still stopped")
    expect(containmentLine({ ok: false, why: 'x' }, 'linux'))
      .toBe('containment: process groups — what a session starts ends with it, unless it leaves the group')
  })
})
```

Also in `tests/contain.test.ts`, a Windows-only block, `describe.runIf(process.platform === 'win32')('the job host on Windows (row 218)')`. Its fixtures:
- `nodeRun(args)` is `{ file: process.execPath, args, env: process.env, windowsVerbatimArguments: false }`;
- `host` is `jobHost(process.env)`;
- an `afterEach` kills every pid the test recorded, so a red run leaves nothing behind.

Its tests:
- `it('the probe finds a host on this machine')` — with `WITNESS_JOB_HOST` deleted from the env, `jobHost(env).ok` is `true`.
- `it('a run that ends leaves nothing it started — the orphan included')`
  - `spawnSync` of `contained(nodeRun(['-e', <execFileSync the starter with the pid file, then process.exit(9)>, starter, pidFile]), host)`.
  - `status` is 9, and `await awaitGone(pid)` is `true` for each pid in `orphansIn(pidFile)`.
- `it('a host killed alone takes the whole run with it')`
  - The same run with the starter's `stay`, started with `spawn`.
  - Once `orphansIn` has two pids, `taskkill /PID <host pid> /F` (no `/T`). Both pids are gone.
- `it('exit codes cross the host unchanged')` — for each of `[0, 1, 3, 255, 0xC000013A]`, the hosted `node -e "process.exit(c)"` `.status` equals the direct run's `.status`.
- `it("the command sees the caller's environment, not the host's")`
  - The hosted command is `node -e` printing `JSON.stringify(process.env)`, run with `WitnessMixedCase: 'MiXeD'` and `PSModulePath: 'C:\\caller'` added to the env.
  - Expect: no key starting `WITNESS_JOB_`, no `PSExecutionPolicyPreference`, `PSModulePath` is `'C:\\caller'`, and `WitnessMixedCase` is `'MiXeD'`.
- `it('a job it cannot enter costs containment, never the run')`
  - Run as the host the script `JOB_SCRIPT.replace('public static extern IntPtr CreateJobObject(', 'public static extern IntPtr CreateJobObjectX(')`, on `node -e "process.exit(4)"`.
  - `status` is 4, and `stderr` matches `/^witness: no job \(/`.
  - The same script with `WITNESS_JOB_PROBE: '1'` exits with `JOB_PROBE_EXIT`.

In `tests/spawn.test.ts`, inside the existing `resolveSpawn against the real cmd.exe (win32 only)` block, which reuses `shimmed`, `ECHO_ARGV`, `ADVERSARIAL` and `envWith`:

```ts
it('delivers every argument through the job host byte for byte (row 218)', () => {
  const dir = shimmed('echoargs', ECHO_ARGV)
  const host = jobHost(process.env)
  const runs = [
    resolveSpawn('echoargs', ADVERSARIAL, envWith(dir)),                                   // batch: verbatim
    resolveSpawn(process.execPath, [join(dir, 'echoargs.js'), ...ADVERSARIAL], envWith(dir)), // image: libuv quoting
  ]
  for (const run of runs) {
    if (!run.ok) throw new Error('resolve')
    const hosted = contained(run.value, host)
    const r = spawnSync(hosted.file, hosted.args, { env: hosted.env, encoding: 'utf8', windowsVerbatimArguments: hosted.windowsVerbatimArguments })
    expect(r.stderr).toBe('')
    expect(JSON.parse(r.stdout)).toEqual(ADVERSARIAL)
  }
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run tests/contain.test.ts tests/spawn.test.ts`
Expected: FAIL, `Cannot find module '../src/contain.js'`.

- [ ] **Step 3: Implement `src/contain.ts`, and export `crtQuote` from `src/spawn.ts` (nothing else changes there)**

The script is fixed copy. H6 ran this exact text:

```ts
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
  'if ($env:WITNESS_JOB_PROBE) { if ($held) { exit 0 } else { exit 86 } }',
  '$psi = New-Object System.Diagnostics.ProcessStartInfo',
  '$psi.FileName = $env:WITNESS_JOB_FILE',
  '$psi.Arguments = $env:WITNESS_JOB_ARGS',
  '$psi.UseShellExecute = $false',
  "if ($env:WITNESS_JOB_PSMODULEPATH) { $psi.EnvironmentVariables['PSModulePath'] = $env:WITNESS_JOB_PSMODULEPATH } else { $psi.EnvironmentVariables.Remove('PSModulePath') }",
  "foreach ($n in 'WITNESS_JOB_FILE', 'WITNESS_JOB_ARGS', 'WITNESS_JOB_PSMODULEPATH') { $psi.EnvironmentVariables.Remove($n) }",
  '$p = [System.Diagnostics.Process]::Start($psi)',
  '$p.WaitForExit()',
  'exit $p.ExitCode',
].join('\n')
```

The functions:
- **`winArg(arg)`** is `arg === '' || /[ \t"]/.test(arg) ? crtQuote(arg) : arg`.
- **`jobTail(run)`** is `run.args.join(' ')` when `run.windowsVerbatimArguments` is set, else `run.args.map(winArg).join(' ')`.
- **`contained(run, host)`**:
  - with `host.ok === false`, return `run` itself;
  - otherwise return `{ file: host.file, args: ['-NoProfile', '-NonInteractive', '-Command', JOB_SCRIPT], env, windowsVerbatimArguments: false }`, where `env` is `{ ...run.env, WITNESS_JOB_FILE: run.file, WITNESS_JOB_ARGS: jobTail(run), WITNESS_JOB_PSMODULEPATH: envGet(run.env, 'PSMODULEPATH') ?? '' }`.
- **`jobHost(env, platform)`**:
  1. Off win32, return `` { ok: false, why: `no job objects on ${platform}` } ``.
  2. If `env.WITNESS_JOB_HOST` is `'job'`, return `{ ok: true, file: system32(env, 'WindowsPowerShell', 'v1.0', 'powershell.exe') }`.
  3. If it is `'none'`, return `{ ok: false, why: 'the drive that started this run found none' }`.
  4. Otherwise return this process's cached probe answer. If there is none yet, probe:
     - the file does not exist (`existsSync`) → `` { ok: false, why: `${file} not found` } ``;
     - otherwise run `spawnSync(file, ['-NoProfile', '-NonInteractive', '-Command', JOB_SCRIPT], { env: { ...env, WITNESS_JOB_PROBE: '1' }, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000 })`;
     - exit 0 → ok; anything else → `` { ok: false, why: <the first stderr line, at most 200 chars> || r.error?.message || `exit ${r.status}` } ``;
     - cache that answer either way.
- **`containmentLine`** returns the three strings the test pins.

The header comment is in this file's own words: row 218, why (E2), and D1, D2 and D4.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run tests/contain.test.ts tests/spawn.test.ts`
Expected: PASS. On Linux the win32 blocks are skipped.

- [ ] **Step 5: Commit**

```bash
git add src/contain.ts src/spawn.ts tests/contain.test.ts tests/helpers.ts tests/spawn.test.ts
git commit -m "feat(contain): a job host — what a command starts ends with it (row 218)"
```

### Task 2: A test run ends with what it started

**Files:**
- Modify: `src/runner.ts`
- Test: `tests/runner-exec.test.ts`

**Interfaces:**
- **Consumes:** `jobHost`, `contained`, `JOB_HOST_ENV` (Task 1); `system32` and `execFileSync` from `./spawn.js`.
- **Produces:** nothing new in `src/` — `execCommand(runRoot, ctx, cmd): RunOutcome` keeps its contract. In `tests/runner-exec.test.ts`: `const TSX_LOADER = pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href`, which Task 5 reuses.

- [ ] **Step 1: Write the failing tests**

A new block, `describe.runIf(process.platform === 'win32')('a test run ends with what it started (row 218, win32)')`. The env is `{ ...process.env, ...fixtureEnv() }`.

- `it('an app the run started detached, through a starter that exited, is gone when execCommand returns')`
  - `` execCommand(repo.root, ctx, `node "${writeOrphanStarter(dir)}" "${pidFile}"`) `` → `exitZero` is `true`.
  - Every pid in `orphansIn(pidFile)` → `awaitGone` is `true`.
- `it('a turn holder killed alone takes its run with it')`
  - A child, started with `spawn` (async), is `node --import ${TSX_LOADER} -e <script>`. The script imports `execCommand` and runs the starter with `stay` inside a `tmpRepo()`.
  - On Windows an ESM specifier must be a URL, so the module is imported by `pathToFileURL(join(REPO, 'src', 'runner.ts')).href`. Every path in the script goes in through `JSON.stringify` (E8).
  - Once `orphansIn(pidFile)` has two pids, run `taskkill /PID <child pid> /F` (no `/T`).
  - Both pids are gone.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run tests/runner-exec.test.ts`
Expected: on Windows, FAIL — the orphan is alive after `execSync` returns.

- [ ] **Step 3: Implement `runCommand` on win32**

- Get the host: `const host = jobHost(ctx.env)`.
- Build the run: `` const run = contained({ file: system32(ctx.env, 'cmd.exe'), args: ['/d', '/s', '/c', `"${cmd}"`], env: { ...ctx.env, [JOB_HOST_ENV]: host.ok ? 'job' : 'none' }, windowsVerbatimArguments: true }, host) ``.
- Start it: `execFileSync(run.file, run.args, { cwd: runRoot, env: run.env, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024, windowsVerbatimArguments: run.windowsVerbatimArguments })`.
- The catch is unchanged: `execFileSync`'s error carries the same `stdout` and `stderr`.
- With no host, print this once per process with `ctx.err`: `runner: no job (<why>) — what this run starts may outlive it`.
- Off win32, keep today's `execSync` exactly.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run tests/runner-exec.test.ts tests/runner-full.test.ts tests/regression-check.test.ts tests/ship-lanes.test.ts tests/evidence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runner.ts tests/runner-exec.test.ts
git commit -m "fix(runner): a test run's job ends what it started, even a detached app (row 218)"
```

### Task 3: A session ends with what it started

**Files:**
- Modify: `src/drive.ts`
- Test: `tests/drive.test.ts`, `tests/spawn.test.ts` (the win32 block)

**Interfaces:**
- **Consumes:** `jobHost`, `contained`, `containmentLine`, `JOB_HOST_ENV` (Task 1).
- `spawnSession`'s and `driveLoop`'s signatures are unchanged.

- [ ] **Step 1: Write the failing tests**

In `tests/drive.test.ts`:

```ts
it.skipIf(process.platform === 'win32')('a session that exits on its own takes what it started with it (row 218)', async () => {
  const repo = await seededRepo()
  const lines: string[] = []
  const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent('sleep 30 &\necho "bg $!"\nexit 0') }, out: (l) => lines.push(l) })
  expect((await spawnSession({ kind: 'spawn', home: repo.root }, cfgOf(repo), ctx, 1)).outcome).toBe('exited')
  const pid = Number(lines.map((l) => /\] bg (\d+)$/.exec(l)?.[1]).find(Boolean))
  expect(await awaitGone(pid)).toBe(true)
}, 20000)
```

Also `it('drive says what ends a session (row 218)')`, on both hosts. On a `seededRepo()`, `driveLoop(repo.root, cfgOf(repo), ttyCtx(repo, {}, out), { maxSpawns: 0 })` prints `containmentLine(jobHost(fixtureEnv()))` among its lines. The line comes before any session, and `maxSpawns: 0` starts none, so no fake agent runs.

In `tests/spawn.test.ts`, in `the harness spawn sites reach a .cmd CLI (win32 only)`, add `it('a .cmd agent session leaves no orphan behind — exited or timed out (row 218)')`:
- The agent is a `shimmed('agent', …)` script. It runs the starter with `execFileSync`, with a pid file passed through the env, then exits — or, with `HANG=1` in the env, hangs.
- Run 1: the outcome is `'exited'`.
- Run 2: `sessionTimeoutMs: 3000`, and the outcome is `'timeout'`.
- After each run, every pid in the file is gone.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run tests/drive.test.ts tests/spawn.test.ts`
Expected:
- Linux: FAIL — `sleep` outlives the session.
- Windows: FAIL — the orphan outlives both runs.
- Both: FAIL — there is no `containment:` line.

- [ ] **Step 3: Implement in `src/drive.ts`**

- **`spawnSession`:**
  - Get the host: `const host = jobHost(ctx.env)`.
  - On win32, add `[JOB_HOST_ENV]: host.ok ? 'job' : 'none'` to `childEnv`.
  - After `resolveSpawn`, wrap the run: `const spawned = contained(run.value, host)`.
  - Spawn `spawned`'s file, args, env and `windowsVerbatimArguments`.
  - Stop it through `signalSession(child, grouped, spawned.env, sig)`.
- **`child.on('exit')`:** send `signal('SIGKILL')` whatever the outcome. The comment says that what a session started goes with it, however it ended (row 218). On win32 the job already closed with the host, and `signalSession` sends nothing once the child has exited.
- **`driveLoop`:** right after the `keep-awake:` line (`:928`), add `ctx.out(containmentLine(jobHost(ctx.env)))`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run tests/drive.test.ts tests/drive-pause.test.ts tests/drive-report.test.ts tests/console.test.ts tests/spawn.test.ts`
Expected: PASS. The existing `returns when the session exits even if a grandchild still holds the pipe` still passes, sooner.

- [ ] **Step 5: Commit**

```bash
git add src/drive.ts tests/drive.test.ts tests/spawn.test.ts
git commit -m "fix(drive): a session's job or group ends what it started, however it ended (row 218)"
```

### Task 4: Drive releases a dead holder's turn

**Files:**
- Modify: `src/runner-lock.ts`, `src/drive.ts`
- Test: `tests/runner-exec.test.ts`, `tests/drive.test.ts`

**Interfaces — Produces:** `export function releaseDeadTurn(root: string): boolean`. It returns `true` only when it removed a turn whose holder is dead. A live holder's turn, an unreadable one (a write in progress), or no turn at all → `false`, and the file is left alone.

- [ ] **Step 1: Write the failing tests**

```ts
it("releaseDeadTurn removes a dead holder's turn and nothing else (row 218)", () => {
  const repo = tmpRepo()
  const p = runnerLockPath(repo.root)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify({ pid: 999_999 })); expect(releaseDeadTurn(repo.root)).toBe(true); expect(existsSync(p)).toBe(false)
  writeFileSync(p, JSON.stringify({ pid: process.pid })); expect(releaseDeadTurn(repo.root)).toBe(false); expect(existsSync(p)).toBe(true)
  writeFileSync(p, ''); expect(releaseDeadTurn(repo.root)).toBe(false); expect(existsSync(p)).toBe(true)
})
```

In `tests/drive.test.ts`, add `it('a turn a dead holder left is gone once drive has run (row 218)')`. Seed a repo with `.witness/runner.lock` set to `{ "pid": 999999 }`. After `driveLoop(repo.root, cfgOf(repo), ttyCtx(repo, {}, out), { maxSpawns: 0 })`, the file is gone.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run tests/runner-exec.test.ts tests/drive.test.ts`
Expected: FAIL — `releaseDeadTurn` is not exported.

- [ ] **Step 3: Implement `releaseDeadTurn`, and call it from drive**

- **`releaseDeadTurn`:** when `holderOf(p)` is a number and `!isAlive(holder)`, return `takeStale(p, (text) => pidOf(text) === holder) === 'taken'`. A throw returns `false`.
- **In `src/drive.ts`**, call `releaseDeadTurn(root)` in two places:
  - once before the loop, beside the `publish()` at `:1019`;
  - after every `lanes.delete(key)` (`:1079`).

- [ ] **Step 4: Run the tests to see them pass**

Run: the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runner-lock.ts src/drive.ts tests/runner-exec.test.ts tests/drive.test.ts
git commit -m "fix(drive): a dead holder's runner turn is released at once (row 218)"
```

### Task 5: `witness turn`

**Files:**
- Create: `src/verbs/turn.ts`
- Modify: `src/cli.ts`
- Test: `tests/runner-exec.test.ts` (beside the B3 tests, reusing `twoWorktrees`)

**Interfaces — Produces:**
- The verb `turn`: `export async function run(ctx: Ctx, argv: string[]): Promise<number>`, with usage `witness turn -- <command> [args…]`.
- Its exit code is the command's own status.
  - A command killed by a signal exits `EXIT.FINDINGS`.
  - No command, or one that `resolveSpawn` refuses or `spawnSync` cannot start, exits `EXIT.REFUSED`.

- [ ] **Step 1: Write the failing tests**

One launcher serves every CLI child in this file: `cliChild(cwd: string, args: string[]): Promise<{ code: number | null; stderr: string }>`.
- It is `spawn(process.execPath, ['--import', TSX_LOADER, join(REPO, 'src', 'bin.ts'), ...args], { cwd, env: fixtureEnv(), stdio: ['ignore', 'ignore', 'pipe'] })`, resolving on `close`.
- `node_modules/.bin/tsx` is a `.cmd` on Windows (E8). So `evidenceChild(cwd, plan)` becomes `cliChild(cwd, ['test-evidence', plan, '--phase', 'red', '--step', 's1'])`, and `turnChild(cwd, cmd)` is `cliChild(cwd, ['turn', '--', ...cmd])`.

The tests:
- `it('witness turn runs a command in the repo turn: two worktrees take turns, and its exit is the command\'s (row 218)')`
  - Set up `twoWorktrees()`, then run `turnChild(wt, ['sh', 'turn.sh', id])` in both worktrees in parallel.
  - The codes are `[1, 1]`, because `turn.sh` exits 1.
  - The marks are `['start', 'end', 'start', 'end']`, and stderr contains `runner: waiting for pid`.
- `it('drive.parallelSuites: true lets witness turn runs overlap')` — the first two marks are `start, start`.
- `it('witness turn inside a turn re-enters it')`, on both hosts, so without `perl`:
  - A scenario dir holds `bounded.cjs`: `const r = require('node:child_process').spawnSync(process.argv[3], process.argv.slice(4), { stdio: 'inherit', timeout: Number(process.argv[2]) }); process.exit(r.status ?? 124)`. It bounds a deadlock as `perl`'s `alarm` does in the sibling test.
  - In a `tmpRepo()`, run `` execCommand(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), `node "${bounded}" 15000 node --import ${TSX_LOADER} "${join(REPO, 'src', 'bin.ts')}" turn -- node -e "console.log('inner-ran')"`) ``.
  - The output contains `inner-ran`, and `exitZero` is `true`.
- `it('refuses a turn with no command')`
  - `repo.cli(['turn'])` and `repo.cli(['turn', '--'])` each exit 2.
  - Their stderr is `usage: witness turn -- <command> [args…]`.
- `it("flags after -- are the command's, never witness's help")`
  - `repo.cli(['turn', '--', 'node', script, '--help'])`, where `script` exits 4.
  - The exit is 4, and no usage line is printed.
- `it.runIf(process.platform === 'win32')('what a witness turn run starts is gone when it returns')` — run `turnChild(root, ['node', starter, pidFile])`; every pid is gone.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run tests/runner-exec.test.ts`
Expected: FAIL — `unknown verb: turn`.

- [ ] **Step 3: Implement**

- **`src/cli.ts`:**
  - Add `turn: () => import('./verbs/turn.js')` to `VERBS`, and `turn: 'witness turn -- <command> [args…]'` to `VERB_USAGE`.
  - `helpRequested` (`:170`) and the per-verb help check (`:209`) read only the arguments before a `--` (D10).
- **`src/verbs/turn.ts`:**
  1. Take the command: `const cmd = argv[0] === '--' ? argv.slice(1) : argv`.
  2. If it is empty: `ctx.err('usage: witness turn -- <command> [args…]'); return EXIT.REFUSED`.
  3. Otherwise run `withRunnerTurn(ctx.cwd, ctx, cmd.join(' '), (env) => …)`. Inside the callback:
     - `resolveSpawn(cmd[0], cmd.slice(1), env)`. On a refusal, render it and return `EXIT.REFUSED`.
     - `const host = jobHost(env)`, then `contained(run, host)`, with `[JOB_HOST_ENV]` set on win32.
     - On win32 with no host, `ctx.err` the runner's `no job` line first.
     - `spawnSync(file, args, { cwd: ctx.cwd, env, stdio: 'inherit', windowsVerbatimArguments })`.
     - On a spawn error: `` ctx.err(`turn: ${cmd[0]}: ${error.message}`) `` and return `EXIT.REFUSED`.
     - Otherwise return `status ?? EXIT.FINDINGS`.
  4. There is no trust check (D7).

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run tests/runner-exec.test.ts tests/verb-usage.test.ts tests/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/turn.ts src/cli.ts tests/runner-exec.test.ts
git commit -m "feat(turn): witness turn — a session's own test run takes the repo's turn (row 218)"
```

### Task 6: A gate reviewer ends with what it started

**Files:**
- Modify: `src/reviewer.ts`
- Test: `tests/spawn.test.ts` (the win32 block)

**Interfaces:**
- **Consumes:** `jobHost`, `contained` (Task 1).
- `Prepared` keeps its shape. The sync and async invokers share it, so both are covered.

- [ ] **Step 1: Write the failing tests**

In `the harness spawn sites reach a .cmd CLI (win32 only)`:
- `it('a reviewer prompt larger than a pipe buffer crosses the job host intact (row 218)')`
  - Take `a gate reviewer reaches pi.cmd …` with `prompt = 'LENS say "hi" & 100% ^ !x! é 中文\n'.repeat(5000)`.
  - The `stdin` it reports equals the prompt.
- `it('a reviewer stopped at its timeout leaves nothing running (row 218)')`
  - A `pi` shim whose script appends `agent <pid>` to a pid file from the env, then starts the starter with `stay`: `spawn(process.execPath, [starter, pidFile, 'stay'], { stdio: 'ignore' })`, not detached. It never answers.
  - The fake exits on its own after 8 s. Without that bound, the red run would block the worker for good: the piped `spawnSync` returns only when the CLI exits (E2), and nothing asynchronous can fire meanwhile.
  - `invokeReviewer(…, { cwd, prompt: 'x', timeoutMs: 1500 })` refuses with `reviewer-timeout` (three attempts).
  - Every pid in the file is gone. An `afterEach` kills the recorded pids, so a red run cannot hang the next test.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run tests/spawn.test.ts`
Expected: on Windows, FAIL. Each attempt returns only when the fake exits at 8 s, about 25 s in all, and the orphan each attempt left is still alive.

- [ ] **Step 3: Implement**

In `prepareInvocation` (`src/reviewer.ts:186`), after `resolveSpawn`, add `const spawned = contained(run.value, jobHost(ctx.env))`. `Prepared` takes `spawned`'s file, args, env and `windowsVerbatimArguments`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run tests/spawn.test.ts tests/reviewer.test.ts tests/reviewer-guard.test.ts tests/battery.test.ts`
Expected: PASS. The existing win32 reviewer tests — the argv, the prompt on stdin, and the planted `node.cmd` that must lose — now run through the host and still pass.

- [ ] **Step 5: Commit**

```bash
git add src/reviewer.ts tests/spawn.test.ts
git commit -m "fix(reviewer): a stopped reviewer takes its agent with it (row 218)"
```

### Task 7: Skills run every test through `witness turn`

**Files:**
- Modify: `plugin/skills/witness-implement/SKILL.md`, `plugin/skills/witness-ship/SKILL.md`
- Test: `tests/skills.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// describe('witness-implement')
it('runs every test of its own through witness turn (row 218)', () => {
  expect(body()).toContain('never the spec tag — through `$WITNESS turn -- <test command>`')
  expect(body()).toContain('**Every test you run yourself goes through `$WITNESS turn --`**')
})
// describe('witness-ship')
it('checks a resolution through witness turn (row 218)', () => {
  const body = readFileSync(skillPath('witness-ship'), 'utf8')
  expect(body).toContain("<run the repo's tests locally through $WITNESS turn -- <test command> — the resolution must be green before it travels>")
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run tests/skills.test.ts`
Expected: FAIL on both new tests.

- [ ] **Step 3: Edit the skills. The text is fixed copy.**

- **implement, protocol step 1 (`:55`).** Replace "Run the inner TDD loop against exactly the test under work — `-t` with the test's own name, never the spec tag." with:

  > Run the inner TDD loop against exactly the test under work — `-t` with the test's own name, never the spec tag — through `$WITNESS turn -- <test command>`.

- **implement, a new paragraph between protocol item 7 and the paragraph that starts "After each step closes, act on `slice:`":**

  > **Every test you run yourself goes through `$WITNESS turn --`** — the inner loop, a probe test, a rerun. Suites share what a machine has one of (a port, an installed build, a certificate): `turn` makes two worktrees' runs take turns, waiting while another holds it, and on Windows ends whatever the run started. Lint and typecheck need no turn; `test-evidence` takes it itself.

- **ship, the recipe line inside the fenced block (`:63`).** It becomes, with no backticks:

  > `<run the repo's tests locally through $WITNESS turn -- <test command> — the resolution must be green before it travels>`

  And a new paragraph after the fenced block, before the one that starts "Conflicts touching `specs/` or `plans/` cannot happen":

  > Any test you run yourself — reproducing a failed lane, checking a resolution — goes through `$WITNESS turn -- <test command>`, so it takes turns with the other worktrees' runs.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run tests/skills.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/skills tests/skills.test.ts
git commit -m "docs(skills): a session's own test runs go through witness turn (row 218)"
```

### Task 8: The decision record

**Files:** `DESIGN.md` (row 218 after 217; Open / deferred), `README.md` (the verbs table; the `drive` paragraph).

- [ ] **Step 1: Add row 218 after row 217.** The row is one line in DESIGN.md: the first block below, a space, then the second. A `|` inside a cell is written `\|`, as everywhere else in DESIGN.md's table.

The first two cells, then **Choice:**

> | 218 ⊜ | What a run starts ends with it | Fixes issue #75; amends 181 and 201; touches 164, 211 and 217. **Containment.** `src/contain.ts` is the job host: System32's Windows PowerShell 5.1 (`-NoProfile -NonInteractive -Command`, never `-ExecutionPolicy`, which it would hand the command as `PSExecutionPolicyPreference=Bypass`) `Add-Type`s kernel32's job calls, enters a job object of its own — `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE \| JOB_OBJECT_LIMIT_BREAKAWAY_OK`, never silent breakaway — and only then starts the command from `WITNESS_JOB_FILE` and `WITNESS_JOB_ARGS` (the command line libuv would have built) with inherited stdio and the caller's `PSModulePath`; it waits and exits with the command's code. Whatever the command starts is born in the job — detached, orphaned by a starter that exited, started by an installer — and dies when the job's last handle closes: when the host exits after the command, or when the host dies, by a stop or with its parent's libuv job. On win32 drive's sessions, `execCommand`'s runs and the gate reviewers start through it, and their stops are unchanged. Drive probes the host once, says `containment:` beside `keep-awake:`, and tells each session (`WITNESS_JOB_HOST`), so nothing under it probes again; a machine where no job can be entered (Constrained Language Mode, no `powershell.exe`) runs everything as before. Off win32 drive kills a session's process group when it ends, however it ended. **Turns.** Drive releases a dead holder's turn when it starts and after every session. `witness turn -- <command> [args…]` runs one command in the repo's turn and, on win32, its job, and exits with its code; the implement and ship skills run every test a session runs itself through it. `main` reads `--help` only before a `--`. A gate reviewer's timeout now ends the CLI under the shim, which closes that gap in Open / deferred (a). The test suite's global setup builds with `tsc` through node, so the suite starts on Windows.

Then **Why:**

> | Issue #75, against 0.27.0 on Windows 11 with `drive.parallel: 2` and `parallelSuites: false`: app windows from the client suite piled up after the runs that opened them, `.witness/runner.lock` named a dead pid, and two worktrees' suites ran at once — one's cleanup uninstalled the other's app, and a ship session's test certificate "went missing twice". Each step costs two full-suite evidence runs of 10–15 min, and sessions ran suites of their own besides, so the 2 h session limit landed inside a test run; drive's stop was a `taskkill /T` walk from the shim, and the suite starts its app detached and its installer starts it and exits, so the app was linked to nothing the walk could find (measured: the orphan survived; its sibling under a live starter died). libuv's own job lets every grandchild out (row 201), a session that ended normally got no stop at all, a reviewer's stop took only its `cmd.exe`, and a turn's holder could die alone while its run went on and the turn read free. Turns were taken in `execCommand` only, while the implement skill sent sessions to run their inner loop themselves and the ship skill its local check. During the collision one session ran its client tests seven times and the other its whole suite in the background, both outside the turn. Measured on the reporting machine: a host-entered job took a detached orphan with it when the command ended, when only the host was killed, and when only the run's holder was killed; libuv's nested silent breakaway stopped at it with `BREAKAWAY_OK` set; stdout, a 210 KB stdin and exit codes crossed the host unchanged, and `set` matched once the host's own variables were stripped and `-ExecutionPolicy` dropped; the job is entered 180–250 ms after PowerShell starts, about 0.7 s a run. Rejected: a better tree walk (an orphan's link is gone), assigning after spawn (the agent starts before PowerShell can), a native addon, a compiled helper on disk, a guard against unturned test runs (it would have to tell a test from any other command, and the canon guard fails open, D133), and serial sessions under `parallelSuites: false`. MEASURED (Task 9). |

- [ ] **Step 2: Open / deferred.** After `Concurrent suites can collide under drive.parallelSuites: true.`, add:
  - **A test run outside `witness turn` takes no turn.** The implement and ship skills route every test a session runs through it; nothing enforces that. A guard would have to tell a test command from any other, and the canon guard fails open on ambiguity (D133) (row 218).
  - **Off Windows, what a session starts is reached through its process group.** A descendant that leaves the group (`setsid`, Node's `detached: true`) outlives the session. A test run or a reviewer has no group of its own: `execSync` runs in witness's (row 218).
  - **A process another running process starts belongs to that process.** Explorer (`explorer.exe <file>`, NSIS's `RunAsUser`), a COM server, a service or the Task Scheduler start their processes in their own job, not a session's (row 218).
  - **Machine state is the suite's to clean.** A job ends processes. An installed build, registry keys, toasts or a certificate that a killed suite left stay until its next run cleans them (row 218).
  - **A pid file names a pid, not a process.** Windows reuses pids within minutes (measured during row 218). A reused pid reads as a live holder of the repo lock, the drive lock or the runner turn. Drive releases a dead holder's turn at once, which narrows the turn's window (row 218).

  Then amend the item "Windows is not a CI platform":
  - In (a), the sentence that starts "And a timeout kills cmd.exe, not the CLI under it" and ends "drive's session stop takes the tree since row 201." becomes: "~~A timeout killed cmd.exe, not the CLI under it~~ — **closed by row 218**: a reviewer starts in a job, so its timeout ends the CLI as well."
  - In (a), "the line-break limit and the timeout gap with it" becomes "the line-break limit with it".
  - "(a)'s timeout residual and (g) are the ones that can hang it" becomes "(g) is the one that can hang it".
  - Before "Nothing left here stops the pipeline outright", add: "(j) the suite starts on Windows since row 218, but `drive.test.ts`'s fake agents are `#!/bin/sh` scripts, so 80 of its 106 tests fail there, and the dangling-symlink test needs a privilege Windows withholds by default."

- [ ] **Step 3: Update the README**

- **The verbs table.** After the `test-evidence … / verify-red …` row, add:

  > | `turn -- <command> [args…]` | run one command in the repo's test turn — it waits while another worktree's test run holds it, unless `drive.parallelSuites: true` — and on Windows inside a job object, so whatever it starts ends with it; exits with the command's code · the implement and ship skills run every test a session runs itself through it |

- **The `drive` paragraph (`:242`)** becomes:

  > **`drive`.** `drive.parallelSuites: false` makes test runs in two worktrees take turns — witness's own and every `witness turn`, which is how a session runs its tests — because suites that boot servers or browsers collide. On Windows each session, test run and gate reviewer runs in a job object, so whatever it starts — detached, or orphaned by an installer that exited — ends with it; elsewhere a session's process group does. A target that reaches any `drive.caps.*` bound is parked.

- [ ] **Step 4: Check the docs**

Run: `pnpm vitest run tests/settings-docs.test.ts`
Expected: PASS (no setting changed).

- [ ] **Step 5: Commit**

```bash
git add DESIGN.md README.md
git commit -m "docs: row 218 — what a run starts ends with it (issue #75)"
```

### Task 9: Verify, measure on Windows, ship, close

**Files:** none, except Step 2's measurement in `DESIGN.md`.

- [ ] **Step 1: Full verification at the branch tip, on both hosts**

```bash
sh "$TEMP/witness75/linux-test.sh" > "$TEMP/witness-218-linux.log" 2>&1; grep -E 'Test Files|Tests ' "$TEMP/witness-218-linux.log"
sh "$TEMP/witness75/win-test.sh" tests/contain.test.ts <Task 0 Step 4's file list>
pnpm run typecheck && pnpm run build && npx biome check .
```

Expected:
- Linux: the whole suite runs, as CI runs it, and `Tests` reports 0 failed.
- Windows: every win32 block passes, and the script prints `no failure beyond the baseline`.
- The other commands exit 0.

- [ ] **Step 2: The Windows probe — human, in the reporting repo, using this build**

With no drive running in that repo, run every command below as `node <checkout>\dist\bin.js …`, with `$env:WITNESS_BIN = "node <checkout>\dist\bin.js"` set.

1. **A real client test inside a job.** Run `… turn -- pnpm vitest run --project client apps/client/test/install-switcher.test.ts`.
   - Expected: it is green, with the WebView2 app, its installer and its uninstaller all running inside a job.
   - Afterwards, `Get-Process lowpro-test -ErrorAction SilentlyContinue` prints nothing, and no `msedgewebview2` process started during the run remains (compare `Get-Process msedgewebview2` before and after).
2. **The issue's own scenario.**
   - Start `… turn -- pnpm test`.
   - While `lowpro-test.exe` runs, run `taskkill /PID <that witness's pid> /F` (no `/T`).
   - Expected: within seconds there is no `lowpro-test.exe` and no `vitest` node from that run.
   - The next `… drive` starts with `.witness\runner.lock` gone.
3. **A parallel drive.** Run a drive with `drive.parallel: 2` until both sessions have run evidence.
   - Its opening lines include `containment: job objects — what drive's work starts ends with it`.
   - A session's output shows `runner: waiting for pid`.
   - After the drive ends, `Get-Process lowpro-test -ErrorAction SilentlyContinue` prints nothing, and no `pi` or node process from the run remains.
4. **Ctrl+C.** In Windows Terminal, run a foreground `… drive --manual` and press Ctrl+C mid-session.
   - Expected: no session process remains, and drive reports `drive: stopped — signal SIGINT`.
5. **A detached drive.** Run `… drive --detach` with row 201's window watcher running for two minutes.
   - Expected: no new console window.
   - Then `taskkill /PID <drive> /F` (no `/T`) leaves no `pi` and no node process from the run.

Replace `MEASURED (Task 9)` in row 218 with what was seen. Then commit:

```bash
git commit -am "docs(design): row 218's Windows measurement (issue #75)"
```

- [ ] **Step 3: Push and open the PR — only after the human says go**

```bash
git push -u origin issue-75-drive-leftovers
gh pr create --title "fix: what a run starts ends with it; a session's tests take the turn (issue #75, row 218)" --body-file "$TEMP/218-pr.md"
```

The PR body has four short sections:
- **Root cause:** E2–E4.
- **Fix:** Tasks 1–7.
- **Not changed:** the Open / deferred items.
- **Verification:** Step 1's counts and Step 2's measurement.

- [ ] **Step 4: Merge and release — only after the human says go**

The new verb makes this a minor release: run `pnpm release minor` from `main` once CI is green. A vitest flake before `npm publish` publishes nothing, so `gh run rerun <id> --failed` is safe.

- [ ] **Step 5: Close #75 — only after the human says go**

Comment on #75 with:
- the root cause, in two sentences;
- the fix;
- the release;
- the measurement.

Then close the issue, and move the reporting repo to the new release.
