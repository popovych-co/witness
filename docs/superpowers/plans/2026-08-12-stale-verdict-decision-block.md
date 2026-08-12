# Stale Verdict Decision Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A gate stopped on a stale verdict below the round bound renders a ranked decision block naming every act that is legal there, instead of a bare one-command `exits:` line.

**Architecture:** Three edits inside the decision layer. `recommend.ts` rule 2 stops returning `undefined` and returns a `stale-below-bound` Decision when a decision is pending; `rounds.ts` widens `liveExits`' stale branch under the same pending condition so the two surfaces carry identical members; `decide.ts` journals the staleness that actually held instead of a hardcoded `false`. Routing (`next.ts`) is deliberately untouched.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, biome. No new dependencies.

## Global Constraints

- `ROUND_BOUND = 3` (`src/rounds.ts:128`). "Below the bound" means `roundsSinceApprove < roundBudget`.
- `recommend.ts` is a **pure** module: journal entries and ids in, data out. It must not load canon, read config, touch git, or call `spec.currentSha`. Staleness arrives as the `stale` boolean on `GateContext`.
- `next.ts` must never import the gate registry — `gate.ts:23` imports `next.ts` and that edge stays one-way.
- The rule table in `recommend.ts` is an **ordered first-match list**. The new rule keeps position 2 (after `malformed`, before `ladder-spent`).
- Commands are emitted raw, never quoted or escaped (D120).
- An option whose command contains `<…>` must be flagged `runnable: false`, never recommended, never silently omitted (D129).
- Commit style: conventional commits with the decision id, e.g. `feat(recommend): … (D131)`.
- Test command: `npx vitest run <file>`; full suite `npm test`; types `npm run typecheck`.

