# Autopilot B: `witness drive` runs everything (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship design §7 Part B (B1–B6) as witness 0.18.0:
- `witness drive` runs every session itself, from a terminal or from `/witness`, and under autonomy needs no terminal (B1);
- decisions settle in the CLI, conversations run headless, and a kept stop holds only its own target (B2);
- up to `drive.parallel` targets run side by side, and state writes wait for the lock (B3);
- usage limits are waited out and the machine stays awake (B4);
- what will not converge is parked at a named cap (B5);
- the run ends with one report and a desktop notification (B6).

**Architecture:**
- **One target per session.** Drive marks every child with `WITNESS_DRIVE=<target>`. The marker is the recursion guard: a marked session's `witness drive` is refused. It is also the child's scope: `computeNext` gains a `scope` filter, and a marked session's `next` answers for its target alone. Two sessions never share a target, and a root session never wanders into another lane's work.
- **The scheduler.** `driveLoop` fills its free slots by asking the same ladder with busy and set-aside targets filtered out, so D73's most-advanced-first order is the ladder's own. Progress is judged per target: the target's action and its streams. A stalled flow is therefore caught while another flow's journal grows. Set-asides live in memory and are never journaled (D145).
- **Decisions are A1's.** Before each fill, drive runs A1's `settleOwed` over every target no session holds, and a drive session's own `next` settles only its own target. So exactly one process settles each stop. Whatever `settleOwed` leaves for a human, drive sets aside.
- **Waiting instead of failing.** The repo lock polls for 30 s, and test-evidence takes it only for its write. A usage limit pauses drive, and under drive a reviewer call, until the reset. Both waits are bounded.
- **Caps and the report.** A cap parks its target through A1's `applyDecision` with `selected: 'policy'`. The report and the notification read the journal written since the run began, plus the state at its end.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), vitest 3, pnpm 10, POSIX `sh` fakes in `fixtures/fakebin/` and in test scenario dirs.

**Spec:** `docs/superpowers/specs/2026-10-19-autopilot-design.md` (§7 Part B; §2 E4 and E7; §10; §11 calls 5 and 11).

## Global Constraints

- Work on branch `autopilot-b-drive`, cut from `main` after A2 has merged (A2's `chore(release): 0.17.0` commit is on `main`).
- Write each behavior change's test first and watch it fail before writing code.
- Judge `pnpm test` by its AssertionError count, which must be 0, not by its exit code. A few worker-RPC timeouts make it exit 1 with every test green.
- No commas in new CLI output text. Use `·` and `—`. Text a human, a model or a provider wrote (an ask, a need, a limit message) is data and prints as written.
- Commit trailer, on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- DESIGN.md rows are **180–184**. 168 stays reserved. 169–179 belong to wave 1, A1 and A2.
- Release with `pnpm release minor`, which produces `0.18.0`. Both pushes, main and then the tag, are the human's.
- This plan changes only the witness repo. fewhats.com and every other consumer are read-only evidence; the release check runs against a throwaway clone.
- This plan owns every change to `src/drive.ts` and `src/verbs/drive.ts`. In `plugin/commands/witness.md` it adds to A1's autonomy conditional and A2's ask sentence and contradicts neither.
- Drive journals nothing of its own (D145). Set-asides, spawn counts, session time and waits live in memory. Every journaled act is a verb's, cap parks included.
- No autonomous `abandon`, and no new abandon path (§6, D168).
- Line numbers below are `main` at `3dcb9a2`. Wave 1, A1 and A2 shift some of them, so find each site by the code quoted beside it.

## Consumed from A1 and A2

These are reconciled against `docs/superpowers/plans/2026-10-19-autopilot-A1-decisions.md` and `…-A2-intake.md`. Where a signature lacks something this plan needs, it is extended with an optional parameter and never forked, which is A1's and A2's own rule.

- **A1 (0.16.0):**
  - `Config.autonomy: boolean`, from `autonomy: on | off`, default off. A run is **autonomous** when `cfg.autonomy && !manual`.
  - In `src/autonomy.ts`: `KeptStop` (`'design-look' | 'unmet-need' | 'trust-grant'`), `KEPT_STOP_NAMES` (design look · unmet need · trust grant) and `keptStopLine(stop, detail)`.
  - In `src/settle.ts`: `settleOwed(ctx, root, cfg): Promise<SettleReport[]>`, `settledLine(r)`, `SettleReport { gate, target, settled }` and `Settled` (`none · decided · routed · kept · left`). They are always loaded with `await import()`, as A1 requires of `gate.ts` and `next.ts`. Task 6 adds `settleOwed`'s optional `scope`. Under CI (`ctx.env.CI`) `settleOwed` returns `[]`, because CI never writes state. GitHub Actions sets `CI=true`, so every test that expects drive or `next` to settle runs them with `gateEnv(...)`, which clears it. A2's `71370cb` fixed exactly this failure, which passed locally and failed only on GitHub.
  - In `src/verbs/decide.ts`: `applyDecision(ctx, act: DecisionAct): Promise<number>`, with `DecisionCore`'s `runId`. Task 10 adds two optional fields, `park` and `rule`, for the cap park.
  - In `src/verbs/next.ts`: `owedDecisions(root, canon): OwedDecision[]` (`{ gate, target, bound }`), tier 2's own list.
  - `DecisionEntry.selected` is widened to `'affirmation' | 'policy' | 'arbiter'`.
  - `mergeOwnPr` (`src/ship.ts`) prints `merge PR #<n> on GitHub when ready` only when it leaves the merge to a human: autonomy is off when re-read at merge time, or off on the PR's base (`refs/witness/ship-authority`). Its held paths print `merge: held — …` instead. Drive's merge sniff therefore fires only where a human merges.
  - The trust stop's human act is running the stopped gate in a terminal, where `ensureTrusted` asks before each command.
  - `autonomyOn(repo)`, `plannedRepo(opts)` and `PLAN_BLOCKING` in `tests/helpers.ts`.
  - The engine's `## Under \`autonomy: on\`` section. Task 14's rows sit at the top of the action table and leave it as it is.
- **A2 (0.17.0):**
  - `queueAsk(ctx, root, text): Result<{ id: string; unanswered: number; already: boolean }>` and `ASK_STREAM` (`'asks'`) in `src/ask.ts`. `already` is true when the same open words already wait, and then the id is that ask's. `drive --ask` calls `queueAsk`.
  - The ask rung at the top of tier 3 carries no `target`, so Task 6's scope passes it `undefined`.
  - `unmetNeeds(canon): UnmetNeed[]` in `src/needs.ts`, with `{ doc, type, need, text, holds, blocks: 'start' | 'nothing', satisfy }`. Task 9 and the report read it.
  - Under autonomy, brainstorm and design authoring are no conversations, and the engine queues `/witness <words>` with `ask` before the first `next`.

## Review Focus

1. **A stalled target loops while another target's journal grows.** Today's guard compares the whole journal's line count, which any other lane's progress satisfies. A flow whose session does nothing must be set aside after one empty session, even while a second flow journals on every spawn. Pinned by Task 8's stall-under-concurrency test.
2. **Two sessions on one target.** A root session finishing its own work must never pick up another lane's ship. Drive must never run two sessions for one target, and a marked session's `next` must answer for its target alone. Pinned by Task 6's marked-session test and Task 8's two-at-once test.
3. **A kept stop that blocks unrelated work.** A ui spec waiting on its look sits in tier 2, ahead of every start. Drive must set it aside, start the other plan, and end a run made only of kept stops with exit 0. Pinned by Task 9's kept-stop tests.
4. **A cap that cannot park.** The common capped state is mid-revise: the author kept editing after the last `--revise`, so `decide`'s anchor rule finds nothing to dispose of. The flow must still be parked, under `selected: 'policy'` and the cap's rule, and no session may be spent past the cap. Pinned by Task 10's mid-revise test.
5. **A misread limit becomes an endless wait.** A message that only looks like a limit, or that repeats forever, must never wait past the run's total bound, and every wait must be printed. Pinned by Task 11's bound test and Task 4's not-a-limit cases.

## Builder's calls

Each of these is decided here (§10 leaves them to the builder):

- **Lanes:** at most one session per target, and at most `drive.parallel` sessions in all. Target-less work (brainstorm, the recovery fork) is one lane.
- **Parallelism:** `drive.parallel` defaults to 2 (§11 call 5). It applies only to autonomous runs. With autonomy off, `--manual` or `--flow`, drive is serial, because the `decide>` prompt and a claimed flow are one conversation.
- **Kept stops and waits:** a kept stop, a stop A1 left for a human, a conversation (autonomy off), a merge left to the human (autonomy off), a stuck target and a capped target are set aside for the run. None of them ends it. Under autonomy drive asks no decision question at all (B1), so a stop left for a human waits for the report.
- **Who settles a stop:** a target's own session, whose gate and scoped `next` settle it, or else drive, between sessions, through `settleOwed` scoped to the targets no session holds. A1's `next` settles repo-wide, and two sessions doing that at once would both judge one stop, so a drive session's `next` passes its scope.
- **Cap defaults,** from fewhats on 2026-10-19 (design B5 and E7, the journals, and the pi session logs):
  - `rounds: 16` is the largest normal merged plan's 13 implement rounds plus one budget window (ROUND_BOUND 3). It parks inbox-list-sync-plan-1 (20), thread-mirror-mirroring-plan-1 (63) and the abandoned thread-mirror-plan-1 (25). It spares thread-mirror-tap-plan-1, at 15 now.
  - `upstream: 6` is where the human abandoned thread-mirror-plan-1. Merged plans took at most 4, apart from the 63-round outlier's 16.
  - `spawns: 24` is half again over the busiest normal merged plan, signin-email-code-plan-1: 10 worktree sessions, plus 5 ship rounds, plus start, is 16.
  - `wallClockMs: 57600000` (16 h) clears the slowest normal merged plan, setup-card-plan-1 at ~14 h in worktree sessions (gaps that end at a human reply excluded). It parks inbox-list-sync-plan-1 (43 h) and the mirroring outlier (100 h).
- **When caps count:**
  - rounds and upstream are counted from the journal, so they hold across runs, and they restart after a cap park;
  - spawns and session time are this run's, in memory, like D145's ceiling;
  - caps are checked between sessions.
- **The spawn ceiling:** D145's `--max-spawns` stays. Its default stays 20 when autonomy is off. It is 200 when autonomy is on, which is the 203 sessions fewhats ran in the whole 33-day evidence window (§2). Under autonomy the per-target caps are the bound, and the ceiling is a backstop against accounting bugs.
- **The lock wait:** 30 s, polled every 50 ms. The longest legitimate holder is `sync`'s pull and push (sync.ts:62-104), while a refused gate throws away a whole battery. An unreadable lock is a write in progress.
- **Usage waits:**
  - a time-boxed limit waits until its reset plus 60 s;
  - a repeat backs off 15 → 30 → 60 min;
  - transient errors back off 1 → 30 min;
  - one wait is at most 6 h, one 5 h session window plus margin;
  - a run waits at most 12 h in total;
  - only shapes seen verbatim in fewhats's pi logs or claude 2.1.304's strings count.
- **Reviewer waits:** a reviewer call waits only inside a drive session. Outside drive it refuses `usage-limit` and names the reset, because an attended gate must not block silently for hours.
- **Keep-awake:** `caffeinate -ims -w <drive pid>` on macOS. Other platforms get a printed note.
- **Notification:** only for autonomous runs, because a human at a TTY prompt is already watching. The default is `osascript` on macOS and `notify-send` on Linux, and none on Windows.
- **Background start:** `/witness` launches drive through a `launch:` line that `next` prints. Drive runs `--detach`ed into `.witness/drive.log`, and `--detach` requires autonomy. One drive runs per repo, guarded by `.witness/drive.lock`.

---

### Task 0: Branch, and check A1's and A2's names

- [ ] **Step 1: Cut the branch after A2**

Run: `git checkout main && git log --oneline -1 --grep 'chore(release): 0.17.0' && git checkout -b autopilot-b-drive`
Expected: one commit line, then `Switched to a new branch 'autopilot-b-drive'`. No line means A2 has not merged: stop.

- [ ] **Step 2: Confirm the A1 and A2 names against the merged code**

Read A1's `src/autonomy.ts`, `src/settle.ts`, and its edits to `src/verbs/decide.ts`, `src/verbs/next.ts` and `plugin/commands/witness.md`. Read A2's `src/ask.ts` and `src/needs.ts`. This plan was reconciled against both plans. Wherever a name under **Consumed from A1 and A2** differs from what merged, edit this plan in place to the merged names and signatures.

- [ ] **Step 3: Commit revisions to this plan, if any**

This plan landed on `main` with wave 1's Task 0. On 2026-10-21 its **Consumed from A1 and A2** names were re-checked against the merged code, and those edits (`queueAsk`'s `already`, `mergeOwnPr`'s print paths, `settleOwed` under CI) sit uncommitted on `main`. Commit them together with any edits Step 2 made:

```bash
git add docs/superpowers/plans/2026-10-19-autopilot-B-drive.md
git commit -m "docs(autopilot): B plan — names as merged" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Drive settings and the machine-local notifier

**Files:**
- Modify: `src/config.ts:129-152` (`DriveConfig`, `resolveDrive`), `:178-233` (`LocalConfig`, `LOCAL_KEYS`, `loadLocalConfig`)
- Modify: `tests/helpers.ts:258-268` (`writeLocalConfig` takes `notify`)
- Modify: `tests/drive.test.ts:124,257`: `drive: { ...cfg.drive, sessionTimeoutMs: … }`, because the type grows
- Modify: `README.md`: the configuration table and the machine-config example
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces, in `src/config.ts`:

```ts
export const DEFAULT_PARALLEL = 2
export interface DriveCaps { rounds: number; upstream: number; spawns: number; wallClockMs: number }
export const DEFAULT_CAPS: DriveCaps = { rounds: 16, upstream: 6, spawns: 24, wallClockMs: 57_600_000 }
export interface DriveConfig { sessionTimeoutMs: number; parallel: number; parallelSuites: boolean; caps: DriveCaps }   // parallelSuites: Task 3b
export interface LocalConfig { reviewerExtensions: string[]; opener?: string; notify?: string }
```

- **Keys:**
  - `drive` holds `sessionTimeoutMs`, `parallel` and `caps`;
  - `drive.caps` holds `rounds`, `upstream`, `spawns` and `wallClockMs`;
  - any other key under either map refuses `unknown-drive-key`, with field `drive.<key>` or `drive.caps.<key>`. No consumer sets `drive:` today, so the strictness costs nobody.
- **Invalid values** refuse `invalid` (each must be an integer ≥ 1, and `drive.caps` must be a map). The wants, verbatim:
  - `drive.parallel`: `an integer >= 1 — sessions drive runs at once · one per target`
  - `drive.caps.rounds`: `an integer >= 1 — gate rounds one target may run across budget resets before drive parks it`
  - `drive.caps.upstream`: `an integer >= 1 — upstream resets one target may take before drive parks it`
  - `drive.caps.spawns`: `an integer >= 1 — sessions one target may take in one drive run`
  - `drive.caps.wallClockMs`: `an integer >= 1 — milliseconds of session time one target may take in one drive run`
  - `drive.caps`: `a map of cap settings`
  - `notify` (machine-local): `a command name or path — it receives the run summary as its one argument`
- `writeLocalConfig(root, opts: { opener?: string; reviewerExtensions?: string[]; notify?: string })`.
- **README rows:**
  - `drive.parallel`, then one row per cap with its default and the line *the run parks a target that reaches it*;
  - `notify:` joins the machine-config example with the comment `# optional; the run summary is its one argument · default: the platform notifier`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('drive settings (B3 · B5)', () => {
  const withDrive = async (yaml: string) => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', `${repo.read('witness.config.yaml')}drive:\n${yaml}`)
    return loadConfig(repo.root)
  }

  it('defaults parallel to 2 and the caps to the B5 calibration', async () => {
    const cfg = loadConfig((await seededRepo()).root)
    expect(cfg.ok && cfg.value.drive).toEqual({
      sessionTimeoutMs: 3_600_000, parallel: 2, parallelSuites: false,
      caps: { rounds: 16, upstream: 6, spawns: 24, wallClockMs: 57_600_000 },
    })
  })

  it('reads parallel and a partial caps map over the defaults', async () => {
    const cfg = await withDrive('  parallel: 3\n  caps:\n    rounds: 20\n')
    expect(cfg.ok && cfg.value.drive.parallel).toBe(3)
    expect(cfg.ok && cfg.value.drive.caps).toEqual({ rounds: 20, upstream: 6, spawns: 24, wallClockMs: 57_600_000 })
  })

  it.each([
    ['  parallel: 0\n', 'drive.parallel', 'invalid'],
    ['  caps:\n    spawns: 1.5\n', 'drive.caps.spawns', 'invalid'],
    ['  caps: 3\n', 'drive.caps', 'invalid'],
    ['  caps:\n    round: 9\n', 'drive.caps.round', 'unknown-drive-key'],
    ['  paralel: 2\n', 'drive.paralel', 'unknown-drive-key'],
  ])('refuses %j', async (yaml, field, rule) => {
    const cfg = await withDrive(yaml)
    expect(!cfg.ok && [cfg.violations[0]!.field, cfg.violations[0]!.rule]).toEqual([field, rule])
  })
})

