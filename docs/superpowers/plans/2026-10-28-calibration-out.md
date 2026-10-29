# Calibration Out (0.26.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Witness loses its calibration feature and the stand-in model that existed only for it. A stage's reviewers and the arbiter are asked on their pin alone, and a pin that cannot be invoked stops the gate at once. DESIGN row 212; release 0.26.0. It is built after 0.25.1 (`docs/superpowers/plans/2026-10-28-issues-58-60.md`) has shipped.

**Architecture:**
- **Task 1** deletes:
  - `witness calibrate` and its suites;
  - the shipped matrix;
  - the nightly workflow;
  - the release gate's matrix rule;
  - the malformed screen's calibrate option.
- **Task 2** collapses `resolveModel`'s chain to one model per stage, `stageModel()`. That takes with it:
  - the model floor (the `model-floor:` lines and the below-floor warning);
  - the `calibration` stamp;
  - the session-default fallback rung;
  - the `fallback-streak` brake.

  A dead pin refuses with a `pin-unanswered` row. The readers of 0.25.x journals (`pin`, `fallback`, `fellBack`) stay.
- **Task 3** writes the DESIGN row.
- **Task 4** verifies, runs the consumer differential, reviews and releases.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict` + `noUncheckedIndexedAccess`) on Node ≥ 20; `tsc` covers `src/` only. Tests use vitest 3, untyped, driving the real CLI against throwaway git repos (`tests/helpers.ts`). The fake `claude` lives in `fixtures/fakebin/claude`: `claude-fail[-<lens>]` fails calls, `putVerdict(…, '<lens>')` answers one lens, and each call leaves `claude-calls/call-N/…`. Lint is biome. No new dependencies.

**Spec:**
- The user's instruction (2026-10-28): "get rid of any calibration logic we have in witness … we never calibrate in any consumers".
- The user's answers the same day:
  - (a) When a pinned model cannot be reached, the gate stops at once, with no stand-in model.
  - (b) No retry of the pin either. The three stand-in rounds in their repos came from their own edits of the model in config, and re-asking a model id that does not exist cannot help.
  - (c) This ships after the issue fixes, as 0.26.0.
- Every claim was read at `main` 933ac1f (0.25.0), probed (P3), or measured in the consumers' journals (read-only).

## Global Constraints

- **Start point.** Start from `main` after 0.25.1 is released. Line numbers here are at 933ac1f, and 0.25.1 edits these files first: `src/gate.ts`, `src/rounds.ts`, `src/recommend.ts`, `src/delta.ts`, `src/verdict.ts`, `src/drive.ts`, `src/spawn.ts`, `src/notify.ts`, `src/awake.ts`, and their tests. Find each site by the code quoted here, not by its number.
- **Witness only.** Never modify fewhats.com, hear-your-customer-mvp, know-your-customer-mvp or wot-mod-manager. The differential reads `git clone --local` copies in a scratch directory.
- **No settings change.** No committed setting is added, removed or re-commented, so an upgrade needs no `witness migrate`.
- **Old journals keep reading.** A journal written by 0.25.x reads unchanged:
  - an entry's `calibration` key is ignored: it is no longer typed and never read;
  - `pin`, `fallback` and `fellBack()` keep every reader they have today (resume, cache, delta base, budget, caps, outstanding demotions).
- **Prompts stay as they are.** `prompts/*.md` are not edited. Their "blocking-bit calibration" is the Apache-2.0 §4b change notice for vendored text, and any prompt edit moves every lens's `basis_sha`, which would make each consumer's next round a full review.
- **Fixture prose stays.** `fixtures/configs/consumer-*.yaml` keep their calibration prose: it is a human's words, and `migrate` must preserve it byte for byte.
- **DESIGN.md keeps its history.**
  - Rows that cite calibration only as reasoning stay as written.
  - A row whose decision changes gains `**Amended by 212:**`.
  - Current-state prose (Orchestration, Gates, Open/deferred) is corrected.
- **Judging the suite.** Count `AssertionError`s; ignore `pnpm test`'s exit code. A few vitest worker-RPC timeouts make it exit 1 with every test green.
- **RED after the fact.** To watch a test fail against pre-fix code, reverse-apply the fix hunk (`git diff <fix>~1 <fix> -- <file> | git apply -R`), run the test, then `git checkout HEAD -- <file>`. Never `git stash`: the checkout holds the user's older stash entries.
- **One release:** 0.26.0 (`pnpm release minor`, run by the human).

## Review Focus

1. **A consumer journal written by 0.25.x.** Entries carry `calibration: 'none'`, and a fallen-back round may still be owed a decision. `decide --show` and a re-gate keep working, and the re-gate retries the pin. Under autonomy that round is re-run, never handed to the arbiter. Tests in Task 2.
2. **A mistyped or retired pin**, the user's own cause of every stand-in round so far. The gate stops at once and names `gates.<gate>.model`, and no other model is asked. Tests in Task 2.
3. **A repair (row 209) whose re-asked lens cannot reach the pin.** The gate refuses and journals nothing; the malformed round stays the last run, so the re-gate after the fix repairs again. Test in Task 2.
4. **A repo that still holds `.witness/calibration.local.yaml` untracked** (one scaffolded before init ignored it). It stays exempt from the dirty check, so state writes never refuse over it. Test in Task 2.
5. **The malformed screen after removal.** It offers one act, the re-run. Under autonomy the policy takes it, and the repair runs. Test in Task 1.

## Verified evidence base

### E1 — Calibration is unused, and costs something (read, measured)

**Shipped matrix and workflow.**
- `calibration.yaml` has shipped `models: []` since 0.1.x.
- `.github/workflows/calibration.yml` has failed every night since August, on an empty `ANTHROPIC_API_KEY` secret.
- `calibration/` is 202 files (952 KB), shipped in every tarball (`package.json` `files`).

**The consumers' journals** (read-only, 1,100 gate runs):

| Consumer | Runs | Calibration stamp | Note |
|---|---|---|---|
| fewhats.com (pi, autonomy on) | 403 (Sep–Oct) | `none` on all 403 | — |
| hear-your-customer-mvp (pi) | 159 (Sep) | `none` on all 159 | — |
| know-your-customer-mvp (pi, pinned 0.14.4, quiet since Sep 14) | 538 | 358 `none`, 180 `local` | stamps came from one local overlay |

- KYC's overlay is `.witness/calibration.local.yaml`, written 2026-08-26 and gitignored. Its entry outlived a later run that scored the same model `clean 6/10`: a failed calibrate never removes an entry (DESIGN Open/deferred). So KYC's 180 `local` stamps rest on a contradicted pass.

**What consumers see today.** fewhats' `status` and `check` both print `model-floor: decompose · plan · implement · ship · design: calibration matrix is empty — no calibrated model exists yet; claude-opus-5-5 runs uncalibrated` (0.25.0, read-only clone).

**Footprint in the code.**
- `src/calibrate.ts` (790 lines) and `src/verbs/calibrate.ts` (139) have no importer but each other and tests.
- The matrix and the overlay are read only by `loadMatrix` (`src/model.ts:33-38`).
  - `resolveModel` feeds `src/gate.ts:304` and `src/arbiter.ts:84`.
  - `modelFloorLines` feeds `src/verbs/check.ts:460` and `src/verbs/dashboard.ts:240`.
- The other mentions are:
  - user-visible copy: `src/pin.ts:50`, `src/verdict.ts:56`, `src/verbs/migrate.ts:27`, `src/recommend.ts:190`, `plugin/commands/witness.md:73,76`;
  - the release gate: `scripts/release-gate.mjs:34-43`;
  - init's ignore line: `src/verbs/init.ts:27`;
  - the dirty-check exemption: `src/gitio.ts:108`;
  - comments.

### E2 — In practice the chain is `[pin, session-default]`, and its one rung was used by config edits (read, probe P3, measured)

- **The chain.** `resolveModel` builds `[pin, …calibrated, SESSION_DEFAULT]` (`src/model.ts:61-86`); with an empty matrix that is `[pin, SESSION_DEFAULT]`.
- **P3.** A gate whose pin fails to invoke re-asks every lens on the session default. The entry reads `model: session-default`, `pin: test-model-1`, `fallback: [test-model-1]`, with the standing stop `fallback — reviewers ran on session-default…`.
- **What session-default is.** Pi's session default on this machine is `anthropic/claude-opus-5` at `max` thinking, older than fewhats' pinned `claude-opus-5-5`.
- **Fallback history.** 3 of the 1,100 runs fell back: fewhats 2026-09-20, KYC 2026-08-29 and 2026-09-03.
  - A human revised each stand-in round, one of them within a minute.
  - The next round answered on the pin each time.
  - The user confirmed the cause: they were changing the model in config at the time.
- **Autonomy.** Under autonomy a fallen-back round goes to the arbiter (`src/autonomy.ts:87`). A clean ship or decompose round with a standing stop reaches the arbiter even earlier (`:86`).
- **Pending rounds.** None of the three is still owed a decision.
- **The recorded reason.** DESIGN row 98(c): "Killing model fallback outright … was rejected only because row 55's floor is built on the chain's last rung."

### E3 — Pieces that stay (read)

- The sync `invokeReviewer` is also drift's lane (`src/drift.ts:144`); only its comment and its test name change.
- pi's worker `--no-session` (`src/harness.ts:221`) is drive's too, and pinned by `tests/drive.test.ts:226,244`; only its comment changes.
- `batch-argv-line-break` keeps a direct `resolveSpawn` test (`tests/spawn.test.ts:151-157`) when the calibrate-worker tests go.

## Calls made in this plan

- **C1 (the user's). No stand-in model.**
  - A stage is asked on its pin.
  - An older file that never pinned one is asked on the session default.
  - A lens that cannot be invoked refuses the gate.
- **C2 (the user's). No retry of the pin.** Every real stand-in round came from a config edit, so the fix is to stop and name the setting.
- **C3. The dead-pin refusal names the pin.** It gains one row, `gates.<gate>.model · pin-unanswered` (`arbiter.model` for the arbiter), marked as a human's call. The removed `fallback-streak` brake used to give this remedy; this row is now where it lives.
- **C4. Old fallen-back rounds are re-run, not arbitrated.** A 0.25.x fallen-back round still owed a decision is re-run under autonomy. The arm sits ahead of the ship/decompose arbiter arm, so no AI weighs a stand-in's verdict.
- **C5. The overlay stays exempt from the dirty check.** An old repo may hold `.witness/calibration.local.yaml` untracked, and a refusal there would block every state write. Init stops ignoring it.

---

### Task 0: Branch

- [ ] **Step 1:** `git switch -c drop-calibration` from `main` after 0.25.1 is released (clean tree). This plan is already on `main`: 0.25.1's Task 0 committed it.

### Task 1: `witness calibrate`, its suites and the shipped matrix are gone

**Files:**
- Delete:
  - `src/calibrate.ts`, `src/verbs/calibrate.ts`
  - `calibration/`, `calibration.yaml`
  - `.github/workflows/calibration.yml`
  - `scripts/gen-vision-fixtures.mjs`
  - `tests/calibrate.test.ts`, `tests/calibrate-skills.test.ts`, `tests/calibration-fixtures.test.ts`
- Modify (code):
  - `src/cli.ts`: the `calibrate` entries in `VERBS` and `VERB_USAGE`
  - `src/recommend.ts`: malformed-rerun option 2 and its D152 comment
  - `scripts/release-gate.mjs`
  - `src/verdict.ts:56`: the `blocking-shape` want
- Modify (config and metadata):
  - `.github/workflows/release.yml:30`: the step name
  - `package.json` `files`: drop `calibration.yaml` and `calibration`
  - `tsconfig.json:12` and `vitest.config.ts:28`: drop the `calibration` excludes
- Modify (comments that name the deleted module):
  - `src/drive.ts`: the `localBin` and `spawnSession` comments
  - `src/harness.ts:45-47,52-55,216-219`
  - `src/reviewer.ts:104-106,125-127,224`
  - `src/spawn.ts:8`
  - `fixtures/fakebin/claude:16-17`
- Modify (docs): `README.md:38-40,212-213,307`, `docs/graduation.md`, `docs/RELEASING.md:19`, `NOTICE.md:58`
- Test:
  - `tests/cli.test.ts:29-38`
  - `tests/recommend.test.ts` (the D152 describe)
  - `tests/release-gate.test.ts`
  - `tests/release-main-guard.test.ts:27,65`
  - `tests/workflows.test.ts:10-24,47`
  - `tests/schema-2.test.ts:4,102-108`
  - `tests/design-lens.test.ts:203-217`
  - `tests/spawn.test.ts:6,312-317,346-353`
  - `tests/reviewer.test.ts:358`: rename
  - `tests/skills.test.ts:255-260`: comment

**Interfaces:**
- Produces: `releaseGate({ version, tag }: { version: string; tag?: string }): { ok: boolean; errors: Row[] }`. There is no `models` input and no `warnings` output.
- Produces: `recommend()`'s `malformed-rerun` block has exactly one option, `witness gate <gate> <target>`. Its `why` keeps 0.25.1's `re-asks only <lenses>` suffix.

- [ ] **Step 1: Write the failing tests**

In `tests/cli.test.ts`, drop `'calibrate'` from the `--help` loop's list and add:

```ts
it('calibrate is no verb (row 212)', async () => {
  const repo = tmpRepo()
  const r = await repo.cli(['calibrate', '--help'])      // --help: the RED run must never start a calibration
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('unknown verb: calibrate')
  expect((await repo.cli(['--help'])).stdout).not.toContain('calibrate')
})
```

In `tests/recommend.test.ts`, replace the D152 `describe` and its comment (Review Focus 5):

```ts
describe('malformed-rerun offers the re-run alone (row 212)', () => {
  it('renders no calibrate invocation, and the re-run says what it re-asks', () => {
    const d = recommend(ctxFor([run(1, 'a', 'S', {
      outcome: 'malformed', malformed: [{ reviewer: 'code-reviewer', violations: [] }],
    })]))!
    expect(d.rule).toBe('malformed-rerun')
    expect(d.options.map((o) => o.command)).toEqual(['witness gate plan p1'])
    expect(d.options[0]!.why).toContain('re-asks only code-reviewer')
  })
})
```

Rewrite `tests/release-gate.test.ts` around the one rule:
- Keep the two mismatch tests (`tag-version-mismatch`; the remedy names the bump first) and the no-tag test, with `models` dropped from every call.
- Delete the matrix tests.
- Add:

```ts
it('passes a tag that names the version, 0.x and 1.x alike — no matrix rule (row 212)', () => {
  for (const version of ['0.26.0', '1.0.0', '1.0.0-rc.1']) {
    expect(releaseGate({ version, tag: `v${version}` })).toEqual({ ok: true, errors: [] })
  }
})
```

In `tests/workflows.test.ts`:
- Delete the `calibration.yml` test.
- Drop `'calibration.yml'` from the frozen-lockfile loop.
- In the ci test, drop the `calibrate` assertion and rename it `'ci runs per commit, model-free — no API key'`.
- Import `readdirSync` and add:

```ts
it('runs exactly two workflows: ci and release (row 212)', () => {
  expect(readdirSync(join(__dirname, '..', '.github', 'workflows')).sort()).toEqual(['ci.yml', 'release.yml'])
})
```

Delete:
- in `release-main-guard.test.ts`, the `calibration.yaml` write (`:27`) and its `git add` path (`:65`);
- in `schema-2.test.ts`, the test `'calibrate writes a schema-2 scratch config'` and the `seedScratchRepo` import;
- in `design-lens.test.ts`, the `'calibration screens support'` describe;
- in `spawn.test.ts`, the two `the calibrate worker …` tests and the `defaultAgent` import.

Rename `reviewer.test.ts:358` to `'the sync invoker (drift\'s lane) never waits · it refuses as outside drive'`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/cli.test.ts tests/recommend.test.ts tests/release-gate.test.ts tests/workflows.test.ts`

Expected: FAIL:
- `calibrate --help` exits 0;
- the malformed-rerun block has two options;
- `releaseGate` returns `warnings`;
- `calibration.yml` still exists.

- [ ] **Step 3: Delete the feature and its references**

Delete every file under **Delete**. Then edit:

- **`scripts/release-gate.mjs`:**
  - `releaseGate` keeps only the tag rule and returns `{ ok, errors }`.
  - The CLI reads `package.json` alone; the unreadable-inputs `want` becomes `readable package.json`.
  - The header comment states one rule, and that row 212 removed the matrix rule.
- **`release.yml:30`:** `- name: release gate (tag/version)`.
- **`src/verdict.ts:56`'s want:** `'true | false — whether this finding blocks the gate'`.
- **The comments:** rewrite each named comment without the deleted module, keeping what it says about drive, the reviewer, drift or a headless worker. The pi worker's reads `--no-session keeps a headless worker's run out of the user's session store.`
- **`README.md:38-40`:** `Status: all four slices landed — state core, deterministic evidence, gates & motion, and the plugin. What remains before 1.0 is listed in \`docs/graduation.md\`.`
- **`README.md:212-213`:** begins `**The judge (\`harness\`).** Which harness runs this repo's gate reviewers and its arbiter, and is probed by \`check\`.` The rest of the paragraph is unchanged.
- **`README.md:307`:** delete the `calibrate <model>` row.
- **`docs/graduation.md`:**
  - delete §2 (lines 34-38) and renumber §3–§5 as §2–§4;
  - line 13's parenthetical begins `(plugin text and prompts are full of`;
  - line 20's list drops `'calibration/**'`;
  - line 31 reads `One \`feature\`-class effort covering a real backlog item, exercising the decompose scope stop.`;
  - delete line 61.
- **`docs/RELEASING.md:19`:** `| \`node scripts/release-gate.mjs\` | the tag equals \`v${package.json.version}\` |`
- **`NOTICE.md:58`:** `scripts, and everything under \`src/\`.`

- [ ] **Step 4: Run the tests and the type check**

Run:

```
npx vitest run tests/cli.test.ts tests/recommend.test.ts tests/release-gate.test.ts \
  tests/release-main-guard.test.ts tests/workflows.test.ts tests/schema-2.test.ts \
  tests/design-lens.test.ts tests/spawn.test.ts tests/reviewer.test.ts
```

Expected: PASS. Then `npx tsc --noEmit` → 0.

Run: `git grep -n -i calibrat -- src scripts .github package.json tsconfig.json vitest.config.ts README.md docs/RELEASING.md docs/graduation.md NOTICE.md`. It lists only Task 2's sites:
- `src/model.ts`, `src/gate.ts`, `src/rounds.ts`;
- `src/verbs/{check,dashboard,init,migrate}.ts`;
- `src/gitio.ts`, `src/pin.ts`, `src/harness.ts:279,323`, `src/settings.ts:44`;
- `README.md:309,322`;
- `src/config.ts:51` (the B5 caps calibration, an unrelated sense that stays).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat!: remove witness calibrate, its suites and the shipped matrix (row 212)"
```

### Task 2: A stage asks its pin alone; the model floor is gone

**Files:**
- Modify (the model and the gate):
  - `src/model.ts`: rewrite
  - `src/battery.ts`: rewrite the lens run
  - `src/arbiter.ts`: its imports, the `:19-22` comment, and the chain walk at `:84-110`
  - `src/gate.ts`: the model import; the `fellBack` import; the model line in `renderGateRun`; the `resolveModel` block; the `fallback-streak` block; `let fallback`; the battery call; the fallback clause in `standing`; and the `calibration` and `fallback` entry fields
  - `src/rounds.ts`: `calibration` and `fallback?`
  - `src/autonomy.ts:81-87`
- Modify (verbs and local state):
  - `src/verbs/check.ts:25,452-463`
  - `src/verbs/dashboard.ts:11,225-243`
  - `src/verbs/init.ts:27`
  - `src/gitio.ts:108`
  - `src/verbs/migrate.ts:27`
  - `src/pin.ts:50`
- Modify (comments): `src/harness.ts:46,279,299,323`, `src/settings.ts:44,228`, `src/config.ts:68,88`, `src/migration.ts:155`
- Modify (docs): `plugin/commands/witness.md:73,76`, `README.md:309,322`
- Test (rewrites and new cases):
  - `tests/model.test.ts` (rewrite)
  - `tests/battery.test.ts`: the fallback-round test, and 0.25.1's repair-fallback test
  - `tests/arbiter.test.ts`: the chain test
  - `tests/gate-engine.test.ts`: `:77`, the three fallback tests, and the `calibration reporting` describe
  - `tests/decide.test.ts`: `fallenBackGate`
  - `tests/drive.test.ts`: the settle-pass limit test
  - `tests/config-typed.test.ts:5,121-125`
  - `tests/autonomy.test.ts`
  - `tests/check.test.ts:473-480`
  - `tests/gitio.test.ts`
  - `tests/draft.test.ts:19`
  - `tests/pin.test.ts:11`
- Test (comments only): `tests/dashboard.test.ts:131`, `tests/harness.test.ts:86`
- Test (fixtures): the `calibration: 'none'` key in 24 files

**Interfaces:**
- Consumes: `stagePin(cfg, role)` (`src/model.ts:54-59`, unchanged); 0.25.1's repair merge in `gate.ts` (row 209).
- Produces: `stageModel(cfg: Config, role: GateName | 'arbiter'): Result<string>`. It returns the role's pin, else `SESSION_DEFAULT`, and refuses whatever `stagePin` refuses.
- Produces: `unansweredPin(rows: Violation[], field: string, model: string, harness: string): Violation[]`. It returns `rows` plus `humanCall(v(field, 'pin-unanswered', model, \`a model the ${harness} harness can invoke — if this pin is the cause, fix it in witness.config.yaml\`))`. The extra row is added only when `model !== SESSION_DEFAULT` and some row's rule is `reviewer-invocation`.
- Produces: `runBattery(ctx: Ctx, harness: Harness, model: string, lenses: readonly BatteryLens[], opts: { cwd: string } & InvokeExtras): Promise<Result<BatteryRun>>`, with `BatteryRun = { verdicts: ReviewerVerdict[]; malformed: Array<{ reviewer: string; violations: Violation[] }>; rerolled: string[] }`.
- `GateRunEntry` loses `calibration`. `pin?` and `fallback?` stay, for reading 0.25.x journals.

- [ ] **Step 1: Strip the dead fixture key, then write the failing tests**

```bash
perl -pi -e "s/^(\s*)calibration: 'none', /\$1/; s/ calibration: 'none',//g" $(grep -rl "calibration: 'none'" tests)
grep -rn "calibration: 'none'" tests          # → nothing (verified at 933ac1f: all 48 go, no whitespace left)
```

In `tests/model.test.ts`:
- Import `stageModel, stagePin, SESSION_DEFAULT`.
- Rename `describe('resolveModel')` to `describe('stageModel (row 212)')`, keeping its two alias tests rewritten through `stageModel`.
- Delete the matrix, overlay, warning and `warningKind` tests, and the `per-harness matrix` describe.
- Add:

```ts
it('asks the stage pin — a per-gate pin wins, other gates keep theirs', async () => {
  const { cfg } = await cfgWith('gates:\n  model: test-model-1\n  decompose: { model: test-model-2 }\n')
  expect(stageModel(cfg, 'decompose')).toEqual({ ok: true, value: 'test-model-2' })
  expect(stageModel(cfg, 'plan')).toEqual({ ok: true, value: 'test-model-1' })
})
it('asks the session default for a file that never pinned one', async () => {
  const { cfg } = await cfgWith('')
  expect(stageModel(cfg, 'arbiter')).toEqual({ ok: true, value: SESSION_DEFAULT })
})
```

In `tests/battery.test.ts`, replace `'one lens failing on the pin makes a fallback round'` (Review Focus 2):

```ts
it('a lens that cannot reach the pin refuses the gate, journals nothing, asks no other model (row 212)', async () => {
  const { repo, planId, scenario } = await batteryRepo()
  patchConfig(repo, { gates: { implement: { model: 'test-model-1' } } })
  writeFileSync(join(scenario, 'claude-fail-code-reviewer'), 'test-model-1')
  const errs: string[] = []
  const c = fakeCtx(repo.root, { env: gateEnv(scenario), err: (l) => errs.push(l) })
  expect(await runGate(c, 'implement', planId, { fresh: false, manual: false })).toBe(2)
  expect(gateRuns(repo, planId)).toHaveLength(0)
  expect(errs.join('\n')).toContain('reviewer-invocation')
  expect(errs.join('\n')).toContain('gates.implement.model')
  expect(errs.join('\n')).toContain('pin-unanswered')
  expect(callCount(scenario)).toBe(4)                     // one call per lens, none on another model
})
```

0.25.1's test `'a repair whose re-asked lens falls back is a fallback round, and keeps what it carried'` keeps its setup through the `claude-fail-pr-test` write. Its tail becomes (Review Focus 3):

```ts
  const errs: string[] = []
  expect(await runGate(fakeCtx(repo.root, { env: gateEnv(scenario), err: (l) => errs.push(l) }), 'implement', planId, F)).toBe(2)
  expect(gateRuns(repo, planId)).toHaveLength(1)          // the malformed round is still the last
  expect(errs.join('\n')).toContain('pin-unanswered')
```

Rename it `'a repair whose re-asked lens cannot reach the pin refuses and journals nothing (row 212)'`.

In `tests/arbiter.test.ts`, replace `'walks the gates.model chain like a lens'`:

```ts
it('a dead pin refuses with the invocation rows and the pin, asking no other model (row 212)', async () => {
  const { repo, scenario, ctx, cfg } = await setup('schema: 1\ngates:\n  model: test-model-1\n')
  writeFileSync(join(scenario, 'claude-fail-arbiter'), 'test-model-1')
  const r = await arbitrate(ctx, repo.root, cfg, REQ)
  expect(!r.ok && r.violations.map((x) => x.rule)).toEqual(expect.arrayContaining(['reviewer-invocation', 'pin-unanswered']))
  expect(!r.ok && r.violations.find((x) => x.rule === 'pin-unanswered')!.field).toBe('arbiter.model')
  expect(callCount(scenario)).toBe(1)
})
```

In `tests/gate-engine.test.ts`:
- Import `callCount`.
- At `:77`, replace the calibration assertion with `expect(all[0]).not.toHaveProperty('calibration')`.
- Replace the three fallback tests and the `calibration reporting` describe with these (Review Focus 1 and 2):

```ts
it('a dead pin refuses the gate with the invocation rows and the pin to fix, journaling nothing (row 212)', async () => {
  const { repo, scenario } = await gateRepo()
  writeFileSync(join(repo.root, 'witness.config.yaml'), 'schema: 1\ngates:\n  model: test-model-1\n')
  putVerdict(scenario, CLEAN('auth-refresh'))
  writeFileSync(join(scenario, 'claude-fail'), '1')
  const errs: string[] = []
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario), err: (l: string) => errs.push(l) })
  expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(2)
  expect(runs(repo)).toHaveLength(0)
  expect(callCount(scenario)).toBe(1)
  expect(errs.join('\n')).toContain('gates.plan.model')
  expect(errs.join('\n')).toContain("a human's decision: pin-unanswered")
})

it('the model line names the model alone; the entry carries no calibration stamp (row 212)', async () => {
  const { repo, scenario } = await gateRepo()
  writeFileSync(join(repo.root, 'witness.config.yaml'), 'schema: 1\ngates:\n  model: test-model-1\n')
  putVerdict(scenario, CLEAN('auth-refresh'))
  const out: string[] = []
  const err: string[] = []
  await runGate(fakeCtx(repo.root, { env: gateEnv(scenario), out: (l) => out.push(l), err: (l) => err.push(l) }),
    'plan', 'auth-refresh', { fresh: false, manual: false })
  const run = runs(repo)[0]!
  expect(out).toContain('model: test-model-1')
  expect(`${out.join('\n')}\n${err.join('\n')}`).not.toMatch(/calibrat/i)
  expect(run).not.toHaveProperty('calibration')
})

it('after a fallen-back round 0.25.x journaled, a re-gate asks the pin and journals no fallback', async () => {
  const { repo, scenario } = await gateRepo()
  writeFileSync(join(repo.root, 'witness.config.yaml'), 'schema: 1\ngates:\n  model: test-model-1\n')
  repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'pin')
  const doc = findById(loadCanon(repo.root), 'auth-refresh')!
  journalDecision(repo, 'auth-refresh', {
    v: 1, t: 'gate-run', gate: 'plan', artifact: 'auth-refresh', round: 1, run_id: 'r-0250',
    reviewed_sha: canonicalSha(doc.meta, doc.body), prompts_sha: 'p', witness: '0.25.0',
    model: 'session-default', pin: 'test-model-1', harness: 'claude-code', calibration: 'none', fallback: ['test-model-1'],
    standing: 'fallback — reviewers ran on session-default, not the pinned test-model-1; the human decides whether that verdict counts',
    checks: [{ name: 'synthetic', ok: true }], verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [] }], outcome: 'stopped',
  } as never)
  putVerdict(scenario, CLEAN('auth-refresh'))
  expect(await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(0)
  const last = runs(repo).at(-1)!
  expect([last.model, last.pin, last.fallback]).toEqual(['test-model-1', 'test-model-1', undefined])
  expect(callCount(scenario)).toBe(1)
})
```

In `tests/decide.test.ts`, `fallenBackGate()` no longer runs a gate, since no run can fall back now. It journals the round 0.25.x would have written: the entry above with `model: 'test-model-2'` and the standing stop `fallback — reviewers ran on test-model-2, not the pinned test-model-1; the human decides whether that verdict counts`. It commits with a `Witness-State: 1` trailer, as `gate-engine.test.ts`'s `journalDecision` does. Its two tests keep their assertions; update the comment above the helper.

Other test edits:
- **`tests/drive.test.ts`**, in the settle-pass limit test: `String(used + 1)   // one call: the arbiter asks its pin alone (row 212)`.
- **`tests/config-typed.test.ts`:** import `stageModel`; at `:121-125`, `expect(stageModel(cfg, 'arbiter')).toEqual({ ok: true, value: 'claude-opus-5-5' })`.
- **`tests/pin.test.ts:11`:** the want becomes `'an exact model id — an alias re-points when its vendor ships a new model (Decision 55)'`.
- **`tests/draft.test.ts:19`:** drop the `.witness/calibration.local.yaml` line from the expected ignore block.

In `tests/autonomy.test.ts` (Review Focus 1):

```ts
it('a fallen-back round 0.25.x journaled is re-run on its pin, never arbitrated (row 212)', () => {
  const fell = { pin: 'm1', model: 'session-default', fallback: ['m1'],
    standing: 'fallback — reviewers ran on session-default, not the pinned m1; the human decides whether that verdict counts' }
  expect(policy('plan', [run(1, 'a', fell)])).toEqual(take('witness gate plan p1'))
  expect(policy('ship', [run(1, 'a', { ...fell, gate: 'ship' })])).toEqual(take('witness gate ship p1'))   // ahead of the clean-standing arm
})
```

In `tests/check.test.ts`, replace the `states the calibration fact` describe:

```ts
describe('the orientation surfaces state no calibration (row 212)', () => {
  it('check and status print no model floor', async () => {
    const repo = await seededRepo()
    for (const verb of ['check', 'status']) {
      const res = await repo.cli([verb])
      expect(res.code, verb).toBe(0)
      expect(res.stdout, verb).not.toMatch(/model-floor|calibrat/)
    }
  })
})
```

In `tests/gitio.test.ts`, beside `'ignores witness local files when checking dirt'` (Review Focus 4). This passes today; it pins the exemption C5 keeps:

```ts
it('a calibration overlay 0.25.x left behind is still a witness local file (row 212)', () => {
  const repo = tmpRepo()
  repo.write('.witness/calibration.local.yaml', 'matrices: {}\n')
  repo.write('specs/a.md', 'a')
  expect(dirtyStatePaths(repo.root)).toEqual(['specs/a.md'])
})
```

- [ ] **Step 2: Run them to see them fail**

Run:

```
npx vitest run tests/model.test.ts tests/battery.test.ts tests/arbiter.test.ts tests/gate-engine.test.ts \
  tests/autonomy.test.ts tests/check.test.ts tests/pin.test.ts tests/draft.test.ts
```

Expected: FAIL:
- `stageModel` is not exported;
- a dead pin still falls back (exit 1, five calls);
- the model line carries `· calibration: none`;
- the fallen-back plan round goes to the arbiter;
- `check` prints `model-floor:`.

- [ ] **Step 3: Implement**

**`src/model.ts`:**
- Keep the `MODEL_ALIASES` re-export, `SESSION_DEFAULT` and `stagePin`.
- Add `stageModel` and `unansweredPin`.
- Delete `MatrixInfo`, `shippedMatrixPath`, `readModels`, `loadMatrix`, `ModelResolution`, `resolveModel` and `modelFloorLines`.
- `stagePin`'s comment ends `the session default answers.`

**`src/battery.ts`:**
- `runLens` invokes once per attempt on `model`, passing `undefined` when it is `SESSION_DEFAULT`.
- An invocation refusal returns `refuse(rows)` at once.
- The one self-repair reroll stays as it is.
- Drop `failedOn`, `rung`, `fallback` and `model`.
- Rewrite the header comment: lenses launch together, and a lens that cannot be invoked refuses the gate (row 212).

**`src/arbiter.ts`:**
- Asks `stageModel(cfg, 'arbiter')`, once per attempt.
- A refusal returns `refuse(unansweredPin(r.violations, 'arbiter.model', model, harness.name))`.
- The ruling's `model` is that model.
- The `:19-22` comment names `arbiter.model` (row 172), not a chain.

**`src/gate.ts`:**
- Import `stageModel` and `unansweredPin`, and drop `fellBack` (only the deleted brake used it).
- The model line becomes `ctx.out(kv('model', \`${entry.model}${entry.cached ? ' · cached' : ''}\`))`.
- The `resolveModel` block becomes `const modelR = stageModel(cfgR.value, spec.gate)`, then either a refusal or `const pin = modelR.value`. The warning and its comment go.
- Delete the `fallback-streak` block; `samePin` stays for `malformed-streak`.
- Delete `let fallback`.
- The battery call:
  - It becomes `runBattery(ctx, harness, pin, <lenses>, …)`.
  - A refusal prints `renderRefusal(unansweredPin(ranR.violations, \`gates.${spec.gate}.model\`, pin, harness.name))`.
  - 0.25.1's repair merge (row 209) reads only the new run's `verdicts`, `malformed` and `rerolled`, and `model` stays `pin`.
- `standing` loses the fallback clause and its comment.
- The entry loses `calibration: calibrationOf(model)` and `...(fallback.length ? { fallback } : {})`.
- `renderGateRun`'s `fallback:` line stays: it renders 0.25.x rounds.

**`src/rounds.ts`:**
- Delete `calibration`.
- Above `fallback?`: `// Row 212: written through 0.25.x only, when a lens that could not reach the pin fell back to another model. Read for those journals (the \`fallback:\` line); \`fellBack\` reads \`pin\`/\`model\`.`

**`src/autonomy.ts`:**
- Delete `if (fellBack(run)) return { kind: 'arbiter' }`.
- Right after the stale/malformed arm, add `if (fellBack(run)) return { kind: 'take', command: \`witness gate ${gate} ${target}\` }`.
- Comment it: `// Row 212. A 0.25.x round that fell back to a model nobody pinned is no verdict to weigh: re-run it on the pin (free — it never spent the budget), ahead of every arbiter arm.`

**`check.ts` and `dashboard.ts`:**
- Delete the `modelFloorLines` import and loop.
- `check.ts:452-457`'s comment becomes: `Judge first: the line answers which reviewers this repo spawns. A stated line, never a finding — it touches neither the findings table nor the exit code, which is a contract about canon validity (101).`
- `dashboard.ts:225-233` keeps its row-105 judgment-lane and degrade reasoning, minus the floor.

**`init.ts`, `gitio.ts`, `migrate.ts`, `pin.ts`:**
- `init.ts:27`: delete the line.
- Above `gitio.ts:108`: `// Row 212: \`witness calibrate\` wrote this through 0.25.x. Nothing reads it now, but a repo scaffolded before init ignored it may still hold one untracked, and an unrelated-dirty refusal there would block every state write.`
- `migrate.ts:27`: `'was unpinned · the harness default model answered'`.
- `pin.ts:50`: the want from Step 1.

**Comments:**
- `harness.ts:46`: `spawn(undefined) is the session default (no model flag).`
- `harness.ts:279`: `THE JUDGE — which harness runs this repo's gate reviewers and is probed for runnability.`
- `harness.ts:299`: `One renderer for both orientation surfaces: the judge must read identically on \`check\` and \`status\` …`
- `harness.ts:323`: ends `what row 83's pins rest on.`
- `settings.ts:44,228`, `config.ts:68,88` and `migration.ts:155`: "the calibration chain", "the model chain" and "the chain" all become "the session default".

**Docs:**
- `plugin/commands/witness.md:73`: `calibration floor stops under \`--manual\`` becomes `` `pin-unanswered` (the pinned reviewer model cannot be invoked — show the human the pin the refusal names) ``.
- `plugin/commands/witness.md:76`: delete `If it reports the reviewer model is uncalibrated, surface that; under \`--manual\` treat it as a stop.`
- `README.md:309`: `| \`status\` | orientation: flows, blocked docs, reconcile rows, pending gates |`
- `README.md:322`: `- Local, never committed: \`.witness/{lock,txn.json,allow.json,drafts/}\`.`

- [ ] **Step 4: Run the tests and the type check**

Run:

```
npx vitest run tests/model.test.ts tests/battery.test.ts tests/arbiter.test.ts tests/gate-engine.test.ts \
  tests/decide.test.ts tests/autonomy.test.ts tests/check.test.ts tests/dashboard.test.ts tests/gitio.test.ts \
  tests/draft.test.ts tests/pin.test.ts tests/config-typed.test.ts tests/rounds.test.ts tests/caps.test.ts \
  tests/drive.test.ts tests/gate-delta-code.test.ts
```

Expected: PASS. Then `npx tsc --noEmit` → 0.

Run: `git grep -n -i calibrat -- src plugin scripts .github README.md`. It prints only `src/gitio.ts` (C5) and `src/config.ts:51` (B5).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(gate)!: a stage asks its pin alone — no stand-in model, no model floor (row 212)"
```

### Task 3: DESIGN.md row 212

**Files:** `DESIGN.md`. Append after row 211. Amend the rows named below. Fix the Orchestration verb list, the Gates prose and Open/deferred.

- [ ] **Step 1:** Append row **212 ⊜ Calibration is gone, and a stage asks its pin alone**, in row 201's shape.
  - **Header:** amends 41, 50, 55, 61, 65, 88, 98, 106, 107, 126, 152, 164, 169, 172 and 209; touches 25, 56 and 105.
  - **What it removes:**
    - `witness calibrate` and its suites;
    - `calibration.yaml`, and the local overlay's reader;
    - the model floor: both orientation lines and the per-run warning;
    - the `calibration` stamp, and `· calibration:` in the model line;
    - the nightly workflow;
    - the release gate's matrix rule;
    - the malformed screen's calibrate option.
  - **Stand-in model:** none. `stageModel` asks the pin, or the session default for a file that never pinned one. A lens that cannot be invoked refuses the gate with its rows plus `pin-unanswered` (C3), and nothing is journaled. No retry (C2).
  - **What stays for 0.25.x journals:** `pin`, `fallback`, `fellBack` and every reader of them. Under autonomy a fallen-back round is re-run on its pin (C4).
  - **The overlay:** it keeps its dirty-check exemption, and init no longer ignores it (C5).
  - **Evidence:** E1 and E2, including P3, the 1,100-run measurement, and the user's statement that the three stand-in rounds were config edits.
- [ ] **Step 2:** Add one sentence to each amended row. Use `**Retired by 212:**` where the row's whole decision is gone, `**Amended by 212:**` otherwise.

  | Row | Label | Sentence covers |
  |---|---|---|
  | 41 | Retired | the suites, `calibrate` and the matrix |
  | 50 | Retired | no matrix, no floor, no `model-floor:` line, no stamp |
  | 55 | Amended | no fallback chain; one model per stage; a dead pin refuses |
  | 61 | Retired | — |
  | 65 | Retired | the overlay is read by nothing, and is still exempt from the dirty check |
  | 88 | Amended | the per-(harness, model) calibration clause is retired; the harness doctrine stands |
  | 98 | Amended | (a) and (b) go with the matrix; (c) can no longer happen; its stop, exemption and brake read only 0.25.x rounds |
  | 106 | Amended | every new round has `pin === model`; the readers stay |
  | 107 | Amended | `fallback-streak` is removed; an old fallen-back round stays exempt and is re-run under autonomy |
  | 126 | Amended | the calibrate alternative is gone |
  | 152 | Retired | — |
  | 164 | Amended | the calibrate worker is gone |
  | 169 | Amended | one model per lens; exhaustion is the only refusal path; `fallback` is no longer written |
  | 172 | Amended | "a fallback round" now means only a 0.25.x round, which the policy re-runs |
  | 209 | Amended | a repair's re-asked lenses run on the pin alone |

- [ ] **Step 3:** Correct the current-state prose.
  - **Orchestration's verb list:** drop the `calibrate <model>` entry.
  - **The skill-handoff paragraph:** drop "the production mirror of the calibration metric (61)".
  - **The Gates paragraph:**
    - Rewrite the reviewer-model and model-floor sentences to say: `gates.<gate>.model` is asked alone, and a dead pin refuses (row 212).
    - The injection sentence ends "and nothing measures it since row 212 retired the calibration suites".
    - "calibration drift is diagnosable" becomes "model drift is diagnosable".
  - **Open/deferred:** delete these five bullets:
    - "The two decision lenses carry no calibration seed yet";
    - "The arbiter is uncalibrated";
    - "A failed `calibrate` leaves the model in the local overlay";
    - "Witness ships an empty calibration matrix";
    - "The skills battery cannot detect a small regression in the `decompose` row".

    The "`gates.<stage>.model` is one key with two consumers" bullet stays: its "calibration story" is rows 79–81's dispatch telemetry.
- [ ] **Step 4:** Verify the counts.
  - `git grep -o -E "(Amended|Retired) by 212" DESIGN.md | wc -l` → 15.
  - The new row renders as one table row.
- [ ] **Step 5:** Commit: `docs(design): row 212 — calibration out, one model per stage`.

### Task 4: Verify, review, release 0.26.0

- [ ] **Step 1: Build and check**

Run:
- `rm -rf dist && pnpm build` → 0. Clearing `dist` drops the stale `calibrate.js` outputs that `tsc` would leave behind.
- `npx tsc --noEmit` → 0.
- `npx biome check src tests plugin scripts` → 0.

- [ ] **Step 2: Run the suite**

Run: `pnpm test 2>&1 | tee <scratch>/suite.log; grep -c AssertionError <scratch>/suite.log` → `0`.

Re-run alone any file whose only failures are worker-RPC timeouts.

- [ ] **Step 3: Check for leftovers**

Run: `git grep -n -i calibrat -- src plugin scripts .github package.json tsconfig.json vitest.config.ts README.md NOTICE.md docs/RELEASING.md docs/graduation.md` → only `src/gitio.ts` (C5) and `src/config.ts:51` (B5).

Run: `git grep -n "resolveModel\|loadMatrix\|modelFloorLines\|fallback-streak" -- src` → nothing.

- [ ] **Step 4: Run the read-only differential**

1. `git clone --local` fewhats.com and hear-your-customer-mvp into scratch.
2. In each clone, with `CI=true`, run:
   - `status`;
   - `check`;
   - `next`;
   - `decide <gate> <target> --show`, for one target whose journal holds a gate-run.
3. Run each command twice: under `npx -y @popovych.co/witness@0.25.1`, and under `node <branch>/dist/bin.js`.

Expected: the outputs are identical, except that the `model-floor:` lines are gone and `· calibration: none` is gone from the `model:` line.

- [ ] **Step 5: Run two opus reviews**

Review `main..drop-calibration` with two agents, each through the Agent tool with `model: "opus"`:
- **(a) code vs this plan:** every C-call and E-line is honored, no calibration residue is left, and 0.25.x journals still read.
- **(b) behavior attack:** starting from the Review Focus list.

Re-run each finding before acting on it. Fix RED→GREEN in one pass, then repeat Steps 1–3.

- [ ] **Step 6 (on the user's go):** Push `drop-calibration` and open the PR, with a body summarizing row 212. Wait for CI to go green; the human merges.

- [ ] **Step 7 (HUMAN):** `pnpm release minor` → 0.26.0; push `main` and the tag.

- [ ] **Step 8 (owed after the release; each needs the user's go):**
  - Upgrade the global skills.
  - Run `witness init --agent <harness>` per consumer, because `plugin/commands/witness.md` changed.
  - Delete the now-unused `ANTHROPIC_API_KEY` repo secret.
  - KYC's inert overlay can go when KYC next upgrades.
