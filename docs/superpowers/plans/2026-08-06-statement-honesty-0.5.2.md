# Statement Honesty (0.5.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make witness stop contradicting itself in what it *says* — the router reads gate verdicts instead of re-deriving them, a revised gate has working exits, `next` names the phase it wants, the dashboard has a name, and no approval is discarded in silence.

**Architecture:** Every change is in the read/report path — `verbs/next.ts`, `verbs/decide.ts`, `gate.ts`, `model.ts`, `cli.ts`, `ship.ts`. **No gate outcome changes**: what passes a gate, what a verdict covers, and what a check asserts are all untouched (that is 0.6.0, rows 95–97). The unifying rule is that a question is answered in exactly one place — the gate decides, the router reports.

**Tech Stack:** TypeScript (strict, ESM, Node builtins only — no new runtime deps), vitest, existing test helpers in `tests/helpers.ts`.

**Design provenance:** DESIGN.md rows 93, 94, 98a, 99, 100, 101 (grill #12, 2026-08-06), from the 0.5.1 field report in `know-your-customer-mvp/docs/witness-issues.md`. Rows 95, 96, 97 and 98b–d are deliberately **out of scope** — they change gate outcomes and ship as 0.6.0.

## Global Constraints

- **No new runtime dependencies.** Node builtins and existing deps only.
- User-facing errors use the `Result` / `refuse([v(field, rule, got, want)])` pattern from `src/refusal.ts` — never throw.
- **No commas inside `kv()` values** — toon's `esc()` quotes any value containing one, and skills print these lines verbatim. Use ` · ` as the separator.
- Refusal `want:` text must name a command the user can actually run in the state they are in. That rule is the whole point of this release; a refusal pointing at a verb that will decline is a task failure.
- `next`'s output block must stay contiguous: `next:` / `stage:` / `target:` / `note:` / `home:` / `run:` / `relay:`, nothing interleaved (row 92).
- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`), one commit per task.
- Run a single test file with `npx vitest run tests/<file> --poolOptions.forks.maxForks=4`. **The fork pool IPC-times-out under full concurrency on this machine** — always pass `--poolOptions.forks.maxForks=4`, and redirect long output to a file with `>` rather than piping to `tail`.
- **Before any full-suite run, remove leaked worktrees:** `rm -rf .witness/worktrees` at the repo root. A nested worktree leaks fixtures into a root-level run and produces false failures.
- Full suite: `npx vitest run --poolOptions.forks.maxForks=4 > /tmp/witness-suite.txt 2>&1; tail -40 /tmp/witness-suite.txt`. Baseline before you start: all green.

## File Structure

| File | Responsibility in this release |
| --- | --- |
| `src/cli.ts` (modify) | `status` verb → the dashboard module; usage entry. |
| `src/model.ts` (modify) | `ModelResolution.warningKind` discriminator; `modelFloorLines()` — the one renderer both `status` and `check` use. |
| `src/gate.ts` (modify) | Per-run warning drops the matrix-empty case; `--fresh` refuses on a settled gate; plain `gate` warns on a non-content key move. |
| `src/verbs/dashboard.ts` (modify) | Uses `modelFloorLines()` instead of its own loop. |
| `src/verbs/check.ts` (modify) | Prints `modelFloorLines()` too — the calibration fact reaches both orientation surfaces. |
| `src/verbs/next.ts` (modify) | `flowAction` asks `gateSettled` first; evidence row derives its phase; `authoringOwed` reads the last decision and covers implement. |
| `src/verbs/decide.ts` (modify) | Anchors approve/stop on a revised-but-unchanged run; `--show` uses the last disposition, computes staleness, and points at `witness next`. |
| `src/ship.ts` (modify) | Hands back instead of gating a revise it cannot re-run. |
| `plugin/commands/witness.md`, `README.md` (modify) | Name `witness status`. |
| `DESIGN.md` (modify) | Row 100's third branch — the reachable trigger is an empty diff, not "no test changes". |
| `package.json` + `scripts/sync-versions.mjs` (run) | 0.5.2. |

Dependency order: Task 1 → 2 (independent of the rest) · Task 3 → 4 → 7 (all edit `flowAction`, must be sequential) · Task 5 → 6 (both edit `decide.ts`) · Task 8, 9 independent · Task 10 last.

---

### Task 1: `witness status` names the dashboard

**Files:**
- Modify: `src/cli.ts:19-45` (VERBS map), `src/cli.ts:46-72` (VERB_USAGE)
- Test: `tests/dashboard.test.ts`, `tests/verb-usage.test.ts` (already enforces a usage entry per verb)

**Interfaces:**
- Consumes: nothing.
- Produces: the verb name `status`, used by docs in Task 10 and by the floor lines in Task 2.

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard.test.ts`:

```ts
it('witness status renders the same dashboard as the bare verb', async () => {
  const repo = await seededRepo()
  const bare = await repo.cli([])
  const named = await repo.cli(['status'])
  expect(named.code).toBe(0)
  expect(named.stdout).toBe(bare.stdout)
  expect(named.stdout).toContain('canon:')
})

it('lists status among the verbs so it can be discovered', async () => {
  const repo = await seededRepo()
  const help = await repo.cli(['help'])
  expect(help.stdout).toContain('status')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — `unknown verb: status`, exit code 2.

- [ ] **Step 3: Write minimal implementation**

In `src/cli.ts`, add to the `VERBS` map (alphabetically near `start`):

```ts
  status: () => import('./verbs/dashboard.js'),
```

And to `VERB_USAGE`:

```ts
  status: 'witness status — flows · blocked docs · reconcile rows · pending gates (bare `witness` is the same screen)',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dashboard.test.ts tests/verb-usage.test.ts tests/cli.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/dashboard.test.ts
git commit -m "feat(cli): name the dashboard witness status (D101)"
```

---

### Task 2: the empty-matrix fact is reported once, not per gate run

**Files:**
- Modify: `src/model.ts` (`ModelResolution`, `resolveModel`, new `modelFloorLines`)
- Modify: `src/gate.ts:205-208`, `src/verbs/dashboard.ts:53-69`, `src/verbs/check.ts` (after the `witness:` line)
- Test: `tests/model.test.ts`, `tests/dashboard.test.ts`, `tests/check.test.ts`, `tests/gate-engine.test.ts`

**Interfaces:**
- Consumes: `resolveModel(cfg, matrix, gate)` as it exists today.
- Produces: `ModelResolution.warningKind?: 'matrix-empty' | 'below-floor'` and
  `modelFloorLines(root: string, cfg: Config, harness: HarnessName): string[]` — pre-rendered `kv()` lines, empty array when every gate is calibrated.

- [ ] **Step 1: Write the failing test**

Append to `tests/model.test.ts`:

```ts
it('labels an empty matrix and a below-floor pin differently', () => {
  const cfg = { raw: { gates: { model: 'claude-opus-5' } } } as unknown as Config
  const empty = resolveModel(cfg, { shipped: [], local: [] }, 'implement')
  expect(empty.ok && empty.value.warningKind).toBe('matrix-empty')

  const populated = resolveModel(cfg, { shipped: ['claude-sonnet-5'], local: [] }, 'implement')
  expect(populated.ok && populated.value.warningKind).toBe('below-floor')

  const calibrated = resolveModel(cfg, { shipped: ['claude-opus-5'], local: [] }, 'implement')
  expect(calibrated.ok && calibrated.value.warningKind).toBeUndefined()
})
```

Append to `tests/gate-engine.test.ts` (it already has `gateRepo()`, which returns `{ repo, scenario, ctx }` and gates the target `auth-refresh` through a synthetic `plan` gate, plus the `CLEAN(doc)` verdict fixture):

```ts
it('does not repeat the empty-matrix fact on every gate run', async () => {
  const { repo, scenario } = await gateRepo()
  putVerdict(scenario, CLEAN('auth-refresh'))
  const err: string[] = []
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario), err: (l) => err.push(l) })
  await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })
  expect(err.join('\n')).not.toContain('calibration matrix is empty')
})
```

Append to `tests/check.test.ts`:

```ts
it('check states the empty-matrix fact once', async () => {
  const repo = await seededRepo()
  const res = await repo.cli(['check'])
  expect(res.stdout).toContain('calibration matrix is empty')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/model.test.ts tests/check.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — `warningKind` is undefined on every branch; `check` prints no calibration line.

- [ ] **Step 3: Write the implementation**

In `src/model.ts`, extend the interface and the return:

```ts
export interface ModelResolution {
  chain: string[]
  calibrationOf(id: string): 'shipped' | 'local' | 'none'
  warning?: string
  // Which fact the warning states. `matrix-empty` is a property of this witness
  // BUILD (calibration.yaml ships `models: []`), so it belongs on the orientation
  // surfaces once — repeating it per gate run trained operators to ignore it, and
  // real reviewer variance then had no signal to attach to (D98).
  warningKind?: 'matrix-empty' | 'below-floor'
}
```

and, replacing the `const warning = …` expression:

```ts
  const kind = calibrationOf(head) !== 'none'
    ? undefined
    : matrixEmpty ? 'matrix-empty' as const : 'below-floor' as const
  const warning = kind === undefined
    ? undefined
    : kind === 'matrix-empty'
      ? `calibration matrix is empty — no calibrated model exists yet; ${headLabel} runs uncalibrated`
      : `reviewer model ${headLabel} is below the model floor — no calibration matrix entry covers it`
  return { chain, calibrationOf, ...(warning ? { warning } : {}), ...(kind ? { warningKind: kind } : {}) }
```

Add the shared renderer at the end of `src/model.ts`:

```ts
// One renderer for both orientation surfaces (`status` and `check`). Lives here
// because the grouping rule — one line per distinct warning, labelled with the gates
// it covers — is a property of the resolution, not of either screen.
export function modelFloorLines(root: string, cfg: Config, harness: HarnessName): string[] {
  const matrix = loadMatrix(root, harness)
  const byWarning = new Map<string, string[]>()
  for (const gate of ['decompose', 'plan', 'implement', 'ship', 'design']) {
    const r = resolveModel(cfg, matrix, gate)
    if (r.ok && r.value.warning) byWarning.set(r.value.warning, [...(byWarning.get(r.value.warning) ?? []), gate])
  }
  return [...byWarning].map(([warning, gates]) => `${gates.join(' · ')}: ${warning}`)
}
```

In `src/gate.ts`, line 208 becomes:

```ts
  // matrix-empty is a build fact, reported by `status`/`check`; only the user's own
  // pin being below the floor is news at run time (D98a)
  if (warning && modelR.value.warningKind === 'below-floor') ctx.err(`warning: ${warning}`)
```

and destructure `warning` from `modelR.value` as today.

In `src/verbs/dashboard.ts`, replace lines 56-69 (the harness/matrix/byWarning block) with:

```ts
    const hxR = resolveHarness(ctx.env, cfg.value.raw)
    for (const line of modelFloorLines(root, cfg.value, hxR.ok ? hxR.value.harness.name : 'claude-code')) {
      ctx.out(kv('model-floor', line))
    }
```

In `src/verbs/check.ts`, after the `witness:` version line and inside the existing `if (cfg.ok)` block, add the same two lines. Import `modelFloorLines` from `../model.js` and `resolveHarness` from `../harness.js` in both files (dashboard already imports both).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/model.test.ts tests/dashboard.test.ts tests/check.test.ts tests/gate-engine.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. If an existing dashboard test asserts the old `model-floor` text, the text is unchanged — only its producer moved.

- [ ] **Step 5: Commit**

```bash
git add src/model.ts src/gate.ts src/verbs/dashboard.ts src/verbs/check.ts tests/
git commit -m "fix(model): report the empty matrix once, not on every gate run (D98a)"
```

---

### Task 3: the router reads the verdict before it re-derives anything

**Files:**
- Modify: `src/verbs/next.ts:87-114` (`flowAction`)
- Test: `tests/flows.test.ts`

**Interfaces:**
- Consumes: `gateSettled(entries, gate, currentSha?)` (`next.ts:26`), `worktreeTreeSha(wt)`.
- Produces: `flowAction`'s new branch order — Task 4 replaces the evidence branch's body, Task 7 adds an authoring branch before the gate row.

- [ ] **Step 1: Write the failing test**

Append to `tests/flows.test.ts`:

```ts
// D93: a settled implement gate outranks the evidence hint. Reproduces the 0.5.1
// field report — an approved override that `next` refused to see.
it('routes to ship after a human approve even when the evidence check is red', async () => {
  const { repo, wt, planId } = await shippableRepo()

  // a test file tagged for ANOTHER spec makes evidenceForDiff unsatisfiable: the tag
  // has no red→green pair and `test-evidence` cannot record one for a foreign spec
  writeFileSync(join(wt, 'src', 'foreign.test.ts'),
    "import { expect, it } from 'vitest'\n\nit('foreign @spec:other-spec', () => { expect(1).toBe(1) })\n")

  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: [{ anchor: 'src/token.ts', note: 'read' }], findings: [] })
  const gate = await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'implement', planId, { fresh: false, manual: false })
  expect(gate).toBe(1)                                   // stopped: the evidence check is red

  const decided = await repo.cli(['decide', 'implement', planId, '--approve'])
  expect(decided.code).toBe(0)

  expect(await nextLine(repo)).toContain(`witness ship ${planId}`)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/flows.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — the line is `witness test-evidence <plan> --phase red|green`, because `flowAction` tests `evidenceForDiff(...).satisfied` before it asks whether the gate is settled.

- [ ] **Step 3: Write the implementation**

In `src/verbs/next.ts`, replace the body of `flowAction` from the `baseR` line through the final `return` with:

```ts
  const treeSha = worktreeTreeSha(wt)
  // D93: the gate owns its deterministic checks; the router reads the verdict and
  // never re-derives the predicate. A human `--approve` (override or not) settles
  // implement, and re-deriving `evidence` here is what made a settled approve
  // invisible to the one verb the driving loop calls every turn.
  // Sha-sensitivity is load-bearing: emptying the worktree after an approval moves
  // the sha and re-arms the gate, which is why this call keeps `treeSha` while
  // `gates/ship.ts` deliberately omits it.
  if (gateSettled(entries, 'implement', treeSha)) {
    return { line: `witness ship ${id}`, stage: 'ship', target: id, ...atRoot }
  }
  const baseR = diffBase(wt, cfg)
  const files = baseR.ok ? changedFiles(wt, baseR.value) : []
  const report = baseR.ok && files.length > 0 ? evidenceForDiff(wt, root, plan, baseR.value) : undefined
  if (report === undefined || !report.satisfied) {
    return { line: `witness test-evidence ${id} --phase red|green`, stage: 'implement', target: id, ...inWorktree }
  }
  return {
    line: `witness gate implement ${id}`, target: id, ...inWorktree,
    ...noteOf(lapseNote(entries, 'implement', treeSha)),
  }
```

(The evidence row keeps its placeholder for one task only — Task 4 replaces it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/flows.test.ts tests/next.test.ts tests/dashboard.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. `dashboard.test.ts` is in scope because the flows table renders `flowAction`'s rows.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/next.ts tests/flows.test.ts
git commit -m "fix(next): a settled implement gate outranks the evidence hint (D93)"
```

---

### Task 4: `next` names the phase it wants

**Files:**
- Modify: `src/verbs/next.ts` (the evidence branch from Task 3; add an `evidenceRow` helper above `flowAction`)
- Test: `tests/next.test.ts`

**Interfaces:**
- Consumes: `evidenceForDiff(...)` → `{ required: Array<{ tag, red, green, vacuous }>, satisfied }`, `isTestPath(rel)` from `../evidence.js`.
- Produces: `evidenceRow(id, plan, files, report)` → `NextAction`, used only by `flowAction`.

**Note on the design row:** DESIGN row 100's third branch says "no live red *and no test changes*". That state is unreachable — `evidenceForDiff` is vacuously satisfied when the diff carries no tagged test changes (an empty `required` list passes `.every()`), so an unsatisfied report always implies test changes. The reachable third branch is an **empty diff**. Task 10 corrects the row.

- [ ] **Step 1: Write the failing test**

Append to `tests/next.test.ts`:

```ts
import { cpSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixturePath } from './helpers.js'

// D100: the owed phase is a derivation, not a human choice (row 85's placeholder rule).
async function startedFlow(): Promise<{ repo: TestRepo; wt: string; planId: string }> {
  const repo = await seededRepo()
  writeFileSync(join(repo.root, 'witness.config.yaml'), singleConfig('filtered'))
  repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'runner config')
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  repo.flipStatus('auth-refresh-plan-1', 'approved')
  await repo.cli(['start', 'auth-refresh-plan-1'])
  return { repo, wt: worktreePath(repo.root, 'auth-refresh-plan-1'), planId: 'auth-refresh-plan-1' }
}

it('asks for the red phase by name on an empty worktree', async () => {
  const { repo } = await startedFlow()
  const out = await nextLine(repo)
  expect(out).toContain('--phase red')
  expect(out).not.toContain('red|green')
  expect(out).toContain('nothing changed yet')
})

it('prefers verify-red when the implementation is already written', async () => {
  const { repo, wt } = await startedFlow()
  cpSync(fixturePath('vitest-single'), wt, { recursive: true, filter: (s) => !s.includes('node_modules') })
  writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
  const out = await nextLine(repo)
  expect(out).toContain('witness verify-red auth-refresh-plan-1')
})

it('names the tags whose evidence is owed', async () => {
  const { repo, wt } = await startedFlow()
  cpSync(fixturePath('vitest-single'), wt, { recursive: true, filter: (s) => !s.includes('node_modules') })
  writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
  const out = await nextLine(repo)
  expect(out).toContain('evidence owed: auth-refresh')
})
```

Add `TOKEN_FIXED`, `singleConfig`, `worktreePath`, `writeSpec`, `writePlan`, `approve`, `seededRepo`, `nextLine`, and the `TestRepo` type to the file's existing imports.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/next.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — every assertion sees the literal `--phase red|green` row.

- [ ] **Step 3: Write the implementation**

In `src/verbs/next.ts`, add above `flowAction`:

```ts
// The owed evidence phase is a DERIVATION (row 85: a placeholder is honest only where
// the CLI cannot know the answer). `evidenceForDiff` already computes red/green/vacuous
// per tag on the way to the gate's own check — this reads that report instead of
// printing the menu. `verify-red` is preferred where a plain red probe is guaranteed
// vacuous: the implementation is already written, so the suite passes as it stands.
function evidenceRow(
  id: string, parentTag: string, files: string[], report: EvidenceReport | undefined,
  seat: { home: string; model?: string },
): NextAction {
  const base = { stage: 'implement' as const, target: id, ...seat }
  if (report === undefined) {
    return {
      line: `witness test-evidence ${id} --phase red`, ...base,
      note: 'nothing changed yet — write the failing test first',
    }
  }
  const owed = report.required
    .filter((r) => !(r.red && r.green && !r.vacuous))
    .map((r) => `${r.tag} ${!r.red || r.vacuous ? 'red' : 'green'}`)
    .join(' · ')
  const parent = report.required.find((r) => r.tag === parentTag)
  const liveRed = parent !== undefined && parent.red && !parent.vacuous
  const line = !liveRed && files.some((f) => !isTestPath(f))
    ? `witness verify-red ${id}`
    : `witness test-evidence ${id} --phase ${liveRed ? 'green' : 'red'}`
  return { line, ...base, ...noteOf(owed === '' ? undefined : `evidence owed: ${owed}`) }
}
```

Import `EvidenceReport` and `isTestPath` from `../evidence.js`. Replace the evidence branch from Task 3 with:

```ts
  if (report === undefined || !report.satisfied) {
    return evidenceRow(id, String(plan.meta.parent), files, report, inWorktree)
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/next.test.ts tests/flows.test.ts tests/skills.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. `skills.test.ts` asserts the implement SKILL contains `--phase red`, which is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/next.ts tests/next.test.ts
git commit -m "feat(next): derive the owed evidence phase and name the owed tags (D100)"
```

---

### Task 5: `decide` anchors approve and stop on a revised-but-unchanged run

**Files:**
- Modify: `src/verbs/decide.ts:110-142` (anchor block), hoisting the config/canon loads from 144-161
- Test: `tests/decide.test.ts`

**Interfaces:**
- Consumes: `pendingDecision`, `lastGateRun`, `boundReached` from `../rounds.js`; `spec.currentSha(root, canon, cfg, target)`.
- Produces: no new exports. Task 6 relies on `cfgR`/`canon` being in scope above the `--show` block.

- [ ] **Step 1: Write the failing test**

Append to `tests/decide.test.ts`:

```ts
// D94: revise → (think better of it) → approve, with nothing edited in between.
// Before this, `gate` answered `changed-nothing` and `decide` answered
// `nothing-pending`, each naming the other, and the only escape was a pointless edit.
it('lets a human approve after their own revise when the content has not moved', async () => {
  const { repo } = await stoppedGate()
  const revised = await repo.cli(['decide', 'plan', 'auth-refresh', '--revise', '--note', 'tighten scope'])
  expect(revised.code).toBe(0)

  const approved = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve'])
  expect(approved.code).toBe(0)
  expect(approved.stdout).toContain('auth-refresh → approve')
  expect(decisions(repo).map((d) => d.decision)).toEqual(['revise', 'approve'])
})

it('still refuses when there is no gate-run to anchor on', async () => {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  const res = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve'])
  expect(res.code).toBe(2)
  expect(res.stderr).toContain('nothing-pending')
})
```

`stoppedGate()` and `decisions(repo)` already exist in this file. **Its target is the spec id `auth-refresh` gated through a synthetic `plan` gate** — not a plan id; keep that, and note that `repo.cli(['decide', …])` imports `gates/index.js` and swaps the real plan gate in, which is why the implementation below must tolerate a `currentSha` of `undefined`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/decide.test.ts --poolOptions.forks.maxForks=4`
Expected: the first test FAILS with exit 2 and `gate,nothing-pending`; the second already passes.

- [ ] **Step 3: Write the implementation**

In `src/verbs/decide.ts`, move the `const cfgR = loadConfig(root)` block (currently 144-145, refusal included) and `const canon = loadCanon(root)` (currently 161) to **just above the `if (argv.includes('--show'))` block at line 48** — Task 6 needs both inside `--show`, and one hoist serves both tasks. Two consequences to accept: a malformed config now refuses before `nothing-pending` rather than after, and `--show` refuses on a malformed config instead of rendering. Both are the correct order — a decision verb that cannot read the config cannot honestly report state.

Then replace the anchor block:

```ts
  const atBound = boundReached(entries, gate)

  // at the bound the gate refuses to run again, so no fresh pending decision can
  // ever exist — the endgame decisions must stay reachable anchored to the last
  // run, or the target livelocks (incident c2692b93)
  const boundEndgame = atBound && (decision === 'stop' || (decision === 'approve' && override) ||
    (decision === 'revise' && upstream !== undefined))

  // D94: a revise is the author's INPUT, not a disposition — it leaves the run
  // undisposed. With the content unchanged, `gate` answers `changed-nothing` and
  // appends nothing, so a pending decision can never reappear and the human's own
  // exits all refuse. The verdict still describes current content, so approving it
  // is a true statement about bytes a battery read; the stale-verdict check below
  // is what keeps that honest, and it passes trivially here.
  const afterLast = last
    ? entries.slice(entries.lastIndexOf(last as unknown as Entry) + 1)
        .filter((e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === gate)
        .map((e) => e as unknown as DecisionEntry)
    : []
  const onlyRevises = afterLast.length > 0 &&
    afterLast.every((d) => d.decision === 'revise' || d.decision === 'revise-upstream')
  // `undefined` means the sha CANNOT be computed (no worktree, missing parent), which
  // must never be read as "moved" — the same doctrine the approve-time staleness check
  // states at :167. Approve still refuses separately if the verdict is genuinely stale.
  const now = last !== undefined ? spec.currentSha?.(root, canon, cfgR.value, target) : undefined
  const unchanged = last !== undefined && (now === undefined || now === last.reviewed_sha)
  const revisedAnchor = onlyRevises && unchanged && (decision === 'approve' || decision === 'stop')

  const anchor = pending ?? ((boundEndgame || revisedAnchor) ? last : undefined)
```

Everything below (`if (!anchor)`, the bound refusals, the stale-verdict check) is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/decide.test.ts tests/decide-show.test.ts tests/reopen.test.ts tests/policy-pins.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. If a test asserts refusal ordering (config errors versus `nothing-pending`), the hoisted config load changes which refusal comes first — update that assertion; the hoist is deliberate.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/decide.ts tests/decide.test.ts
git commit -m "fix(decide): anchor approve and stop on a revised run whose content has not moved (D94)"
```

---

### Task 6: `--show` tells the truth about a revised, reopened or settled gate

**Files:**
- Modify: `src/verbs/decide.ts:48-87` (the `--show` block)
- Test: `tests/decide-show.test.ts`

**Interfaces:**
- Consumes: `cfgR` / `canon` in scope from Task 5; `liveExits(gate, target, entries, stale)` from `../gate.js`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `tests/decide-show.test.ts`:

This file builds its streams with `appendEntry` against the **decompose** gate on `repo.effort` (see its existing `reopenedAfterApprove()`), and that idiom carries here. Add one helper and three tests:

```ts
import { loadCanon } from '../src/scan.js'
import { effortReviewedSha } from '../src/reviewed.js'

// A stopped run whose reviewed_sha is the effort's REAL current sha, so the content
// genuinely has not moved — the state where `gate` answers changed-nothing.
async function stoppedOnCurrentContent() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  const s = repo.effort
  const sha = effortReviewedSha(repo.root, loadCanon(repo.root), s).sha
  appendEntry(repo.root, s, {
    v: 1, t: 'gate-run', gate: 'decompose', artifact: s, round: 1, run_id: 'r1',
    reviewed_sha: sha, prompts_sha: 'p', witness: '0', model: 'm', calibration: 'none',
    checks: [], outcome: 'stopped',
    verdicts: [{ reviewer: 'slicing-critic', coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [] }],
  })
  return { repo, effort: s }
}

// D94: after revise → approve the gate is settled; --show must report the LAST
// disposition, not the first one it finds.
it('reports the last disposition, not the first', async () => {
  const { repo, effort } = await stoppedOnCurrentContent()
  appendEntry(repo.root, effort, { v: 1, t: 'human-decision', gate: 'decompose', artifact: effort, round: 1, decision: 'revise', note: 'tighten scope' })
  appendEntry(repo.root, effort, { v: 1, t: 'human-decision', gate: 'decompose', artifact: effort, round: 1, decision: 'approve' })

  const shown = await repo.cli(['decide', 'decompose', effort, '--show'])
  expect(shown.stdout).toContain('state: settled — approve')
  expect(shown.stdout).not.toContain('decision: revise')
})

it('points a settled gate at the verb that knows what comes next', async () => {
  const { repo, effort } = await stoppedOnCurrentContent()
  appendEntry(repo.root, effort, { v: 1, t: 'human-decision', gate: 'decompose', artifact: effort, round: 1, decision: 'approve' })
  const shown = await repo.cli(['decide', 'decompose', effort, '--show'])
  expect(shown.stdout).toContain('help: witness next')
})

// D94: a reopened gate whose content has NOT moved cannot be re-run — `gate` answers
// `changed-nothing` — so advertising the re-gate is the deadlock the row removes.
it('offers decisions, not a re-gate, when a reopen sits on unchanged content', async () => {
  const { repo, effort } = await stoppedOnCurrentContent()
  appendEntry(repo.root, effort, {
    v: 1, t: 'human-decision', gate: 'decompose', artifact: effort, round: 1, decision: 'revise',
    caused_by: { artifact: 'auth-refresh', gate: 'design', round: 1 },
  })
  const shown = await repo.cli(['decide', 'decompose', effort, '--show'])
  expect(shown.stdout).toContain('--approve')
  expect(shown.stdout).toContain('--stop')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/decide-show.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — the first sees `decision: revise` (a settled gate reported as revised), the second has no `help:` line, the third prints only `exits: witness gate plan auth-refresh-plan-1`.

- [ ] **Step 3: Write the implementation**

In `src/verbs/decide.ts`, inside the `--show` block:

```ts
    // The LAST non-caused_by decision is the disposition. `find` returned the first,
    // so revise → approve reported `decision: revise` on a gate that is settled (D94).
    const disposition = decisionsAfter.filter((d) => d.caused_by === undefined).at(-1)
    // Staleness is a fact about content, not about being reopened. Hardcoding `true`
    // here printed `witness gate …` in a state where the gate answers changed-nothing.
    // An uncomputable sha is NOT staleness — same doctrine as the approve-time check.
    const shownSha = spec.currentSha?.(root, canon, cfgR.value, target)
    const stale = shownSha !== undefined && shownSha !== last.reviewed_sha
```

Use `stale` in both `liveExits` call sites (the reopen branch at line 66 and the tail at line 85), and add to the settled branch, after the `last-run` line:

```ts
      ctx.out('help: witness next')
```

`canon` and `cfgR` are already above the `--show` block from Task 5's hoist. If you are executing this task first, do that hoist here instead.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/decide-show.test.ts tests/decide.test.ts tests/reopen.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/decide.ts tests/decide-show.test.ts
git commit -m "fix(decide): --show reports the last disposition and real staleness (D94, D101)"
```

---

### Task 7: `authoringOwed` reads the last decision, and implement routes to authoring

**Files:**
- Modify: `src/verbs/next.ts:48-57` (`authoringOwed`), and `flowAction`'s gate branch
- Test: `tests/next-authoring.test.ts`

**Interfaces:**
- Consumes: `authoringOwed(entries, gate, currentSha)` — same signature.
- Produces: `flowAction` may now return `stage: 'implement'` with a revise note in place of the `gate implement` row.

- [ ] **Step 1: Write the failing test**

Append to `tests/next-authoring.test.ts`:

```ts
// D94: after a revise on the implement gate the owed work is EDITING CODE. Routing to
// `witness gate implement` sends the loop at a command that appends nothing and
// returns the same line next turn — the loop's own no-progress stop then fires.
it('routes a revised implement gate to the worktree, not back to the gate', async () => {
  const { repo, wt, planId } = await shippableRepo()
  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: [{ anchor: 'src/token.ts', note: 'read' }], findings: [] })
  await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'implement', planId, { fresh: false, manual: false })
  await repo.cli(['decide', 'implement', planId, '--revise', '--note', 'extract the helper'])

  const out = await nextLine(repo)
  expect(out).not.toContain(`witness gate implement ${planId}`)
  expect(out).toContain('stage: implement')
  expect(out).toContain('revise owed')
  expect(out).toContain(`home: ${wt}`)
})

it('stops claiming authoring is owed once the human approves instead', async () => {
  const { repo, planId } = await shippableRepo()
  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: [{ anchor: 'src/token.ts', note: 'read' }], findings: [] })
  await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'implement', planId, { fresh: false, manual: false })
  await repo.cli(['decide', 'implement', planId, '--revise', '--note', 'extract the helper'])
  await repo.cli(['decide', 'implement', planId, '--approve'])

  expect(await nextLine(repo)).toContain(`witness ship ${planId}`)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/next-authoring.test.ts --poolOptions.forks.maxForks=4`
Expected: the first FAILS (`witness gate implement …`); the second FAILS too, because `.some()` keeps reporting authoring after the approve.

- [ ] **Step 3: Write the implementation**

In `src/verbs/next.ts`, replace the tail of `authoringOwed`:

```ts
  // The LAST decision is the state. `.some()` kept claiming authoring after a human
  // answered the revise with an approve (D94) — a state read by presence rather than
  // by recency, the same defect class as decide --show's disposition.
  const after = entries.slice(entries.lastIndexOf(last as unknown as Entry) + 1)
    .filter((e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === gate)
    .map((e) => e as unknown as DecisionEntry)
  const recent = after.at(-1)
  return recent !== undefined && ['revise', 'revise-upstream'].includes(recent.decision)
```

and in `flowAction`, replace the final `return` with:

```ts
  if (authoringOwed(entries, 'implement', treeSha)) {
    return {
      line: `witness test-evidence ${id} --phase green`, stage: 'implement', target: id, ...inWorktree,
      note: 'revise owed — edit the code in the worktree · re-run the evidence cycle · then re-gate',
    }
  }
  return {
    line: `witness gate implement ${id}`, target: id, ...inWorktree,
    ...noteOf(lapseNote(entries, 'implement', treeSha)),
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/next-authoring.test.ts tests/next.test.ts tests/flows.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/next.ts tests/next-authoring.test.ts
git commit -m "fix(next): a revised implement gate owes authoring, not a re-gate (D94)"
```

---

### Task 8: `ship` hands back instead of gating a revise it cannot re-run

**Files:**
- Modify: `src/ship.ts:187-205` (the `gate` phase)
- Test: `tests/ship-lanes.test.ts`

**Interfaces:**
- Consumes: `authoringOwed` — **export it** from `src/verbs/next.ts` (it is currently module-private).
- Produces: no new exports from `ship.ts`.

- [ ] **Step 1: Write the failing test**

Append to `tests/ship-lanes.test.ts`:

```ts
// D94, ship side: shipPhase returns 'gate' after a revise, and the gate answers
// changed-nothing on unchanged content — so `witness ship` burned a turn telling the
// human to run the command that just declined.
it('hands back a revised ship gate instead of re-gating unchanged content', async () => {
  const { repo, wt, planId } = await shippableRepo()
  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: [{ anchor: 'src/token.ts', note: 'read' }], findings: [] })
  await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'ship', planId, { fresh: false, manual: false })
  await repo.cli(['decide', 'ship', planId, '--revise', '--note', 'rename the helper'])

  const before = readStream(repo.root, planId).filter((e) => e.t === 'gate-run').length
  const res = await repo.cli(['ship', planId], { env: gateEnv(scenario) })
  expect(res.code).toBe(1)
  expect(res.stdout).toContain('revise owed')
  expect(readStream(repo.root, planId).filter((e) => e.t === 'gate-run').length).toBe(before)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ship-lanes.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — output contains `revise changed nothing` from the gate rather than a hand-back.

- [ ] **Step 3: Write the implementation**

In `src/verbs/next.ts`, add `export` to `function authoringOwed`. In `src/ship.ts`, inside `if (phase === 'gate')`, before the rebase:

```ts
    // D94: the gate cannot judge unchanged content twice — it answers changed-nothing
    // and appends nothing. The owed work is the edit the revise asked for, so say that
    // instead of spending a turn on a command that will decline.
    if (authoringOwed(entries, 'ship', worktreeTreeSha(wt))) {
      ctx.out(kv('ship', `${planId} — revise owed`))
      ctx.out(`help: edit the code in ${wt} · then re-run witness ship ${planId}`)
      return EXIT.FINDINGS
    }
```

Import `authoringOwed` alongside the existing `gateSettled` import from `./verbs/next.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ship-lanes.test.ts tests/ship-pr.test.ts tests/flows.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ship.ts src/verbs/next.ts tests/ship-lanes.test.ts
git commit -m "fix(ship): hand back a revised gate instead of re-running an unchanged battery (D94)"
```

---

### Task 9: no approval is discarded in silence

**Files:**
- Modify: `src/gate.ts:215-233` (the `fresh` / `kind` block)
- Test: `tests/gate-engine.test.ts`

**Interfaces:**
- Consumes: `gateSettled(entries, gate)` — sha-free here on purpose; the question is "was this gate settled before this run", not "does the verdict still describe current content".
- Produces: refusal `gate,settled-approve`; warning text `warning: re-gating discards …`.

- [ ] **Step 1: Write the failing test**

Append to `tests/gate-engine.test.ts`:

Use this file's existing `gateRepo()` / `CLEAN(doc)` and settle the gate with a **passed run** — do *not* reach for `repo.cli(['decide', …])` here: it imports `gates/index.js`, which registers the real `plan` gate over the once-guarded synthetic one and poisons the rest of the file.

```ts
// D99: gateSettled reads only the last run, so any new run un-settles the gate.
// Content moving is self-explaining. A flag is not.
it('refuses --fresh on a settled gate and names the retraction verb', async () => {
  const { repo, scenario, ctx } = await gateRepo()
  putVerdict(scenario, CLEAN('auth-refresh'))
  expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(0)

  const err: string[] = []
  const code = await runGate(fakeCtx(repo.root, { env: gateEnv(scenario), err: (l) => err.push(l) }),
    'plan', 'auth-refresh', { fresh: true, manual: false })
  expect(code).toBe(2)
  expect(err.join('\n')).toContain('settled-approve')
  expect(err.join('\n')).toContain('--revise')
  expect(runs(repo).length).toBe(1)          // nothing appended
})

it('warns when a reviewer-setup change is about to drop a settled approve', async () => {
  const { repo, scenario, ctx } = await gateRepo()
  putVerdict(scenario, CLEAN('auth-refresh'))
  await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })

  // a re-pinned model moves the gate key without moving one byte of content
  repo.write('witness.config.yaml', 'schema: 1\ngates:\n  plan: { model: claude-sonnet-5 }\n')
  repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'repin plan model')

  const err: string[] = []
  await runGate(fakeCtx(repo.root, { env: gateEnv(scenario), err: (l) => err.push(l) }),
    'plan', 'auth-refresh', { fresh: false, manual: false })
  expect(err.join('\n')).toContain('discards the settled approve')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/gate-engine.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — `--fresh` returns 0 or 1 and prints nothing about the approval; the re-pin run prints no warning.

- [ ] **Step 3: Write the implementation**

In `src/gate.ts`, after `const entries = readStream(root, target)` and before `const kind = …`:

```ts
  // D99: `gateSettled` reads only the last run, so any new run un-settles the gate.
  // Content moving is a legitimate, self-explaining reason. A flag is not: --fresh
  // discarded a human decision with nothing printed and nothing journaled, and row 94
  // removed its other job (escaping the changed-nothing deadlock), so it can refuse.
  const settledBefore = gateSettled(entries, spec.gate)
  if (flags.fresh && settledBefore) {
    renderRefusal([v('gate', 'settled-approve', `${spec.gate} ${target} is settled`,
      `witness decide ${spec.gate} ${target} --revise --note "<why>" — retract the approval, then re-gate`)])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
```

and after `const kind = flags.fresh ? … : appendKind(entries, spec.gate, key)`:

```ts
  // A key that moved for a NON-content reason — edited prompt, re-pinned model, new
  // witness version — un-settles just as quietly as --fresh did. Content moving is
  // self-explaining; this is not.
  const lastRun = lastGateRun(entries, spec.gate)
  if (settledBefore && kind.kind === 'fresh' && lastRun && lastRun.reviewed_sha === input.reviewedSha) {
    ctx.err(`warning: reviewer setup changed — this run discards the settled approve on ${spec.gate} ${target}`)
  }
```

Add `gateSettled` to the imports from `./verbs/next.js` and `lastGateRun` to the imports from `./rounds.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/gate-engine.test.ts tests/gate-plan.test.ts tests/gate-implement.test.ts tests/gate-decompose.test.ts tests/gate-design.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. A test that uses `--fresh` on a settled gate as a shortcut must switch to `decide --revise` first — that is the behaviour change.

- [ ] **Step 5: Commit**

```bash
git add src/gate.ts tests/gate-engine.test.ts
git commit -m "fix(gate): refuse --fresh on a settled gate and warn on silent key-move discards (D99)"
```

---

### Task 10: docs, the row-100 correction, and the version bump

**Files:**
- Modify: `plugin/commands/witness.md` (the dashboard sentence), `README.md` (verb list / orientation section), `DESIGN.md` (row 100's third branch)
- Modify: `package.json` (version `0.5.2`), then run `npm run sync-versions`
- Test: `tests/version-sync.test.ts`, `tests/harness-neutrality.test.ts`, `tests/skills.test.ts`

**Interfaces:**
- Consumes: the verb name `status` from Task 1.
- Produces: nothing code-facing.

- [ ] **Step 1: Run the full suite as the pre-docs baseline**

```bash
rm -rf .witness/worktrees
npx vitest run --poolOptions.forks.maxForks=4 > /tmp/witness-suite.txt 2>&1; tail -40 /tmp/witness-suite.txt
```

Expected: all green. Fix any regression before touching docs.

- [ ] **Step 2: Name the dashboard in the prompt and README**

In `plugin/commands/witness.md`, replace the sentence *"If the dashboard warns the reviewer model is uncalibrated, surface the warning"* with:

```markdown
Run `$WITNESS status` (the orientation screen — flows, blocked docs, reconcile rows, pending gates) when you need position rather than the next action. If it reports the reviewer model is uncalibrated, surface that; under `--manual` treat it as a stop.
```

In `README.md`, add `status` to the verb list next to `check`, described as orientation versus validation.

- [ ] **Step 3: Correct DESIGN row 100's third branch**

In row 100's Choice cell, replace *"no live red **and** no test changes → the owed work is writing tests, so a `stage: implement` row rather than a command"* with:

```markdown
an empty diff → `--phase red` with the note `nothing changed yet — write the failing test first`, since an unsatisfied report always implies test changes (`evidenceForDiff` is vacuously satisfied when the diff carries none)
```

Append to the same row's Why cell:

```markdown
 Implementation corrected the third branch: "no live red and no test changes" is unreachable — an empty `required` list passes `.every()`, so an unsatisfied report always implies changed tests. The reachable case is an empty worktree.
```

- [ ] **Step 4: Bump and sync the version**

```bash
npm version 0.5.2 --no-git-tag-version
npm run sync-versions
npx vitest run tests/version-sync.test.ts tests/skills.test.ts tests/harness-neutrality.test.ts --poolOptions.forks.maxForks=4
```

Expected: PASS. `sync-versions` restamps the `npx -y @popovych.co/witness@<v>` pin in the shipped payload; `version-sync.test.ts` is what proves it.

- [ ] **Step 5: Full suite, then commit**

```bash
rm -rf .witness/worktrees
npx vitest run --poolOptions.forks.maxForks=4 > /tmp/witness-suite.txt 2>&1; tail -40 /tmp/witness-suite.txt
git add -A
git commit -m "docs + chore(release): statement-honesty pass (rows 93-101), 0.5.2"
```

Do **not** publish. Publishing needs `--otp` and a cold verification run from outside this repo — a separate, human-driven step.

---

## Out of scope — 0.6.0 (rows 95, 96, 97, 98b–d)

Do not implement these here. They change what passes a gate and what a verdict covers, and they ship on their own branch with a fixture pass:

- **Row 95** — `write` preserves an in-flight plan's status; `flowAction` routes a reopened plan gate; spec-upstream resolves to the effort stream; `flowBlocked` counts a parent-decompose reopen (but **not** the plan's own, which would strand the flow); implement re-arms on plan content excluding `derives-from`.
- **Row 96** — reviewed identity becomes base + diff blob set; state-only base advances stop counting as movement.
- **Row 97** — `evidence` / `regression` check split; foreign tags from whole-file extraction; `filter-matched-nothing` degrades to a check.
- **Row 98b–d** — ship a real calibration matrix; standing stop on a fallback round.