describe('machine-local notify (B6)', () => {
  it('reads notify and refuses an empty one', async () => {
    const repo = await seededRepo()
    writeLocalConfig(repo.root, { notify: '/usr/local/bin/ping-me' })
    const ok = loadLocalConfig(repo.root)
    expect(ok.ok && ok.value.notify).toBe('/usr/local/bin/ping-me')
    repo.write('.witness/config.local.yaml', "notify: ''\n")
    const bad = loadLocalConfig(repo.root)
    expect(!bad.ok && [bad.violations[0]!.field, bad.violations[0]!.rule]).toEqual(['notify', 'invalid'])
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/config.test.ts`
Expected: FAIL. `drive` equals `{ sessionTimeoutMs: 3600000 }`, every refusal case loads, and `notify` is `unknown-local-key`.

- [ ] **Step 3: Implement as specified under Interfaces**

- [ ] **Step 4: Run the tests and watch them pass, then drive's**

Run: `pnpm vitest run tests/config.test.ts tests/drive.test.ts tests/check.test.ts && pnpm run typecheck`
Expected: PASS, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/helpers.ts tests/config.test.ts tests/drive.test.ts README.md
git commit -m "feat(config): drive.parallel · drive.caps · machine-local notify" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The repo lock waits for its holder

**Files:**
- Modify: `src/lock.ts:1-37`
- Modify: `tests/txn.test.ts:20-33`. The foreign-holder case passes `waitMs: 0`, or it would wait 30 s.
- Test: `tests/txn.test.ts`

**Interfaces:**
- Produces, in `src/lock.ts`:

```ts
export const LOCK_WAIT_MS = 30_000
export function isAlive(pid: number): boolean        // now exported · drive-presence.ts reuses it
export function acquireLock(root: string, pid = process.pid, waitMs = LOCK_WAIT_MS): Result<() => void>
```

- Every call site keeps its signature. The wait is synchronous, so no caller turns async: 50 ms polls through `Atomics.wait` on a `SharedArrayBuffer`.
- **The refusal:**
  - rule `locked`;
  - got `held by pid <n> · waited <waitMs>ms`;
  - want `one clone one writer — the other witness invocation held it past the wait · run this again when it finishes`.
- **An unreadable lock file is a write in progress:** `wx` creates the file empty before the pid lands. Poll it, and steal it only after it has stayed unreadable for 1 s. Today it is stolen at once, and with parallel flows that is two holders.
- Re-entry by the same pid stays as today: it is granted.

The loop, because the tests do not fix its order:

```ts
const t0 = Date.now()
let unreadableSince: number | undefined
for (;;) {
  try { writeFileSync(p, JSON.stringify({ pid }), { flag: 'wx' }); return ok(release) } catch { /* held */ }
  const holder = readHolder(p)                       // number | 'absent' | 'unreadable'
  if (holder === 'absent') continue                  // released between our write and our read
  if (holder === pid) return ok(release)
  if (holder === 'unreadable') {
    unreadableSince ??= Date.now()
    if (Date.now() - unreadableSince >= 1_000) { rmSync(p, { force: true }); unreadableSince = undefined; continue }
  } else if (!isAlive(holder)) { rmSync(p, { force: true }); continue }
  if (Date.now() - t0 >= waitMs) return refuse([/* the locked row */])
  pause(50)
}
```

- `readHolder(p)` returns the parsed pid, `'absent'` on `ENOENT`, and `'unreadable'` for anything else.
- `pause(ms)` is `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)`.

- [ ] **Step 1: Write the failing tests**

```ts
// A second process holds the lock: a same-process holder cannot let go while
// acquireLock's synchronous wait blocks the thread.
async function holdLock(root: string, ms: number): Promise<ChildProcess> {
  mkdirSync(join(root, '.witness'), { recursive: true })
  const child = spawn(process.execPath, ['-e', `
    const fs = require('fs'); const p = process.argv[1]
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid }), { flag: 'wx' })
    process.stdout.write('held\\n')
    setTimeout(() => { fs.rmSync(p, { force: true }); process.exit(0) }, ${ms})
  `, join(root, '.witness', 'lock')], { stdio: ['ignore', 'pipe', 'inherit'] })
  await once(child.stdout!, 'data')
  return child
}

describe('acquireLock waits (B3)', () => {
  it('waits for a live holder to let go, then takes the lock', async () => {
    const repo = seeded()
    await holdLock(repo.root, 400)
    const t0 = Date.now()
    const r = acquireLock(repo.root, process.pid, 5_000)
    expect(r.ok).toBe(true)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    if (r.ok) r.value()
  }, 15_000)

  it('refuses once the wait is spent and names the holder', async () => {
    const repo = seeded()
    const holder = await holdLock(repo.root, 5_000)
    const r = acquireLock(repo.root, process.pid, 300)
    expect(!r.ok && r.violations[0]!.rule).toBe('locked')
    expect(!r.ok && r.violations[0]!.got).toBe(`held by pid ${holder.pid} · waited 300ms`)
    holder.kill()
  }, 15_000)

  it('reads an unreadable lock as a write in progress and takes it after a grace', () => {
    const repo = seeded()
    repo.write('.witness/lock', '')
    const t0 = Date.now()
    const r = acquireLock(repo.root, process.pid, 5_000)
    expect(r.ok).toBe(true)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000)
    if (r.ok) r.value()
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/txn.test.ts`
Expected: FAIL. The first case refuses at once with `held by pid …`. The second has the old got text. The third takes the lock in under 1 s.

- [ ] **Step 3: Implement as specified under Interfaces**

- [ ] **Step 4: Run the tests and watch them pass, then every lock user's suite**

Run: `pnpm vitest run tests/txn.test.ts tests/gate-lock.test.ts tests/protocol/crash.test.ts tests/stamp.test.ts tests/sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lock.ts tests/txn.test.ts
git commit -m "feat(lock): state writes wait for the repo lock instead of refusing at once" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: test-evidence holds the lock for its write only

D76 says the lock wraps only the write window, and the design's B3 rests on that window being ~100 ms. `test-evidence` and `verify-red` hold it across the whole suite instead: `src/verbs/evidence.ts:35-53` and `:82-101` take it, then `recordEvidence` runs the runner inside it. That is 13–48 s per run with fewhats's filtered runner, and minutes with a full suite. Under parallel flows, every other flow's write would wait out the suite, or refuse after its battery.

**Files:**
- Modify: `src/evidence.ts:100-114`: `journalEvidence` takes the lock around its `withTxn`
- Modify: `src/verbs/evidence.ts:35-53,82-101`: drop the wide locks. A `locked` refusal from `recordEvidence` still exits `EXIT.BLOCKED` (3).
- Test: `tests/evidence.test.ts`

**Interfaces:**
- `journalEvidence(stateRoot, planId, phase, run, extra)` keeps its signature. It now returns the lock's refusal as its own.
- Nothing else moves. The suite and `verifyRed`'s stash-and-restore run unlocked in the plan's own worktree, which only that plan's session touches. Gate checks already run unlocked (`gate.ts:217` resolves before the lock at `:460`).

- [ ] **Step 1: Write the failing test**

```ts
it('test-evidence runs the suite outside the repo lock and journals inside it (D76 · B3)', async () => {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  approve(repo, 'auth-refresh-plan-1')
  await repo.cli(['start', 'auth-refresh-plan-1'])
  const wt = worktreePath(repo.root, 'auth-refresh-plan-1')
  const probe = join(fakeScenario(), 'probe')
  writeFileSync(join(wt, 'probe.sh'),
    `if [ -e "${repo.root}/.witness/lock" ]; then echo held; else echo free; fi > "${probe}"\nexit 1\n`)
  writeFileSync(join(wt, 'witness.config.yaml'), "schema: 1\ncriteria:\n  runner: 'sh probe.sh {id}'\n")
  const r = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red'], { cwd: wt, env: fixtureEnv() })
  expect(r.code).toBe(0)
  expect(readFileSync(probe, 'utf8').trim()).toBe('free')
  expect(readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'test-evidence')).toHaveLength(1)
  expect(existsSync(join(repo.root, '.witness', 'lock'))).toBe(false)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/evidence.test.ts`
Expected: FAIL with `expected 'held' to be 'free'`.

- [ ] **Step 3: Implement as specified under Interfaces**

- [ ] **Step 4: Run it and watch it pass, then the evidence suites**

Run: `pnpm vitest run tests/evidence.test.ts tests/verify-red.test.ts tests/evidence-for-diff.test.ts tests/protocol/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evidence.ts src/verbs/evidence.ts tests/evidence.test.ts
git commit -m "fix(evidence): run the suite outside the repo lock — the lock wraps the write (D76)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3b: Test runs take turns across worktrees (designer's call)

Task 3 lets two worktrees' suites overlap. fewhats's e2e boots a web server and a browser for each suite, so two suites at once can collide on a fixed port or a browser profile, and each collision costs a whole round. With wave 1's filtered runner a run takes 13–48 s, so taking turns costs seconds. Serialize from the start, in one place, so it can be relaxed later.

**Files:**
- Create: `src/runner-lock.ts`
- Modify: `src/runner.ts`. `execCommand` runs its command inside `withRunnerTurn`; its signature is unchanged.
- Modify: `src/config.ts`. `drive.parallelSuites` is a boolean, default `false`, and refuses `invalid` otherwise. Task 1 owns `resolveDrive`; add the key there.
- Test: `tests/runner-exec.test.ts`

**Interfaces:**
- `export function withRunnerTurn<T>(runRoot: string, ctx: Ctx, label: string, fn: () => T): T`:
  - It resolves `primaryRoot(runRoot)`, so every worktree of one repo shares one turn.
  - The turn is `.witness/runner.lock`, with the pid-and-liveness shape of `src/lock.ts`: the same pid re-enters, and a dead holder is taken over.
  - While a live pid holds it, it waits, polling every 200 ms with a synchronous sleep (`Atomics.wait` on a 4-byte `SharedArrayBuffer`). It prints `runner: waiting for pid <pid> · <label>` once to stderr, then runs `fn` and releases in `finally`.
  - **Bound:** the holder's own lifetime. A holder is a live process running one command, and its session's `drive.sessionTimeoutMs` kills it. A turn never refuses and never fakes a run outcome. A fake failed run would journal a false red.
  - When the primary root's `drive.parallelSuites` is `true`, it calls `fn()` directly.
- **What it covers:** every command witness runs goes through `execCommand`: `runFiltered`, `runFullSuite` and ship's `commandLane`. So evidence, gate checks, regression and ship lanes all take turns.

- [ ] **Step 1: Write the failing tests**

The turn is per pid, so the two runs must be separate processes. Start them with `tsx src/bin.ts`, as Task 13's detach test does; two in-process `repo.cli` calls share a pid.

```ts
it('test runs in two worktrees take turns and neither refuses (B3)', async () => {
  // two approved plans p1 and p2, both started: two worktrees. Each worktree's runner is
  // 'sh turn.sh {id}', which appends "start <id>" to one shared log, sleeps 1 and appends "end <id>".
  const [a, b] = await Promise.all([evidenceChild(wt1, 'p1'), evidenceChild(wt2, 'p2')])
  expect([a.code, b.code]).toEqual([0, 0])
  const marks = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')[0])
  expect(marks).toEqual(['start', 'end', 'start', 'end'])
  expect(`${a.stderr}${b.stderr}`).not.toContain('locked')
  expect(`${a.stderr}${b.stderr}`).toContain('runner: waiting for pid')
}, 60_000)
it('drive.parallelSuites: true lets them overlap', async () => {
  // same setup with drive: { parallelSuites: true }
  expect(marks.slice(0, 2)).toEqual(['start', 'start'])
}, 60_000)
it('a dead holder loses its turn', () => {
  writeFileSync(join(repo.root, '.witness', 'runner.lock'), JSON.stringify({ pid: 999_999 }))
  expect(withRunnerTurn(repo.root, fakeCtx(repo.root), 'x', () => 42)).toBe(42)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/runner-exec.test.ts`
Expected: FAIL. The two logs interleave as `start start end end`, and `withRunnerTurn` is not exported.

- [ ] **Step 3: Implement as specified under Interfaces**

- [ ] **Step 4: Run them and watch them pass, then the runner and evidence suites**

Run: `pnpm vitest run tests/runner-exec.test.ts tests/runner-full.test.ts tests/runner-parity.test.ts tests/evidence.test.ts tests/ship-lanes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runner-lock.ts src/runner.ts src/config.ts tests/runner-exec.test.ts
git commit -m "feat(runner): test runs take turns across worktrees" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Usage limits are recognized, conservatively (B4)

**Files:**
- Create: `src/usage.ts`
- Test: `tests/usage.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export type Limit =
  | { kind: 'usage'; text: string; resetAt?: number }   // epoch ms · absent when the reset did not parse
  | { kind: 'transient'; text: string }
export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export const realClock: Clock
export const USAGE_MARGIN_MS = 60_000
export const SINGLE_WAIT_MAX_MS = 21_600_000   // 6 h
export const TOTAL_WAIT_MAX_MS = 43_200_000    // 12 h
export function limitIn(text: string, now: number): Limit | undefined
export function sessionLimit(end: { code: number | null; tail: readonly string[] }, now: number): Limit | undefined
export function waitFor(limit: Limit, streak: number, now: number): number
export function duration(ms: number): string
```

- **The shapes,** each found per line. Anything else is not a limit:
  1. **usage:** a line containing `You've hit your <session|weekly|usage|5-hour|daily> limit · resets <when>`, with `’` or `'`. It may sit anywhere in the line, because a refusal's got prefixes it (`exit 1: …`). `<when>` is `[<Mon> <D>, ]<h>[:<mm>]<am|pm>[ (<IANA zone>)]`, or `in <h>h[ <m>m]`, or `in <m>m`. With no zone, the time is local. A `<when>` that does not parse leaves `resetAt` unset. fewhats's pi logs hold 11 of these, and claude 2.1.304's strings hold the template.
  2. **usage (claude's older form):** `Claude AI usage limit reached|<epoch seconds>`.
  3. **transient:** a line carrying `"type":"rate_limit_error"` or `"type":"overloaded_error"` (37 and 27 in the logs). Or a whole line `Request timed out.` or `Connection error.`, optionally after `API Error: `.
- **Not limits:** a spend or budget limit (`You've hit your monthly spend limit.`), the extra-usage 400, a bare `429`, and a usage line with no `resets` clause. Each of those needs a human, and waiting cannot fix it.
- **`sessionLimit`** reads only the last 3 entries of `tail`. A usage shape counts at any exit code, because claude may exit 0. A transient shape counts only on a non-zero exit.
- **`waitFor`:**
  - a usage limit with `resetAt` waits `max(0, resetAt − now) + USAGE_MARGIN_MS`;
  - from `streak` 1 on, it waits at least `min(15 · 2^(streak − 1), 60)` minutes;
  - a usage limit without `resetAt` waits that backoff, with a 15-minute floor;
  - a transient limit waits `min(2^streak, 30)` minutes.
- **A time-of-day reset that has just passed** reads as now: if its next occurrence is more than 23 h 30 m away, the limit has already reset and the message is stale. The streak backoff still applies on a repeat.
- **`duration`** renders `1h31m`, `45s`, `12m` and `7h`.

The zone math, which the tests check but do not determine:

```ts
// wall-clock fields of instant t in zone tz
const parts = (t: number, tz: string) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
}).formatToParts(t).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]))
// the instant whose wall clock in tz reads y-mo-d h:mi — two passes settle a DST edge
function zonedEpoch(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  let t = Date.UTC(y, mo - 1, d, h, mi)
  for (let i = 0; i < 2; i++) {
    const p = parts(t, tz)
    t -= Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Date.UTC(y, mo - 1, d, h, mi)
  }
  return t
}
```

An invalid zone throws `RangeError` in `Intl.DateTimeFormat`. That is caught, and the limit is read with no `resetAt`.

- [ ] **Step 1: Write the failing tests**

```ts
const at = (iso: string) => Date.parse(iso)
const NOW = at('2026-10-19T19:30:00Z')                     // 12:30 in America/Los_Angeles (PDT)
const LA = (when: string) => `You've hit your session limit · resets ${when} (America/Los_Angeles)`

describe('limitIn (B4)', () => {
  it('reads the session-limit line pi and claude print', () => {
    expect(limitIn(LA('2pm'), NOW)).toEqual({ kind: 'usage', text: LA('2pm'), resetAt: at('2026-10-19T21:00:00Z') })
  })
  it.each([
    [LA('12am'), '2026-10-20T07:00:00Z'],
    ["You've hit your weekly limit · resets 10:59am (America/Los_Angeles)", '2026-10-20T17:59:00Z'],
    ["You've hit your usage limit · resets 7:20pm (America/Los_Angeles)", '2026-10-20T02:20:00Z'],
    ['You’ve hit your weekly limit · resets Oct 22, 4pm (America/Los_Angeles)', '2026-10-22T23:00:00Z'],
    ['Claude AI usage limit reached|1792440000', '2026-10-19T20:00:00Z'],
  ])('%s resets at %s', (text, iso) => {
    expect(limitIn(text, NOW)).toMatchObject({ kind: 'usage', resetAt: at(iso) })
  })
  it('reads the rate-limit and overloaded bodies and the two network lines as transient', () => {
    for (const text of [
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
      '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"}}',
      'Request timed out.', 'API Error: Connection error.',
    ]) expect(limitIn(text, NOW)).toEqual({ kind: 'transient', text })
  })
  it.each([
    "You've hit your monthly spend limit.",
    "You've hit your session limit",
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage"}}',
    'HTTP 429', 'the rate limit test passed', 'Request timed out. retrying',
  ])('%s is not a limit', (text) => {
    expect(limitIn(text, NOW)).toBeUndefined()
  })
  it('a zone it cannot resolve leaves the reset unknown', () => {
    expect(limitIn("You've hit your session limit · resets 2pm (Mars/Olympus)", NOW)).toEqual(
      { kind: 'usage', text: "You've hit your session limit · resets 2pm (Mars/Olympus)" })
  })
})

describe('sessionLimit · waitFor · duration (B4)', () => {
  it('reads only the last three lines · transient only on a non-zero exit', () => {
    expect(sessionLimit({ code: 0, tail: ['a', LA('2pm')] }, NOW)?.kind).toBe('usage')
    expect(sessionLimit({ code: 1, tail: [LA('2pm'), 'a', 'b', 'c'] }, NOW)).toBeUndefined()
    expect(sessionLimit({ code: 0, tail: ['Request timed out.'] }, NOW)).toBeUndefined()
    expect(sessionLimit({ code: 1, tail: ['Request timed out.'] }, NOW)?.kind).toBe('transient')
  })
  it('waits to the reset plus a minute and backs off on repeats', () => {
    const lim = limitIn(LA('2pm'), NOW)!
    expect(waitFor(lim, 0, NOW)).toBe(5_460_000)                         // 1h31m
    const stale = { kind: 'usage' as const, text: 'x', resetAt: NOW }
    expect([0, 1, 2, 3, 5].map((s) => waitFor(stale, s, NOW) / 60_000)).toEqual([1, 15, 30, 60, 60])
    expect(waitFor({ kind: 'usage', text: 'x' }, 0, NOW) / 60_000).toBe(15)
    expect([0, 1, 4, 5, 9].map((s) => waitFor({ kind: 'transient', text: 'x' }, s, NOW) / 60_000)).toEqual([1, 2, 16, 30, 30])
  })
  it('a time-of-day reset that just passed reads as now', () => {
    const tenPast = at('2026-10-19T21:10:00Z')                           // 14:10 PDT
    expect(limitIn(LA('2pm'), tenPast)).toMatchObject({ resetAt: tenPast })
  })
  it('renders durations', () => {
    expect([5_460_000, 45_000, 720_000, 25_200_000].map(duration)).toEqual(['1h31m', '45s', '12m', '7h'])
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/usage.test.ts`
Expected: FAIL with `Cannot find module '../src/usage.js'`.

- [ ] **Step 3: Implement as specified under Interfaces**

- [ ] **Step 4: Run them and watch them pass**

Run: `pnpm vitest run tests/usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/usage.ts tests/usage.test.ts
git commit -m "feat(usage): recognize usage limits and transient provider errors, conservatively" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Reviewer calls wait out limits inside drive

**Files:**
- Create: `src/drive-presence.ts`. This task adds the marker half; Task 13 adds the lock half.
- Modify: `src/reviewer.ts`: wave 1's `invokeReviewerAsync` retry loop. `InvokeOpts` gains `clock`.
- Modify: `src/harness.ts:58-67`: a claude envelope with `is_error: true` is an invocation failure
- Modify: `fixtures/fakebin/pi:23-33`: `pi-error-calls` limits `pi-error` to the first N calls
- Modify: `tests/helpers.ts`: `fakeClock`
- Test: `tests/reviewer.test.ts`, `tests/harness.test.ts`

**Interfaces:**
- Produces, in `src/drive-presence.ts`:

```ts
export const DRIVE_ENV = 'WITNESS_DRIVE'
export const TARGETLESS = '-'     // the marker's value for work with no target
export function driveChild(env: Record<string, string | undefined>): { target: string | undefined } | undefined
  // unset → undefined · '-' → { target: undefined } · else → { target: <value> }
```

- Produces, in `src/reviewer.ts`:

```ts
export interface InvokeOpts extends InvokeExtras { cwd: string; prompt: string; model?: string; lens?: string; clock?: Clock }
export const REVIEWER_WAIT_MAX_MS = SINGLE_WAIT_MAX_MS
```

- **In `invokeReviewerAsync`,** take an attempt refused `reviewer-invocation` whose `got` reads as a `Limit` (`limitIn`).
  - When `driveChild(ctx.env)` is set and this invocation's waits stay within `REVIEWER_WAIT_MAX_MS`: print `ctx.err(`reviewer: usage limit — waiting ${duration(wait)} · ${limit.text}`)`, `await clock.sleep(wait)`, and retry the same rung. The wait spends no timeout retry.
  - Otherwise refuse `v(cmd, 'usage-limit', limit.text, want)`. The want is `wait for the reset — witness drive waits it out on its own` outside drive, and `a reset inside the 6h reviewer wait — re-run the gate after it` inside.
- The sync `invokeReviewer` (calibration's lane) never waits. It refuses as it would outside drive.
- Only a provider failure is read: a refusal's `got`, never verdict text. A finding that quotes a limit message stays a finding.
- A1's arbiter calls through the same invoker, so it waits too.
- **`parseClaudeEnvelope`:** `is_error === true` refuses `v('claude', 'reviewer-invocation', String(result ?? '').slice(0, 200), 'claude print mode answering without an error envelope — check auth and usage for that account')`.
- **In `tests/helpers.ts`:** `export function fakeClock(start: number): Clock & { slept: number[] }`. Its `sleep` records the ms and advances `now`.

- [ ] **Step 1: Write the failing tests**

In `tests/reviewer.test.ts`:

```ts
describe('usage limits at the reviewer (B4)', () => {
  const LIMIT = "You've hit your session limit · resets 2pm (America/Los_Angeles)"
  const START = Date.parse('2026-10-19T19:30:00Z')
  const setup = async (limit = LIMIT, env: Record<string, string> = {}) => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    writeFileSync(join(scenario, 'pi-error'), limit)
    writeFileSync(join(scenario, 'pi-error-calls'), '1')
    const errs: string[] = []
    const ctx = fakeCtx(repo.root, { env: { ...gateEnv(scenario), ...env }, err: (l) => errs.push(l) })
    return { repo, scenario, ctx, errs, clock: fakeClock(START) }
  }

  it('inside drive a limited call waits for the reset and retries', async () => {
    const { repo, scenario, ctx, errs, clock } = await setup(LIMIT, { WITNESS_DRIVE: 'p1' })
    const r = await invokeReviewerAsync(ctx, piHarness, { cwd: repo.root, prompt: 'x', clock })
    expect(r.ok).toBe(true)
    expect(clock.slept).toEqual([5_460_000])
    expect(errs).toContain(`reviewer: usage limit — waiting 1h31m · ${LIMIT}`)
    expect(existsSync(join(scenario, 'pi-calls/call-2'))).toBe(true)
  })

  it('outside drive it refuses at once and names the reset', async () => {
    const { repo, scenario, ctx, clock } = await setup()
    const r = await invokeReviewerAsync(ctx, piHarness, { cwd: repo.root, prompt: 'x', clock })
    expect(!r.ok && [r.violations[0]!.rule, r.violations[0]!.got]).toEqual(['usage-limit', LIMIT])
    expect(clock.slept).toEqual([])
    expect(existsSync(join(scenario, 'pi-calls/call-2'))).toBe(false)
  })

  it('a reset past the 6h reviewer wait refuses inside drive too', async () => {
    const late = "You've hit your session limit · resets 9pm (America/Los_Angeles)"   // 8h31m away
    const { repo, ctx, clock } = await setup(late, { WITNESS_DRIVE: 'p1' })
    const r = await invokeReviewerAsync(ctx, piHarness, { cwd: repo.root, prompt: 'x', clock })
    expect(!r.ok && r.violations[0]!.rule).toBe('usage-limit')
    expect(clock.slept).toEqual([])
  })

  it('a verdict that quotes the limit line is a verdict', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [{ blocking: false, anchor: 'src/usage.ts', claim: LIMIT }] })
    const clock = fakeClock(START)
    const ctx = fakeCtx(repo.root, { env: { ...gateEnv(scenario), WITNESS_DRIVE: 'p1' } })
    expect((await invokeReviewerAsync(ctx, piHarness, { cwd: repo.root, prompt: 'x', clock })).ok).toBe(true)
    expect(clock.slept).toEqual([])
  })
})
```

In `tests/harness.test.ts`:

```ts
it('claude: an is_error envelope is an invocation failure, not a verdict', () => {
  const h = loadHarness('claude-code')
  const r = h.ok && h.value.reviewer.parseEnvelope(JSON.stringify({ type: 'result', is_error: true, result: 'boom' }))
  expect(r && !r.ok && [r.violations[0]!.rule, r.violations[0]!.got]).toEqual(['reviewer-invocation', 'boom'])
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/reviewer.test.ts tests/harness.test.ts`
Expected: FAIL. The first case refuses `reviewer-invocation`, the second has the wrong rule, and the `is_error` envelope parses `ok`.

- [ ] **Step 3: Implement as specified under Interfaces**

- [ ] **Step 4: Run them and watch them pass, then the gate suites**

Run: `pnpm vitest run tests/reviewer.test.ts tests/harness.test.ts tests/fakebin.test.ts tests/battery.test.ts tests/gate-engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/drive-presence.ts src/reviewer.ts src/harness.ts fixtures/fakebin/pi tests/helpers.ts tests/reviewer.test.ts tests/harness.test.ts
git commit -m "feat(reviewer): inside drive a usage-limited call waits for the reset" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `next` answers for one target

**Files:**
- Modify: `src/verbs/next.ts`:
  - `computeNext` takes `opts.scope`, and every rung honors it;
  - `planWriteAction`'s fallback (`:508-512`) names its target;
  - `NOTHING_OWED` is exported;
  - `run()` scopes a marked session, passes that scope to A1's `settleOwed`, and prints its `drive:` lines.
- Modify: `src/settle.ts`: A1's `settleOwed` takes an optional `scope`
- Test: `tests/next-scope.test.ts` (new)

**Interfaces:**
- Consumes: Task 5's `driveChild`; A1's `owedDecisions`, `settleOwed`, `plannedRepo`, `PLAN_BLOCKING` and `autonomyOn`.
- Produces:

```ts
export interface NextOpts { scope?: (target: string | undefined) => boolean }
export function computeNext(root: string, ctx: Ctx, canon: Canon, cfg: Config, opts?: NextOpts): NextAction
export const NOTHING_OWED = 'nothing is owed — no effort, spec or plan has a next step; a clean check confirms it'
// src/settle.ts — A1's signature plus one optional parameter
export async function settleOwed(ctx: Ctx, root: string, cfg: Config, opts?: { scope?: (target: string) => boolean }): Promise<SettleReport[]>
```

- **The rule:** every rung that names a target passes it through `scope` before it may answer. A rung with no target passes `undefined`. The default scope admits everything, so every existing caller is unchanged.
- **The rungs on `main`:**
  - tier 1 (`:552-556`, plan id);
  - tier 2, which A1 answers from `owedDecisions(root, canon)[0]` (pending decisions, then bound endgames, `:569-613`). It becomes the first owed decision whose target `scope` admits;
  - A2's ask rung and the no-effort brainstorm (`:615-617`, `undefined`);
  - the effort loop (`:618-661`, slug);
  - design (`:663-684`, spec id);
  - the plan queue (`:702-722`, spec id): its ready list and choose block are computed over the specs that `scope` admits;
  - draft plans (`:726-740`, plan id);
  - start (`:744-748`, plan id).

  The recovery fork (`:523-527`) and canon errors (`:528-530`) are global and never filtered; under autonomy A1 already answers the fork and `choose:` with the policy's pick. With nothing in scope, the terminal rung answers.
- **The plan queue's open-an-effort fallback** carries `target`. A session scoped to that spec must be able to find the work again.
- **`settleOwed`'s scope** filters `owedDecisions` before any `settleStop` runs. A1's `next` settles repo-wide. A marked session's `next` passes its own scope, so two drive sessions never judge one stop, and a stop on a target no session holds is drive's to settle (Task 9).
- **`next`'s precedence:** a `--flow` claim first, then the drive marker, then the worktree's ambient flow, then the whole ladder.
  - A marked session prints `drive: <target> — assigned by witness drive` above the routing block, where D153's `flow:` line goes. A target-less session prints `drive: untargeted work — assigned by witness drive`.
  - When its answer is the terminal rung (`line === 'witness check' && note === NOTHING_OWED`), it prints `drive: done — nothing more is owed for <target>` after the routing block.

- [ ] **Step 1: Write the failing tests**

```ts
// a flow at ship (in progress · pr set) beside a draft plan of another spec awaiting its gate.
// The fake gh answers the lazy stamp's PR query, so `next` never reaches a real gh.
async function flowAndDraft(): Promise<TestRepo & { env: Record<string, string> }> {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  approve(repo, 'auth-refresh-plan-1')
  await repo.cli(['start', 'auth-refresh-plan-1'])
  repo.setMeta('auth-refresh-plan-1', { pr: 7 })
  await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
  approve(repo, 'auth-mfa')
  await writePlan(repo, 'auth-mfa-plan-1', { parent: 'auth-mfa', steps: [{ id: 's1', title: 'mfa', criteria: ['ac-mfa'] }] })
  const scenario = fakeScenario()
  ghState(scenario, 7, 'OPEN')
  return Object.assign(repo, { env: gateEnv(scenario) })
}
const derive = (repo: TestRepo, scope?: (t: string | undefined) => boolean) => {
  const cfg = loadConfig(repo.root)
  if (!cfg.ok) throw new Error('config')
  return computeNext(repo.root, fakeCtx(repo.root), loadCanon(repo.root), cfg.value, { scope })
}

describe('computeNext scope (B3)', () => {
  it('admits everything by default — the ladder is unchanged', async () => {
    expect(derive(await flowAndDraft()).line).toBe('witness ship auth-refresh-plan-1')
  })

  it('keeps every rung to the targets it admits', async () => {
    const repo = await flowAndDraft()
    expect(derive(repo, (t) => t !== 'auth-refresh-plan-1').line).toBe('witness gate plan auth-mfa-plan-1')
    expect(derive(repo, (t) => t === 'auth-mfa-plan-1').line).toBe('witness gate plan auth-mfa-plan-1')
    expect(derive(repo, (t) => t === undefined)).toMatchObject({ line: 'witness check', note: NOTHING_OWED })
  })

  it('scopes tier 2 to its own decision', async () => {
    const repo = await flowAndDraft()
    appendEntry(repo.root, 'auth-mfa-plan-1', {
      v: 1, t: 'gate-run', gate: 'plan', artifact: 'auth-mfa-plan-1', round: 1, run_id: 'r1',
      reviewed_sha: 's', prompts_sha: 'p', witness: '0', model: 'm', calibration: 'none', checks: [], outcome: 'stopped',
    })
    expect(derive(repo).line).toBe('witness ship auth-refresh-plan-1')
    expect(derive(repo, (t) => t === 'auth-mfa-plan-1').line).toBe('witness decide plan auth-mfa-plan-1 --show')
  })

  it('a marked session settles only its own target\'s stop (Review Focus 2)', async () => {
    const repo = await plannedRepo({ autonomy: false })                 // A1: the stop waits while autonomy is off
    const scenario = fakeScenario()
    putVerdict(scenario, PLAN_BLOCKING)
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
    autonomyOn(repo)
    const decisions = () => readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'human-decision')
    await repo.cli(['next'], { env: { ...gateEnv(scenario), WITNESS_DRIVE: repo.effort } })
    expect(decisions()).toEqual([])
    await repo.cli(['next'], { env: { ...gateEnv(scenario), WITNESS_DRIVE: 'auth-refresh-plan-1' } })
    expect(decisions().at(-1)).toMatchObject({ decision: 'revise', selected: 'policy' })
  })

  it('a marked session answers for its target alone and says so (Review Focus 2)', async () => {
    const repo = await flowAndDraft()
    const out = await nextLine(repo, { env: { ...repo.env, WITNESS_DRIVE: 'auth-mfa-plan-1' } })
    expect(out).toContain('drive: auth-mfa-plan-1 — assigned by witness drive')
    expect(out).toContain('next: witness gate plan auth-mfa-plan-1')
    expect(out).not.toContain('witness ship')
  })

  it('a marked session whose target needs nothing more is told so', async () => {
    const repo = await flowAndDraft()
    const out = await nextLine(repo, { env: { ...repo.env, WITNESS_DRIVE: 'auth-refresh' } })
    expect(out).toContain('drive: done — nothing more is owed for auth-refresh')
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/next-scope.test.ts`
Expected: FAIL. `computeNext` ignores the fourth argument, so every scoped case answers `witness ship …`. `NOTHING_OWED` is not exported. The first marked `next` settles the plan's stop repo-wide.

- [ ] **Step 3: Implement as specified under Interfaces**

- [ ] **Step 4: Run them and watch them pass, then the ladder and settle suites**

Run: `pnpm vitest run tests/next-scope.test.ts tests/next.test.ts tests/next-authoring.test.ts tests/next-live-queue.test.ts tests/next-home.test.ts tests/next-ask.test.ts tests/autonomy-next.test.ts tests/flows.test.ts tests/dashboard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/next.ts src/settle.ts tests/next-scope.test.ts
git commit -m "feat(next): a scope keeps the ladder to one target · a drive session answers for its own" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Sessions carry their target and say how they ended

**Files:**
- Modify: `src/drive.ts:23-69` (`isConversation`, `classifyAction`), `:71-186` (`spawnSession`)
- Modify: `tests/drive.test.ts:105-150`: the four `spawnSession` cases read `.outcome`
- Test: `tests/drive.test.ts`

**Interfaces:**
- Consumes: Task 5's `DRIVE_ENV` and `TARGETLESS`.
- Produces:

```ts
export function classifyAction(action: NextAction, root: string, opts?: { autonomy?: boolean }): DriveStep
export type SpawnOutcome = 'exited' | 'timeout' | 'spawn-failed' | 'stopped'
export interface SessionEnd { outcome: SpawnOutcome; code: number | null; tail: string[]; ms: number }
export async function spawnSession(
  step: SpawnStep, cfg: Config, ctx: Ctx, spawnN: number, opts?: { manual?: boolean; signal?: AbortSignal },
): Promise<SessionEnd>
```

- **Under autonomy** nothing is a conversation. Brainstorm, `witness recap`, and design `--file` and `--open` all spawn at their home, because A2 runs them headless. A1 already answers the choose block and the recovery fork with the policy's pick and no block. A block that still reaches drive under a runnable line spawns, and the session's own `next` takes it, so no block stops an unattended run. `witness decide` lines stay decisions in both modes.
- **The child's env** adds `[DRIVE_ENV]: step.target ?? TARGETLESS` beside `WITNESS_BIN`.
- **The prompt** is `/witness --manual` when `opts.manual` is set, and `/witness` otherwise.
- **`SessionEnd`:**
  - `tail` holds the last 3 non-empty lines the child printed, from either pipe, unprefixed;
  - `code` is its exit code, or null when it was killed;
  - `ms` runs from spawn to settle.
- **Abort:** `signal` sends SIGTERM, then SIGKILL after `TERM_GRACE_MS`, and the outcome is `stopped`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('sessions carry their target (B1 · B3)', () => {
  it('hands the child its target as the drive marker', async () => {
    const repo = await seededRepo()
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent('echo "marker=$WITNESS_DRIVE"') }, out: (l) => lines.push(l) })
    await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfgOf(repo), ctx, 1)
    await spawnSession({ kind: 'spawn', home: repo.root }, cfgOf(repo), ctx, 2)
    expect(lines).toContain('[1 implement/p1] marker=p1')
    expect(lines.find((l) => l.startsWith('[2 '))).toMatch(/marker=-$/)
  }, 20000)

  it('reports the exit code and the last three lines', async () => {
    const repo = await seededRepo()
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent("printf 'a\\nb\\n\\nc\\nd\\n'\nexit 3") } })
    const end = await spawnSession({ kind: 'spawn', home: repo.root }, cfgOf(repo), ctx, 1)
    expect(end).toMatchObject({ outcome: 'exited', code: 3, tail: ['b', 'c', 'd'] })
    expect(end.ms).toBeGreaterThan(0)
  }, 20000)

  it('prompts a --manual session with /witness --manual', async () => {
    const repo = await seededRepo()
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent('echo "prompt=$2"') }, out: (l) => lines.push(l) })
    await spawnSession({ kind: 'spawn', home: repo.root }, cfgOf(repo), ctx, 1, { manual: true })
    expect(lines.join('\n')).toContain('prompt=/witness --manual')
  }, 20000)

  it('an abort stops the session', async () => {
    const repo = await seededRepo()
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent('sleep 30') } })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    const t0 = Date.now()
    const end = await spawnSession({ kind: 'spawn', home: repo.root }, cfgOf(repo), ctx, 1, { signal: ac.signal })
    expect(end.outcome).toBe('stopped')
    expect(Date.now() - t0).toBeLessThan(10_000)
  }, 20000)
})

describe('classifyAction under autonomy (B2)', () => {
  const root = '/repo'
  const auto = { autonomy: true }
  it('runs conversations and option blocks headless · decisions stay decisions', () => {
    expect(classifyAction({ line: 'witness recap --file <recap.json> --ask a1', stage: 'brainstorm' }, root, auto))
      .toEqual({ kind: 'spawn', home: root, stage: 'brainstorm', target: undefined, model: undefined })
    expect(classifyAction({ line: 'witness design auth-refresh --file <html>', stage: 'design', target: 'auth-refresh' }, root, auto).kind)
      .toBe('spawn')
    expect(classifyAction({ line: 'witness recover --complete', block: ['recovery: 2 options · 1 is recommended'] }, root, auto).kind)
      .toBe('spawn')
    expect(classifyAction({
      line: 'witness write a-plan-1 --effort e --meta m.json --body b.md', stage: 'plan', target: 'a',
      block: ['choose: 2 options · 1 is recommended'],
    }, root, auto).kind).toBe('spawn')
    expect(classifyAction({ line: 'witness decide ship p1 --show', target: 'p1' }, root, auto))
      .toEqual({ kind: 'decision', gate: 'ship', target: 'p1' })
  })
})
```

`fakeAgent`, `cfgOf`, `ttyCtx`, `askCtx` and `idleAgent` are the file's existing helpers (`tests/drive.test.ts:92-103,208-214,289-305`). Later tasks use them from new `describe` blocks, so lift them all to file scope, and make `idleAgent` `echo tick` before it exits.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/drive.test.ts`
Expected: FAIL. `marker=` is empty, `spawnSession` resolves a bare string, the prompt is `/witness`, and the brainstorm action classifies as `conversation`.

- [ ] **Step 3: Implement as specified under Interfaces**

- [ ] **Step 4: Run them and watch them pass**

Run: `pnpm vitest run tests/drive.test.ts`
Expected: PASS. The `driveLoop` cases still pass, because the loop reads `.outcome`.

- [ ] **Step 5: Commit**

```bash
git add src/drive.ts tests/drive.test.ts
git commit -m "feat(drive): sessions carry their target · say how they ended · run headless under autonomy" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Up to N targets at once (B3)

**Files:**
- Modify: `src/drive.ts:188-296`: `DriveFlags`, the ceiling, `journalTotal` (removed), and `driveLoop` (rewritten)
- Modify: `src/verbs/drive.ts:39`: `resolveFlow` refuses a `--flow` claim at the door, before `driveLoop`, because the loop no longer calls it (Task 13 keeps it at step 6)
- Test: `tests/drive.test.ts`

**Interfaces:**
- Consumes:
  - Task 6's `computeNext(…, { scope })`;
  - Task 7's `spawnSession` and `classifyAction`;
  - Task 1's `cfg.drive.parallel`;
  - Task 4's `Clock` and `realClock`;
  - A1's `KeptStop`, and A2's `ASK_STREAM`.
- Produces:

```ts
export const AUTONOMY_MAX_SPAWNS = 200
export interface DriveFlags { flow?: string; maxSpawns?: number; manual?: boolean }
export type AsideKind = 'kept' | 'decision' | 'conversation' | 'merge' | 'stuck' | 'capped'
export interface Aside { target: string; kind: AsideKind; line: string; why: string; gate?: string; stop?: KeptStop }   // KeptStop: A1's
export async function driveLoop(root: string, cfg: Config, ctx: Ctx, flags: DriveFlags, clock?: Clock): Promise<number>
```

- **Parallelism:** `cfg.drive.parallel` when the run is autonomous and `flags.flow` is unset, and 1 otherwise.
- **The ceiling:** `flags.maxSpawns ?? (autonomous ? AUTONOMY_MAX_SPAWNS : DEFAULT_MAX_SPAWNS)`, counted across every lane. On reaching it, drive starts nothing more and lets running sessions finish. It prints today's two lines (`drive.ts:273-274`).
- **Progress, per target.** Before each spawn, the target's key is compared with the key recorded at its last spawn. If they are equal, drive prints `drive: no progress — <line>` and `help: <target> is set aside for this run — read its stream above`, and sets the target aside `stuck`. While a transaction is pending, nothing is judged, because a crash anywhere blocks every write. The keys, joined with `\u0000`:
  - a target: `line · lines in its stream · lines in its owning effort's stream` (`effortOf`);
  - target-less work: `line · count of effort streams · lines in A2's ASK_STREAM`. A rejected recap check grows the asks stream, and an accepted one births an effort.
- **Session ends:**
  - `timeout` prints `drive: spawn-timeout — <line>` and sets the target aside `stuck`;
  - `spawn-failed` prints `drive: spawn-failed — <line>` and stops the run, because this machine can spawn nothing;
  - a child line carrying `merge PR` prints `drive: merge — <line>` and sets the target aside `merge`. Only a merge left to a human prints it: A1's `mergeOwnPr` never does.
- **With autonomy off,** every non-spawn step sets its target aside and the run carries on:
  - a decision goes to `resolveDecision` (unchanged prompt). An executed one changes nothing and the loop derives again. A standing stop sets the target aside `decision`, and a refused one sets it aside `stuck`.
  - a conversation prints today's two lines (`drive.ts:248-249`) and is set aside `conversation`.
- **Until Task 9,** an autonomous decision is set aside `decision`, silently. Task 9 adds A1's settle pass in front of the fill.
- **Signals:** SIGINT and SIGTERM during the loop abort every running session through Task 7's `signal`, stop filling, and end with `drive: stopped — signal <name>`. Task 13's detach test pins this.
- **The end:**
  - `drive: idle — <line>` when the last derivation answered `witness check`;
  - exit 1 when anything was set aside `stuck` or `capped`, the ceiling was hit, or the run stopped (a signal or `spawn-failed`); exit 0 otherwise.
- **`--flow P`:** `resolveFlow` refuses the claim at the verb's door (this task; Task 13 keeps it), and the scope admits only P.

The loop, because the tests do not fix its order:

```ts
const admits = (t: string | undefined) => {
  const k = t ?? TARGETLESS
  return !lanes.has(k) && !aside.has(k) && (flags.flow === undefined || t === flags.flow)
}
for (;;) {
  // Task 9's settle pass runs here under autonomy: A1's settleOwed over what `admits` covers
  while (!stop && lanes.size < parallel && clock.now() >= pausedUntil) {
    const action = computeNext(root, ctx, loadCanon(root), cfg, { scope: admits })
    const key = action.target ?? TARGETLESS
    if (lanes.has(key) || aside.has(key)) break     // a global rung, already in hand
    const step = classifyAction(action, root, { autonomy })
    if (step.kind === 'idle') { idle = action.line; break }
    if (step.kind !== 'spawn') { await standAside(step, action, key); continue }
    if (spawns >= ceiling) { stop = 'ceiling'; ceilingLine = action.line; break }
    // Task 9's waiting-need check, then Task 10's caps, go here: a cap outranks a stall in the report
    const pk = progressKey(root, action)
    if (pendingTxn(root) === undefined && progress.get(key) === pk) { stuck(key, action); continue }
    progress.set(key, pk); spawns += 1
    lanes.set(key, launch(step, action, key, spawns))
  }
  if (lanes.size === 0) {
    if (!stop && pausedUntil > clock.now()) { await clock.sleep(pausedUntil - clock.now()); continue }
    break
  }
  const { key, end } = await Promise.race([...lanes].map(([k, l]) => l.end.then((e) => ({ key: k, end: e }))))
  settle(key, lanes.get(key)!, end)                   // Task 11 reads limits here
  lanes.delete(key)
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// n started flows, one spec each. A fresh worktree owes its first red, so every flow sits
// at `witness test-evidence <plan> --phase red` (rank 1). `shipping` gets a pr (rank 3).
async function startedFlows(specs: string[], opts: { shipping?: string } = {}): Promise<TestRepo> {
  const repo = await seededRepo()
  for (const s of specs) {
    await writeSpec(repo, s, { criteria: [{ id: `ac-${s}`, test: `@spec:${s}` }] })
    approve(repo, s)
    await writePlan(repo, `${s}-plan-1`, { parent: s, steps: [{ id: 's1', title: s, criteria: [`ac-${s}`] }] })
    approve(repo, `${s}-plan-1`)
    await repo.cli(['start', `${s}-plan-1`])
  }
  if (opts.shipping) repo.setMeta(`${opts.shipping}-plan-1`, { pr: 7 })
  autonomyOn(repo)
  writeLocalConfig(repo.root, { notify: noopOpener() })
  return repo
}
const autoCtx = (repo: TestRepo, env: Record<string, string>, out: string[]): Ctx =>
  fakeCtx(repo.root, { env: fixtureEnv({ WITNESS_KEEP_AWAKE_BIN: noopOpener(), ...env }), out: (l) => out.push(l) })
const script = (body: string): string => {
  const bin = join(fakeScenario(), 'agent')
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return bin
}

describe('side by side (B3)', () => {
  it('runs two targets at once, most advanced first, never two on one target (Review Focus 2)', async () => {
    const repo = await startedFlows(['a', 'b', 'c'], { shipping: 'c' })
    const log = join(fakeScenario(), 'log')
    const agent = script(`echo hi\necho "$WITNESS_DRIVE start" >> "${log}"\nsleep 1\necho "$WITNESS_DRIVE end" >> "${log}"`)
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), {})
    expect(out).toContain('[1 ship/c-plan-1] hi')                    // the ladder's own order (D73)
    expect(out).toContain('[2 implement/a-plan-1] hi')
    expect(out).toContain('[3 implement/b-plan-1] hi')
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    expect(lines.slice(0, 2).sort()).toEqual(['a-plan-1 start', 'c-plan-1 start'])      // both ran at once
    expect(lines.indexOf('b-plan-1 start')).toBeGreaterThan(Math.min(lines.indexOf('c-plan-1 end'), lines.indexOf('a-plan-1 end')))
    for (const t of ['a-plan-1', 'b-plan-1', 'c-plan-1']) expect(lines.filter((l) => l === `${t} start`)).toHaveLength(1)
    expect(code).toBe(1)                               // all three made no progress
  }, 60000)

  it('catches a stalled target while another target journals every spawn (Review Focus 1)', async () => {
    const repo = await startedFlows(['a', 'b'])
    const agent = script(`echo tick\ncase "$WITNESS_DRIVE" in a-plan-1) exec ${witnessCli()} dispatch-report a-plan-1 --steps-assigned 1 --steps-completed 0 ;; *) exit 0 ;; esac`)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), { maxSpawns: 6 })
    const all = out.join('\n')
    expect(all).toContain('drive: no progress — witness test-evidence b-plan-1 --phase red')
    expect(out.filter((l) => / implement\/b-plan-1\] tick$/.test(l))).toHaveLength(1)
    expect(all).toMatch(/drive: spawn ceiling reached \(6\)/)
  }, 90000)

  it('with autonomy off a standing decision no longer ends the run', async () => {
    const repo = await gatedEffort()
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
    approve(repo, 'auth-mfa')
    await writePlan(repo, 'auth-mfa-plan-1', { parent: 'auth-mfa', steps: [{ id: 's1', title: 'mfa', criteria: ['ac-mfa'] }] })
    approve(repo, 'auth-mfa-plan-1')
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), askCtx(repo, ['', ''], out), { maxSpawns: 1 })
    expect(out.join('\n')).toMatch(/drive: decision stands/)
    expect(out.join('\n')).toMatch(/\[1 drive\/auth-mfa-plan-1\]/)       // the start ran after it
  }, 60000)
})
```

`witnessCli`, `gatedEffort` and `askCtx` are the file's existing helpers (`tests/drive.test.ts:187-190,275-305`), lifted to file scope in Task 7. `askCtx`'s idle agent echoes `tick`, so the last case finds its session by the `[1 drive/auth-mfa-plan-1]` prefix.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/drive.test.ts`
Expected: FAIL.
- The first case runs `c-plan-1` alone and ends at its `no progress`, so there is no `[2 implement/a-plan-1] hi`.
- The second spawns `b-plan-1` again and again until the ceiling, because the journal total keeps growing.
- The third returns at `decision stands`.

- [ ] **Step 3: Implement as specified under Interfaces**

- [ ] **Step 4: Run them and watch them pass, with every existing drive case**

Run: `pnpm vitest run tests/drive.test.ts`
Expected: PASS. The existing cases keep their asserted lines and exit codes:
- `no progress` exits 1;
- the ceiling exits 1;
- a conversation exits 0;
- `spawn-timeout` exits 1;
- `decision stands` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/drive.ts tests/drive.test.ts
git commit -m "feat(drive): up to drive.parallel targets at once · progress judged per target" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Autonomy in the loop: A1 settles, kept stops wait, needs wait (B2)

**Files:**
- Modify: `src/drive.ts`: the settle pass before each fill, the loop's decision step, and its pre-spawn needs check
- Modify: `tests/drive.test.ts:174-181`: `planReady(opts = {})` passes `opts` to `writePlan`
- Test: `tests/drive.test.ts`

**Interfaces:**
- Consumes:
  - A1's `settleOwed`, `settledLine`, `SettleReport`, `Settled` (loaded with `await import('./settle.js')`), `KEPT_STOP_NAMES` and `keptStopLine`;
  - A2's `unmetNeeds`;
  - Task 6's `settleOwed` scope.
- Produces no new export. `Aside` (Task 8) is filled with `gate` and `stop`.
- **The settle pass.** Under autonomy, each round of the loop starts with one pass, before any slot fills. `settleOwed(ctx, root, cfg, { scope })` runs with the scope `admits` (Task 8), so it covers every target that no session holds, nothing set aside, and only P under `--flow P`. A running session settles its own target through its gate and its scoped `next`. The pass's ctx carries `WITNESS_DRIVE: '-'`, so an arbiter call in it waits out a usage limit as a drive session's would (Task 5). Drive prints each report's `settledLine`. Then:
  - **`kept`:** print `drive: waits on you — <target> · <KEPT_STOP_NAMES[stop]>`, and set the target aside `kept` with `gate`, `stop` and A1's line.
  - **`left`:** print `drive: waits on you — <target> · decision · <why>`, and set it aside `decision`. The arbiter is never re-invoked on it this run.
  - **`decided`:** nothing more. The next derivation sees the new state.
  - **`routed` and `none`:** recorded for the decision step.
- **The decision step, under autonomy.** A `witness decide` line still reaching the fill is a stop the pass did not settle.
  - Its report was `routed` (a re-run the CLI names): spawn a session scoped to the target. Its own `next` prints the re-run (A1).
  - Otherwise, it is `none`, which is a `--manual` run's stop: print `drive: waits on you — <target> · decision · <line>` and set it aside `decision`.

  `resolveDecision` (`drive.ts:402-441`) runs only when autonomy is off.
- **The needs check, in both modes.** `witness start <plan>`, where `unmetNeeds(canon)` lists a `blocks: 'start'` need of that plan. Print `drive: waits on you — <plan> · unmet need`, then `keptStopLine('unmet-need', <the needs' texts, then their satisfy commands, all joined ' · '>)`, and set the plan aside `kept` with `stop: 'unmet-need'`. No session is spawned only to be refused. A2's start rung reaches this only when every approved plan waits. Env and cmd needs stay `start`'s, as A2 decided.
- The `merge PR` sniff stays on in both modes. `mergeOwnPr` prints it only when it leaves the merge to a human (A1: autonomy off at merge time, or off on the PR's base), so it fires only where a human merges.

- [ ] **Step 1: Write the failing tests**

```ts
// a ui spec whose design gate stopped clean: under autonomy the look is the human's (A1)
function pendingLook(repo: TestRepo, spec: string): void {
  appendEntry(repo.root, spec, {
    v: 1, t: 'gate-run', gate: 'design', artifact: spec, round: 1, run_id: 'rd1', reviewed_sha: 's',
    prompts_sha: 'p', witness: '0', model: 'm', pin: 'm', calibration: 'none', checks: [], outcome: 'stopped',
    standing: 'design always stops — the human judges the look',
    verdicts: [{ reviewer: 'design-critic', coverage: [{ anchor: `${spec} > ## Behavior`, note: 'read' }], findings: [] }],
  })
}
const uiSpec = async (repo: TestRepo, id: string) => {
  await writeSpec(repo, id, { ui: true, criteria: [{ id: `ac-${id}`, test: `@spec:${id}` }] })
  approve(repo, id)
}

describe('autonomy in the loop (B2)', () => {
  it('a kept stop holds only its target and the run moves on (Review Focus 3)', async () => {
    const repo = await seededRepo()
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    await uiSpec(repo, 'billing-page')
    pendingLook(repo, 'billing-page')
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
    approve(repo, 'auth-mfa')
    await writePlan(repo, 'auth-mfa-plan-1', { parent: 'auth-mfa', steps: [{ id: 's1', title: 'mfa', criteria: ['ac-mfa'] }] })
    approve(repo, 'auth-mfa-plan-1')
    const seen = join(fakeScenario(), 'seen')
    const out: string[] = []
    let asked = 0
    const ctx = { ...autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script(`echo "$WITNESS_DRIVE" >> "${seen}"`) }, out), ask: async () => { asked++; return '' } }
    await driveLoop(repo.root, cfgOf(repo), ctx, {})
    expect(out.join('\n')).toContain('kept-stop: design look — ')
    expect(out).toContain('drive: waits on you — billing-page · design look')
    expect(readFileSync(seen, 'utf8')).toContain('auth-mfa-plan-1')
    expect(asked).toBe(0)
  }, 60000)

  it('a run that ends on kept stops alone exits 0', async () => {
    const repo = await seededRepo()
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    await uiSpec(repo, 'billing-page')
    pendingLook(repo, 'billing-page')
    const out: string[] = []
    expect(await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('exit 9') }, out), {})).toBe(0)
    expect(out.join('\n')).not.toMatch(/\[\d+ /)        // no session was spawned
  }, 60000)

  it('a plan waiting on a manual need waits without a session', async () => {
    const repo = await planReady({ needs: [{ id: 'ses-prod', manual: 'SES production access', satisfied: false }] })
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('exit 9') }, out), {})
    expect(out).toContain('drive: waits on you — auth-refresh-plan-1 · unmet need')
    expect(out).toContain('kept-stop: unmet need — SES production access · witness satisfy auth-refresh-plan-1 --need ses-prod')
    expect(out.join('\n')).not.toMatch(/\[\d+ /)
    expect(code).toBe(0)
  }, 60000)

  it('drive settles a waiting decision itself, then hands the target to its own session', async () => {
    const repo = await gatedEffort()                    // stopped on a blocking finding while autonomy was off
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const seen = join(fakeScenario(), 'seen')
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script(`echo "$WITNESS_DRIVE" >> "${seen}"`) }, out), { maxSpawns: 1 })
    expect(out).toContain(`decided: decompose ${repo.effort} → revise · policy · blocking-here`)
    expect(readFileSync(seen, 'utf8').trim()).toBe(repo.effort)
  }, 60000)

  it('a --manual run\'s stop waits for the human and is never settled', async () => {
    const repo = await plannedRepo()                    // A1 · autonomy on
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const scenario = fakeScenario()
    putVerdict(scenario, PLAN_BLOCKING)
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1', '--manual'], { env: gateEnv(scenario) })
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('exit 9') }, out), {})
    expect(out).toContain('drive: waits on you — auth-refresh-plan-1 · decision · witness decide plan auth-refresh-plan-1 --show')
    expect(readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'human-decision')).toEqual([])
    expect(code).toBe(0)
  }, 60000)

  it('brainstorm runs headless under autonomy', async () => {
    const repo = await seededRepo({ noRecap: true })
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    await repo.cli(['ask', 'Refresh tokens rotate before expiry'])
    const seen = join(fakeScenario(), 'seen')
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script(`echo "$WITNESS_DRIVE" >> "${seen}"`) }, out), { maxSpawns: 1 })
    expect(readFileSync(seen, 'utf8').trim()).toBe('-')
    expect(out.join('\n')).not.toContain('drive: conversation')
  }, 60000)
})
```

`pendingLook` appends the run directly, as `tests/drive.test.ts:351-360` does for decompose. A1's policy gives a clean design stop to the human (`design-look`).

Add the race, which leans on A1's re-read under the lock (A1 Task 4: `applyDecision` re-reads the stream inside the lock):

```ts
it('two settlers racing one stop journal exactly one decision · the loser reads left', async () => {
  // a stopped implement gate under autonomy with one blocking-here finding, so the policy takes revise
  const [x, y] = await Promise.all([nextChild(repo.root), nextChild(repo.root)])   // two `witness next` processes
  const decided = readStream(repo.root, planId).filter((e) => e.t === 'human-decision')
  expect(decided).toHaveLength(1)
  expect([x, y].filter((r) => r.stdout.includes('decided:'))).toHaveLength(1)
}, 60_000)
```

`nextChild` starts `tsx src/bin.ts next` in a separate process, like Task 3b's helper. The loser sees A1's `nothing-pending` or `anchor-moved` refusal, which `settleOwed` maps to `left`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/drive.test.ts`
Expected: FAIL.
- The kept-stop case sets `billing-page` aside as a plain `decision`, so no `kept-stop:` line and no `waits on you` line print.
- The needs case spawns a session for `witness start`.
- The waiting decision is set aside unsettled, so no `decided:` line prints and no session runs.

