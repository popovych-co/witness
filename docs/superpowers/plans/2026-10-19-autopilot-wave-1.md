# Autopilot wave 1: filtered runner, parallel reviewers, failed-check recommendation (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship build steps 1–2 of the autopilot design:
- fewhats.com evidence runs one spec's tests instead of the whole suite (C1);
- the gate runs its reviewer lenses at once (C2);
- a gate whose deterministic checks failed is recommended `revise`, never `approve` (the `checks-failed` rule);
- the deferral block stops telling reviewers the opposite of what the gate does (Task 5b).

Release them as witness 0.15.0.

**Architecture:**
- **C1** is a config change in the consumer repo (fewhats.com), plus one human trust grant.
- **C2:**
  - adds an async reviewer invocation next to the sync one, sharing its preparation and result mapping;
  - moves the battery loop out of `src/gate.ts` into a new `src/battery.ts`, which runs every lens concurrently and aggregates in lens order;
  - teaches the fake reviewer binaries to number calls atomically and to answer per lens, because call order is no longer lens order.
- **`checks-failed`** is one new first-match rule in `src/recommend.ts`.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), vitest 3, pnpm 10, POSIX `sh` fakes in `fixtures/fakebin/`.

**Spec:** `docs/superpowers/specs/2026-10-19-autopilot-design.md` (§7 C1, C2 and A2's failed-checks paragraph; §8 steps 1–2).

## Global Constraints

- Work on branch `autopilot-wave-1`, cut from `main` at `3dcb9a2`.
- Write each behavior change's test first and watch it fail before writing code.
- Judge `pnpm test` by its AssertionError count, which must be 0, not by its exit code. A few worker-RPC timeouts make it exit 1 with every test green.
- No commas in new CLI output text. Use `·` and `—`.
- Commit trailer, on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- In fewhats.com, touch only `witness.config.yaml`. Never touch `docs/specs/**`, `docs/plans/**` or `docs/designs/**`.
- DESIGN.md:
  - the new rows are **169** (parallel battery) and **170** (`checks-failed`);
  - **168 stays reserved** for the owed pin-resolution fix.
- Release with `pnpm release minor`, which produces `0.15.0`. Both pushes, main and then the tag, are the human's.
- fewhats's runner template, verbatim: `pnpm test -t "@spec:{id}($|[^a-z0-9-])"`.

## Review Focus

1. **A lens that answers last must not reorder the journal.** `verdicts`, `malformed` and `rerolled` stay in battery order whatever order the lenses finish in. Pinned by Task 4's delayed-first-lens test.
2. **One lens fails on the pin while the others answer.** The round must still be classified as a fallback round, exactly as the sequential battery classified it:
   - `model` is the fallback id;
   - `fallback` is `[pin]`;
   - the fallback standing stop is present.

   Pinned by Task 4's mixed-rung test.
3. **One lens exhausts the chain.** The whole gate refuses (exit 2), the gate-run is not appended, and the refusal shown is that lens's. Pinned by Task 4's exhausted-chain test.
4. **A hung reviewer whose grandchild holds stdout open.** The async invocation must settle and retry within seconds, not wait for the grandchild. `fixtures/fakebin/claude` sleeps 30 s in a child process. Pinned by Task 3's timeout test, which also bounds elapsed time.
5. **A failed check next to non-blocking findings, including at ship.** This must give `checks-failed`, never `non-blocking-only` or `manual-stop`. Pinned by Task 5's ordering tests.

---

### Task 0: Branch and commit the design and its five plans

**Files:**
- Add: `docs/superpowers/specs/2026-10-19-autopilot-design.md` and the five plans `docs/superpowers/plans/2026-10-19-autopilot-{wave-1,A1-decisions,A2-intake,B-drive,C3-delta-review}.md`

- [ ] **Step 1: Cut the branch**

Run: `git checkout -b autopilot-wave-1 3dcb9a2`
Expected: `Switched to a new branch 'autopilot-wave-1'`

- [ ] **Step 2: Commit the design and the plans**

```bash
git add docs/superpowers/specs/2026-10-19-autopilot-design.md docs/superpowers/plans/2026-10-19-autopilot-*.md
git commit -m "docs(autopilot): design and its five plans" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: fewhats.com runs one spec's tests per evidence run (C1)

This task runs in `/Users/home/x/personal/fewhats.com` and is independent of the witness release.

**Two facts drive the order of its steps:**
- Evidence reads the runner config from the **checkout it runs in** (`src/evidence.ts:49-55` → `loadConfig(runRoot)`).
- The drift lane and the trust list resolve at the **primary root** (`src/criteria.ts:31-36`).

So the edit lands on main and in each live worktree. Trust must be granted before any pi session gates on the new template, or that session's drift lane fails as `untrusted-blocked`.

**Files:**
- Modify: `fewhats.com/witness.config.yaml`, the `criteria:` block.
- Modify, only when unmodified there: `.witness/worktrees/{reply-send-plan-1,thread-mirror-tap-plan-1}/witness.config.yaml`

- [ ] **Step 1: Preconditions**

Run: `cd /Users/home/x/personal/fewhats.com && git status --short witness.config.yaml && pgrep -fl "pi .*-p|vitest" || true`
Expected: no output. The config is clean, and no headless pi session or vitest run is in flight. If something is in flight, wait for it.

- [ ] **Step 2: Refresh main's install**

The 2026-10-19 probe hit `Cannot find package '@repo/logger'` in main.

Run: `pnpm install --frozen-lockfile`
Expected: exit 0.

- [ ] **Step 3: Replace the runner lines and their comment**

The current comment says criteria are counted from the report. In filtered mode the drift lane judges by exit code, so that sentence would become false. Replace it with this block:

```yaml
criteria:
  exclude: [docs/superpowers/**]
  # One spec per evidence run: `-t` filters vitest by test NAME, and the pattern
  # is anchored — `($|[^a-z0-9-])` — so `thread-mirror` never also runs
  # `thread-mirror-tap`'s tests. That matters beyond speed: witness judges a
  # filtered criterion by the run's exit code, so an over-match would fail the
  # wrong spec's lane. Measured 2026-10-19: 13–48 s per run against ~9 min for
  # the whole suite. The whole suite still runs once per ship gate (ship.test).
  # The report stays: evidence counts a spec's tests from it by exact tag. An
  # exact path, not a ** glob, so no foreign report merges in.
  runner: 'pnpm test -t "@spec:{id}($|[^a-z0-9-])"'
  report: "junit:reports/junit.xml"
```

Keep the existing `exclude` comment lines above `exclude:`.

- [ ] **Step 4: Config validates**

Run: `CI=1 WITNESS_REGISTRY=off npx -y @popovych.co/witness@0.14.8 check`
Expected: `0 errors`. The warnings stay as before: `ahead` and 3 `need-unmet`.

- [ ] **Step 5: HUMAN, grant trust (a kept stop)**

Stop and ask the human to run this in their own terminal (it needs a TTY):

```bash
cd ~/x/personal/fewhats.com && CI=1 npx -y @popovych.co/witness@0.14.8 check --drift
```

- They answer `y` to `trust this command?` for `pnpm test -t "@spec:{id}($|[^a-z0-9-])"`.
- `CI=1` keeps the sweep read-only: it appends no journal entries and stamps nothing.

Expected:
- `.witness/allow.json` lists the template;
- a `drift` row per live spec;
- a summary line ending `mode read-only`.

`ac-baseline` stays red (no production credentials), as it was before.

- [ ] **Step 6: Re-run headless to prove the grant took**

Run: `CI=1 npx -y @popovych.co/witness@0.14.8 check --drift 2>&1 | grep -c untrusted || true`
Expected: `0`.

- [ ] **Step 7: Commit on main**

```bash
git add witness.config.yaml
git commit -m "chore(witness): filtered criteria runner — one spec's tests per evidence run" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Same edit in each live worktree whose config is unmodified**

For each `wt` in `.witness/worktrees/reply-send-plan-1` and `.witness/worktrees/thread-mirror-tap-plan-1`:
1. Run `git -C "$wt" diff --quiet -- witness.config.yaml`.
2. If that exits 0, apply Step 3's block.
3. Then run `git -C "$wt" commit -m "chore(witness): filtered criteria runner" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- witness.config.yaml`.

Expected: each commit lists exactly one file. The session work left uncommitted in the worktree is untouched (`git -C "$wt" status --short` shows the same paths as before).

---

### Task 2: Fake reviewers survive concurrent calls

Today both fakes number a call by counting the existing `call-*` dirs, then run `mkdir -p`. Two concurrent calls can therefore share a number. Their verdicts are also chosen by call number, which stops naming a lens once lenses run concurrently.

**Files:**
- Modify: `fixtures/fakebin/claude`, `fixtures/fakebin/pi`
- Modify: `tests/helpers.ts`. `putVerdict` accepts a lens name; add `callFor` and `callCount`.
- Test: `tests/fakebin.test.ts`

**Interfaces:**
- Produces, in `tests/helpers.ts`:
  - `putVerdict(scenario: string, verdict: unknown, call?: number | string): void`. A string writes `verdict-<lens>.json`.
  - `callFor(scenario: string, lens: string, bin: 'claude' | 'pi' = 'claude'): string | undefined`. Returns the highest-numbered call dir whose `lens` file names `lens`.
  - `callCount(scenario: string, bin: 'claude' | 'pi' = 'claude'): number`
- Produces, in the fakes (contract for Tasks 3–4):
  - reads `WITNESS_LENS` and records it to `call-N/lens`;
  - verdict precedence is `verdict-<n>.json`, then `verdict-<lens>.json`, then `verdict.json`;
  - `claude-barrier` or `pi-barrier` holds each call until N calls exist, giving up after 5 s with exit 1;
  - `claude-delay-<lens>` or `pi-delay-<lens>` holds that lens's call for the given number of seconds before it answers;
  - `claude-fail-<lens>` or `pi-fail-<lens>` fails that lens's calls with exit 1. If the file's content is empty, every call fails. Otherwise only calls whose argv contains that text fail, for example a model id, which fails the lens on that rung only. Failure keyed by call number stops identifying a lens once lenses run concurrently, so lens-keyed failure is what keeps Task 4's tests deterministic.
- Test-local helpers in `tests/fakebin.test.ts`:
  - `runFakeAsync(bin: 'claude' | 'pi', args: string[], scenario: string, input: string): Promise<string>` uses promisified `execFile` with `gateEnv(scenario)`;
  - `runFakeLens(bin: 'claude' | 'pi', lens: string, scenario: string, input = 'x'): string` is `runFake` with `WITNESS_LENS=<lens>` added to the env.

- [ ] **Step 1: Write the failing tests**

Add to `tests/fakebin.test.ts` an async launcher that uses `execFile` from `node:child_process` (promisified), with the same env as `runFake`.

```ts
it('concurrent calls get distinct numbers', async () => {
  const dir = fakeScenario()
  putVerdict(dir, { coverage: [], findings: [] })
  await Promise.all(Array.from({ length: 6 }, (_, i) => runFakeAsync('claude', ['-p'], dir, `p${i}`)))
  expect(readdirSync(join(dir, 'claude-calls')).sort()).toEqual(['call-1', 'call-2', 'call-3', 'call-4', 'call-5', 'call-6'])
})

it('records WITNESS_LENS and answers verdict-<lens>.json, a numbered verdict still winning', () => {
  const dir = fakeScenario()
  putVerdict(dir, { coverage: [], findings: [] })
  putVerdict(dir, { coverage: [{ anchor: 'L', note: 'lens' }], findings: [] }, 'code-reviewer')
  const out = runFakeLens('claude', 'code-reviewer', dir)   // env + WITNESS_LENS
  expect(JSON.parse(JSON.parse(out).result).coverage[0].anchor).toBe('L')
  expect(readFileSync(join(dir, 'claude-calls/call-1/lens'), 'utf8').trim()).toBe('code-reviewer')
  expect(callFor(dir, 'code-reviewer')).toBe(join(dir, 'claude-calls/call-1'))
  putVerdict(dir, { coverage: [{ anchor: 'N', note: 'numbered' }], findings: [] }, 2)
  expect(JSON.parse(JSON.parse(runFakeLens('claude', 'code-reviewer', dir)).result).coverage[0].anchor).toBe('N')
})

it('a barrier of 2 passes two concurrent calls and fails a lone call', async () => {
  const dir = fakeScenario()
  putVerdict(dir, { coverage: [], findings: [] })
  writeFileSync(join(dir, 'claude-barrier'), '2')
  await Promise.all([runFakeAsync('claude', ['-p'], dir, 'a'), runFakeAsync('claude', ['-p'], dir, 'b')])
  const lone = fakeScenario()
  putVerdict(lone, { coverage: [], findings: [] })
  writeFileSync(join(lone, 'claude-barrier'), '2')
  await expect(runFakeAsync('claude', ['-p'], lone, 'c')).rejects.toThrow(/barrier of 2 not reached/)
}, 15_000)

it('claude-fail-<lens> fails that lens — on every call when empty, on a matching argv otherwise', () => {
  const dir = fakeScenario()
  putVerdict(dir, { coverage: [], findings: [] })
  writeFileSync(join(dir, 'claude-fail-type-design'), '')
  expect(() => runFakeLens('claude', 'type-design', dir)).toThrow()
  expect(runFakeLens('claude', 'pr-test', dir)).toContain('result')
  writeFileSync(join(dir, 'claude-fail-code-reviewer'), 'test-model-1')
  expect(() => execFileSync(join(fakeBinDir(), 'claude'), ['-p', '--model', 'test-model-1'],
    { env: { ...gateEnv(dir), WITNESS_LENS: 'code-reviewer' }, input: 'x', encoding: 'utf8' })).toThrow()
  expect(execFileSync(join(fakeBinDir(), 'claude'), ['-p', '--model', 'test-model-2'],
    { env: { ...gateEnv(dir), WITNESS_LENS: 'code-reviewer' }, input: 'x', encoding: 'utf8' })).toContain('result')
})
```

Add the same three cases for `pi`, driven through `PATH`, as the existing pi test does.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/fakebin.test.ts`
Expected: FAIL. Calls collide, so the `call-N` list is short; the `lens` file is missing; the barrier is ignored.

- [ ] **Step 3: Edit both fakes**

Replace the count-and-`mkdir -p` lines. `PFX` is `claude` in one fake and `pi` in the other. The block below is exact; keep every other existing line, including the lock probe and `argv`/`stdin`, in its current order.

```sh
mkdir -p "$dir/PFX-calls"
# claim the next number atomically: mkdir without -p fails when the dir exists, so
# lenses the gate launches together can never share a number
n=1
while ! mkdir "$dir/PFX-calls/call-$n" 2>/dev/null; do n=$((n + 1)); done
call="$dir/PFX-calls/call-$n"
```

Place this after `cat > "$call/stdin"`:

```sh
# the lens this call reviews for — witness exports WITNESS_LENS to every reviewer
lens="${WITNESS_LENS:-}"
if [ -n "$lens" ]; then printf '%s\n' "$lens" > "$call/lens"; fi
# barrier: hold until N calls exist — only a concurrent battery fills it
if [ -f "$dir/PFX-barrier" ]; then
  want=$(cat "$dir/PFX-barrier"); i=0
  while :; do
    have=0
    for d in "$dir"/PFX-calls/call-*; do [ -e "$d" ] && have=$((have + 1)); done
    [ "$have" -ge "$want" ] && break
    i=$((i + 1))
    if [ "$i" -ge 50 ]; then echo "fake PFX: barrier of $want not reached ($have in flight)" >&2; exit 1; fi
    sleep 0.1
  done
fi
if [ -n "$lens" ] && [ -f "$dir/PFX-delay-$lens" ]; then sleep "$(cat "$dir/PFX-delay-$lens")"; fi
if [ -n "$lens" ] && [ -f "$dir/PFX-fail-$lens" ]; then
  only=$(cat "$dir/PFX-fail-$lens")
  if [ -z "$only" ] || grep -qF -- "$only" "$call/argv"; then
    echo "fake PFX: injected failure for lens $lens" >&2
    exit 1
  fi
fi
```

Then change the verdict selection to:

```sh
body="$dir/verdict.json"
if [ -n "$lens" ] && [ -f "$dir/verdict-$lens.json" ]; then body="$dir/verdict-$lens.json"; fi
[ -f "$dir/verdict-$n.json" ] && body="$dir/verdict-$n.json"
```

- [ ] **Step 4: Add the helpers**

In `tests/helpers.ts`, `putVerdict` gets a `call?: number | string` parameter. Add `callFor` and `callCount` with the signatures above:
- `callFor` reads `<scenario>/<bin>-calls/call-*/lens` and returns the matching dir with the highest number.
- `callCount` counts `call-*` dirs. A missing calls dir counts as 0.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm vitest run tests/fakebin.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add fixtures/fakebin/claude fixtures/fakebin/pi tests/helpers.ts tests/fakebin.test.ts
git commit -m "test(fakebin): atomic call numbers, per-lens verdicts, barrier and delay" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `invokeReviewerAsync`

**Files:**
- Modify: `src/reviewer.ts`
- Test: `tests/reviewer.test.ts`

**Interfaces:**
- Consumes: Task 2's fakes (`WITNESS_LENS`, and `claude-hang` / `claude-fail` by call number).
- Produces:
  - `export interface InvokeOpts extends InvokeExtras { cwd: string; prompt: string; model?: string; lens?: string }`. When `lens` is set, the child's env carries `WITNESS_LENS=<lens>`. This holds for **both** invokers, the same way the CLI exports `WITNESS_SCREENS_DIR` to runners.
  - `export async function invokeReviewerAsync(ctx: Ctx, harness: Harness, opts: InvokeOpts): Promise<Result<{ text: string }>>`. It returns the same `ok` and refusal rows as `invokeReviewer` in every case: `reviewer-invocation` with the exit-code and stderr message, and `reviewer-timeout` after `TIMEOUT_RETRIES` retries.

- [ ] **Step 1: Write the failing tests**

Add a `describe('invokeReviewerAsync', …)` block that mirrors the sync cases at the same assertions, with `await invokeReviewerAsync(…)` in place of `invokeReviewer(…)`:
- the claude cases at `tests/reviewer.test.ts:31-56` and `:84-93`;
- the three pi cases at `:97-137`.

Then add these:

```ts
it('claude: prompt on stdin, model on argv, lens exported', async () => {
  // the :31-43 setup, with lens: 'code-reviewer' added to the options
  expect(r.ok).toBe(true)
  expect(readFileSync(join(scenario, 'claude-calls/call-1/lens'), 'utf8').trim()).toBe('code-reviewer')
})
it('retries a hung call and settles without waiting on the hung call\'s grandchild', async () => {
  writeFileSync(join(scenario, 'claude-hang'), '1')         // the fake sleeps 30 s in a child
  const t0 = Date.now()
  const r = await invokeReviewerAsync(ctx, claudeHarness, { cwd: repo.root, prompt: 'x', timeoutMs: 400 })
  expect(r.ok).toBe(true)
  expect(existsSync(join(scenario, 'claude-calls/call-2'))).toBe(true)
  expect(Date.now() - t0).toBeLessThan(10_000)
}, 20_000)
it('a nonzero exit is reviewer-invocation naming the exit code', async () => {
  writeFileSync(join(scenario, 'claude-fail'), '1')
  const r = await invokeReviewerAsync(ctx, claudeHarness, { cwd: repo.root, prompt: 'x' })
  expect(!r.ok && r.violations[0]!.rule).toBe('reviewer-invocation')
  expect(!r.ok && r.violations[0]!.got).toContain('exit 1')
})
```

Also add one sync case: `invokeReviewer` with `lens: 'x'` writes `call-1/lens`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/reviewer.test.ts`
Expected: FAIL: `invokeReviewerAsync is not a function`, and the sync `lens` file is missing.

- [ ] **Step 3: Implement**

In `src/reviewer.ts`:
- Factor the current body into two non-exported functions, so the two invokers cannot drift apart:
  - `prepareInvocation(ctx, harness, opts)` validates the pin, resolves the spawn and adds `WITNESS_LENS` to the env.
  - `classifyAttempt(cmd, timeout, attempt, outcome)` maps `{ timedOut, error, status, stdout, stderr }` to `'retry' | Result<{ text: string }>`, using the exact rows the code produces today.
- `invokeReviewer` keeps `spawnSync`, mapping `error.code === 'ETIMEDOUT'` to `timedOut`.
- `invokeReviewerAsync` uses `spawn`:
  - write the prompt to stdin and end it, ignoring `EPIPE`;
  - collect stdout and stderr as utf8, with stdout capped at 64 MiB; past the cap, kill the child and report `reviewer-invocation` with got `output exceeded 64 MiB`;
  - on timeout, SIGTERM the child, then SIGKILL after 5 s;
  - settle on `close`, or 2 s after `exit` (`spawnSession` in `src/drive.ts:137-185`, a grandchild may hold the pipe).

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm vitest run tests/reviewer.test.ts`
Expected: PASS, and the hung-call case finishes in about 3 s.

- [ ] **Step 5: Commit**

```bash
git add src/reviewer.ts tests/reviewer.test.ts
git commit -m "feat(reviewer): async invocation sharing the sync path's prep and result rows" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The battery runs its lenses at once (C2)

**Files:**
- Create: `src/battery.ts`
- Modify: `src/gate.ts`. The `for (const lens of lenses)` block at `:393-433` becomes prompt composition plus one `runBattery` call, and the `invokeReviewer` import goes.
- Test: `tests/battery.test.ts`, new.
- Migrate: tests that read `call-N` or set numbered verdicts for **multi-lens** gates. They move to `callFor` / `callCount` and lens-named verdicts:
  - `tests/design-lens.test.ts` (verdict 5 → `'design-reviewer'`, `call-5` → `callFor(…, 'design-reviewer')`, "4 lenses only" → `callCount === 4`);
  - `tests/protocol/design-lens.test.ts`;
  - `tests/docs-injection.test.ts` (ship order: `call-1` drift → `callFor(…, 'drift-reviewer')`, `call-2` code → `callFor(…, 'code-reviewer')`, "`call-3` absent" → `callCount === 2`);
  - any other the full run surfaces.

  `tests/policy-pins.test.ts` needs nothing: its synthetic gate is `chore`, a single lens.

  Single-lens gates (plan, decompose, design) keep their call numbers, because their calls stay sequential.

**Interfaces:**
- Consumes: `invokeReviewerAsync`, with `lens` set to the lens name.
- Produces:

```ts
export interface BatteryLens { name: string; prompt: string; reviewed: Reviewed }
export interface BatteryRun {
  verdicts: ReviewerVerdict[]                                    // battery order
  malformed: Array<{ reviewer: string; violations: Violation[] }> // battery order
  fallback: string[]   // chain ids any lens failed to invoke on · chain order · each once
  rerolled: string[]   // lens names that took the self-repair reroll · battery order
  model: string        // chain[highest rung any lens answered on] — chain[0] when none answered
}
export async function runBattery(
  ctx: Ctx, harness: Harness, chain: readonly string[], lenses: readonly BatteryLens[],
  opts: { cwd: string } & InvokeExtras,
): Promise<Result<BatteryRun>>
```

- **Per lens,** concurrently with every other lens:
  - walk `chain` from rung 0;
  - pass `model: id === SESSION_DEFAULT ? undefined : id`;
  - an invocation failure on the last rung refuses with that lens's violations;
  - otherwise record the id and step down a rung;
  - parse with `parseVerdictText` → `parseVerdict` → `verdictViolations`;
  - on the first invalid parse, append today's `## Previous attempt rejected` block, unchanged, and reroll once at the same rung;
  - a second invalid parse is `malformed`.
- **Aggregate** after every lens settles. If any lens refused, return the first refusal in battery order. This preserves the sequential battery's outcome classification: a round that fell back anywhere has `model !== pin`, so `fellBack` (`src/rounds.ts:128`) holds.

- [ ] **Step 1: Write the failing tests**

`tests/battery.test.ts` builds on `shippableRepo()`: a feature effort, not a UI plan, so the battery is `['code-reviewer', 'silent-failure-hunter', 'type-design', 'pr-test']`.

**Shared setup, per test:**
- `files = changedFiles(wt, diffBase(wt, cfg))`, as in `tests/design-lens.test.ts:128-132`;
- `putVerdict(scenario, treeClean(files))`, with a local `treeClean`, as in `tests/gate-implement.test.ts:13`;
- `ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })`.

**Local helpers:**
- `lastRun(repo, planId)` is the last `gate-run` entry of `readStream(repo.root, planId)`;
- `gateRuns(repo, planId)` is all of them;
- `BLOCKING_AT(file)` is `{ coverage: treeClean(files).coverage, findings: [{ blocking: true, anchor: file, claim: 'x' }] }`.

**Two-rung chain** (the mixed-rung test): append `gates:\n  model: test-model-1\n` to `witness.config.yaml`, and write `.witness/calibration.local.yaml` with `models:\n  - test-model-2\n`, as `tests/gate-engine.test.ts:256-258` does.

```ts
it('launches every lens at once', async () => {
  writeFileSync(join(scenario, 'claude-barrier'), '4')
  expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(0)
  expect(lastRun(repo, planId).verdicts!.map((v) => v.reviewer))
    .toEqual(['code-reviewer', 'silent-failure-hunter', 'type-design', 'pr-test'])
}, 30_000)
it('keeps battery order when the first lens answers last', async () => {
  writeFileSync(join(scenario, 'claude-delay-code-reviewer'), '1')
  putVerdict(scenario, BLOCKING_AT(files[0]), 'code-reviewer')
  expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(1)
  const run = lastRun(repo, planId)
  expect(run.verdicts![0]!.reviewer).toBe('code-reviewer')
  expect(run.verdicts![0]!.findings[0]!.blocking).toBe(true)
  expect(run.verdicts!.slice(1).every((v) => v.findings.length === 0)).toBe(true)
})
it('one lens failing on the pin makes a fallback round', async () => {
  // two-rung chain · code-reviewer fails on the pin only
  writeFileSync(join(scenario, 'claude-fail-code-reviewer'), 'test-model-1')
  expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(1)
  const run = lastRun(repo, planId)
  expect(run.model).toBe('test-model-2'); expect(run.pin).toBe('test-model-1')
  expect(run.fallback).toEqual(['test-model-1'])
  expect(run.standing).toContain('fallback — reviewers ran on test-model-2')
  expect(run.verdicts).toHaveLength(4)
})
it('one lens exhausting the chain refuses the gate and journals nothing', async () => {
  writeFileSync(join(scenario, 'claude-fail-type-design'), '')   // fails on every rung
  const errs: string[] = []
  const c = fakeCtx(repo.root, { env: gateEnv(scenario), err: (l) => errs.push(l) })
  expect(await runGate(c, 'implement', planId, { fresh: false, manual: false })).toBe(2)
  expect(gateRuns(repo, planId)).toHaveLength(0)
  expect(errs.join('\n')).toContain('reviewer-invocation')
  expect(callCount(scenario)).toBeGreaterThanOrEqual(4)          // the other lenses still ran
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/battery.test.ts`
Expected: FAIL. The barrier test gets exit 2, because the sequential first call starves at the barrier and the single rung refuses. The order test passes vacuously at this point; that's fine, it pins the behavior.

- [ ] **Step 3: Implement**

- Implement `runBattery` in `src/battery.ts`.
- In `src/gate.ts`, compose each `BatteryLens.prompt` exactly as `:396-399` does today, with `ov?.reviewed`, `ov?.promptBody` and `anchorMenu`. Call `runBattery(ctx, harness, chain, composed, { cwd: root, ...extras })`.
- On refusal, render it and return `EXIT.REFUSED`.
- Otherwise assign `verdicts`, `malformed`, `fallback`, `rerolled` and `model` from the result.
- The `cached` branch is unchanged.

- [ ] **Step 4: Migrate the multi-lens tests listed above, then run them**

Run: `pnpm vitest run tests/battery.test.ts tests/design-lens.test.ts tests/protocol/design-lens.test.ts tests/docs-injection.test.ts tests/policy-pins.test.ts tests/gate-implement.test.ts tests/gate-engine.test.ts tests/gate-lock.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `pnpm test 2>&1 | grep -c AssertionError; pnpm run typecheck`
Expected: `0`, and typecheck exits 0. Any test still reading `call-N` for a multi-lens gate shows up here; migrate it the same way.

- [ ] **Step 6: Commit**

```bash
git add src/battery.ts src/gate.ts tests/
git commit -m "feat(gate): the battery runs its lenses at once" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: A failed check recommends revise (`checks-failed`)

**Files:**
- Modify: `src/recommend.ts`. Add rule 9b after the blocking-findings block at `:299-322`, before `non-blocking-only`, and update the rule-order comment at `:79-81`.
- Test: `tests/recommend.test.ts`

**Interfaces:**
- Produces: the rule id `checks-failed`, journaled as `rule:` by `decide` with no further change (`src/verbs/decide.ts:336-351`).
- Options, in this order:
  1. `${d} --revise --note "<notePrefill>"`, depth `root`. Its `why` names the failed checks joined by ` · ` and ends with the round count.
  2. `upAlt(…)`, depth `root`.
  3. `${d} --approve`, depth `deferral`.
     - `when`: `the failing check is wrong or cannot pass for a reason outside this artifact`.
     - `tradeoff`: `stamps the artifact over a failed deterministic check · no obligation is minted — the failure stays visible only until a later gate run passes the check`.
  4. `stopOpt`.

  `notePrefill` already yields `failed checks: <names>` when no finding blocks (`src/rounds.ts:251-254`).
- `withTrustVariants` applies to the `--approve` option as it does elsewhere.

- [ ] **Step 1: Write the failing tests**

```ts
const failedRun = (extra: Record<string, unknown> = {}) => {
  const r = run(1, 'a', 'S', { checks: [{ name: 'drift-lane', ok: false, detail: 'ac-baseline:fail' }], ...extra })
  ;(r as unknown as { verdicts: Array<{ findings: unknown[] }> }).verdicts[0]!.findings = []
  return r
}
it('checks-failed: a failed check with no blocking finding recommends revise', () => {
  const d = recommend(ctxFor([failedRun()]))!
  expect(d.rule).toBe('checks-failed')
  expect(d.options[0]!.command).toBe('witness decide plan p1 --revise --note "failed checks: drift-lane"')
  expect(d.options[0]!.why).toContain('drift-lane')
  expect(d.options[0]!.why).not.toContain('--manual')
  expect(d.options[0]!.why).not.toContain(',')
  expect(d.options.find((o) => o.command === 'witness decide plan p1 --approve')!.depth).toBe('deferral')
})
it('checks-failed outranks non-blocking-only', () => {
  const r = failedRun()
  ;(r as unknown as { verdicts: Array<{ findings: unknown[] }> }).verdicts[0]!.findings =
    [{ blocking: false, anchor: 'S', claim: 'nit' }]
  expect(recommend(ctxFor([r]))!.rule).toBe('checks-failed')
})
it('checks-failed at a ship standing stop', () => {
  const r = failedRun({ gate: 'ship', standing: 'ship always stops' })
  expect(recommend({ ...ctxFor([r]), gate: 'ship' })!.rule).toBe('checks-failed')
})
```

- Add `['checks-failed', [failedRun()], {}]` to the `states` list under `describe('block properties')`, so the four property tests cover the new rule.
- Keep the existing `manual-stop` test unchanged. Its run has `checks: []`, so it still matches.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/recommend.test.ts`
Expected: FAIL with `expected 'manual-stop' to be 'checks-failed'`.

- [ ] **Step 3: Implement the rule as specified under Interfaces**

- [ ] **Step 4: Run the tests and watch them pass, then the decide and status tests**

Run: `pnpm vitest run tests/recommend.test.ts tests/decide.test.ts tests/decide-show.test.ts tests/dashboard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recommend.ts tests/recommend.test.ts
git commit -m "fix(recommend): a failed check recommends revise, not approve" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5b: The deferral block says what the gate does

This bug was found while planning C3, and it is pre-existing. `deferralsBlock` tells every reviewer `Silence is read as "still present"` (`src/deferral.ts:55-56`). Yet the gate discharges every open obligation the round does not report: the `discharged` filter in `src/gate.ts`, whose own comment says "Silence in a real verdict is the evidence; that is exactly what the injected block tells the reviewer". So a reviewer who still sees a deferred defect can stay silent, and the obligation closes wrongly. The block also lists an omission obligation as `omission:<scope>`, which is not an anchor any verdict can carry.

The discharge code is unchanged. Only the block changes, so that it states the gate's real rule.

**Files:**
- Modify: `src/deferral.ts` (`deferralsBlock`)
- Test: `tests/deferral.test.ts`. Extend the `deferralsBlock is the inverse of a pin` block, and update `:150`.

**Interfaces:**
- `deferralsBlock(open: DeferralEntry[]): string`. The signature is unchanged; the text is exact copy:

```text
## Open deferrals (approved over findings — report these if they still hold)

This artifact was approved over the findings below rather than fixed. They are NOT settled policy and they are NOT pins. If a defect is still present, report it as a finding anchored exactly as listed: that keeps its obligation open. Silence is read as fixed: an obligation this round does not report is discharged.

1. src/token.ts#rotate — implement round 2 (d-1)
2. omission · scope tests/ — implement round 3 (d-2) — report it with "anchor": { "kind": "omission", "scope": "tests/" }
```

  An entry whose stored anchor starts with `omission:` renders as `omission · scope <rest>`, followed by the anchor object reviewers must emit. Every other entry renders as it does today.

  "Approved over findings", rather than "A human approved", stays true once A1's arbiter can take an override.

- [ ] **Step 1: Write the failing tests**

```ts
it('says silence is read as fixed — the rule the gate applies', () => {
  const text = deferralsBlock([mint('d-1') as unknown as DeferralEntry])
  expect(text).toContain('Silence is read as fixed')
  expect(text).not.toContain('still present"')
})
it('renders an omission obligation as the anchor object a verdict can carry', () => {
  const text = deferralsBlock([mint('d-2', { anchor: 'omission:tests/' }) as unknown as DeferralEntry])
  expect(text).toContain('omission · scope tests/')
  expect(text).toContain('"anchor": { "kind": "omission", "scope": "tests/" }')
  expect(text).not.toContain('omission:tests/')
})
```

Change `tests/deferral.test.ts:150` to `expect(prompt).toMatch(/Silence is read as fixed/)`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/deferral.test.ts`
Expected: FAIL. The text still says `still present`, and the omission is rendered `omission:tests/`.

- [ ] **Step 3: Implement the exact copy above**

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm vitest run tests/deferral.test.ts tests/gate-engine.test.ts`
Expected: PASS. The block joins `prompts_sha` (`src/gate.ts`, the key's `prompts_sha` composition), so artifacts with open obligations re-roll their next verdict once. That is intended.

- [ ] **Step 5: Commit**

```bash
git add src/deferral.ts tests/deferral.test.ts
git commit -m "fix(deferral): the block says silence is read as fixed, as the gate does" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: DESIGN.md rows 169 and 170, and the recorded residual

**Files:**
- Modify: `DESIGN.md`. Append the rows after row 167, and add the residual at the top of `## Open / deferred`.

- [ ] **Step 1: Write the rows in the house shape** (`| N mark | title | decision | why/evidence |`, with a new wave mark)

**Row 169, "The battery runs its lenses at once".**
- **Decision:**
  - lenses launch concurrently, and each walks the fallback chain on its own;
  - the round's `model` is the highest rung any lens answered on, and `fallback` lists the ids any lens failed on, so a round that fell back anywhere is still a fallback round (106/107);
  - `verdicts`, `malformed` and `rerolled` keep battery order;
  - invocation is async, settling on close or on exit plus a grace period (D145's grandchild lesson);
  - `WITNESS_LENS` is exported to every reviewer, the way `WITNESS_SCREENS_DIR` is exported to runners;
  - the fakes address verdicts by lens, because call order is no longer lens order.
- **Evidence:** fewhats measured 319 implement gates, median 14 min and p90 31 min, running 5 lenses one after another (autopilot design E4).

**Row 170, "A failed check recommends revise".**
- **Decision:**
  - a new rule, `checks-failed`, sits after the blocking rules and before `non-blocking-only`;
  - `manual-stop` now fires only when every check is green, there are zero findings and there is no standing stop.
- **Evidence:** 31 of 31 `manual-stop` recommendations in fewhats were runs with failed checks, and none had `--manual`. 25 were approved, including 8 of the 9 ship gates (autopilot design E8).

**Row 122, amended in place.** Add a sentence: amended 0.15.0. The injected block told reviewers that silence reads as still present, while discharge reads silence as fixed. The block now states the gate's rule, and lists an omission obligation in the anchor shape a verdict can carry. Both reasons go into Task 6's commit message.

**Open / deferred, new first bullet.** Filtered-mode criteria are judged by exit code (`src/criteria.ts:71-80`), while evidence reads the report by exact tag (`src/evidence.ts:58-77`). So a template that over-matches fails the wrong spec's lane. fewhats anchors its template. The fix, reading the report when one is configured, is deferred.

- [ ] **Step 2: Commit**

```bash
git add DESIGN.md
git commit -m "docs(design): rows 169-170 and row 122 amended -- the battery runs at once · a failed check recommends revise · the deferral block tells the truth" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Verify, review, release 0.15.0, upgrade the consumers

- [ ] **Step 1: Full suite and typecheck**

Run: `pnpm test 2>&1 | tee /tmp/w1-suite.log | tail -5; grep -c AssertionError /tmp/w1-suite.log; pnpm run typecheck`
Expected: the passed count is at or above main's 1223, with 0 AssertionError and typecheck clean.

- [ ] **Step 2: Consumer differential (read-only)**

1. Build `main` in a temporary worktree: `git worktree add ../witness-main main && (cd ../witness-main && pnpm install --frozen-lockfile && pnpm run build)`.
2. Build this branch in place: `pnpm run build`.
3. From `~/x/personal/fewhats.com`, run each build with `CI=1 WITNESS_REGISTRY=off`: `check`, `next`, `status`, and `decide <gate> <target> --show` for every pending decision that `status` lists. Save each output and `diff` the two sets.
4. Remove the temporary worktree: `git worktree remove ../witness-main`.

Expected: identical output, except that a decision block whose last run failed a check now says `checks-failed` and recommends `--revise`.

- [ ] **Step 3: Adversarial review**

Dispatch two fresh opus reviewers, `model: "opus"`, on the branch diff:
1. a code review against this plan and the design;
2. a behavior attack on the parallel battery: fallback classification, refusal precedence, hung children, journal order.

Re-verify every finding by probe before acting on it. Fix in one pass and commit.

- [ ] **Step 4: HUMAN, merge and release**

Open a PR (`gh pr create`). After the human merges it, on `main`:
1. Run `pnpm release minor`. Expected: release commit and tag `v0.15.0`.
2. The human pushes `main`, then the tag. Wait for `release.yml` to pass, then for `npm view @popovych.co/witness version` to print `0.15.0`. The registry takes about 2 minutes.

- [ ] **Step 5: Upgrade the skills and fewhats.com**

```bash
npx -y skills@latest add -g -y https://registry.npmjs.org/@popovych.co/witness/-/witness-0.15.0.tgz
cd ~/x/personal/fewhats.com && npx -y @popovych.co/witness@0.15.0 init --agent pi && CI=1 WITNESS_REGISTRY=off npx -y @popovych.co/witness@0.15.0 check
```

Expected:
- all three skill homes read 0.15.0 (the `PromptScript` errors are the known, ignorable target);
- `init` commits a 2-line pin bump on main and in each live worktree;
- `check` reports `0 errors`.

KYC is not touched; it stays pinned at 0.14.4 by the user's choice.
