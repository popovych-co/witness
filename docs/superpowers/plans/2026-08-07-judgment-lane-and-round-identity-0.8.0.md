# witness 0.8.0 — the judgment lane and round identity (DESIGN rows 105, 106, 107) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the 0.8.0 half of grill #13 — the repo declares which harness judges it, a round is identified by the model it asked for, and a round whose reviewers ran on a substituted model stops for the human without spending the human's budget.

**Architecture:** Three DESIGN rows, seven tasks, one branch, and every one of them changes what a gate decides — that is the split line against 0.7.0, which changed install, diagnostics and one block of text. Row 106 gives the gate-run entry a `pin` field and renames `GateKey.model` to `GateKey.pin`, so the model a round is *identified* by (what was asked for, knowable before invoking) stops sharing a name with the model that *answered* (knowable only after); a round whose two differ becomes invisible to every identity decision — cache source, resume, changed-nothing — which is what makes re-gating retry a recovered pin. Row 107 makes such a round carry a standing stop, exempt from the round budget under row 67's principle, and guarded by a second trigger on the existing streak brake so an exempt round cannot repeat forever. Row 105 splits harness resolution by the question being asked: `resolveJudge` walks `harness:` → detection → default for everything that spawns a reviewer or reasons about calibration, `resolveDriver` walks detection → `harness:` → default for the three places that render a launch or relay line, and the name `resolveHarness` is retired so the compiler enumerates the migration.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), vitest. CI is `pnpm run build` then `pnpm exec vitest run` — there is no lint script, and `biome.jsonc` is config-only.

## Global Constraints

- **No per-task commits.** This project's standing preference: implement every task's code and tests, run the verifications, leave the working tree uncommitted, and ask about commit granularity only once the whole plan is green end to end. Every task below ends in a verification step, never a commit step.
- **Base: `main`, after 0.7.0 has merged.** Verify before Task 1: `package.json` reads `"version": "0.7.0"` and `git log --oneline -5` shows the 0.7.0 merge. Then `git switch -c judgment-lane-0.8.0`. Tasks 3 and 4 rewrite a `src/verbs/check.ts` block that 0.7.0's Task 5 restructured and its Task 6 extended — branching off an unmerged 0.7.0 turns every review change there into a conflict here.
- **`DESIGN.md` is uncommitted with rows 102–108 written.** It is the spec this plan implements. Leave it alone during the tasks; a single revision pass at the end applies the corrections this plan's design pass produced (listed under "DESIGN.md revision pass owed" below) and commits with the work.
- **Test command:** `npx vitest run tests/<file> --poolOptions.forks.maxForks=4`. The fork pool IPC-times-out under full concurrency on this machine — `[vitest-worker]: Timeout calling "onTaskUpdate"` is a flake, not a failure. Redirect long output with `>`, never pipe to `tail`.
- **`rm -rf .witness/worktrees` before every full-suite run.** A leaked nested worktree drags fixtures into a root-level run and produces false failures.
- **Measure the baseline before Task 1** — `npx vitest run --poolOptions.forks.maxForks=4 > /tmp/baseline.txt` — and record the file and test counts at the top of your working notes. 0.7.0 added `tests/version-compare.test.ts` and `tests/registry.test.ts`, so the pre-0.7.0 figure of 107 files / 790 tests is stale. No task may reduce the test count without replacing what it removes.
- **No `--harness` flag.** It looks like an obvious convenience and it is refused by row 105 on row 90's grounds: configuration has one home, and re-pointing every subsequent verdict should cost a deliberate edit to a committed key.
- **`recordHarness` stays write-once.** A second `init --agent` installs a payload set; it must never re-point the judge as a side effect.
- **Row 108 is NOT in this plan** — it is text, it rode 0.7.0, and `decide`'s bound-endgame sites are already done. **98b (a populated calibration matrix) is NOT in this plan** — still blocked on `calibrate`'s sampler noise, and it re-points `resolveModel`'s fallback ladder for every user, which would make any regression in rows 106/107 unattributable. **Publishing is NOT in this plan** — the version bump is Task 7; `npm publish --otp` and the cold-verify outside this repo are manual release steps no task can assert green.
- **Accepted residual, state it, do not close it:** row 105 leaves the judge ambient for every *undeclared* repo, which is the default state, since `init` writes `harness:` only under `--agent`. The measured harm — a harness flip spends a round out of three on content nobody edited — survives 0.8.0 for those repos, closed only by the nudge in the judge line and by `next`'s judge-changed note. The alternative (bare `init` writing the driver-resolved harness) is worse: a repo scaffolded from the wrong terminal gets a confidently wrong declaration made permanent by write-once. Do not "finish" this.
- Style: comments explain *why the rule exists and what breaks without it*, in the voice of the surrounding code. Match it — this codebase carries its design rationale inline and a bare mechanical comment reads as a regression. `src/**` uses no semicolons, 2-space indent, single quotes.

---

## File Structure

**Modified:**
- `src/rounds.ts` — `GateRunEntry` gains `pin?`; `GateKey.model` becomes `GateKey.pin`; `keyOf` reads `pin ?? model`; new `fellBack` and `runsSinceReset` exports; `appendKind` excludes a fallen-back round from both branches; `roundsSinceApprove` exempts one.
- `src/gate.ts` — key construction names the pin; the entry writes it; the standing stop gains a fallback element and the stderr fallback warning is retired into it; the streak brake compares pins, guards the budget window, and gains a second trigger.
- `src/harness.ts` — `resolveHarness` retired for `resolveJudge` and `resolveDriver` over one private `rungs` walk; new `judgeLine` renderer.
- `src/verbs/check.ts` — one judge resolution serving the probe, the judge line and the model floor; the duplicate `unknown-harness` finding collapses to one reporter.
- `src/verbs/dashboard.ts` — the judge line, and the model floor computed for the judge.
- `src/verbs/next.ts` — `judgeNote` at all four gate rows; `flowAction` takes the judge; both lanes resolved, each feeding named lines.
- `src/verbs/init.ts` — `DEFAULT_CONFIG` documents `harness:`; the mismatch warning; `resolveDriver` for `--agent auto`.
- `src/install.ts` — `recordHarness` returns the declared value and writes a true trailer.
- `src/drift.ts`, `src/verbs/calibrate.ts`, `src/verbs/dispatch.ts` — call-site reassignment only.
- `README.md` — the `harness:` row in Configuration keys, and the sentence below it.
- `package.json` + every `plugin/**` pin — 0.8.0, via `pnpm run sync-versions`.

**Modified tests:** `tests/rounds.test.ts`, `tests/gate-engine.test.ts`, `tests/harness.test.ts`, `tests/check.test.ts`, `tests/dashboard.test.ts`, `tests/init-agent.test.ts`, `tests/next.test.ts`.

No files are created. Every change lands in a module that already owns the question.

---

### Task 1: A round is identified by the model it asked for

`gate.ts:221` built the verdict-cache key with `model: chain[0]` — the pin, the only model knowable before invoking — while `gate.ts:379` journaled the *answering rung* and `keyOf` read that. For every round that fell back the two disagreed, `sameKey` was permanently false, and `appendKind` returned `fresh` forever. Three things died silently: `resume` never fired, so re-running unchanged content re-invoked the whole battery and spent a round; `changed-nothing` never fired, bypassing row 94's deadlock guard; and the malformed-streak brake never fired, because `gate.ts:268` compared `r.model` against `key.model`.

Making the entry match the key is not an available choice but a circularity — the key decides whether to invoke, and the answering rung is only known after invoking. Two facts need two fields.

The exclusion rule is stronger than row 106 as written, and Q16 of this plan's design pass is why. Row 106 protected `resume` on the grounds that it "re-renders that same entry, standing stop and all". Traced through, that leaves the human trapped: after a fallen-back round, re-gating unchanged content returns `resume` and never retries the pin even once it recovers, and the routed alternative — `decide --revise`, then re-gate — returns `changed-nothing` with `help: edit the artifact (or code) before re-running`, which is row 108's false-sentence defect in a second place, because the artifact was never the problem. `resume` and `changed-nothing` are decisions about *this* run taken from *that* one without invoking anything; that is using a substituted round as evidence for another one, which is exactly what the row's own title forbids. Re-showing the entry is `decide --show`'s job (`decide.ts:57-99` already renders it with its standing stop, staleness check and pins).