- [ ] **Step 3: Implement as specified under Interfaces**

- [ ] **Step 4: Run them and watch them pass, with A1's settle suites**

Run: `pnpm vitest run tests/drive.test.ts tests/autonomy-next.test.ts tests/autonomy-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/drive.ts tests/drive.test.ts
git commit -m "feat(drive): A1 settles every stop no session holds · kept stops and needs wait without a session" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Caps park what will not converge (B5)

**Files:**
- Create: `src/caps.ts`
- Modify: `src/drive.ts`: the cap check before each spawn, and per-target use (spawns and session ms)
- Modify: `src/verbs/decide.ts`: A1's `DecisionCore` gains two optional fields, `park` and `rule`
- Test: `tests/caps.test.ts` (new), `tests/drive.test.ts`, `tests/decide.test.ts`

**Interfaces:**
- Consumes: Task 1's `DriveCaps`, Task 4's `duration`, A1's `applyDecision` and `DecisionCore`.
- Produces:

```ts
export type CapName = 'rounds' | 'upstream' | 'spawns' | 'wall-clock'
export interface TargetUse { spawns: number; ms: number }
export interface CapHit { cap: CapName; gate?: string; note: string }
export function capHit(entries: Entry[], use: TargetUse, caps: DriveCaps): CapHit | undefined
export async function parkAtCap(ctx: Ctx, root: string, target: string, hit: CapHit): Promise<'parked' | 'unparkable'>
// src/verbs/decide.ts — A1's DecisionCore plus two optional fields, read only for selected: 'policy'
interface DecisionCore { /* A1's fields */ park?: true; rule?: string }
```

- **Counting starts after the target's last cap park:** a `human-decision` with `selected: 'policy'` and a `cap-` rule. A human who un-parks starts the count again.
- **The caps,** checked in this order, first hit wins:
  - **rounds:** per gate, the gate-runs on the target's stream that are neither malformed nor fallen back (`roundsSinceApprove`'s exemptions, `rounds.ts:169-178`), with every budget reset ignored. It trips at `≥ caps.rounds` on a gate that is not settled: a gate that converged at round 16 is not capped. Note: `drive cap: <gate> ran <n> rounds across budget resets · drive.caps.rounds <cap>`.
  - **upstream:** `revise-upstream` decisions on the stream, at `≥ caps.upstream`. Note: `drive cap: <n> upstream resets · drive.caps.upstream <cap>`.
  - **spawns:** this run's sessions for the target. Sessions that ended on a usage limit are not counted (Task 11). Note: `drive cap: <n> session(s) this run · drive.caps.spawns <cap>`.
  - **wall-clock:** this run's session time for the target. Note: `drive cap: <duration(ms)> of sessions this run · drive.caps.wallClockMs <duration(cap)>`.
- **`parkAtCap`:**
  - the gate is `hit.gate`, or else the gate of the stream's last gate-run `last`;
  - with no gate-run it is `'unparkable'`;
  - otherwise it loads `decide.ts` with `await import()`, on A1's precedent for `settle.ts`, and calls `applyDecision(ctx, { gate, target, decision: 'stop', note: hit.note, selected: 'policy', rule: `cap-${hit.cap}`, park: true, runId: last.run_id })`;
  - exit 0 is `'parked'`, and any other exit is `'unparkable'`.
- **The two fields** are this plan's addition to A1's `DecisionCore`. `decisionAct` never sets them, so the human verb never does. `applyDecision` refuses either one beside a `selected` other than `policy`, with A1's `autonomy-cannot`.
  - **`park: true`:** when `decide`'s anchor rule (`decide.ts:259`) finds no anchor, a `stop` anchors on the gate's last run. A park is a decision about the flow, and `gateParked` has no sha term (`next.ts:46-66`), so a tree that moved after a revise does not cancel it. A1's `anchor-moved` check still applies, through `runId`.
  - **`rule`:** the journaled `rule` is the act's own, in place of the recommender's. For a park at a cap, the cap is the rule that matched (D121). A1's D130 audit already skips `selected: 'policy'` rows, and A1's `status` shows the rule in its recent decisions.
- **In the loop,** before any spawn for a target, the first included, `capHit` runs:
  - parked: print `drive: parked — <target> · <note>` and set it aside `capped`;
  - unparkable: print `drive: capped — <target> · <note> · no gate run to park it on` and set it aside `capped`.

- [ ] **Step 1: Write the failing tests**

In `tests/caps.test.ts`:

```ts
const run = (gate: string, round: number, extra: Record<string, unknown> = {}) => ({
  v: 1, t: 'gate-run', gate, artifact: 'p1', round, run_id: `r-${gate}-${round}`, reviewed_sha: 's',
  prompts_sha: 'p', witness: '0', model: 'm', pin: 'm', calibration: 'none', checks: [], outcome: 'stopped', ...extra,
})
const decide = (gate: string, decision: string, extra: Record<string, unknown> = {}) =>
  ({ v: 1, t: 'human-decision', gate, artifact: 'p1', round: 1, decision, ...extra })