**Spec:** `docs/superpowers/specs/2026-08-12-stale-verdict-decision-block-design.md`

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/recommend.ts` | The rule table and the block model | Rule 2 returns a Decision when a decision is pending |
| `src/rounds.ts` | Round accounting + `liveExits` | Stale branch becomes two-state |
| `src/verbs/decide.ts` | The decision verb and `--show` | Journal real staleness at the `recommend` call that records `rule` |
| `src/gate.ts` | Gate surfaces | Comment only — the over-general doctrine sentence |
| `tests/recommend.test.ts` | Rule-table unit + block properties | New rule cases; property `states` carry a stale entry |
| `tests/exits-line.test.ts` | Exits-line composition | Two-state stale branch assertions |
| `tests/decide-show.test.ts` | The `--show` surface | Retire the `:72` doctrine comment; assert the block |
| `DESIGN.md` | Decision record | Row 131 + one open-list residual |

---

### Task 1: The `stale-below-bound` rule

**Files:**
- Modify: `src/recommend.ts:146-147`
- Test: `tests/recommend.test.ts`

**Interfaces:**
- Consumes: `pendingDecision(entries, gate)` from `./rounds.js` (already exported; `recommend.ts` already imports from that module).
- Produces: `Decision` with `rule: 'stale-below-bound'`, four options in order — `witness gate <gate> <target>`, `--revise --note`, `--revise --upstream` (omitted when no upstream resolves), `--stop`. No `anchor` field.

- [ ] **Step 1: Write the failing tests**

Add to `tests/recommend.test.ts` inside `describe('the rule table is ordered and total', …)`:

```ts
  it('stale-below-bound: a pending decision on a verdict whose content moved', () => {
    const d = recommend(ctxFor([run(1, 'a', 'p1 > ## Step: s1')], { stale: true }))!
    expect(d.rule).toBe('stale-below-bound')
    expect(d.options[0]!.command).toBe('witness gate plan p1')
    expect(d.options[0]!.why).toContain('no battery')
    expect(d.options[0]!.tradeoff).toContain('round 2 of 3')
    expect(d.options.map((o) => o.command)).toEqual([
      'witness gate plan p1',
      'witness decide plan p1 --revise --note "1 blocking finding: p1 > ## Step: s1"',
      'witness decide plan p1 --revise --upstream auth-refresh',
      'witness decide plan p1 --stop',
    ])
  })

  it('stale-below-bound: never offers approve, which the stale-verdict refusal blocks', () => {
    const d = recommend(ctxFor([run(1, 'a', 'p1 > ## Step: s1')], { stale: true }))!
    expect(d.options.some((o) => o.command.includes('--approve'))).toBe(false)
  })

  it('stale-below-bound: a findings-free run still recommends a runnable command', () => {
    // notePrefill falls back to "<why>" with no findings to quote, so option 2 is flagged
    // not runnable — the recommendation must never be the flagged one (D129)
    const d = recommend(ctxFor([{
      v: 1, t: 'gate-run', gate: 'plan', artifact: 'p1', round: 1, run_id: 'r1',
      reviewed_sha: 'a', prompts_sha: 'ps', witness: '0', model: 'm', pin: 'm',
      harness: 'claude-code', calibration: 'none',
      checks: [{ name: 'graph', ok: false, detail: 'cycle' }], outcome: 'stopped', verdicts: [],
    } as unknown as Entry], { stale: true }))!
    expect(d.rule).toBe('stale-below-bound')
    expect(d.options[0]!.runnable).toBe(true)
    expect(d.options.find((o) => o.command.includes('--note'))!.runnable).toBe(false)
  })

  it('stale-below-bound: yields to the caller when no decision is pending', () => {
    // a disposition after the run means no anchor resolves — every decide verb refuses
    // with nothing-pending there, so the caller's single re-gate act is the honest answer
    const entries = [run(1, 'a', 'p1 > ## Step: s1'), decision('approve')]
    expect(recommend(ctxFor(entries, { stale: true }))).toBeUndefined()
  })

  it('stale-below-bound: the bound outranks it', () => {
    const entries = [run(1, 'a', 'S'), run(2, 'b', 'S2'), run(3, 'c', 'S3')]
    expect(recommend(ctxFor(entries, { stale: true }))!.rule).toBe('bound-stale')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/recommend.test.ts -t stale-below-bound`
Expected: FAIL — the first three cases get `undefined` from `recommend` (`Cannot read properties of undefined` / `toBeUndefined` passes only for the third).

- [ ] **Step 3: Implement the rule**

In `src/recommend.ts`, extend the rounds import with `pendingDecision`:

```ts
import {
  anchorRecurrence, boundReached, ladderSpent, lastGateRun, notePrefill, pendingDecision,
  repairGranted, roundBudget, roundsSinceApprove, type GateRunEntry,
} from './rounds.js'
```

Replace lines 146-147:

```ts
  // 2 — stale below the bound. Staleness blocks STAMPING, not judging: `--approve` asserts
  // about current content and `decide` refuses it with `stale-verdict`, while a stop, a
  // revise and an upstream judge the WORK and are all legal (probed 2026-08-12, all exit 0).
  // Gated on a pending decision because that is what resolves an anchor: on the reopened
  // and revised screens every decide verb refuses with `nothing-pending`, and there the
  // caller's single re-gate act is the honest answer.
  if (stale && !atBound) {
    if (pendingDecision(entries, gate) === undefined) return undefined
    const nextRound = spent + 1
    return {
      key: 'decide', rule: 'stale-below-bound',
      // No anchor: the findings describe bytes that no longer exist, and pinning a decision
      // to one of them would file recurrence against a verdict nothing can still reproduce.
      options: [
        opt(`witness gate ${gate} ${target}`, 'root', {
          why: `the verdict judged @${last.reviewed_sha.slice(0, 7)} and the content has moved since — no battery has read the current bytes, so every finding above describes a tree that no longer exists`,
          tradeoff: `spends round ${nextRound} of ${budget}${nextRound >= budget ? ' — the last before the bound' : ''}`,
        }),
        opt(note, 'root', {
          when: 'you already know the next edit and want no verdict on this state',
          tradeoff: 'spends no round now — the round is spent by the re-gate that follows it',
        }),
        ...upAlt('the parent artifact is what is wrong, whatever the current bytes say',
          'reopens the parent stage and resets this budget'),
        stopOpt,
      ],
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/recommend.test.ts`
Expected: PASS, including the pre-existing `block properties` suite (unchanged — its states are all non-stale).

- [ ] **Step 5: Commit**

```bash
git add src/recommend.ts tests/recommend.test.ts
git commit -m "feat(recommend): a stale verdict below the bound ranks its acts (D131)"
```

---

### Task 2: `liveExits`' stale branch learns the same distinction

**Files:**
- Modify: `src/rounds.ts:283`
- Test: `tests/exits-line.test.ts`, `tests/recommend.test.ts` (property states)

**Interfaces:**
- Consumes: `pendingDecision` (declared later in the same module — function declarations hoist), `notePrefill`, the `up` array already built at `rounds.ts:263`.
- Produces: for stale + pending, the string `witness gate <gate> <target> | witness decide <gate> <target> --revise --note "…" | --revise --upstream <id> | --stop`; for stale without a pending decision, the unchanged single `witness gate <gate> <target>`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/exits-line.test.ts` inside `describe('liveExits', …)`:

```ts
  it('a stale verdict with a decision pending names every act that is legal there', () => {
    const entries = [{
      v: 1, t: 'gate-run', gate: 'plan', artifact: 'p1', round: 1, run_id: 'r1',
      reviewed_sha: 'deadbee', prompts_sha: 'ps', witness: '0', model: 'm', calibration: 'none',
      checks: [], outcome: 'stopped',
      verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [{ blocking: true, anchor: 'p1 > ## Step: s1', claim: 'x' }] }],
    }] as unknown as Entry[]
    const acts = liveExits('plan', 'p1', entries, true, 'auth-refresh').split(' | ')
    expect(acts[0]).toBe('witness gate plan p1')
    expect(acts.join(' | ')).toContain('--stop')
    expect(acts.join(' | ')).toContain('--revise --upstream auth-refresh')
    expect(acts.join(' | ')).not.toContain('--approve')
  })

  it('a stale verdict with no decision pending still names only the re-gate', () => {
    // measured: in the reopened state --stop, --revise and --approve all refuse with
    // nothing-pending, so widening this branch would advertise three refusing acts
    const entries = [
      { v: 1, t: 'gate-run', gate: 'plan', artifact: 'p1', round: 1, run_id: 'r1',
        reviewed_sha: 'deadbee', prompts_sha: 'ps', witness: '0', model: 'm', calibration: 'none',
        checks: [], outcome: 'stopped', verdicts: [] },
      { v: 1, t: 'human-decision', gate: 'plan', artifact: 'p1', round: 1, decision: 'approve' },
    ] as unknown as Entry[]
    expect(liveExits('plan', 'p1', entries, true, 'auth-refresh')).toBe('witness gate plan p1')
  })
```

If `Entry` is not yet imported in that file, add `import type { Entry } from '../src/journal.js'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/exits-line.test.ts -t "stale verdict"`
Expected: first case FAILS (`acts` is the single `witness gate plan p1`, so `--stop` is absent); second case PASSES already.

- [ ] **Step 3: Implement the two-state branch**

Replace `src/rounds.ts:283`:

```ts
  // Stale removes --approve and nothing else: `decide` refuses that one with `stale-verdict`
  // because a stamp asserts about current content, while a stop or a revise judges the work.
  // Both halves are measured (2026-08-12). The pending check is what separates this from the
  // reopened and revised screens, where no anchor resolves and every decide verb refuses.
  if (stale) {
    if (pendingDecision(entries, gate) === undefined) return `witness gate ${gate} ${target}`
    return [`witness gate ${gate} ${target}`, `${d} ${[note, ...up, '--stop'].join(' | ')}`].join(' | ')
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/exits-line.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend the block properties over the stale state**

In `tests/recommend.test.ts`, `describe('block properties', …)`, widen the fixture tuple so a state can carry a context override, and add the stale state:

```ts
  const states: Array<[string, Entry[], Partial<{ stale: boolean }>]> = [
    ['blocking-here', [run(1, 'a', 'p1 > ## Step: s1')], {}],
    ['blocking-parent', [run(1, 'a', 'auth-refresh > ## Behavior')], {}],
    ['recurrence', [run(1, 'a', 'p1 > ## Step: s1'), run(2, 'b', 'p1 > ## Step: s1')], {}],
    ['bound', [run(1, 'a', 'S'), run(2, 'b', 'S2'), run(3, 'c', 'S3')], {}],
    ['stale-below-bound', [run(1, 'a', 'p1 > ## Step: s1')], { stale: true }],
  ]
```

Then in each of the four property tests, destructure the third element and thread it through both calls:

```ts
    for (const [name, entries, over] of states) {
      const d = recommend(ctxFor(entries, over))!
      const live = liveExits('plan', 'p1', entries, over.stale ?? false, 'auth-refresh')
```

(the `exactly one rule matches` test needs only the `ctxFor(entries, over)` change; the two parity tests need both.)

- [ ] **Step 6: Run the property suite**

Run: `npx vitest run tests/recommend.test.ts -t "block properties"`
Expected: PASS — the block's option 1 is `witness gate plan p1`, which is member 1 of the widened live set, and every other member survives into the block.

- [ ] **Step 7: Commit**

```bash
git add src/rounds.ts tests/exits-line.test.ts tests/recommend.test.ts
git commit -m "fix(rounds): the stale exits line widens only where an anchor resolves (D131)"
```

---

### Task 3: Journal the staleness that actually held

**Files:**
- Modify: `src/verbs/decide.ts:293`
- Test: `tests/recommend.test.ts`

**Interfaces:**
- Consumes: `nowSha` (`decide.ts:212`) and `anchor` (`decide.ts:216`), both already in scope at the call site.
- Produces: `human-decision` entries whose `rule` is the rule the human was actually shown.

- [ ] **Step 1: Write the failing test**

Add to `tests/recommend.test.ts`. Extend the existing imports with `appendEntry`:

```ts
import { appendEntry, readStream, type Entry } from '../src/journal.js'
```

Then, next to the other `stopped()` helpers:

```ts
// A second run whose reviewed sha nothing can reproduce: the state is stale and, with no
// disposition after it, still pending. Round 2 of 3 keeps it below the bound.
async function staleStopped() {
  const { repo } = await stopped()
  appendEntry(repo.root, 'auth-refresh-plan-1', {
    v: 1, t: 'gate-run', gate: 'plan', artifact: 'auth-refresh-plan-1', round: 2, run_id: 'r-stale',
    reviewed_sha: 'deadbee', prompts_sha: 'ps', witness: '0.11.0', model: 'm', pin: 'm',
    harness: 'claude-code', calibration: 'none', checks: [], outcome: 'stopped',
    verdicts: [{
      reviewer: 'plan-critic', coverage: [],
      findings: [{ blocking: true, anchor: 'auth-refresh-plan-1 > ## Step: s1', claim: 'x' }],
    }],
  } as never)
  return repo
}
```

And the case, inside `describe('the decision records what was recommended', …)`:

```ts
  it('records the rule the human was actually shown when the verdict was stale', async () => {
    const repo = await staleStopped()
    const r = await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])
    expect(r.code).toBe(0)
    const d = readStream(repo.root, 'auth-refresh-plan-1')
      .filter((e) => e.t === 'human-decision').at(-1)! as unknown as Record<string, unknown>
    expect(d.rule).toBe('stale-below-bound')
    // Option 1 is a gate verb, so `recommendedVerb` (a match on --approve|--revise|--stop)
    // finds nothing. Deliberate: journaling `recommended: 'gate'` would make every such
    // decision count as overridden in dashboard.ts:90, reporting a working rule as 100%
    // wrong. The cost is that dashboard.ts:85 skips the row — this rule is unauditable
    // under D130, and the spec records that rather than faking a countable value.
    expect(d.recommended).toBeUndefined()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/recommend.test.ts -t "actually shown"`
Expected: FAIL — `expected 'blocking-here' to be 'stale-below-bound'`.

- [ ] **Step 3: Implement**

Replace `src/verbs/decide.ts:293`:

```ts
  const rec = recommend({
    gate, target, entries, upstream: upstreamId,
    // The truth, not `false`. The hardcode existed because a stale state produced no rule at
    // all and the entry's fields would have been empty; with the stale rule in place it only
    // misattributes — D130's audit was reporting rules that were never rendered.
    stale: nowSha !== undefined && nowSha !== anchor.reviewed_sha,
  })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/recommend.test.ts`
Expected: PASS, including `journals recommended, rule and anchor` and `records divergence …`, which are non-stale states and keep `rule: 'blocking-here'`.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/decide.ts tests/recommend.test.ts
git commit -m "fix(decide): the journal records the rule the human was shown (D131)"
```

---

### Task 4: Retire the over-general doctrine, record the decision

**Files:**
- Modify: `src/gate.ts:161-162`, `src/verbs/decide.ts:132-134`, `tests/decide-show.test.ts:70-73`, `DESIGN.md`
- Test: `tests/decide-show.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. Comments, one assertion, one decision row.

- [ ] **Step 1: Write the failing test**

In `tests/decide-show.test.ts`, add a case asserting the stale-pending surface renders the block (place it beside `renders full findings and the normal exits while a decision is pending`):

```ts
  it('a stale pending verdict ranks the re-gate instead of printing a bare exits line', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const s = repo.effort
    appendEntry(repo.root, s, {
      v: 1, t: 'gate-run', gate: 'decompose', artifact: s, round: 1, run_id: 'r1',
      reviewed_sha: 'deadbee', prompts_sha: 'p', witness: '0', model: 'm', calibration: 'none',
      checks: [], outcome: 'stopped',
      verdicts: [{
        reviewer: 'slicing-critic',
        coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }],
        findings: [{ blocking: true, anchor: 'auth-refresh > ## Behavior', claim: 'expiry unbounded' }],
      }],
    })
    const r = await repo.cli(['decide', 'decompose', s, '--show'])
    expect(r.stdout).toMatch(/decide: \d+ options · 1 is recommended/)
    expect(r.stdout).toContain(`run: witness gate decompose ${s}`)
    expect(r.stdout).toContain('--stop')
    expect(r.stdout).not.toMatch(/^exits: witness gate decompose \S+$/m)
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/decide-show.test.ts -t "bare exits line"`
Expected: PASS if Tasks 1-2 are complete (this is the integration proof of them). If it fails, the earlier tasks are incomplete — fix there, not here.

- [ ] **Step 3: Rewrite the three doctrine comments**

`src/recommend.ts:75` — the `Order:` list needs **no change**: it already reads `malformed · stale-below-bound · ladder-spent · …`. The id was reserved in the table while rule 2 emitted nothing, so D129's "every journalable rule id appears in the table" held in the wrong direction. Leave it; Task 1 makes it true.

`src/gate.ts:161-162`:

```ts
// `undefined` from `recommend` means no anchor resolves at this state — stale with no
// decision pending (reopened, or already revised), where every decide verb refuses with
// nothing-pending and the exits line's single re-gate act is the whole live set.
```

`src/verbs/decide.ts:133-134`:

```ts
    // ranking rather than a menu. `undefined` is stale with no decision pending, where no
    // act but the re-gate is legal and the exits line already says exactly that.
```

`tests/decide-show.test.ts:71-73`:

```ts
    // The CURRENT sha, not a placeholder: "the normal exits" is a claim about unchanged
    // content. A fake sha makes the state stale, which is a different screen — it keeps
    // --revise, --upstream and --stop and loses only --approve (D131).
```

- [ ] **Step 4: Add the DESIGN.md row**

Append row 131 to the decision table (immediately after row 130's row, before the `---` that precedes `## Open / deferred`):

```markdown
| 131 ⊗ | A stale verdict keeps every act that judges the work | Rule 2 stops returning `undefined` and ranks the acts that are legal at a stale verdict *with a decision pending*: the re-gate first (the only act that produces knowledge — nothing on screen describes the current tree), then `--revise --note`, `--revise --upstream` and `--stop`. `--approve` is absent by construction, refused by `stale-verdict`. `liveExits`' stale branch widens under the same condition, and `decide` journals the staleness that actually held instead of a hardcoded `false` | Measured 2026-08-12 on the shipped CLI: at a stale pending gate `--stop`, `--revise` and `--revise --upstream` all exit 0 while `--approve` exits 2, so three legal acts were advertised on no surface — row 119's failure inside the module written to end it. The rule id was already reserved in `recommend.ts`'s ordered table while the code emitted nothing, so row 129's *every journalable rule id appears in the table* held in the wrong direction — a named rule no state could produce. Four comments (`recommend.ts`, `decide.ts`, `gate.ts`, `decide-show.test.ts`) stated *the only live act is a re-gate*, each true-looking beside its own code; that is how the over-generalisation survived. The pending gate is not decoration: the same probe against the **reopened** state refuses every decide verb with `nothing-pending`, so a blanket widening would have put three refusing commands on that screen. The hardcoded `stale: false` at the journaling call was a workaround for this same hole — with no stale rule the entry's `rule` field would have been empty — and it was recording `blocking-here` for decisions taken at a screen that recommended nothing, feeding row 130's audit rows it never produced. **Routing is deliberately unchanged**: `next` still names `decide --show`, because the agent contract ends the turn there (`plugin/commands/witness.md:29`) while a `witness gate` line is unattended motion, and the re-gate spends a round — measured, `[1, 2]` after one — which at round 3 of 3 is the last before the bound. Row 121's premise decides it: every remaining act carries a cost, and which cost is worth paying is the human's question |
```

Extend row 131's body with the audit limit (it is the one thing a reader would otherwise assume seam 3 fixed):

> …and the rule is unauditable under row 130 by construction: its recommendation is a gate act, so compliance writes no `human-decision` entry and divergence writes one `recommenderRowsFrom` skips for want of `recommended`. Journaling `recommended: 'gate'` was rejected — no `decision` value starts with it, so a working rule would report 100% overridden, row 130's own inversion. Seam 3 removes false rows; it adds no true ones.

Add to `## Open / deferred`:

```markdown
- **`stale-below-bound` cannot be measured by the recommender audit.** Following it produces a gate-run, not a decision, and diverging from it produces a decision with no `recommended` verb — both invisible to `recommenderRowsFrom`. Measuring it needs a different instrument (gate-runs whose preceding state was stale-pending), which `status` does not compute. Until then the rule's correctness rests on the 2026-08-12 probes recorded in its spec.
```

```markdown
- **The dashboard's `flows` row and its `next:` line answer different questions.** `dashboard.ts:198` calls `flowAction` directly and never consults pending decisions, so a stale-pending flow shows `witness gate …` in the flows table while `next:` shows `decide … --show`. Both are true — one is *what motion exists*, the other is *who owes the next act* — and row 131 declined to collapse them. Revisit if a field report shows someone acting on the wrong one.
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS. Pay attention to `tests/dead-fields.test.ts` (every entry field needs a reader), `tests/exits-line.test.ts` (`no source builds its own exits set` — the new `witness gate` string in `rounds.ts` is composed inside `liveExits`, which is the one module allowed to), and `tests/release-gate.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs(design): a stale verdict keeps every act that judges the work (D131)"
```

---

## Self-Review

**Spec coverage.** Seam 1 → Task 1. Seam 2 → Task 2 (both states, plus the property extension). Seam 3 → Task 3. The four doctrine sites → Task 4 step 3. DESIGN row 131 + the dashboard residual → Task 4 step 4. The spec's verification list → Tasks 1, 2, 3 step 1 and Task 4 step 1.

**Deliberately not covered.** The spec's third residual — the *revised* (non-reopened) stale screen — is asserted only indirectly, by Task 1's `yields to the caller when no decision is pending` case, which uses a disposition to remove the anchor. That is the same mechanism a revise uses (`decide.ts:214` requires `unchanged`, so a stale revise resolves no anchor), so the behavior is covered even though the fixture is not literally a revise.

**Known risk.** `pendingDecision` is declared at `rounds.ts:299`, after `liveExits` at `:259`. Function declarations hoist, so this works — but if a future refactor converts either to a `const` arrow, Task 2's call breaks at runtime rather than at compile time. `npm test` catches it immediately.