**Files:**
- Modify: `src/rounds.ts` (`GateRunEntry` at 8-39, `GateKey` at 54-63, `keyOf` at 70-73, `sameKey` at 75-79, `appendKind` at 162-185)
- Modify: `src/gate.ts` (key construction at 219-223, `let model` at 289, the streak brake's `sameSetup` at 267-269, the entry literal at 375-392)
- Test: `tests/rounds.test.ts`, `tests/gate-engine.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (from `src/rounds.ts`):
  - `GateRunEntry.pin?: string` — the chain head actually requested. Written unconditionally by `gate.ts`; optional for reads only.
  - `GateKey.pin: string` — replaces `GateKey.model`. Required, as `GateKey.model` was.
  - `fellBack(run: GateRunEntry): boolean` — `(run.pin ?? run.model) !== run.model`. False for every journal written before 0.8.0.

- [ ] **Step 1: Write the failing tests**

In `tests/rounds.test.ts`, replace the `KEY` constant and the `run` helper at lines 7-17 with:

```typescript
const MODEL = 'm1'
const KEY = { gate: 'plan', prompts_sha: 'p1', pin: MODEL, witness: '0.1.0', harness: 'claude-code' }

// No `pin` by default: this is the shape of every journal written before 0.8.0, which
// is what the `pin ?? model` migration has to read identically. Fallen-back rounds pass
// `{ pin, model }` explicitly.
function run(sha: string, outcome: 'passed' | 'stopped' | 'malformed', round: number, extra: Partial<GateRunEntry> = {}): GateRunEntry {
  return {
    v: 1, t: 'gate-run', gate: 'plan', artifact: 'auth-refresh-plan-1', round,
    run_id: `r-${round}`, reviewed_sha: sha, prompts_sha: KEY.prompts_sha,
    witness: KEY.witness, model: MODEL, calibration: 'none',
    checks: [], verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [] }],
    outcome, ...extra,
  }
}
```

Update the two existing assertions that name the renamed key component. In `'any key component differing → fresh (edited lens, new model, new version)'`, change `{ ...key('a'), model: 'm2' }` to `{ ...key('a'), pin: 'm2' }`. In `'extracts exactly the six key components'`, change the expected object's `model: 'm1'` to `pin: 'm1'`.

Add `fellBack` to the `../src/rounds.js` import, and append this describe block:

```typescript
describe('pin identifies the round (row 106)', () => {
  // The defect: the key was built from chain[0] (the pin — the only model knowable
  // before invoking) and the entry journaled the answering rung, under one name.
  it('a fallen-back round keys on its pin, not on what answered', () => {
    const fell = run('a', 'stopped', 1, { pin: 'm1', model: 'm2' })
    expect(keyOf(fell).pin).toBe('m1')
    expect(sameKey(keyOf(fell), key('a'))).toBe(true)
  })

  // Exact migration, the same shape row 88 used for `harness ?? 'claude-code'`: a round
  // that did not fall back has pin === model, so every existing journal reads identically.
  it('a legacy entry with no pin keys on its model', () => {
    const legacy = run('a', 'stopped', 1)
    expect(legacy.pin).toBeUndefined()
    expect(keyOf(legacy).pin).toBe('m1')
    expect(fellBack(legacy)).toBe(false)
  })

  it('fellBack is true only when what answered is not what was asked for', () => {
    expect(fellBack(run('a', 'stopped', 1, { pin: 'm1', model: 'm1' }))).toBe(false)
    expect(fellBack(run('a', 'stopped', 1, { pin: 'm1', model: 'm2' }))).toBe(true)
  })

  // A substituted round is not evidence for another one — and `resume` is a decision
  // about THIS run taken from THAT one without invoking anything. Excluding it is what
  // makes a re-gate retry the pin: a recovered pin yields a real verdict on the spot.
  it('a fallen-back last round is not a resume source — the re-gate retries the pin', () => {
    const entries = [run('a', 'stopped', 1, { pin: 'm1', model: 'm2' })]
    expect(appendKind(entries, 'plan', key('a')).kind).toBe('fresh')
  })

  // The same exclusion at the same branch, revise side: `changed-nothing` would tell the
  // human to edit an artifact that was never the problem — row 108's defect, relocated.
  it('a fallen-back last round is not a changed-nothing source either', () => {
    const entries = [run('a', 'stopped', 1, { pin: 'm1', model: 'm2' }), revise(1)]
    expect(appendKind(entries, 'plan', key('a')).kind).toBe('fresh')
  })

  // Second reason for the same exclusion: with `pin` in the key, a fallen-back round and
  // a clean one over the same content share a key, so edit-then-revert would replay an
  // unpinned verdict into a passing run.
  it('an earlier fallen-back round never serves the cache', () => {
    const entries = [
      run('a', 'stopped', 1, { pin: 'm1', model: 'm2' }), revise(1),
      run('b', 'stopped', 2), revise(2),
    ]
    expect(appendKind(entries, 'plan', key('a')).kind).toBe('fresh')
  })

  // A clean earlier round IS still a cache source when the last round fell back — the
  // exclusion is about the substituted entry, not about everything behind it.
  it('a clean earlier round still serves the cache past a fallen-back last round', () => {
    const entries = [
      run('a', 'stopped', 1), revise(1),
      run('b', 'stopped', 2, { pin: 'm1', model: 'm2' }), revise(2),
    ]
    const k = appendKind(entries, 'plan', key('a'))
    expect(k.kind).toBe('cached')
    if (k.kind === 'cached') expect(k.from.reviewed_sha).toBe('a')
  })
})
```

In `tests/gate-engine.test.ts`, extend `'walks the model fallback chain on invocation failure and records it'` with two assertions after the existing ones:

```typescript
    // Row 106: the entry records BOTH — what was asked for and what answered.
    expect(entry!.pin).toBe('test-model-1')
    expect(entry!.model).toBe('test-model-2')
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/rounds.test.ts tests/gate-engine.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — `fellBack` is not exported, `GateKey.pin` does not exist, the `pin` assertions read `undefined`, and the exclusion cases return `resume`/`changed-nothing`/`cached`.

- [ ] **Step 3: Add `pin` to the entry and rename the key component**

In `src/rounds.ts`, add the field to `GateRunEntry` immediately after `model: string`:

```typescript
  model: string
  // Row 106: the chain head actually REQUESTED. The verdict-cache key is built before
  // anything is invoked, when only this is knowable; `model` is written afterwards, when
  // the answering rung is. Those were one field, so every fallen-back round keyed against
  // a model the key could not contain — permanently `fresh`, which killed resume,
  // changed-nothing and the malformed-streak brake at once. Optional for READS only:
  // every journal written before 0.8.0 lacks it and `pin ?? model` is exact for them,
  // since a round that did not fall back has pin === model. gate.ts writes it always.
  pin?: string
```

Replace `GateKey`'s `model` member:

```typescript
  prompts_sha: string
  // Named for what it is. A key can only ever hold the model that was ASKED for — it is
  // constructed before invoking — and calling it `model` is what let the streak brake
  // compare it against the answering rung for three releases without anyone noticing.
  pin: string
```

Replace `keyOf` and `sameKey`:

```typescript
export function keyOf(run: GateRunEntry): GateKey {
  const { reviewed_sha, gate, prompts_sha, witness } = run
  return {
    reviewed_sha, gate, prompts_sha, witness,
    pin: run.pin ?? run.model,
    harness: run.harness ?? 'claude-code',
  }
}

export function sameKey(a: GateKey, b: GateKey): boolean {
  return a.reviewed_sha === b.reviewed_sha && a.gate === b.gate &&
    a.prompts_sha === b.prompts_sha && a.pin === b.pin && a.witness === b.witness &&
    a.harness === b.harness
}
```

Add `fellBack` directly below `sameKey`:

```typescript
// Rows 106 and 107: did this round's reviewers run on something other than what was
// pinned? One definition for three consumers — the cache/resume exclusion below, the
// budget exemption in roundsSinceApprove, and gate.ts's streak brake — because the
// inline form inverts silently, and a flipped exemption is a budget that never spends.
// False for every pre-0.8.0 entry by construction.
export function fellBack(run: GateRunEntry): boolean {
  return (run.pin ?? run.model) !== run.model
}
```

- [ ] **Step 4: Exclude a substituted round from both identity branches**

Replace `appendKind` (`src/rounds.ts:162-185`) with:

```typescript
export function appendKind(entries: Entry[], gate: string, key: GateKey): AppendKind {
  let lastRunIdx = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRun(entries[i], gate)) { lastRunIdx = i; break }
  }
  if (lastRunIdx >= 0) {
    const last = entries[lastRunIdx] as unknown as GateRunEntry
    // Row 106: a substituted round is not evidence for another one, and `resume` and
    // `changed-nothing` are both decisions about THIS run taken from THAT one without
    // invoking anything. Excluding it is what makes a re-gate retry the pin — a
    // recovered pin yields a real verdict immediately, a dead one falls back again and
    // row 107's fallback-streak brake stops it with the remedy that is actually true.
    // Keeping it here traps the human exactly as row 107's own trap does: `resume`
    // never retries, and `changed-nothing` says `edit the artifact` about an artifact
    // that was never the problem. Re-SHOWING the entry is `decide --show`'s job.
    if (!fellBack(last) && sameKey(keyOf(last), key)) {
      const revised = entries.slice(lastRunIdx + 1).some((e) =>
        isDecision(e, gate) &&
        ['revise', 'revise-upstream'].includes((e as unknown as DecisionEntry).decision))
      return revised ? { kind: 'changed-nothing', entry: last } : { kind: 'resume', entry: last }
    }
  }
  for (let i = lastRunIdx - 1; i >= 0; i--) {
    const e = entries[i]
    if (!isRun(e, gate)) continue
    const run = e as unknown as GateRunEntry
    // The same exclusion, second reason: with `pin` in the key a fallen-back round and a
    // clean one over the same content share a key, so edit-then-revert would replay an
    // unpinned verdict into a passing run. Beside the malformed filter, which is here
    // for the identical reason — a round witness could not complete is not evidence.
    if (run.outcome !== 'malformed' && !fellBack(run) && run.verdicts && sameKey(keyOf(run), key)) {
      return { kind: 'cached', from: run }
    }
  }
  return { kind: 'fresh' }
}
```

- [ ] **Step 5: Name the pin at the gate's key construction and write it on the entry**

In `src/gate.ts`, replace the key construction at 219-223:

```typescript
  // Row 106: the key is built BEFORE invoking, so the only model knowable here is the one
  // being asked for. Naming it `pin` is what stops the entry's `model` — what actually
  // answered — from being compared against it by accident, which is how the streak brake
  // below spent three releases never firing.
  const pin = chain[0]!
  const key: GateKey = {
    reviewed_sha: input.reviewedSha, gate: spec.gate,
    prompts_sha: promptsSha(lenses, pinsText === '' ? undefined : pinsText), pin, witness: version(),
    harness: harness.name,
  }
```

At line 289, `let model = chain[0]!` becomes `let model = pin`.

In the streak brake at 267-269, replace `sameSetup`:

```typescript
    // Row 106: "same setup" always meant the same PIN. Comparing the answering rung meant
    // two malformed fallen-back rounds never matched — the one thing this brake exists
    // to stop. (Its window is corrected in Task 2.)
    const sameSetup = (r: GateRunEntry) =>
      r.outcome === 'malformed' && (r.pin ?? r.model) === key.pin &&
      r.prompts_sha === key.prompts_sha && (r.harness ?? 'claude-code') === key.harness
```

In the entry literal at 375-392, add `pin` beside `model` — unconditionally, not as a conditional spread like `fallback` and `rerolled`, because presence must not become a second meaning:

```typescript
      witness: key.witness, model, pin, harness: harness.name, calibration: calibrationOf(model),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/rounds.test.ts tests/gate-engine.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 7: Run the neighbours that read the journal and the key**

Run: `npx vitest run tests/dead-fields.test.ts tests/decide.test.ts tests/decide-show.test.ts tests/gate-plan.test.ts tests/gate-implement.test.ts tests/gate-decompose.test.ts tests/gate-design.test.ts tests/journal.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

`tests/dead-fields.test.ts` is the one that will bite. It requires every field declared on a `*Entry` interface to be read outside `rounds.ts`/`journal.ts`, matching `/[.\['"\`]pin\b/`. `gate.ts`'s entry literal writes `pin: chain[0]` — preceded by whitespace, so it does not match — and the reader that satisfies it is `(r.pin ?? r.model)` in the brake you just rewrote. **If this test fails, the brake is wrong, not the test.** Do not add `pin` to `WRITE_ONLY`: the field genuinely is read, and suppressing it would hide the exact defect row 106 exists to fix.

- [ ] **Step 8: Typecheck**

Run: `pnpm run typecheck`
Expected: no output, exit 0.

---

### Task 2: A fallback is witness's failure, not the artifact's

Row 98 said a fallen-back round cannot pass on its own and left its **cost** unstated, so it spent one of three. Followed through with a persistently broken pin that is a trap: the rounds reach the bound, the human diagnoses the real problem and fixes `gates.<gate>.model` — **and the gate still refuses**, because `gate.ts:256` short-circuits on `boundReached` before invoking anything and `lastResetIndex` resets only on approve, revise-upstream or a passed run, none of which a config fix is. Fixing the root cause does not restore the ability to obtain a real verdict; the only way forward is to override on evidence the CLI has just said not to trust.

Row 67's exemption is stated as a principle, not a special case — *the battery failed to emit a legal verdict; witness's failure, not the artifact's; it never spends the human's budget* — and a fallback is that same failure one level up: witness could not deliver the judgment the human configured, and the artifact was never the problem in either case.

The exemption and the brake are one change, not two. An exempt round that can repeat forever is D67's livelock, which is why row 67 added the malformed brake in the same breath. A commit landing the exemption without the trigger leaves a repo with a dead pin running batteries forever; a commit landing the trigger without the standing stop lets an unpinned verdict pass. Neither half is independently shippable, which is why this is one task.

Q17 of this plan's design pass found a third thing that must land here. `gate.ts:266` takes `gateRuns(entries, gate).slice(-2)` — the last two runs in the whole stream, with no reference to what the human did between them. Row 107 specifies a plain `--approve` as the dismissal for a fallen-back round, so: two fallen-back rounds, human approves, flow moves on, gate re-arms when content moves (D75), human re-gates — and the tail is *still* those two rounds, so the brake refuses a legitimate run over rounds already disposed of. The same latent defect exists today for the malformed trigger and is near-unreachable only because approving a malformed round is a strange thing to do. The window is the budget window: the brakes exist because budget-exempt rounds could otherwise repeat for free, so they guard exactly the span the budget covers.

**Files:**
- Modify: `src/rounds.ts` (`roundsSinceApprove` at 109-119; new `runsSinceReset`)
- Modify: `src/gate.ts` (the fallback warning at 339-341, the `standing` composition at 344-347, the streak brake at 263-277)
- Test: `tests/rounds.test.ts`, `tests/gate-engine.test.ts`, `tests/decide.test.ts`

**Interfaces:**
- Consumes: `fellBack`, `GateKey.pin` from Task 1.
- Produces (from `src/rounds.ts`):
  - `runsSinceReset(entries: Entry[], gate: string): GateRunEntry[]` — the gate-runs after the last reset (approve, revise-upstream, or a passed run). `roundsSinceApprove` is now derived from it.

- [ ] **Step 1: Write the failing tests**

In `tests/rounds.test.ts`, add `runsSinceReset` to the `../src/rounds.js` import and append:

```typescript
describe('a fallback does not spend the budget (row 107)', () => {
  const fell = (sha: string, round: number) => run(sha, 'stopped', round, { pin: 'm1', model: 'm2' })

  // Row 67's principle, applied a second time: witness could not deliver the judgment
  // the human configured, and the artifact was never the problem.
  it('fallen-back rounds do not count toward the bound', () => {
    const entries = [run('a', 'stopped', 1), fell('b', 2), run('c', 'stopped', 2)]
    expect(roundsSinceApprove(entries, 'plan')).toBe(2)
    expect(boundReached(entries, 'plan')).toBe(false)
    expect(boundReached([...entries, run('d', 'stopped', 3)], 'plan')).toBe(true)
  })

  // Row 105 deliberately did NOT join them: exempting a harness-only difference would
  // let a repo flip judges indefinitely and never reach the bound. Pinned beside its
  // sibling so nobody assumes the two exemptions behave alike.
  it('a harness flip still spends its round', () => {
    const entries = [
      run('a', 'stopped', 1),
      run('a', 'stopped', 2, { harness: 'pi' }),
      run('a', 'stopped', 3),
    ]
    expect(roundsSinceApprove(entries, 'plan')).toBe(3)
    expect(boundReached(entries, 'plan')).toBe(true)
  })

  // Q17: the brakes guard the budget window, because that is what they exist to protect.
  // Runs on the far side of an approve were disposed of and can trip nothing.
  it('runsSinceReset stops at the last approve', () => {
    const entries = [fell('a', 1), fell('b', 2), approve(2), run('c', 'stopped', 1)]
    expect(runsSinceReset(entries, 'plan').map((r) => r.reviewed_sha)).toEqual(['c'])
    expect(runsSinceReset(entries.slice(0, 2), 'plan').map((r) => r.reviewed_sha)).toEqual(['a', 'b'])
  })

  // A plain revise is not a reset: the row's own scenario is revise → re-gate → fall
  // back again → brake, and that has to keep working.
  it('a plain revise does not close the window', () => {
    const entries = [fell('a', 1), revise(1), fell('b', 2)]
    expect(runsSinceReset(entries, 'plan').length).toBe(2)
  })
})
```

In `tests/gate-engine.test.ts`, the existing `'walks the model fallback chain on invocation failure and records it'` changes outcome — a fallen-back round now stops. Replace its two outcome-bearing lines and add the standing assertions:

```typescript
    // Row 107: a fallen-back round carries a standing stop, so it cannot pass on its own.
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(1)
    const [entry] = runs(repo)
    expect(entry!.fallback).toEqual(['test-model-1'])
    expect(entry!.model).toBe('test-model-2')
    expect(entry!.pin).toBe('test-model-1')
    expect(entry!.calibration).toBe('local')
    expect(entry!.outcome).toBe('stopped')
    expect(entry!.standing).toContain('fallback — reviewers ran on test-model-2, not the pinned test-model-1')
    // The stderr warning is retired INTO the standing stop: it fired on the same
    // condition, unjournaled and non-blocking, and one fact printed twice is the shape
    // this release removes.
    expect(errs.join('\n')).not.toContain('failed to invoke')
```

and append two integration cases to the same describe block.

**Read this before writing them.** `fixtures/fakebin/claude` treats `claude-fail` as a call *number*, not a flag: it records every call and then fails calls `1..N`. The synthetic gate has one lens, so round 1 is `call-1` (the pin, fails) then `call-2` (the fallback rung, answers); round 2 is `call-3` then `call-4`. Bumping the file to `3` between rounds fails the pin again without touching the rung that answers. Writing `1` once and expecting both rounds to fall back is the mistake this note exists to prevent.

No content edit is needed between the rounds, and that is Task 1's doing: a fallen-back last round is not a resume source, so a plain re-gate retries the pin and journals a second round. That is the behaviour these tests exist to prove.

```typescript
  // The terminating story row 107 argues for: two batteries, then a refusal naming the
  // pin — never a bound, because the rounds are exempt.
  it('two consecutive fallen-back rounds brake before spending a third battery', async () => {
    const { repo, scenario } = await gateRepo()
    writeFileSync(join(repo.root, 'witness.config.yaml'), 'schema: 1\ngates:\n  model: test-model-1\n')
    writeFileSync(join(repo.root, '.witness/calibration.local.yaml'), 'models:\n  - test-model-2\n')
    putVerdict(scenario, CLEAN('auth-refresh'))
    const errs: string[] = []
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario), err: (l: string) => errs.push(l) })

    writeFileSync(join(scenario, 'claude-fail'), '1')     // fails call-1, the pin
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(1)
    writeFileSync(join(scenario, 'claude-fail'), '3')     // fails call-3, the pin again
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(1)
    expect(runs(repo).length).toBe(2)

    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(2)
    expect(errs.join('\n')).toContain('fallback-streak')
    expect(errs.join('\n')).toContain('the pinned model is not answering')
    expect(runs(repo).length).toBe(2)                     // refused before the battery
    // Exempt throughout: the bound was never in play, which is what makes the remedy
    // in the next test reachable at all.
    expect(roundsSinceApprove(readStream(repo.root, 'auth-refresh'), 'plan')).toBe(0)
  })

  // The point of the exemption. Under row 98 as written, three fallbacks reached the
  // bound and a config fix could not reopen it — gate.ts:256 short-circuits on
  // boundReached and lastResetIndex ignores config — so override on distrusted evidence
  // was the only exit. Here the pin moves, key.pin moves with it, samePin goes false,
  // and the battery runs.
  it('fixing the pin clears the brake and the battery runs', async () => {
    const { repo, scenario } = await gateRepo()
    writeFileSync(join(repo.root, 'witness.config.yaml'), 'schema: 1\ngates:\n  model: test-model-1\n')
    writeFileSync(join(repo.root, '.witness/calibration.local.yaml'), 'models:\n  - test-model-2\n')
    putVerdict(scenario, CLEAN('auth-refresh'))
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    writeFileSync(join(scenario, 'claude-fail'), '1')
    await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })
    writeFileSync(join(scenario, 'claude-fail'), '3')
    await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })

    writeFileSync(join(repo.root, 'witness.config.yaml'), 'schema: 1\ngates:\n  model: test-model-2\n')
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(0)
    const last = runs(repo).at(-1)!
    expect(last.pin).toBe('test-model-2')
    expect(last.model).toBe('test-model-2')
    expect(last.outcome).toBe('passed')
  })
```