const CAPS = { rounds: 4, upstream: 2, spawns: 3, wallClockMs: 1_000 }
const none = { spawns: 0, ms: 0 }
const hit = (entries: unknown[], use = none) => capHit(entries as Entry[], use, CAPS)

describe('capHit (B5)', () => {
  it('counts rounds across budget resets', () => {
    expect(hit([run('implement', 1), decide('implement', 'revise-upstream'), run('implement', 1),
      run('implement', 2), decide('implement', 'revise'), run('implement', 3)]))
      .toEqual({ cap: 'rounds', gate: 'implement', note: 'drive cap: implement ran 4 rounds across budget resets · drive.caps.rounds 4' })
  })
  it('malformed and fallen-back rounds spend nothing', () => {
    expect(hit([run('implement', 1), run('implement', 2), run('implement', 3),
      run('implement', 3, { outcome: 'malformed' }), run('implement', 3, { model: 'other' })])).toBeUndefined()
  })
  it('a gate that converged is not capped', () => {
    expect(hit([run('implement', 1), run('implement', 2), run('implement', 3), run('implement', 4, { outcome: 'passed' })])).toBeUndefined()
  })
  it('counts upstream resets', () => {
    expect(hit([run('implement', 1), decide('implement', 'revise-upstream'), run('implement', 1), decide('implement', 'revise-upstream')]))
      .toEqual({ cap: 'upstream', note: 'drive cap: 2 upstream resets · drive.caps.upstream 2' })
  })
  it('counts this run\'s sessions and session time', () => {
    expect(hit([], { spawns: 3, ms: 0 })).toMatchObject({ cap: 'spawns', note: 'drive cap: 3 session(s) this run · drive.caps.spawns 3' })
    expect(hit([], { spawns: 0, ms: 1_000 })).toMatchObject({ cap: 'wall-clock' })
  })
  it('a cap park starts the count again', () => {
    const four = [1, 2, 3, 4].map((r) => run('implement', r))
    expect(hit([...four, decide('implement', 'stop', { selected: 'policy', rule: 'cap-rounds' }), run('implement', 5)])).toBeUndefined()
  })
  it('rounds outrank the run-scoped caps', () => {
    expect(hit([1, 2, 3, 4].map((r) => run('implement', r)), { spawns: 9, ms: 9_000 })?.cap).toBe('rounds')
  })
})
```

In `tests/decide.test.ts`, beside A1's `applyDecision` cases and with its `stoppedGate`:

```ts
it('only a policy act may park past the anchor rule or name its own rule (B5)', async () => {
  const { repo } = await stoppedGate()
  const errs: string[] = []
  const ctx = fakeCtx(repo.root, { err: (l) => errs.push(l) })
  const arbiter = { reason: 'r', arbiter: { model: 'm', prompts_sha: 'p' } }
  expect(await applyDecision(ctx, { gate: 'plan', target: 'auth-refresh', decision: 'stop', selected: 'arbiter', ...arbiter, park: true })).toBe(2)
  expect(await applyDecision(ctx, { gate: 'plan', target: 'auth-refresh', decision: 'stop', rule: 'cap-rounds' })).toBe(2)
  expect(errs.join('\n').match(/autonomy-cannot/g)).toHaveLength(2)
  expect(decisions(repo)).toEqual([])
})
```

In `tests/drive.test.ts`:

```ts
describe('caps (B5)', () => {
  it('parks a capped flow through the policy even after the author moved the tree (Review Focus 4)', async () => {
    const repo = await startedFlows(['a'])
    for (const round of [1, 2]) {
      appendEntry(repo.root, 'a-plan-1', { v: 1, t: 'gate-run', gate: 'implement', artifact: 'a-plan-1', round,
        run_id: `ri${round}`, reviewed_sha: `s${round}`, prompts_sha: 'p', witness: '0', model: 'm', pin: 'm',
        calibration: 'none', checks: [], outcome: 'stopped' })
      appendEntry(repo.root, 'a-plan-1', { v: 1, t: 'human-decision', gate: 'implement', artifact: 'a-plan-1', round, decision: 'revise' })
    }
    writeFileSync(join(worktreePath(repo.root, 'a-plan-1'), 'moved.txt'), 'the author kept working\n')
    repo.write('witness.config.yaml', `${repo.read('witness.config.yaml')}drive:\n  caps:\n    rounds: 2\n`)
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'caps')
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('echo tick') }, out), {})
    const entries = readStream(repo.root, 'a-plan-1')
    expect(gateParked(entries, 'implement')).toBe(true)
    expect(entries.at(-1)).toMatchObject({ t: 'human-decision', decision: 'stop', selected: 'policy', rule: 'cap-rounds' })
    expect(out.join('\n')).toContain('drive: parked — a-plan-1 · drive cap: implement ran 2 rounds across budget resets · drive.caps.rounds 2')
    expect(out.join('\n')).not.toContain('] tick')       // no session past the cap
    expect(code).toBe(1)
  }, 60000)

  it('a target with no gate run to park on is set aside and named', async () => {
    const repo = await startedFlows(['a'])
    repo.write('witness.config.yaml', `${repo.read('witness.config.yaml')}drive:\n  caps:\n    spawns: 1\n`)
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'caps')
    const agent = script(`exec ${witnessCli()} dispatch-report a-plan-1 --steps-assigned 1 --steps-completed 0`)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), {})
    expect(out.join('\n')).toContain('drive: capped — a-plan-1 · drive cap: 1 session(s) this run · drive.caps.spawns 1 · no gate run to park it on')
  }, 60000)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/caps.test.ts tests/drive.test.ts tests/decide.test.ts`
Expected: FAIL. `src/caps.js` does not exist, the drive cases spawn past the cap, and `applyDecision` journals both acts.

- [ ] **Step 3: Implement as specified under Interfaces**

- [ ] **Step 4: Run them and watch them pass, then decide's suites**

Run: `pnpm vitest run tests/caps.test.ts tests/drive.test.ts tests/decide.test.ts tests/decide-show.test.ts tests/gate-park.test.ts`
Expected: PASS. The human `decide --stop` path is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/caps.ts src/drive.ts src/verbs/decide.ts tests/caps.test.ts tests/drive.test.ts tests/decide.test.ts
git commit -m "feat(drive): hard caps park a target through the policy · the cap is named" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Usage pauses and a machine that stays awake (B4)

**Files:**
- Create: `src/awake.ts`
- Modify: `src/drive.ts`: `settle` reads `sessionLimit`; the loop pauses, keeps the machine awake, and lets go after
- Test: `tests/drive.test.ts`

**Interfaces:**
- Consumes: Task 4's `sessionLimit`, `waitFor`, `duration`, the bounds and `Clock`.
- Produces, in `src/awake.ts`:

```ts
export interface Awake { command?: string; stop(): void }
export function keepAwake(env: Record<string, string | undefined>, platform: NodeJS.Platform, pid: number): Awake
```

- **The binary** is `env.WITNESS_KEEP_AWAKE_BIN` when set: a test seam on `WITNESS_DRIVE_AGENT_BIN`'s precedent, never documented. Otherwise it is `caffeinate` on darwin, run as `-ims -w <pid>`. That holds off idle, disk and AC system sleep, and caffeinate exits with drive even when drive is killed.
- **Drive prints** `keep-awake: <command> — a closed lid on battery still sleeps`. Elsewhere it prints `keep-awake: none on <platform> — keep the host awake yourself`. It stops the process when the run ends.
- **A session whose end reads as a `Limit`** pauses every lane: nothing new starts until `now + waitFor(limit, streak)`, and running sessions finish, because they meet the same account. The session counts toward no cap, and its target's next consideration is not judged for progress.
  - It prints `drive: usage limit — waiting <duration> · <limit text>`.
  - Only the time a wait adds beyond a pause already running counts toward the total.
  - The streak resets when a session ends without a limit.
- **The two stops,** each ending the run:
  - a wait past `SINGLE_WAIT_MAX_MS` prints `drive: usage limit — resets in <duration> — beyond drive's 6h wait · <limit text>`;
  - a wait that would take the run past `TOTAL_WAIT_MAX_MS` prints `drive: usage limit — waited <duration> — the next wait passes drive's 12h bound · <limit text>`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('surviving unattended (B4)', () => {
  const LIMIT = "You've hit your session limit · resets 2pm (America/Los_Angeles)"
  const START = Date.parse('2026-10-19T19:30:00Z')

  it('waits out a usage limit and spawns again after the reset', async () => {
    const repo = await planReady()
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const flag = join(fakeScenario(), 'limited')
    const agent = script(`if [ ! -f "${flag}" ]; then touch "${flag}"; echo "${LIMIT}" >&2; exit 1; fi\nexec ${witnessCli()} start auth-refresh-plan-1`)
    const clock = fakeClock(START)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), { maxSpawns: 2 }, clock)
    expect(out.join('\n')).toContain(`drive: usage limit — waiting 1h31m · ${LIMIT}`)
    expect(clock.slept).toEqual([5_460_000])
    expect(existsSync(worktreePath(repo.root, 'auth-refresh-plan-1'))).toBe(true)   // the second session acted
    expect(out.join('\n')).not.toContain('drive: no progress — witness start')
  }, 60000)

  it('a reset past the single wait stops the run', async () => {
    const repo = await planReady()
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const late = "You've hit your session limit · resets 4am (America/Los_Angeles)"          // 15h30m away
    const clock = fakeClock(START)
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script(`echo "${late}" >&2\nexit 1`) }, out), {}, clock)
    expect(out.join('\n')).toContain("drive: usage limit — resets in 15h31m — beyond drive's 6h wait")
    expect(clock.slept).toEqual([])
    expect(code).toBe(1)
  }, 60000)

  it('a limit that never lifts never waits past the total bound (Review Focus 5)', async () => {
    const repo = await planReady()
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const spawned = join(fakeScenario(), 'spawned')
    const agent = script(`echo x >> "${spawned}"\necho '429 {"type":"error","error":{"type":"rate_limit_error","message":"x"}}' >&2\nexit 1`)
    const clock = fakeClock(START)
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), {}, clock)
    expect(out.join('\n')).toContain("the next wait passes drive's 12h bound")
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(43_200_000)
    expect(readFileSync(spawned, 'utf8').trim().split('\n')).toHaveLength(clock.slept.length + 1)
    expect(code).toBe(1)
  }, 120000)

  it('keeps the machine awake for the run and lets go after', async () => {
    const repo = await planReady()
    const dir = fakeScenario()
    const awake = join(dir, 'awake')
    writeFileSync(awake, `#!/bin/sh\necho "$@" > "${dir}/args"\necho $$ > "${dir}/pid"\nexec sleep 30\n`, { mode: 0o755 })
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), fakeCtx(repo.root, { tty: true, out: (l) => out.push(l),
      env: fixtureEnv({ WITNESS_KEEP_AWAKE_BIN: awake, WITNESS_DRIVE_AGENT_BIN: script('sleep 0.5') }) }), { maxSpawns: 1 })
    expect(readFileSync(join(dir, 'args'), 'utf8').trim()).toBe(`-ims -w ${process.pid}`)
    expect(out.join('\n')).toContain(`keep-awake: ${awake} -ims -w ${process.pid} — a closed lid on battery still sleeps`)
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    await expect.poll(() => { try { process.kill(pid, 0); return 'alive' } catch { return 'gone' } }, { timeout: 5_000 }).toBe('gone')
  }, 60000)
})
```

The transient backoff in the bound test is 1, 2, 4, 8, 16 and then 30 minutes. The run waits 27 times (691 min) and stops at the 28th wait. Expect about 28 quick sessions.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/drive.test.ts`
Expected: FAIL.
- The first case reads the limited session as no progress.
- The third runs to the 200 ceiling with no wait.
- The fourth finds no `args` file.

- [ ] **Step 3: Implement as specified under Interfaces**

- [ ] **Step 4: Run them and watch them pass**

Run: `pnpm vitest run tests/drive.test.ts tests/usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/awake.ts src/drive.ts tests/drive.test.ts
git commit -m "feat(drive): usage limits pause every lane until the reset · the machine stays awake" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: One report, one notification (B6)

**Files:**
- Create: `src/drive-report.ts`, `src/notify.ts`
- Modify: `src/opener.ts:14-19`: export `resolves`
- Modify: `src/drive.ts`: snapshot the journal at the start; print the report and notify at the end
- Test: `tests/drive-report.test.ts` (new), `tests/drive.test.ts`

**Interfaces:**
- Consumes:
  - A1's `owedDecisions`, `KEPT_STOP_NAMES` and `KeptStop`;
  - A2's `unmetNeeds`;
  - `parkedGates` (`next.ts:343`), `handoffLine` and `resolveDriver` (`harness.ts:263,334`);
  - Task 8's `Aside`, which Task 9 fills with `gate` and `stop` for a kept stop.
- Produces:

```ts
// src/drive-report.ts
export interface RunStart { lines: Map<string, number> }          // stream → line count when the run began
export function runStart(root: string): RunStart
export function entriesSince(root: string, start: RunStart): Array<{ stream: string; entry: Entry }>
export interface Report { lines: string[]; summary: string; merged: number; waiting: number; parked: number; stuck: number }
export function driveReport(
  root: string, ctx: Ctx, cfg: Config, start: RunStart, aside: readonly Aside[], run: { autonomous: boolean; stopped?: string },
): Report
// src/notify.ts
export function notifyArgv(platform: NodeJS.Platform, configured: string | undefined, title: string, message: string): string[] | undefined
export function notify(configured: string | undefined, title: string, message: string, platform?: NodeJS.Platform):
  { outcome: 'sent' | 'failed' | 'none'; command?: string }