Add `roundsSinceApprove` to that file's `../src/rounds.js` import.

Finally, row 107 specifies the *dismissal* — a plain `--approve`, because `--override` is reserved for the bound and this is a first-round event — and that needs the verb, not the engine. In `tests/decide.test.ts`, add a helper beside `stoppedGate` and two cases:

```typescript
// A genuine fallen-back round: pinned model dead, calibrated rung answers. One round, so
// `claude-fail: 1` is exactly right — call-1 is the pin and call-2 is the rung.
async function fallenBackGate() {
  synthetic()
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  repo.write('witness.config.yaml', 'schema: 1\ngates:\n  model: test-model-1\n')
  repo.write('.witness/calibration.local.yaml', 'models:\n  - test-model-2\n')
  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [] })
  writeFileSync(join(scenario, 'claude-fail'), '1')
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
  await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })
  return { repo, scenario }
}

// Row 107: the round cannot pass on its own, and dismissing it costs a plain --approve.
// --override is reserved for the bound, and the exemption means the bound is not reached.
it('a plain --approve dismisses a fallen-back round', async () => {
  const { repo } = await fallenBackGate()
  const last = readStream(repo.root, 'auth-refresh')
    .filter((e) => e.t === 'gate-run').at(-1) as unknown as GateRunEntry
  expect(last.outcome).toBe('stopped')
  expect(last.standing).toContain('fallback — reviewers ran on test-model-2, not the pinned test-model-1')
  const res = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve'])
  expect(res.code).toBe(0)
  expect(decisions(repo).at(-1)?.decision).toBe('approve')
  expect(decisions(repo).at(-1)?.override).toBeUndefined()
})

// Re-shown, never re-used. `decide --show` is the surface whose job is showing, which is
// what lets appendKind exclude a substituted round from `resume` without losing anything.
it('decide --show renders a fallen-back round with its standing stop', async () => {
  const { repo } = await fallenBackGate()
  const res = await repo.cli(['decide', 'plan', 'auth-refresh', '--show'])
  expect(res.code).toBe(0)
  expect(res.stdout).toContain('standing-stop: fallback — reviewers ran on test-model-2')
})
```

Add `writeFileSync` from `node:fs`, `join` from `node:path`, `gateEnv`/`fakeScenario`/`fakeCtx`/`putVerdict` from `./helpers.js`, and `GateRunEntry` to the `../src/rounds.js` type import, if any are absent.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/rounds.test.ts tests/gate-engine.test.ts tests/decide.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — `runsSinceReset` is not exported, the fallen-back round still passes with no standing, the stderr warning still fires, and there is no `fallback-streak` rule.

- [ ] **Step 3: Derive the budget from one window**

In `src/rounds.ts`, replace `roundsSinceApprove` (109-119) with a pair:

```typescript
// The window the round budget spans, and therefore the window the streak brakes guard:
// an approve, a revise-upstream or a passed run settles everything before it, so runs on
// the far side of one can neither spend budget nor trip a brake. gate.ts took the last two
// runs in the WHOLE stream, so an approved pair of fallen-back rounds — the dismissal row
// 107 specifies — refused the next legitimate run over rounds already disposed of.
export function runsSinceReset(entries: Entry[], gate: string): GateRunEntry[] {
  return gateRuns(entries.slice(lastResetIndex(entries, gate) + 1), gate)
}

export function roundsSinceApprove(entries: Entry[], gate: string): number {
  // Row 67's principle, stated once and applied twice: the battery failed to deliver the
  // judgment the human configured — witness's failure, not the artifact's — so it never
  // spends the human's budget. `malformed` is a verdict witness could not parse; a
  // fallback is a model witness could not reach. Row 105 deliberately does NOT join them:
  // a harness flip still spends its round, or a repo could flip judges forever and never
  // reach the bound.
  return runsSinceReset(entries, gate)
    .filter((r) => r.outcome !== 'malformed' && !fellBack(r)).length
}
```

- [ ] **Step 4: Retire the warning into the standing stop**

In `src/gate.ts`, delete the block at 339-341 entirely:

```typescript
  if (fallback.length > 0 && chain[0] !== SESSION_DEFAULT && fallback.includes(chain[0]!)) {
    ctx.err(`warning: head model ${chain[0]} failed to invoke — reviewers ran on ${model}; check gates.${spec.gate}.model`)
  }
```

`fallback` is pushed in rung order starting at rung 0, so a non-empty `fallback` always contains `chain[0]`, and a head of `SESSION_DEFAULT` implies a chain of length one whose invocation failure returns `EXIT.REFUSED` at `gate.ts:309` before any entry exists. The condition and `model !== pin` are one condition; the surface being retired is the weaker one.

Add the third element to the `standing` composition:

```typescript
  const standing = [
    input.standingStop,
    pinConflicts > 0 ? 'contradicts-pin — a finding disputes a settled policy pin; the human decides which one dies' : undefined,
    // Row 98c, specified by row 107. Composed HERE, after the battery, because whether a
    // fallback happened is not knowable at resolve() time. Dismissed by a plain
    // --approve: --override is reserved for the bound and this is a first-round event.
    // The remedy is deliberately absent — on round one the honest statement is that a
    // human decides whether the verdict counts; the remedy becomes true only once the pin
    // proves persistently dead, which is what fallback-streak below prints.
    model !== pin
      ? `fallback — reviewers ran on ${model}, not the pinned ${pin}; the human decides whether that verdict counts`
      : undefined,
  ].filter((s): s is string => s !== undefined).join(' · ') || undefined
```

`SESSION_DEFAULT` is now unused in `gate.ts` outside line 307 — leave that import and use alone.

- [ ] **Step 5: One brake, two triggers, the budget window**

Replace the whole `if (!flags.fresh)` block at 263-277:

```typescript
  if (!flags.fresh) {
    // Both brakes guard the SAME window as the round budget (rounds.ts): exempt rounds
    // could otherwise repeat for free, and a run on the far side of an approve was
    // disposed of and can trip nothing.
    const tail = runsSinceReset(entries, spec.gate).slice(-2)
    const samePin = (r: GateRunEntry) =>
      (r.pin ?? r.model) === key.pin && (r.harness ?? 'claude-code') === key.harness
    // Row 107. A fallen-back round does not spend the budget, and an exempt round that
    // repeats forever is D67's livelock — the exemption and this trigger are one change.
    // `prompts_sha` is deliberately NOT compared: a lens edit has nothing to do with
    // whether a model answers, and comparing it would let an unrelated edit reset a brake
    // on a dead pin. Checked first because when both hold, "the pinned model is not
    // answering" is the true remedy and "your battery emits invalid verdicts" is not.
    // No --fresh in the want: --fresh bypasses the brake and would spend a battery
    // re-invoking the same dead pin. Fixing the pin moves key.pin, samePin goes false,
    // and the battery runs — which is only reachable BECAUSE these rounds were exempt.
    if (tail.length === 2 && tail.every((r) => fellBack(r) && samePin(r))) {
      renderRefusal([v(`gates.${spec.gate}.model`, 'fallback-streak',
        `${tail.length} consecutive rounds fell back from ${key.pin}`,
        'a reachable gates.<gate>.model — the pinned model is not answering')])
        .forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
    // malformed rounds don't spend the bound either — this brake is what stops an
    // unreliable battery from re-running for free forever instead. Row 106: "same setup"
    // always meant the same PIN, and comparing the answering rung meant two malformed
    // fallen-back rounds never matched, which is the one thing this exists to stop.
    const sameSetup = (r: GateRunEntry) =>
      r.outcome === 'malformed' && samePin(r) && r.prompts_sha === key.prompts_sha
    if (tail.length === 2 && tail.every(sameSetup)) {
      renderRefusal([v('reviewers', 'malformed-streak',
        `${tail.length} consecutive malformed rounds on ${tail[1]!.model}`,
        `a changed gates.${spec.gate}.model pin or updated prompts — the battery is emitting invalid verdicts (or force with --fresh)`,
      )]).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
  }
```

Add `fellBack` and `runsSinceReset` to `gate.ts`'s `./rounds.js` import.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/rounds.test.ts tests/gate-engine.test.ts tests/decide.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 7: Run every gate and decision neighbour**

Run: `npx vitest run tests/gate-plan.test.ts tests/gate-implement.test.ts tests/gate-decompose.test.ts tests/gate-design.test.ts tests/gate-lock.test.ts tests/gate-lens-override.test.ts tests/decide-show.test.ts tests/reopen.test.ts tests/flows.test.ts tests/protocol/pipeline.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. Any failure here is a real interaction, not a stale assertion — the standing stop changes an outcome from `passed` to `stopped`, and a fixture that relied on a fallback passing was relying on row 98c being unimplemented.

- [ ] **Step 8: Typecheck**

Run: `pnpm run typecheck`
Expected: no output, exit 0.

---

### Task 3: The repo declares its judge; the session declares its driver

A repo declaring `harness: pi`, gated from a Claude Code session, spawns `claude -p` reviewers and reads a different calibration matrix, and nothing refuses. Row 88 forbade this for *fallback* on the grounds that it swaps reviewer identity mid-pipeline; the harm does not depend on the mechanism, and ambient detection produces it exactly. The calibration matrix cannot be a session fact under any reading — `loadMatrix(root, harness)` is keyed by harness and `calibrate` writes `matrices.<name>.models` into the repo's overlay — so the same repo would stop, or not stop, depending on which terminal was open.

The split is by *question*, not by ladder. A single resolver with a lane argument re-asks "which ladder am I on" at every call site, lets a wrong argument pass review invisibly, and gives a new call site the wrong answer by default — which is precisely how `check` came to audit its caller rather than its repo (row 104). Retiring the name `resolveHarness` makes the compiler enumerate the migration instead of leaving it to a reviewer's attention.

**Files:**
- Modify: `src/harness.ts` (`resolveHarness` at 214-233)
- Modify: `src/gate.ts:203`, `src/drift.ts:125`, `src/verbs/calibrate.ts:75`, `src/verbs/check.ts:207` and `:267`, `src/verbs/dashboard.ts:55` — judgment lane
- Modify: `src/verbs/next.ts:507`, `src/verbs/dispatch.ts:84`, `src/verbs/init.ts:90` — session lane
- Test: `tests/harness.test.ts`

**Interfaces:**
- Consumes: `HarnessSource`, `loadHarness`, `DEFAULT_HARNESS` — all already in `src/harness.ts`.
- Produces (from `src/harness.ts`):
  - `resolveJudge(env, raw): Result<{ harness: Harness; source: HarnessSource }>` — `harness:` → detection → default.
  - `resolveDriver(env, raw): Result<{ harness: Harness; source: HarnessSource }>` — detection → `harness:` → default. Byte-identical behaviour to the retired `resolveHarness`.
  - `resolveHarness` no longer exists.

- [ ] **Step 1: Write the failing tests**

In `tests/harness.test.ts`, change the `../src/harness.js` import to bring in `resolveDriver` and `resolveJudge` instead of `resolveHarness`, then rename the existing describe block and its body:

```typescript
describe('the session lane — resolveDriver, detection first', () => {
```

and inside it, replace every `resolveHarness(` with `resolveDriver(`. All six existing cases keep their assertions unchanged: the driver ladder is exactly today's ladder, and a test that has to change is a test that caught a regression.

Append the judgment lane's own block:

```typescript
describe('the judgment lane — resolveJudge, declaration first', () => {
  // Row 105. A repo declaring `harness: pi`, gated from a Claude Code session, spawned
  // claude reviewers and read a different calibration matrix, and nothing refused. A
  // committed key binds every teammate's gates, on the same argument that puts
  // gates.model in committed config: the evidence trail is comparable across machines.
  it('a declaration outranks the ambient session', () => {
    const r = resolveJudge({ CLAUDECODE: '1' }, { harness: 'pi' })
    expect(r.ok && r.value.harness.name).toBe('pi')
    expect(r.ok && r.value.source).toBe('config')
  })

  // The residual, stated so it is not mistaken for a bug: an UNDECLARED repo is still
  // judged by whatever terminal is open. Declaration is what the row makes able to win;
  // it does not make declaration mandatory, and `init` writes the key only under --agent.
  it('falls to detection, then to claude-code, when nothing is declared', () => {
    const detected = resolveJudge({ PI_CODING_AGENT: 'true' }, {})
    expect(detected.ok && detected.value.harness.name).toBe('pi')
    expect(detected.ok && detected.value.source).toBe('detected')
    const def = resolveJudge({}, {})
    expect(def.ok && def.value.harness.name).toBe('claude-code')
    expect(def.ok && def.value.source).toBe('default')
  })

  // The two lanes disagree on exactly one input, and that is the whole release.
  it('the two lanes answer differently on a declared repo in a foreign session', () => {
    const env = { CLAUDECODE: '1' }
    const raw = { harness: 'pi' }
    expect(resolveJudge(env, raw).ok && resolveJudge(env, raw).value.harness.name).toBe('pi')
    expect(resolveDriver(env, raw).ok && resolveDriver(env, raw).value.harness.name).toBe('claude-code')
  })

  // The typo is no longer invisible to judgment: the config rung is rung ONE here, so it
  // refuses rather than being skipped. `check` reports it as a finding either way.
  it('refuses an unreadable declaration even when a detection rung could have answered', () => {
    const r = resolveJudge({ CLAUDECODE: '1' }, { harness: 'nope' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations[0]).toMatchObject({ field: 'harness', rule: 'unknown-harness' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/harness.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — neither `resolveDriver` nor `resolveJudge` exists.

- [ ] **Step 3: Split the ladder**

In `src/harness.ts`, replace `resolveHarness` (lines 203-233, comment included) with:

```typescript
// Decision 5, split by Decision 105. TWO questions share three rungs, and the NAME of the
// function is which question you asked — not an argument, because a lane parameter
// re-asks it at every call site, lets a wrong value pass review invisibly, and gives a
// new call site the wrong answer by default. That is exactly how `check` came to audit
// its caller instead of its repo (row 104). `resolveHarness` is deliberately GONE: the
// rename is what made the compiler enumerate all nine call sites at once.
//
// Deliberately NOT wired into loadConfig: every verb calls that, so an invalid `harness:`
// there would brick `witness check` on a key nothing read. Verbs that need a harness ask
// for one; `check` reports a malformed config value as a finding.
//
// Row 90 removed the WITNESS_HARNESS env rung: configuration has one home, and tests
// simulate harnesses by setting the detection vars production actually reads.
interface Rung { source: HarnessSource; name: string }

// Detection tests PRESENCE: neither CLAUDECODE=1 nor PI_CODING_AGENT=true is a documented
// value contract.
function detectedRung(env: Record<string, string | undefined>): Rung | undefined {
  if (env.PI_CODING_AGENT !== undefined) return { source: 'detected', name: 'pi' }
  if (env.CLAUDECODE !== undefined) return { source: 'detected', name: 'claude-code' }
  return undefined
}

function declaredRung(raw: Record<string, unknown>): Rung | undefined {
  const configured = raw.harness
  return configured === undefined ? undefined : { source: 'config', name: String(configured) }
}

function walk(ladder: Array<Rung | undefined>): Result<{ harness: Harness; source: HarnessSource }> {
  const rung = ladder.find((r): r is Rung => r !== undefined)
    ?? { source: 'default' as const, name: DEFAULT_HARNESS }
  const r = loadHarness(rung.name)
  return r.ok ? ok({ harness: r.value, source: rung.source }) : refuse(r.violations)
}

// THE JUDGE — which harness runs this repo's gate reviewers, reads its calibration matrix
// and is probed for runnability. A committed declaration wins, because reviewer identity
// is a property of the repo's evidence trail and must be comparable across machines; row
// 88 already said an identity chosen by ambient environment is the opposite of a pin.
export function resolveJudge(
  env: Record<string, string | undefined>, raw: Record<string, unknown>,
): Result<{ harness: Harness; source: HarnessSource }> {
  return walk([declaredRung(raw), detectedRung(env)])
}

// THE DRIVER — which CLI is about to be typed at. Detection wins, because a launch or
// relay line is a fact about the session that will run it, and a config-authority default
// in a fresh repo emits a runnable-LOOKING, unrunnable handoff behind a warning that gets
// scrolled past — bug B2's exact shape.
export function resolveDriver(
  env: Record<string, string | undefined>, raw: Record<string, unknown>,
): Result<{ harness: Harness; source: HarnessSource }> {
  return walk([detectedRung(env), declaredRung(raw)])
}
```

- [ ] **Step 4: Assign every call site**

`pnpm run typecheck` now fails at nine places. Assign each — six judgment, three session — changing the import and the call:

| File | Line | Lane | Why |
|---|---|---|---|
| `src/gate.ts` | 203 | `resolveJudge` | spawns the reviewer battery |
| `src/drift.ts` | 125 | `resolveJudge` | the deep lane is a reviewer lane |
| `src/verbs/calibrate.ts` | 75 | `resolveJudge` | measures the (harness, model) pair the battery will use, and writes `matrices.<name>` |
| `src/verbs/check.ts` | 207 | `resolveJudge` | the CLI probe asks whether this machine can run *this repo's* reviewers |
| `src/verbs/check.ts` | 267 | `resolveJudge` | the model floor is a fact about the judge's calibration matrix |
| `src/verbs/dashboard.ts` | 55 | `resolveJudge` | same `modelFloorLines` renderer as `check` — one fact, one ladder, or `status` and `check` disagree about the same repo |
| `src/verbs/next.ts` | 507 | `resolveDriver` | renders `run:` and `relay:` |
| `src/verbs/dispatch.ts` | 84 | `resolveDriver` | renders `relay:` |
| `src/verbs/init.ts` | 90 | `resolveDriver` | `--agent auto` means "the harness I am sitting in" |

`src/verbs/check.ts` gets one resolution serving all three of its uses in Task 4 — for now, rename both call sites in place and leave the duplication.

Add this comment at `src/verbs/dashboard.ts:55`, because the assignment contradicts DESIGN row 105's call-site list as originally written and a reader will otherwise "fix" it back:

```typescript
    // Row 105's judgment lane, not its session lane: this feeds modelFloorLines, the one
    // renderer shared with `check`, and a floor computed on a different ladder from the
    // judge line above it would have `status` and `check` disagreeing about which
    // reviewers the same repo spawns. `status` renders no handoff, so it has no driver.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/harness.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 6: Run every call site's suite**

Run: `npx vitest run tests/gate-engine.test.ts tests/drift.test.ts tests/drift-flag.test.ts tests/calibrate.test.ts tests/check.test.ts tests/dashboard.test.ts tests/next.test.ts tests/dispatch-relay.test.ts tests/init-agent.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. Every one of these seeds from `seededRepo`, which runs `witness init` with no `--agent` and therefore writes no `harness:` key, so the judgment ladder falls straight through to detection and every existing assertion holds. The one exception is `tests/check.test.ts`'s `'reports an unreadable harness: even when detection answered'`, which now produces two `unknown-harness` rows — leave it failing or double-reporting; Task 4 collapses it.

- [ ] **Step 7: Typecheck**

Run: `pnpm run typecheck`
Expected: no output, exit 0. A remaining `resolveHarness` reference means a call site was missed.

---

### Task 4: The judge, printed with its provenance, on both orientation surfaces

Row 105 makes `harness:` a committed key that binds every teammate's gates, so it stops being invisible. `check` and `status` both print the judge and how it was resolved, on the `modelFloorLines` precedent of rendering one fact at both surfaces — and the provenance is what makes the residual actionable, because an undeclared repo's judge still flips with the terminal and the nudge is the only remedy for that.

The line is stated, never a finding: it touches neither the findings table nor `check`'s exit code, which is a contract about canon validity (row 101). It prints unconditionally, including when declared, because `judge: pi (declared in witness.config.yaml)` read from a Claude Code session is exactly the fact the release exists to surface, and a line that appears only in the bad state teaches people to read its absence as "nothing to know" — the confident silence row 104 spent a release killing.

`check` also stops reporting a bad `harness:` twice. `resolveJudge` can fail on exactly one input — the detection rungs load literals and the last rung loads `DEFAULT_HARNESS`, so only an unreadable declaration refuses — and the explicit validation above it catches that totally, with the better message, because it names the expected set.

**Files:**
- Modify: `src/harness.ts` (add `judgeLine` below `resolveDriver`)
- Modify: `src/verbs/check.ts` (the config-validation comment at 198-200, the harness block at 207-218, the model-floor block at 266-271)
- Modify: `src/verbs/dashboard.ts` (52-62)
- Test: `tests/check.test.ts`, `tests/dashboard.test.ts`

**Interfaces:**
- Consumes: `resolveJudge`, `HarnessSource`, `DEFAULT_HARNESS` from Task 3.
- Produces (from `src/harness.ts`):
  - `judgeLine(r: Result<{ harness: Harness; source: HarnessSource }>): string` — the rendered provenance, without the `judge: ` prefix. Provenance is rendered, never stored.

- [ ] **Step 1: Write the failing tests**

In `tests/check.test.ts`, append to the harness describe block:

```typescript
  // Row 105: the judge is a repo fact and it prints unconditionally, declared or not.
  it('names the declared judge and where it was declared', async () => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', `${repo.read('witness.config.yaml')}harness: pi\n`)
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'declare the judge')
    const res = await repo.cli(['check'], { env: { CLAUDECODE: '1' } })
    expect(res.stdout).toContain('judge: pi (declared in witness.config.yaml)')
  })

  // The residual made actionable: an undeclared repo is still judged by the ambient
  // session, and the nudge is the only thing that closes it.
  it('names the nudge when nothing is declared', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['check'], { env: { CLAUDECODE: '1' } })
    expect(res.stdout).toContain('judge: claude-code (detected — undeclared; set harness: in witness.config.yaml to pin it)')
  })

  // The probe follows the judge, which is the behaviour change: it asks whether this
  // machine can run THIS REPO's reviewers, not the caller's.
  it('probes the declared judge, not the session harness', async () => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', `${repo.read('witness.config.yaml')}harness: pi\n`)
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'declare the judge')
    const res = await repo.cli(['check'], { env: { PATH: '/nonexistent', CLAUDECODE: '1' } })
    expect(res.stdout).toContain('pi,missing')
    expect(res.stdout).not.toContain('claude,missing')
  })
```

and replace `'reports an unreadable harness: even when detection answered'` — same scenario, corrected claim:

```typescript
  // The config rung is rung ONE of the judgment ladder now, so `resolveJudge` refuses on
  // this input too. The explicit validation above is the single reporter, because it names
  // the expected set where a violation-derived row renders only `got` — one question, one
  // answer, which is this release's whole theme.
  it('reports an unreadable harness: exactly once', async () => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', `${repo.read('witness.config.yaml')}harness: pikachu\n`)
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'bad harness')
    const res = await repo.cli(['check'], { env: { CLAUDECODE: '1' } })
    expect(res.code).toBe(1)
    expect(res.stdout.match(/unknown-harness/g)?.length).toBe(1)
    expect(res.stdout).toContain('judge: claude-code (default — harness: pikachu is unreadable; witness check reports it)')
  })
```

In `tests/dashboard.test.ts`, append:

```typescript
  // One fact, one wording, both orientation surfaces — modelFloorLines' own precedent,
  // which row 105 cites by name.
  it('prints the judge with its provenance, as check does', async () => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', `${repo.read('witness.config.yaml')}harness: pi\n`)
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'declare the judge')
    const status = await repo.cli(['status'], { env: { CLAUDECODE: '1' } })
    const check = await repo.cli(['check'], { env: { CLAUDECODE: '1' } })
    expect(status.stdout).toContain('judge: pi (declared in witness.config.yaml)')
    expect(check.stdout).toContain('judge: pi (declared in witness.config.yaml)')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/check.test.ts tests/dashboard.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — no `judge:` line anywhere, the probe still follows the session, and `unknown-harness` appears twice.

- [ ] **Step 3: Add the shared renderer**

In `src/harness.ts`, below `resolveDriver`:

```typescript
// One renderer for both orientation surfaces, on modelFloorLines' precedent: the judge
// must read identically on `check` and `status`, or the two screens disagree about which
// binary judges the same repo. Provenance is RENDERED here, never stored — HarnessSource
// stays a resolution fact and the wording stays a presentation one.
//
// It prints in every state, including `declared`: that line read from a foreign session
// is exactly what row 105 exists to surface, and a line that appeared only in the bad
// state would teach people to read its absence as "nothing to know" — the confident
// silence row 104 spent a release killing. The nudge is not decoration: an UNDECLARED
// repo's judge still flips with the terminal, and declaring is the only thing that ends it.
export function judgeLine(r: Result<{ harness: Harness; source: HarnessSource }>): string {
  if (!r.ok) {
    // A diagnostic surface must not brick on a broken key — `check` reports it as a
    // finding and the floor falls back — so say what was fallen back TO, and to what.
    return `${DEFAULT_HARNESS} (default — harness: ${r.violations[0]?.got ?? '?'} is unreadable; witness check reports it)`
  }
  const nudge = 'undeclared; set harness: in witness.config.yaml to pin it'
  if (r.value.source === 'config') return `${r.value.harness.name} (declared in witness.config.yaml)`
  return `${r.value.harness.name} (${r.value.source} — ${nudge})`
}
```

- [ ] **Step 4: One resolution in `check`, serving three uses**

In `src/verbs/check.ts`, change the harness import to `import { HARNESSES, judgeLine, loadHarness, resolveJudge, resolveSkills } from '../harness.js'`.

Replace the comment at 198-200 — it is now false as written:

```typescript
  // `harness:` is rung ONE of the judgment ladder (which binary judges this repo) and
  // rung TWO of the session ladder (which CLI is about to be typed at), so a typo brings
  // judgment down everywhere while still being invisible to launch lines on a machine
  // with a detection var. check is the diagnostic verb: it reports the value regardless
  // of who answered, and it is the ONLY reporter — resolveJudge can fail on exactly this
  // input, so pushing its violations too would say one thing twice.
```

Replace the resolution-and-probe block at 207-218 with:

```typescript
  const judgeR = resolveJudge(ctx.env, cfg.ok ? cfg.value.raw : {})
  if (judgeR.ok) {
    // Row 104/105: the probe asks whether THIS MACHINE can run THIS REPO's reviewers, so
    // it follows the judge — which is why it kept a harness resolution when row 104 took
    // one away from the audit. An unresolvable judge has no binary to probe.
    const launch = judgeR.value.harness.launch
    if (!probe(launch, ['--version'], ctx.env)) {
      findings.push(f('warn', 'probes', launch, 'missing',
        `the ${launch} CLI runs this harness's gate reviewers — install and authenticate it`))
    }
  }
```

Replace the model-floor block at 266-271 with one that reuses `judgeR` and prints the judge above it:

```typescript
  // Judge first, then the floor computed FOR that judge: read top to bottom, the second
  // line is a consequence of the first, and the pair answers "which reviewers will this
  // repo spawn, and are they calibrated". Stated lines, never findings — neither touches
  // the findings table nor the exit code, which is a contract about canon validity (101).
  ctx.out(kv('judge', judgeLine(judgeR)))
  if (cfg.ok) {
    for (const line of modelFloorLines(root, cfg.value, judgeR.ok ? judgeR.value.harness.name : DEFAULT_HARNESS)) {
      ctx.out(kv('model-floor', line))
    }
  }
```

Add `DEFAULT_HARNESS` to the `../harness.js` import.

- [ ] **Step 5: The same pair on `status`**

In `src/verbs/dashboard.ts`, replace the block at 52-62:

```typescript
  if (cfg.ok) {
    // Row 105's judgment lane, not its session lane: this feeds modelFloorLines, the one
    // renderer shared with `check`, and a floor computed on a different ladder from the
    // judge line above it would have `status` and `check` disagreeing about which
    // reviewers the same repo spawns. `status` renders no handoff, so it has no driver.
    // A broken harness config must not brick the dashboard — `check` reports that as a
    // finding, so both lines degrade to claude-code and say so.
    const judgeR = resolveJudge(ctx.env, cfg.value.raw)
    ctx.out(kv('judge', judgeLine(judgeR)))
    // One line per distinct warning, labelled with the gates it applies to — per-gate
    // model pins can put each gate in a different calibration state. Shared with `check`
    // (D98a): the calibration fact must read the same on both surfaces.
    for (const line of modelFloorLines(root, cfg.value, judgeR.ok ? judgeR.value.harness.name : DEFAULT_HARNESS)) {
      ctx.out(kv('model-floor', line))
    }
  }
```

Change its harness import to `import { DEFAULT_HARNESS, judgeLine, resolveJudge } from '../harness.js'`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/check.test.ts tests/dashboard.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 7: Run the surfaces that read these screens**

Run: `npx vitest run tests/regression-check.test.ts tests/cli.test.ts tests/verb-usage.test.ts tests/hooks-dashboard.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. A failure here means something asserted on whole-screen output rather than a row; fix the assertion to name the row it cares about, do not remove the judge line.

- [ ] **Step 8: Typecheck**

Run: `pnpm run typecheck`
Expected: no output, exit 0.

---

### Task 5: The key stops being invisible — scaffold, trailer, and the mismatch

`recordHarness` is already write-once, and it must stay so: a second `init --agent` installs a payload set and must not re-point the judge as a side effect. What it cannot do today is *say* anything, because `{ text, changed }` makes "unchanged because it already says this" and "unchanged because it says something else" the same answer.

Refusing the mismatch is off the table on the codebase's own terms — a repo carrying both payload sets is a state row 104's audit exists to report honestly, and `--agent` is the documented way a Claude Code repo gains Pi support. The confusing case is `--agent auto`, which resolves on the *session* ladder: run from a Claude Code session in a repo declaring `harness: pi`, it installs claude-code's payload while pi keeps judging, and nothing the user typed mentioned judgment.

**Files:**
- Modify: `src/install.ts` (`recordHarness` at 126-134)
- Modify: `src/verbs/init.ts` (`DEFAULT_CONFIG` at 18-39, the `recordHarness` call at 147-151)
- Test: `tests/init-agent.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (from `src/install.ts`):
  - `recordHarness(configText, name): { text: string; changed: boolean; declared?: string }` — `declared` is the value already present in the file, whether or not it matches `name`.

- [ ] **Step 1: Write the failing tests**

In `tests/init-agent.test.ts`, append:

```typescript
  // Write-once, and now audible. Installing a second payload set is legitimate — it is
  // how a claude-code repo gains pi support — but `--agent pi` reads as "make this repo
  // pi", and the judge does not move. Say so once, on stderr, and install anyway.
  it('warns when the installed agent is not the declared judge, and installs anyway', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const res = await repo.cli(['init', '--agent', 'claude-code'])
    expect(res.code).toBe(0)
    expect(repo.read('witness.config.yaml')).toContain('harness: pi')
    expect(res.stderr).toContain('this repo declares harness: pi')
    expect(res.stderr).toContain('claude-code\'s payload is installed, but pi still judges')
    expect(repo.read('.claude/commands/witness.md')).toContain('# /witness — the engine')
  })

  it('stays quiet when the installed agent is the declared judge', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.stderr).not.toContain('still judges')
  })

  // The scaffold documents the key without declaring it. A commented line must not read
  // as a declaration — `recordHarness` anchors on /^harness:/m for exactly this reason,
  // and relaxing that regex would silently turn documentation into a permanent, write-once
  // declaration on every repo.
  it('the documented harness: line is not a declaration', async () => {
    const repo = tmpRepo()
    await repo.cli(['init'])
    expect(repo.read('witness.config.yaml')).toContain('# harness: pi')
    const check = await repo.cli(['check'])
    expect(check.stdout).toContain('undeclared')
    await repo.cli(['init', '--agent', 'pi'])
    expect(repo.read('witness.config.yaml')).toContain('\nharness: pi')
  })

  // Row 105: the auto-written trailer said something that is now false.
  it('the written trailer names the judge, not a fallback', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const cfg = repo.read('witness.config.yaml')
    expect(cfg).not.toContain('detection wins')
    expect(cfg).toContain('# the judge — which harness runs this repo\'s gate reviewers; declared wins')
  })
```

Add `tmpRepo` to the `./helpers.js` import if absent.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/init-agent.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — no warning, the old trailer, no commented scaffold line.

- [ ] **Step 3: Widen `recordHarness`**

In `src/install.ts`, replace `recordHarness` (126-134):

```typescript
// The config rung of Decision 5's ladder, and rung ONE of Decision 105's judgment ladder.
// Recorded once, on the run that installs the first payload set; a later `--agent` for a
// second harness leaves it alone, because installing a payload set is not being asked to
// re-point every subsequent verdict. `declared` is what lets the caller SAY so when the
// two disagree — `{changed: false}` alone cannot tell "already says this" from "says
// something else", which is why the mismatch was silent.
//
// The anchor matters: a commented `# harness: pi` in the scaffold must NOT read as a
// declaration. Relaxing this to /harness:/ would turn documentation into a permanent,
// write-once declaration on every repo that ran `witness init`.
export function recordHarness(configText: string, name: string): { text: string; changed: boolean; declared?: string } {
  const found = /^harness:\s*(\S+)/m.exec(configText)
  if (found) return { text: configText, changed: false, declared: found[1] }
  const suffix = configText.endsWith('\n') ? '' : '\n'
  return {
    text: `${configText}${suffix}harness: ${name}   # the judge — which harness runs this repo's gate reviewers; declared wins\n`,
    changed: true,
  }
}
```

- [ ] **Step 4: Document the key and say the mismatch**

In `src/verbs/init.ts`, add the commented key to `DEFAULT_CONFIG` immediately above `gates:` — commented, because a bare `init` cannot know which harness will judge this repo, and a guess made permanent by write-once is worse than an honest "undeclared":

```
# harness: pi               # the judge — which harness runs this repo's gate reviewers;
                            # declared beats the ambient session (init --agent writes it once)
```

Replace the `recordHarness` call at 147-151:

```typescript
      const recorded = recordHarness(readFileSync(configPath(root), 'utf8'), harness.name)
      if (recorded.changed) {
        writeFileSync(configPath(root), recorded.text)
        if (!files.includes('witness.config.yaml')) files.push('witness.config.yaml')
      } else if (recorded.declared !== undefined && recorded.declared !== harness.name) {
        // Not a refusal: a repo carrying both payload sets is legitimate (row 104), and
        // --agent is how a claude-code repo gains pi support. But `--agent pi` reads as
        // "make this repo pi" and the judge does not move — and `--agent auto` produces
        // this state from a command that never mentioned judgment at all.
        ctx.err(`warning: this repo declares harness: ${recorded.declared} — ${harness.name}'s payload is installed, but ${recorded.declared} still judges; edit harness: in witness.config.yaml to re-point the judge`)
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/init-agent.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 6: Run the scaffold's neighbours**

Run: `npx vitest run tests/init.test.ts tests/config.test.ts tests/check.test.ts tests/paths.test.ts tests/pi-extension.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. `tests/config.test.ts` parses `harness: pi` directly and is unaffected; `tests/init.test.ts` may assert on `DEFAULT_CONFIG`'s shape and should gain the new line rather than lose it.

- [ ] **Step 7: Typecheck**

Run: `pnpm run typecheck`
Expected: no output, exit 0.

---

### Task 6: A judge that changes mid-flow is named, and still spends its round

`appendKind` keys on harness (`rounds.ts:78`), so a cross-harness run is `fresh` and re-invokes the whole battery on unchanged content — while `roundsSinceApprove` counts every non-malformed run since the last reset with no reference to the key. Each harness flip therefore spends a round out of three on content nobody edited.

Row 105 refuses to exempt it: a harness-only key difference exempted from the round count would let a repo flip judges indefinitely and never reach the bound. So the round is spent by design, and the CLI says why — at every gate row `next` emits, because the mechanism is gate-independent and "we only told you at implement" is not a rule anyone could state.

The note degrades silently when the judge is unresolvable. A note is an explanation attached to a row; it has no business deciding whether the row prints, and `next`'s driver resolution already refuses that config with the accurate message. This is `lapseNote`'s own doctrine, where an uncomputable sha must never render as "moved".

**Files:**
- Modify: `src/verbs/next.ts` (`lapseNote` region at 69-83; `flowAction` at 132-194; the four gate rows at 188, 411, 431, 468; `computeNext` at 290)
- Modify: `src/verbs/dashboard.ts` (the `flowAction` call in the flows table)
- Test: `tests/next.test.ts`

**Interfaces:**
- Consumes: `resolveJudge` from Task 3; `lastGateRun`, `ROUND_BOUND` from `src/rounds.js`.
- Produces (in `src/verbs/next.ts`):
  - `judgeNote(entries: Entry[], gate: string, judge: string | undefined): string | undefined`
  - `flowAction(root, cfg, plan, judge?: string)` — one added optional parameter. Both callers pass it.

- [ ] **Step 1: Write the failing tests**

In `tests/next.test.ts`, append:

```typescript
  // Row 105: the flip is not exempted — it spends a round out of three on content nobody
  // edited — so the CLI names it. `shippableRepo` gates under the stripped env, so its
  // journal records claude-code; resolving the judge to pi is what fires this.
  it('names a judge that changed since the last round', async () => {
    const { repo } = await shippableRepo()
    const out = await nextLine(repo, { env: { PI_CODING_AGENT: 'true' } })
    expect(out).toContain('judge changed — round')
    expect(out).toContain('claude-code')
    expect(out).toContain('pi judges now')
  })

  it('says nothing when the judge is the one that ran the last round', async () => {
    const { repo } = await shippableRepo()
    const out = await nextLine(repo, { env: { CLAUDECODE: '1' } })
    expect(out).not.toContain('judge changed')
  })

  // A note explains a row; it never decides whether the row prints. The driver refusal
  // below already covers this config with the accurate message.
  it('an unresolvable judge costs the note, not the verb', async () => {
    const { repo } = await shippableRepo()
    repo.write('witness.config.yaml', `${repo.read('witness.config.yaml')}harness: pikachu\n`)
    const r = await repo.cli(['next'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown-harness')
    expect(r.stdout).not.toContain('judge changed')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/next.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — no note is ever emitted.

- [ ] **Step 3: Add `judgeNote`**

In `src/verbs/next.ts`, directly below `lapseNote`:

```typescript
// Row 105. `appendKind` keys on harness, so a cross-harness run is `fresh` and re-invokes
// the whole battery — while roundsSinceApprove counts every non-malformed run with no
// reference to the key, so each flip spends a round out of ROUND_BOUND on content nobody
// edited. The row refuses to exempt it (a repo could then flip judges forever and never
// reach the bound), so the cost is real and the CLI says why before it is paid.
//
// `undefined` judge means the declaration is unreadable: no note, never a refusal. A note
// explains a row; it does not decide whether the row prints — the same doctrine lapseNote
// applies to an uncomputable sha.
function judgeNote(entries: Entry[], gate: string, judge: string | undefined): string | undefined {
  if (judge === undefined) return undefined
  const last = lastGateRun(entries, gate)
  // `?? 'claude-code'` for the reason keyOf uses it: every pre-88 entry lacks the field,
  // and claude-code is the only harness that could have written one.
  if (!last || (last.harness ?? 'claude-code') === judge) return undefined
  return `judge changed — round ${last.round} ran on ${last.harness ?? 'claude-code'}, ${judge} judges now — the next round re-invokes the whole battery and spends one of ${ROUND_BOUND}`
}
```

Add `lastGateRun` and `ROUND_BOUND` to the `../rounds.js` import if absent.

- [ ] **Step 4: Thread the judge to all four gate rows**

`flowAction` does not take `ctx`, so it cannot resolve the judge itself. Give it the answer:

```typescript
export function flowAction(root: string, cfg: Config, plan: CanonDoc, judge?: string): NextAction | undefined {
```

and at its implement gate row (line 188), compose the note beside the lapse note:

```typescript
  return {
    line: `witness gate implement ${id}`, target: id, ...inWorktree,
    ...noteOf(lapseNote(entries, 'implement', diffSha), judgeNote(entries, 'implement', judge)),
  }
```

In `computeNext`, resolve once at the top, immediately after the canon guard:

```typescript
  // `next` is the one verb that legitimately holds BOTH lanes, and each feeds named
  // lines: the DRIVER resolved at the print site renders `run:`/`relay:` (the session
  // about to be typed at), and the JUDGE here feeds the judge-changed note (which binary
  // will spend the round). A reader who has internalised "one lane per verb" will
  // otherwise read this as a mistake.
  const judgeR = resolveJudge(ctx.env, cfg.raw)
  const judge = judgeR.ok ? judgeR.value.harness.name : undefined
```

Then compose it at the remaining three rows:

```typescript
        : { line: `witness gate decompose --effort ${e.slug}`, target: e.slug,
            ...noteOf(judgeNote(e.entries, 'decompose', judge)) }
```

```typescript
    return designUnseen(root, cfg.paths, id) !== undefined
      ? { line: `witness design ${id} --open`, stage: 'design', target: id }
      : { line: `witness gate design ${id}`, target: id,
          ...noteOf(judgeNote(readStream(root, id), 'design', judge)) }
```

```typescript
    if (!authoringOwed(entries, 'plan', planSha)) {
      return { line: `witness gate plan ${id}`, target: id, ...noteOf(judgeNote(entries, 'plan', judge)) }
    }
```

Pass `judge` at `computeNext`'s `flowAction` call, and add `resolveJudge` to the `../harness.js` import beside `resolveDriver`.

- [ ] **Step 5: Keep the dashboard's derivation identical**

`flowAction`'s comment states that `--flow` and the dashboard must answer with the SAME derivation, never a re-derived shorthand — so `dashboard` passes its judge too, even though its flows table has no note column and nothing changes on screen. Diverging the arguments is how the shorthand creeps back in.

In `src/verbs/dashboard.ts`, the flows table already sits below the `judgeR` you added in Task 4, so:

```typescript
        const action = flowAction(root, cfg.value, d, judgeR.ok ? judgeR.value.harness.name : undefined)
```

Hoist `judgeR` out of the `if (cfg.ok)` block if the flows table cannot see it — declare it before, guarded, rather than resolving twice.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/next.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 7: Run the routing neighbours**

Run: `npx vitest run tests/next-authoring.test.ts tests/flows.test.ts tests/dashboard.test.ts tests/reopen.test.ts tests/reslice.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `pnpm run typecheck`
Expected: no output, exit 0.

---

### Task 7: Documentation and the version bump

`harness:` stops being a fallback rung nobody needed to know about and becomes a committed key that binds every teammate's gates, so the README row describing it is now false in both directions — it names one ladder where there are two, and calls the key a fallback where it is the declaration.

**Files:**
- Modify: `README.md` (the `harness:` row at 104; the sentence at 107-108)
- Modify: `package.json` (`version`)
- Modify: `plugin/**` (via `pnpm run sync-versions`)
- Test: `tests/version-sync.test.ts` (existing, no edit)

**Interfaces:** none.

- [ ] **Step 1: Correct the configuration table**

In `README.md`, replace the `harness:` row:

```markdown
| `harness: claude-code \| pi` | **the judge** — which harness runs this repo's gate reviewers, is measured by `calibrate`, and is probed by `check`. Judgment resolves `harness:` → `PI_CODING_AGENT` → `CLAUDECODE` → `claude-code`; session lines (`next`'s handoff, `dispatch`'s relay, `init --agent auto`) resolve detection first, because those name the CLI you are about to type at. Committed, so it binds every teammate's gates; `witness init --agent` writes it once and never re-points it. Undeclared repos are judged by whichever agent's session is open — `witness check` and `witness status` say so |
```

and the sentence below it, which names the wrong resolution:

```markdown
There is no `provider:` key. `witness gate` spawns the DECLARED harness's headless
mode for every reviewer (Decisions 88, 105): claude-code renders bare Anthropic ids, pi
```

- [ ] **Step 2: Bump and stamp**

```bash
npm version 0.8.0 --no-git-tag-version
pnpm run sync-versions
```

Expected: `@popovych.co/witness@0.8.0: N file(s) restamped`.

- [ ] **Step 3: Verify the stamp**

Run: `npx vitest run tests/version-sync.test.ts tests/licenses.test.ts tests/release-gate.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 4: Build, then the full suite — exactly what CI runs**

`.github/workflows/ci.yml` runs `pnpm run build` and `pnpm exec vitest run`, in that order, and nothing else. There is no lint script and biome is config-only (`biome.jsonc` exists; `@biomejs/biome` is not a dependency), so `pnpm run build` — a real `tsc` emit, stricter than `--noEmit` in what it will refuse to write — is the second gate, not a formatter.

```bash
pnpm run build
rm -rf .witness/worktrees
npx vitest run --poolOptions.forks.maxForks=4 > /tmp/full.txt 2>&1; tail -30 /tmp/full.txt
```

Expected: `build` silent and exit 0; the suite green, with a file and test count at or above the baseline recorded before Task 1.

---

## DESIGN.md revision pass owed

One pass after Task 7, before the commit conversation. Seven edits inside the uncommitted ⊛ block:

1. **Row 105, call-site list** — `dashboard.ts:55` moves out of the session lane and into the judgment lane beside `check.ts:267`'s model floor. It is the same `modelFloorLines` renderer the row cites as its precedent for printing at both surfaces, and one renderer cannot walk two ladders. The session lane then reads as three sites that all render a launch or relay string.
2. **Row 105, enforcement** — `resolveHarness` is retired for `resolveJudge`/`resolveDriver`, so the ladder a call site walks is its name and a new site cannot silently inherit the wrong one. This is the property that stops row 104's defect from recurring and it is invisible in the code to anyone who does not know it was deliberate.
3. **Row 105, note scope** — "named in `lapseNote`'s shape" becomes "at every gate row `next` emits".
4. **Row 105, the residual** — state that `init` writes `harness:` only under `--agent`, so undeclared is the default state and those repos keep ambient judgment; record the rejected alternative (bare `init` writing the driver-resolved harness produces a confidently wrong declaration made permanent by write-once).
5. **Row 106, key rename and the stronger exclusion** — `GateKey.model` becomes `GateKey.pin`; and "re-shown, never re-used" now names `decide --show` rather than `resume`, because `resume` and `changed-nothing` are decisions about the next run taken from a substituted one without invoking anything. Record why the original clause failed: it left a recovered pin unreachable through `gate`, and routed the human to `changed-nothing`'s `edit the artifact` about an artifact that was never the problem — row 108's defect relocated — while making row 107's own brake near-unreachable.
6. **Row 107, three clauses** — the stderr warning at `gate.ts:339` is retired into the standing stop rather than kept; "same shape" gains its qualifier (the two triggers share pin and harness and deliberately differ on `prompts_sha`); and the brakes' window is the budget window, since `slice(-2)` over the whole stream let an approved pair of fallen-back rounds refuse the next legitimate run. Qualify the Why's "rounds 1–3 fall back and stop, the bound is reached" — that path existed *because* of row 106's bug, and after 106 it needs content edits between rounds.
7. **The ⊛ amendment paragraph** — one sentence recording that writing this plan corrected 105's lane list and sharpened 106 and 107, the practice rows 75 and 77 already follow for defects found while executing.