```

- **The report, exact copy, in this order.** Every `run:` and `then:` line is raw: commands are never `kv`-escaped (D120).

```
drive: <done | stopped> — <m> merged · <w> wait on you · <p> parked · <s> stuck
merged: <plan> · PR #<pr>
wait: design look · <spec>
  run: witness design <spec> --open
  then: witness decide design <spec> --show
wait: trust grant · <target> · in a terminal · answer each prompt
  run: witness gate <gate> <target>
wait: unmet need · <doc> · <text>
  run: <satisfy>
wait: held criterion · <doc> · <text> holds <holds joined ' · '>
  run: <satisfy>
wait: decision · <gate> <target>
  run: witness decide <gate> <target> --show
wait: conversation · <target or brainstorm>
  run: <handoffLine(driver, root, undefined)>
wait: merge · <target> · PR #<n>
  run: gh pr merge <n>
parked: <target> · <gate> round <round> — <why>
  run: <reopen>
stuck: <target> — <why>
obligation: <id> · <target> · <anchor> — <kind>
decisions: policy <n> · arbiter <n> · affirmation <n> · named <n>
help: answer the waits above · then /witness or witness drive picks up where this run stopped
```

- **merged:** the `status` entries with `cause: 'merge'` since the start.
- **wait,** each target once, in this order:
  - this run's `kept` set-asides whose `stop` is `design-look` or `trust-grant`. Their acts are the ones A1's kept lines name: open the look and then decide it; run the stopped gate in a terminal and answer each trust prompt.
  - `unmetNeeds(canon)` (A2): a plan need is `unmet need`, a spec need with `holds` is `held criterion`, and a spec need holding nothing is `unmet need`. A plan set aside `kept` for an unmet need is listed here, from the state.
  - every owed decision (`owedDecisions(root, canon)`, A1) whose target no row above names. Under autonomy that is a stop A1 left for a human, or a `--manual` run's. With autonomy off it is every owed decision.
  - this run's set-asides of kind `conversation` and `merge`.
- **parked:** `parkedGates(root, canon)`. The `why` is the stop decision's note when its `selected` is `policy`, and `parked at <anchor>` otherwise.
- **stuck:** this run's `stuck` set-asides, and its unparkable `capped` ones, with their `why`.
- **obligation:** the `deferral` entries since the start.
- **decisions:** the `human-decision` entries since the start, with reopens (`caused_by`) left out, counted by `selected`. An absent `selected` counts as `named` (D143).
- **help** prints only when something waits. The head reads `stopped` when the run stopped (ceiling, usage, signal or spawn-failed).
- **The summary** is `witness drive — <repo basename> · <m> merged · <w> wait on you · <p> parked · <s> stuck`.
- **The notification fires only for autonomous runs:** `notify(local.notify, 'witness drive', summary)`. Drive prints one of:
  - `notify: sent via <command>`;
  - `notify: <command> not found — set notify: in .witness/config.local.yaml`;
  - `notify: none on <platform> — set notify: in .witness/config.local.yaml`.
- **`notifyArgv`:**
  - a configured command gets `[configured, message]`;
  - darwin gets `['osascript', '-e', `display notification ${q(message)} with title ${q(title)}`]`, where `q` wraps in `"` and escapes `\` and `"`;
  - linux gets `['notify-send', title, message]`;
  - anything else gets `undefined`.
- **`notify`** probes with `resolves`, spawns detached and `unref`s, on `openArtifact`'s precedent (`opener.ts:27-44`).

- [ ] **Step 1: Write the failing tests**

In `tests/drive-report.test.ts`:

```ts
describe('the run report (B6)', () => {
  it('names what merged · what waits with its command · what was parked · obligations · decisions', async () => {
    const repo = await seededRepo()
    autonomyOn(repo)
    await writeSpec(repo, 'billing-page', { ui: true, criteria: [{ id: 'ac-bill', test: '@spec:billing-page' }] })
    approve(repo, 'billing-page')
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-2', { needs: [{ id: 'ses-prod', manual: 'SES production access', satisfied: false }] })
    approve(repo, 'auth-refresh-plan-2')
    await writePlan(repo, 'auth-refresh-plan-3')
    await writePlan(repo, 'auth-refresh-plan-4')
    const start = runStart(repo.root)
    const add = (stream: string, e: Record<string, unknown>) => appendEntry(repo.root, stream, { v: 1, ...e } as never)
    const planRun = (plan: string, round: number) => add(plan, { t: 'gate-run', gate: 'plan', artifact: plan, round, run_id: `r-${plan}`,
      reviewed_sha: 's', prompts_sha: 'p', witness: '0', model: 'm', calibration: 'none', checks: [], outcome: 'stopped' })
    add('auth-refresh-plan-1', { t: 'status', artifact: 'auth-refresh-plan-1', from: 'in-progress', to: 'done', cause: 'merge', pr: 7 })
    add('auth-refresh-plan-1', { t: 'deferral', id: 'd-1a2b3c4d', artifact: 'auth-refresh-plan-1', gate: 'ship', round: 1,
      anchor: 'src/token.ts#rotate', kind: 'artifact-debt', caused_by_run: 'r1' })
    for (const selected of ['policy', 'policy', 'arbiter', undefined]) {
      add(repo.effort, { t: 'human-decision', gate: 'decompose', artifact: repo.effort, round: 1, decision: 'revise', ...(selected ? { selected } : {}) })
    }
    add(repo.effort, { t: 'human-decision', gate: 'decompose', artifact: repo.effort, round: 1, decision: 'revise', caused_by: { artifact: 'x', gate: 'plan', round: 1 } })
    planRun('auth-refresh-plan-3', 3)
    add('auth-refresh-plan-3', { t: 'human-decision', gate: 'plan', artifact: 'auth-refresh-plan-3', round: 3, decision: 'stop',
      selected: 'policy', rule: 'cap-rounds', note: 'drive cap: plan ran 16 rounds across budget resets · drive.caps.rounds 16' })
    planRun('auth-refresh-plan-4', 1)                    // owed · never settled: a --manual run's stop
    const cfg = loadConfig(repo.root)
    if (!cfg.ok) throw new Error('config')
    const r = driveReport(repo.root, fakeCtx(repo.root), cfg.value, start, [
      { target: 'billing-page', kind: 'kept', stop: 'design-look', gate: 'design', line: 'witness decide design billing-page --show', why: 'design look' },
      { target: 'x-plan-1', kind: 'stuck', line: 'witness ship x-plan-1', why: 'no progress on witness ship x-plan-1' },
    ], { autonomous: true })
    expect(r.lines[0]).toBe('drive: done — 1 merged · 3 wait on you · 1 parked · 1 stuck')
    for (const line of [
      'merged: auth-refresh-plan-1 · PR #7',
      'wait: design look · billing-page',
      '  run: witness design billing-page --open',
      '  then: witness decide design billing-page --show',
      'wait: unmet need · auth-refresh-plan-2 · SES production access',
      '  run: witness satisfy auth-refresh-plan-2 --need ses-prod',
      'wait: decision · plan auth-refresh-plan-4',
      '  run: witness decide plan auth-refresh-plan-4 --show',
      'parked: auth-refresh-plan-3 · plan round 3 — drive cap: plan ran 16 rounds across budget resets · drive.caps.rounds 16',
      'stuck: x-plan-1 — no progress on witness ship x-plan-1',
      'obligation: d-1a2b3c4d · auth-refresh-plan-1 · src/token.ts#rotate — artifact-debt',
      'decisions: policy 3 · arbiter 1 · affirmation 0 · named 1',      // the cap park is a policy decision too
    ]) expect(r.lines).toContain(line)
    expect(r.lines.every((l) => !l.includes(','))).toBe(true)
    expect(r.summary).toBe(`witness drive — ${basename(repo.root)} · 1 merged · 3 wait on you · 1 parked · 1 stuck`)
  })
})

describe('notify (B6)', () => {
  it('renders the platform notifier and a configured command', () => {
    expect(notifyArgv('darwin', undefined, 'witness drive', 'a "b" c'))
      .toEqual(['osascript', '-e', 'display notification "a \\"b\\" c" with title "witness drive"'])
    expect(notifyArgv('linux', undefined, 'witness drive', 'm')).toEqual(['notify-send', 'witness drive', 'm'])
    expect(notifyArgv('win32', undefined, 'witness drive', 'm')).toBeUndefined()
    expect(notifyArgv('win32', '/bin/ping-me', 'witness drive', 'm')).toEqual(['/bin/ping-me', 'm'])
  })
})
```

In `tests/drive.test.ts`:

```ts
describe('coming back (B6)', () => {
  const recorder = () => {
    const dir = fakeScenario()
    const bin = join(dir, 'notify')
    writeFileSync(bin, `#!/bin/sh\necho "$1" >> "${dir}/got"\n`, { mode: 0o755 })
    return { bin, got: join(dir, 'got') }
  }

  it('an autonomous run ends with the report and one notification', async () => {
    const repo = await startedFlows(['a'])
    const n = recorder()
    writeLocalConfig(repo.root, { notify: n.bin })
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('exit 0') }, out), {})
    expect(out).toContain('drive: done — 0 merged · 0 wait on you · 0 parked · 1 stuck')
    expect(readFileSync(n.got, 'utf8').trim().split('\n'))
      .toEqual([`witness drive — ${basename(repo.root)} · 0 merged · 0 wait on you · 0 parked · 1 stuck`])
    expect(out).toContain(`notify: sent via ${n.bin}`)
  }, 60000)

  it('a run with autonomy off reports and sends nothing', async () => {
    const repo = await planReady()
    const n = recorder()
    writeLocalConfig(repo.root, { notify: n.bin })
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), ttyCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('exit 0'), WITNESS_KEEP_AWAKE_BIN: noopOpener() }, out), { maxSpawns: 1 })
    expect(out.some((l) => l.startsWith('drive: done — ') || l.startsWith('drive: stopped — '))).toBe(true)
    expect(existsSync(n.got)).toBe(false)
  }, 60000)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/drive-report.test.ts tests/drive.test.ts`
Expected: FAIL. `src/drive-report.js` and `src/notify.js` do not exist, and the run prints no report.

- [ ] **Step 3: Implement as specified under Interfaces**

- [ ] **Step 4: Run them and watch them pass, then opener's**

Run: `pnpm vitest run tests/drive-report.test.ts tests/drive.test.ts tests/opener.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/drive-report.ts src/notify.ts src/opener.ts src/drive.ts tests/drive-report.test.ts tests/drive.test.ts
git commit -m "feat(drive): one report when nothing else can move · a desktop notification" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Entry: one command, one drive per repo (B1)

**Files:**
- Modify: `src/verbs/drive.ts` (whole)
- Modify: `src/drive-presence.ts`: the drive lock and `watchLine`
- Modify: `src/drive.ts`: `detachDrive`
- Modify: `src/gitio.ts:95-105` (`LOCAL_STATE_FILES`), `src/verbs/init.ts:43-50` (`GITIGNORE_BLOCK`)
- Modify: `src/cli.ts:75` (usage), `README.md` (the verb row and the keep-awake operator note)
- Modify: `tests/drive.test.ts:20-25`. Today's `refuses without a TTY` case is kept: autonomy defaults off.
- Test: `tests/drive.test.ts`, `tests/gitio.test.ts`, `tests/init.test.ts`

**Interfaces:**
- Consumes:
  - Task 5's marker;
  - A2's `queueAsk`;
  - `resolveFlow` (`next.ts:759`);
  - Task 8's `driveLoop`.
- Produces:

```ts
// src/drive-presence.ts
export const DRIVE_LOCK = '.witness/drive.lock'
export const DRIVE_LOG = '.witness/drive.log'
export interface DriveHolder { pid: number; log?: string }
export function driveHolder(root: string): DriveHolder | undefined       // a live holder only · a dead one reads as none
export function acquireDriveLock(root: string, info: { log?: string }, pid?: number): Result<() => void>
export function watchLine(h: DriveHolder): string
  // 'tail -f <log> · stop it: kill <pid>' · 'the terminal running witness drive · pid <pid>' when there is no log
// src/drive.ts
export function detachDrive(root: string, ctx: Ctx, args: readonly string[]): Result<{ pid: number; log: string }>
```

- **`detachDrive`** spawns this CLI with `['drive', ...args]`: `WITNESS_BIN` through `/bin/sh -c 'exec <bin> "$@"' witness` when it is set, so the printed pid is the CLI's own and no shell sits between it and a `kill`, and `process.execPath` with this build's `bin.js` otherwise. The child runs detached at the root with `ctx.env`, stdin ignored, and stdout and stderr appended to `<root>/.witness/drive.log` after a `--- witness drive <ISO time> ---` header. Then it `unref`s the child. The background drive takes the drive lock itself and records the log path in it.
- **The verb, in this order:**
  1. `WITNESS_DRIVE` set → `drive-inside-drive`, before the root lookup, because it is true wherever it was typed;
  2. root, config and flags (`--flow`, `--max-spawns`, `--manual`, `--detach`, `--ask`);
  3. `--detach` while autonomy is off, or with `--manual` → `detach-needs-autonomy`;
  4. no TTY while the run is not autonomous → `drive-needs-tty`;
  5. a live drive lock → `drive-running`;
  6. `--flow` → `resolveFlow`, with today's claim refusals;
  7. `--ask <text>` → `queueAsk(ctx, root, text)`. A refusal renders and exits 2. Success prints what `witness ask` prints (`src/verbs/ask.ts:42`): `ask: <id> — queued`, or `ask: <id> — already queued` when `already` is true.
  8. `--detach` → `detachDrive` with every flag except `--detach` and `--ask`. Print `drive: started in the background · pid <n>`, then `watch: <watchLine>`, and exit 0.
  9. Acquire the drive lock, run `driveLoop`, and release the lock.
- **The refusals, `field · rule · got · want`:**
  - `WITNESS_DRIVE` · `drive-inside-drive` · `set (<value>)` · `run witness drive in your own terminal — agents are what drive spawns, never what spawns drive`
  - `tty` · `drive-needs-tty` · `non-interactive session · autonomy off` (or `· --manual`) · `a terminal — drive asks you at every stop unless autonomy: on is set in witness.config.yaml`
  - `--detach` · `detach-needs-autonomy` · `autonomy off` (or `--manual`) · `autonomy: on in witness.config.yaml — a background drive cannot ask you anything`
  - `.witness/drive.lock` · `drive-running` · `pid <n>` · `one drive per repo — <watchLine>`
- **Local files:** `.witness/drive.lock` and `.witness/drive.log` join `LOCAL_STATE_FILES` and `GITIGNORE_BLOCK`.
- **`VERB_USAGE.drive`:** `witness drive [--flow <plan-id>] [--max-spawns <n>] [--manual] [--detach] [--ask "<text>"] — runs every session itself · under autonomy it needs no terminal and reports when nothing else can move`
- **README:**
  - the drive row says the same thing;
  - the keep-awake note says `witness drive` holds `caffeinate -ims` on macOS for its own lifetime.

- [ ] **Step 1: Write the failing tests**

```ts
describe('one command (B1)', () => {
  const autonomous = async (): Promise<TestRepo> => {
    const repo = await seededRepo()
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    return repo
  }
  const quiet = { WITNESS_DRIVE_AGENT_BIN: '/usr/bin/true', WITNESS_KEEP_AWAKE_BIN: '/usr/bin/true' }

  it('a session drive spawned is refused even in a terminal', async () => {
    const repo = await seededRepo()
    // `quiet` matters while this test fails: today's drive would otherwise spawn the real harness CLI
    const r = await repo.cli(['drive'], { tty: true, env: { ...quiet, WITNESS_DRIVE: 'p1' } })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('drive-inside-drive')
  })

  it('under autonomy drive needs no terminal · --manual still does', async () => {
    const repo = await autonomous()
    const r = await repo.cli(['drive', '--max-spawns', '1'], { env: quiet })
    expect(r.stderr).not.toContain('drive-needs-tty')
    const manual = await repo.cli(['drive', '--manual'], { env: quiet })
    expect(manual.code).toBe(2)
    expect(manual.stderr).toContain('drive-needs-tty')
  }, 60000)

  it('one drive per repo', async () => {
    const repo = await autonomous()
    const holder = spawn('sleep', ['30'])
    writeFileSync(join(repo.root, '.witness/drive.lock'), JSON.stringify({ pid: holder.pid, log: join(repo.root, '.witness/drive.log') }))
    const r = await repo.cli(['drive'], { env: quiet })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('drive-running')
    expect(r.stderr).toContain(`stop it: kill ${holder.pid}`)
    holder.kill()
    await once(holder, 'exit')
    expect((await repo.cli(['drive', '--max-spawns', '1'], { env: quiet })).stderr).not.toContain('drive-running')
  }, 60000)

  it('--detach needs autonomy', async () => {
    const repo = await seededRepo()
    const r = await repo.cli(['drive', '--detach'], { env: quiet })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('detach-needs-autonomy')
  })

  it('--detach starts drive in the background · says where to watch · a SIGTERM stops it and its sessions', async () => {
    const repo = await autonomous()
    const dir = fakeScenario()
    const agent = join(dir, 'agent')
    writeFileSync(agent, `#!/bin/sh\necho $$ > "${dir}/session"\nexec sleep 30\n`, { mode: 0o755 })
    const r = await repo.cli(['drive', '--detach'], { env: { WITNESS_BIN: witnessCli(), WITNESS_DRIVE_AGENT_BIN: agent, WITNESS_KEEP_AWAKE_BIN: '/usr/bin/true' } })
    expect(r.code).toBe(0)
    const pid = Number(/background · pid (\d+)/.exec(r.stdout)![1])
    const log = join(repo.root, '.witness', 'drive.log')
    expect(r.stdout).toContain(`watch: tail -f ${log} · stop it: kill ${pid}`)
    await expect.poll(() => existsSync(join(dir, 'session')), { timeout: 30_000 }).toBe(true)
    process.kill(pid, 'SIGTERM')
    await expect.poll(() => readFileSync(log, 'utf8'), { timeout: 30_000 }).toContain('drive: stopped — signal SIGTERM')
    const session = Number(readFileSync(join(dir, 'session'), 'utf8'))
    await expect.poll(() => { try { process.kill(session, 0); return 'alive' } catch { return 'gone' } }, { timeout: 15_000 }).toBe('gone')
    expect(existsSync(join(repo.root, '.witness', 'drive.lock'))).toBe(false)
  }, 90000)

  it('--ask queues the ask before the first session', async () => {
    const repo = await autonomous()
    const agent = script(`grep -rqF 'add dark mode' "${repo.root}/.witness/journal" && echo ask-seen`)
    const r = await repo.cli(['drive', '--ask', 'add dark mode', '--max-spawns', '1'], { env: { ...quiet, WITNESS_DRIVE_AGENT_BIN: agent } })
    expect(r.stdout).toMatch(/ask: a\d+ — queued/)
    expect(r.stdout).toContain('] ask-seen')
  }, 60000)
})
```

In `tests/gitio.test.ts` and `tests/init.test.ts`:

```ts
it('drive\'s lock and log are witness local files', () => {
  const repo = tmpRepo()
  repo.write('.witness/drive.lock', '{"pid":1}')
  repo.write('.witness/drive.log', 'x\n')
  repo.write('specs/a.md', 'a')
  expect(dirtyStatePaths(repo.root)).toEqual(['specs/a.md'])
})
it('init ignores drive\'s lock and log', async () => {
  const repo = tmpRepo()
  await repo.cli(['init'])
  expect(repo.read('.gitignore')).toContain('.witness/drive.lock\n.witness/drive.log\n')
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/drive.test.ts tests/gitio.test.ts tests/init.test.ts`
Expected: FAIL. A marked session gets `drive-needs-tty` or runs. A non-TTY autonomous drive refuses `drive-needs-tty`. `--detach` and `--ask` are unknown options (`bad-arguments`). The drive files read as dirty.

- [ ] **Step 3: Implement as specified under Interfaces**

- [ ] **Step 4: Run them and watch them pass, then the CLI's own suites**

Run: `pnpm vitest run tests/drive.test.ts tests/gitio.test.ts tests/init.test.ts tests/cli.test.ts tests/verb-usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/drive.ts src/drive-presence.ts src/drive.ts src/gitio.ts src/verbs/init.ts src/cli.ts README.md tests/drive.test.ts tests/gitio.test.ts tests/init.test.ts
git commit -m "feat(drive): the marker guards recursion · one drive per repo · --detach · --ask · --manual" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: `/witness` hands the run to drive

**Files:**
- Modify: `src/verbs/next.ts` (`run()`): `launch:` and `watch:`, printed last
- Modify: `plugin/commands/witness.md`: three rows at the top of the action table
- Test: `tests/next-scope.test.ts`, `tests/command.test.ts`

**Interfaces:**
- Consumes: Task 13's `driveHolder` and `watchLine`; A1's `Config.autonomy`.
- **What `next` prints:** when `cfg.autonomy` is on, the session is not marked, and the routing answer is not `witness check`, it prints one more line, last:
  - `launch: witness drive --detach` when no drive is running;
  - `watch: <watchLine(holder)>` while one is.
- **The rows, exact copy, inserted above `A \`choose:\` block is printed`:**

```md
| `launch:` is printed and this session is not `--manual`-armed | Autonomy is on and no `witness drive` runs for this repo. Run the `launch:` command via Bash as you run a `next:` line. It starts drive in the background and prints a `watch:` line. Print that `watch:` line for the human and **END YOUR TURN**: drive starts every session from here and reports when nothing else can move. |
| `watch:` is printed and no `launch:` | A `witness drive` already runs this repo. Print the `watch:` line for the human and **END YOUR TURN**. |
| `drive: done` is printed | `witness drive` started this session for one target and that target needs nothing more from it. **END YOUR TURN**. |
```

- A2's ask sentence runs before the first `next`, so `/witness <words>` queues the ask and then launches drive. A1's autonomy conditional is not touched.

- [ ] **Step 1: Write the failing tests**

In `tests/next-scope.test.ts`:

```ts
describe('next hands an autonomous chat session to drive (B1)', () => {
  it('prints launch: under autonomy when no drive runs', async () => {
    const repo = await seededRepo()
    autonomyOn(repo)
    expect(await nextLine(repo)).toContain('launch: witness drive --detach')
  })
  it('prints watch: while a drive runs', async () => {
    const repo = await seededRepo()
    autonomyOn(repo)
    const holder = spawn('sleep', ['30'])
    const log = join(repo.root, '.witness', 'drive.log')
    writeFileSync(join(repo.root, '.witness', 'drive.lock'), JSON.stringify({ pid: holder.pid, log }))
    const out = await nextLine(repo)
    expect(out).toContain(`watch: tail -f ${log} · stop it: kill ${holder.pid}`)
    expect(out).not.toContain('launch:')
    holder.kill()
  })
  it('prints neither to a drive session · or with autonomy off', async () => {
    const auto = await seededRepo()
    autonomyOn(auto)
    expect(await nextLine(auto, { env: { WITNESS_DRIVE: auto.effort } })).not.toMatch(/^(launch|watch):/m)
    expect(await nextLine(await seededRepo())).not.toMatch(/^(launch|watch):/m)
  })
})
```

In `tests/command.test.ts`:

```ts
it('hands an autonomous run to drive before any other row (B1)', () => {
  const b = body()
  for (const s of ['`launch:` is printed and this session is not `--manual`-armed', '`watch:` is printed and no `launch:`', '`drive: done` is printed']) {
    expect(b).toContain(s)
  }
  expect(b.indexOf('`launch:` is printed')).toBeLessThan(b.indexOf('A `choose:` block is printed'))
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/next-scope.test.ts tests/command.test.ts`
Expected: FAIL. No `launch:` line prints, and the engine has no such row.

- [ ] **Step 3: Implement, and paste the rows byte for byte**

- [ ] **Step 4: Run them and watch them pass, then the payload suites**

Run: `pnpm vitest run tests/next-scope.test.ts tests/command.test.ts tests/harness-neutrality.test.ts tests/pi-extension.test.ts tests/version-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/next.ts plugin/commands/witness.md tests/next-scope.test.ts tests/command.test.ts
git commit -m "feat(next): under autonomy /witness launches drive and says where to watch" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: DESIGN.md rows 180–184

**Files:**
- Modify: `DESIGN.md`. Append the rows after row 179, in the house shape `| N mark | title | decision | why/evidence |`, with the mark the autopilot rows use. Put the residuals at the top of `## Open / deferred`.

- [ ] **Step 1: Write the rows**

**Row 180, "`witness drive` runs everything".** Amends 145.
- **Decision:**
  - the TTY rule binds only when the run is not autonomous (autonomy off, or `--manual`);
  - the recursion guard is `WITNESS_DRIVE`, set on every child; a marked session's `drive` refuses `drive-inside-drive`;
  - one drive per repo (`.witness/drive.lock`, `drive-running`);
  - `--detach` (autonomy only) runs in the background into `.witness/drive.log`;
  - `--ask` queues through A2's `queueAsk`;
  - `--manual` makes the run serial with the `decide>` prompt and prompts children `/witness --manual`;
  - under autonomy `next` prints `launch:` or `watch:`, and `/witness` starts drive and ends its turn;
  - under autonomy nothing is a conversation, and decisions settle in the CLI instead of the prompt: drive runs A1's `settleOwed` between sessions;
  - a kept stop, a stop A1 left for a human, a conversation or a merge left to the human sets its target aside, and the run moves on.
- **Amends:** 145, and 173's stop set: under autonomy drive asks no decision question, so a stop left for a human waits for the report.
- **Evidence:** drive never ran in fewhats, and `witness drive` is not in the shell history. It was TTY-only and stopped at every decision and conversation stage (autopilot design E3).

**Row 181, "Side by side, one target per session".** Extends 73 and 76.
- **Decision:**
  - `drive.parallel` (default 2) sessions at once, one per target;
  - the marker scopes a child: `computeNext`'s `scope` filters every rung, a marked session's `next` answers for its target alone, and it passes that scope to A1's `settleOwed`, so each stop has one settler;
  - slots fill from the ladder itself, so tier 1's most-advanced-first order (73) decides who runs;
  - progress is judged per target (line, its stream, its effort's stream);
  - the repo lock waits up to 30 s (50 ms polls), and an unreadable lock is a write in progress;
  - `test-evidence` and `verify-red` take the lock for their write only;
  - test runs take turns across worktrees at `execCommand` (`.witness/runner.lock` at the primary root). A turn waits while its holder lives and never refuses, and `drive.parallelSuites: true` relaxes it (Task 3b);
  - `applyDecision` re-reads under the lock (A1), so two settlers racing one stop journal one decision.
- **Evidence:** today's guard compared the whole journal, which any other lane satisfies. Evidence held the lock across the suite: 13–48 s filtered in fewhats, ~9 min full-suite (E4, E6).

**Row 182, "Usage limits are waited out".**
- **Decision:**
  - only these shapes count: `You've hit your <session|weekly|usage|5-hour|daily> limit · resets <when>`, claude's `usage limit reached|<epoch>`, and the `rate_limit_error` and `overloaded_error` bodies and the two network lines, which count as transient;
  - a limit pauses every lane until the reset plus 60 s;
  - repeats back off;
  - one wait is at most 6 h, and a run waits at most 12 h, with every wait printed;
  - under drive a reviewer call waits for the reset; outside drive it refuses `usage-limit` naming the reset;
  - drive holds `caffeinate -ims -w <pid>` on macOS.
- **Evidence:** the shapes were read verbatim from fewhats's pi logs (11 usage, 37 rate-limit, 27 overloaded) and claude 2.1.304. The README's operator note calls suspend the killer of long runs (79).

**Row 183, "Hard caps park what will not converge".**
- **Decision:** rounds 16, upstream 6, spawns 24, wall-clock 16 h, per target.
  - Rounds and upstream are counted from the journal across budget resets, and they restart after a cap park.
  - Spawns and session time are counted for the run.
  - Caps are checked between sessions.
  - A cap parks through `applyDecision` with `selected: policy`, two policy-only fields added to A1's `DecisionCore`: `rule: cap-<name>` and `park`, whose anchor lets a stop land on the last run after the tree moved. A target with no gate run is set aside and named.
  - Under autonomy the spawn ceiling is 200.
- **Evidence (B5):** merged plans ran ≤ 13 implement rounds apart from 20 and 63. thread-mirror-plan-1 was abandoned at 25 rounds and 6 upstream resets. Normal plans took ≤ 16 sessions and ≤ ~14 h in worktree sessions. fewhats ran 203 sessions in 33 days.

**Row 184, "One report and a notification".**
- **Decision:**
  - the report names what merged (merge stamps since the start);
  - what waits, each with its exact command: looks, trust grants, unmet and holding needs (A2's `unmetNeeds`), decisions, conversations and merges;
  - what is parked and why;
  - what is stuck;
  - the obligations minted since the start;
  - decisions by `selected`;
  - an autonomous run notifies through `notify:` (machine-local) or the platform notifier;
  - exit 1 when anything was stuck or capped, or the run stopped.
- **Evidence:** design B6 and G3.

**Open / deferred, new first bullets:**
1. **Concurrent suites share the machine.** Two worktrees can now run their suites at once, which gate checks already could (`gate.ts:217`). A suite on a fixed port or a shared database, such as fewhats's e2e web server, can then read the other worktree's server. A runner lock is deferred until a collision is measured.
2. **A reviewer's wait can outlive its session.** A gate waiting inside drive keeps sleeping when the agent session that ran it dies on the same limit. It journals whatever it finishes, and the next session's gate meets D76's re-read.
3. **Caps are checked between sessions.** A session can run a few rounds past `drive.caps.rounds` before it relays, bounded by `drive.sessionTimeoutMs`.
4. **Two settlers outside drive can judge one stop.** Two chat sessions under autonomy both run A1's repo-wide `settleOwed`. Drive's sessions are scoped (row 181), but nothing re-reads the stop under the lock.

- [ ] **Step 2: Commit**

```bash
git add DESIGN.md
git commit -m "docs(design): rows 180-184 -- drive runs everything · side by side · usage waits · caps · the report" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Verify, review, release 0.18.0

- [ ] **Step 1: Full suite and typecheck**

Run: `pnpm test 2>&1 | tee /tmp/b-suite.log | tail -5; grep -c AssertionError /tmp/b-suite.log; pnpm run typecheck`
Expected: the passed count is at or above `main`'s (after A2), plus this plan's new tests, with 0 AssertionError and a clean typecheck.

- [ ] **Step 2: Consumer differential (read-only)**

As wave 1's Task 7 Step 2:
1. Build `main` in a temporary worktree, and this branch in place.
2. In a throwaway clone (`C=$(mktemp -d)/fewhats && git clone --local ~/x/personal/fewhats.com "$C"`, so the real repo is never touched), run each build with `CI=1 WITNESS_REGISTRY=off`: `check`, `next`, `status`, and `decide <gate> <target> --show` for every pending decision. Save each output and `diff` the two sets.
3. Remove the worktree.

Expected: identical output, except that under `autonomy: on` `next` gains its last line, `launch: witness drive --detach`.

- [ ] **Step 3: Adversarial review**

Dispatch three fresh opus reviewers, `model: "opus"`, on the branch diff:
1. a code review against this plan and the design;
2. a behavior attack on the scheduler: two sessions on one target, a stall under concurrency, the ceiling, a signal mid-run, a crash leaving a transaction;
3. a behavior attack on the waits and the caps: a misread limit, a limit with a stale reset, the lock under contention, a cap on a moved tree.

Re-verify every finding by probe before acting on it. Fix in one pass and commit.

- [ ] **Step 4: HUMAN, merge and release**

Open a PR (`gh pr create`). After the human merges it, on `main`:
1. Run `pnpm release minor`. Expected: a release commit and tag `v0.18.0`.
2. The human pushes `main`, then the tag. Wait for `release.yml` to pass, then for `npm view @popovych.co/witness version` to print `0.18.0`.

Upgrading the skills and any consumer repo to this release is a separate step, outside this plan.

---

## Self-review

- **Spec coverage:**
  - **B1:**
    - `witness drive`: Tasks 8 and 13;
    - `/witness` launching in the background and saying where to watch: Tasks 13 and 14;
    - no TTY under autonomy: Task 13;
    - the marker guard: Tasks 5, 7 and 13;
    - one drive per repo: Task 13;
    - `--ask`: Task 13.
  - **B2:**
    - A1's decisions instead of `decide>`: Task 9;
    - headless conversations: Task 7;
    - kept stops do not end the run: Tasks 8 and 9.
  - **B3:**
    - N flows, each in its own worktree session: Tasks 6 and 8;
    - D73's order: Task 8;
    - the next ready one past a kept stop: Task 9;
    - lock waits: Tasks 2 and 3;
    - parallel PRs re-gate through ship's existing machinery, unchanged.
  - **B4:** session and reviewer waits: Tasks 4, 5 and 11. Keep-awake: Task 11.
  - **B5:** the four caps, parked through `applyDecision` with `selected: 'policy'`, named and reported, defaults derived: Tasks 1, 10 and 12.
  - **B6:** the report's six parts and the notification through machine-local `notify:`: Tasks 1 and 12.
  - **D145's no-progress guard and ceiling stay,** per target and across lanes: Task 8.
  - **§10:** the cap numbers, the lock wait, the backoff, the notifier and the background launch are each decided under Builder's calls.
- **Type consistency:**
  - `DRIVE_ENV`, `TARGETLESS`, `driveChild`, `driveHolder`, `acquireDriveLock`, `watchLine`, `DRIVE_LOCK` and `DRIVE_LOG` live in `src/drive-presence.ts`;
  - `Limit`, `Clock`, `realClock`, `limitIn`, `sessionLimit`, `waitFor`, `duration` and the bounds live in `src/usage.ts`;
  - `CapName`, `CapHit`, `TargetUse`, `capHit` and `parkAtCap` live in `src/caps.ts`;
  - `Awake` and `keepAwake` live in `src/awake.ts`;
  - `RunStart`, `runStart`, `entriesSince`, `Report` and `driveReport` live in `src/drive-report.ts`;
  - `notifyArgv` and `notify` live in `src/notify.ts`;
  - `SessionEnd`, `DriveFlags`, `Aside`, `AsideKind`, `AUTONOMY_MAX_SPAWNS` and `detachDrive` live in `src/drive.ts`;
  - `NOTHING_OWED`, `NextOpts` and `computeNext`'s `scope` live in `src/verbs/next.ts`; `settleOwed`'s `scope` and `DecisionCore`'s `park` and `rule` are this plan's optional additions to A1's signatures.

  Each later task uses these names as defined. A1's and A2's names are used exactly as listed under **Consumed from A1 and A2**.
- **Proportion:** the code blocks are the tests, the signatures, and the three algorithms the tests do not fix: the lock loop, the zone math and the fill loop.

## Designer answers (2026-10-20)

1. **Narrow the repo lock, and serialize test runs from the start.** Task 3 keeps D76's write-only lock. Task 3b adds the runner turn, which waits and never refuses, at `execCommand`, so every test, lint and check command takes turns across worktrees. `drive.parallelSuites: true` relaxes it.
2. **Caps between sessions are hard enough.** Inside one session, the round bound and `drive.sessionTimeoutMs` already bound the overshoot.
3. **Accepted.** `park: true` and `rule: 'cap-<name>'` are policy-only extensions to `DecisionCore`, and humans keep D124's stop. A policy act journaling its own rule id is honest attribution under D121, because the cap is the rule that decided.
4. **Accepted.** The spawn ceiling is 200 under autonomy (the basis is the 203 sessions in 33 days) and 20 when autonomy is off.
5. **A1 re-reads under the lock.** `applyDecision` re-reads the stream inside the lock and refuses `nothing-pending` or `anchor-moved` when the run it judged is no longer the pending one. Drive's per-session scoping stays as defense in depth. Task 9's race test pins that exactly one decision lands.
