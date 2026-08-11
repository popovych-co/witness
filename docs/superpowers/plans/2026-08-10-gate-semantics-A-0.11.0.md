# Gate semantics: a stop parks, a malformed round is not a decision (D124, D126) — Plan A of 4 for 0.11.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make two decisions the CLI already offers mean something — `--stop` parks a flow instead of changing nothing, and a round in which no verdict parsed stops being handed to a human as a disposition.

**Architecture:** Both are one-predicate fixes with a reporting obligation attached. `gateSettled` (`src/verbs/next.ts:26`) settles only on `approve` or a passed run, while `decide --show` (`src/verbs/decide.ts:105`) already reports any non-revise disposition as `settled` — two live definitions with `stop` on opposite sides. Unifying them makes `next` stop offering a stopped flow, which must be *reported* (a `status` parked row) or a stall becomes a disappearance. `pendingDecision` (`src/rounds.ts:209`) returns any run whose outcome is not `passed`, malformed included; skipping malformed routes the human to the gate, whose re-run is free because malformed rounds do not spend the budget.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥20, vitest (`pool: 'forks'`), biome.

## Global Constraints

- **This plan is part of the 0.11.0 release. Do not bump `package.json` or any payload pin** — Plan D owns the release. Every plan in this set lands on the same branch.
- **Prerequisite: 0.10.1 is merged.** This plan calls `liveExits` with its required fifth `upstream` argument (`liveExits(gate, target, entries, stale, upstream)`) and uses `cmd()` from `src/toon.ts`. If either is missing, stop — 0.10.1 has not landed.
- **Import specifiers end in `.js`** even for TypeScript sources. This is an ESM package.
- **Run the suite with a bounded fork pool:** `npx vitest run --poolOptions.forks.maxForks=4`. The default pool causes IPC timeouts and false failures.
- **Never run `git commit` outside the steps that say to.** One commit per task.
- **These are gate-outcome changes.** Unlike 0.10.1, this plan deliberately alters routing. Every change here must be covered by a test that asserts the *routing* result, not just the predicate.

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `src/verbs/next.ts` | `gateSettled` treats `stop` as settling. New `parkedGates(root, canon)` enumerates stopped-but-unreopened gates for `status`. |
| `src/rounds.ts` | `pendingDecision` skips `malformed` runs and continues scanning to the last real verdict. New `reopenCommand(gate, target, entries, upstream)` — the act that un-parks. |
| `src/verbs/dashboard.ts` | Renders a `parked` table. |
| `tests/gate-park.test.ts` | New. Stop→park→reopen cycle, and malformed routing. |

---

### Task 1: A stop settles the gate for routing

**Files:**
- Modify: `src/verbs/next.ts:26-40`
- Test: `tests/gate-park.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `gateSettled(entries, gate, currentSha?)` now returns `true` when the last disposition for that gate is `stop`. Task 2 relies on this to detect parked gates.

- [ ] **Step 1: Write the failing test**

Create `tests/gate-park.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { approve, fakeScenario, gateEnv, putVerdict, seededRepo, writePlan, writeSpec } from './helpers.js'

export const BLOCKING = {
  coverage: [
    { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
    { anchor: 'auth-refresh > ## Behavior', note: 'read' },
  ],
  findings: [{ blocking: true, anchor: 'auth-refresh-plan-1 > ## Step: s1', claim: 'step is untestable' }],
}

export async function stoppedPlanGate() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  const scenario = fakeScenario()
  putVerdict(scenario, BLOCKING)
  await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
  return repo
}

describe('a stop parks the flow', () => {
  it('next stops offering a stopped gate', async () => {
    const repo = await stoppedPlanGate()
    const before = await repo.cli(['next'])
    expect(before.stdout).toContain('witness decide plan auth-refresh-plan-1 --show')

    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])

    const after = await repo.cli(['next'])
    expect(after.stdout).not.toContain('witness gate plan auth-refresh-plan-1')
    expect(after.stdout).not.toContain('witness decide plan auth-refresh-plan-1')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/gate-park.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — `next` still answers `witness gate plan auth-refresh-plan-1` after the stop.

- [ ] **Step 3: Unify the two definitions of settled**

Replace the tail of `gateSettled` in `src/verbs/next.ts` (`:35-39`):

```ts
  if (last.outcome === 'passed') return true
  // D124. The LAST disposition is the state, and `stop` is one — `decide --show` has
  // always reported `state: settled — stop` (decide.ts:105), while this predicate honored
  // only `approve`, so one verb said settled and this one re-offered the flow forever.
  // Two definitions of settled with `stop` on opposite sides; this is the unification.
  // Read by position, not by presence: a revise AFTER a stop un-parks by design.
  const after = entries.slice(entries.lastIndexOf(last as unknown as Entry) + 1)
    .filter((e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === gate)
    .map((e) => e as unknown as DecisionEntry)
    .at(-1)
  return after !== undefined && (after.decision === 'approve' || after.decision === 'stop')
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/gate-park.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 5: Run the full suite and triage**

Run: `npx vitest run --poolOptions.forks.maxForks=4`
Expected: some failures. Every failing test asserting that a flow is still offered after a `--stop` was pinning the old behavior — update it to assert parking and note each in the commit body. A failure where a stop was used as a *no-op* to set up a later state is a genuine break: change that setup to use `--revise` instead.

- [ ] **Step 6: Commit**

```bash
git add src/verbs/next.ts tests
git commit -m "feat(next): a stop settles its gate for routing (D124)"
```

---

### Task 2: A parked flow is reported

Settling without reporting trades a stall for a disappearance, which is worse. `status` must name every parked gate and the act that un-parks it.

**Files:**
- Modify: `src/rounds.ts` (add `reopenCommand`)
- Modify: `src/verbs/next.ts` (add `parkedGates`)
- Modify: `src/verbs/dashboard.ts`
- Test: `tests/gate-park.test.ts`

**Interfaces:**
- Consumes: `gateSettled` (Task 1), `liveExits` and `boundReached` from `src/rounds.ts`.
- Produces:
  - `reopenCommand(gate: string, target: string, entries: Entry[], upstream: string | undefined): string` in `src/rounds.ts` — the act that un-parks this gate.
  - `parkedGates(root: string, canon: Canon): Array<{ gate: string; target: string; round: number; anchor: string; reopen: string }>` exported from `src/verbs/next.ts`.

- [ ] **Step 1: Write the failing test**

Append to `tests/gate-park.test.ts`:

```ts
describe('status reports a parked flow', () => {
  it('names the gate, round, anchor and the reopen command', async () => {
    const repo = await stoppedPlanGate()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])
    const s = await repo.cli(['status'])
    expect(s.stdout).toContain('parked')
    expect(s.stdout).toContain('auth-refresh-plan-1')
    expect(s.stdout).toContain('## Step: s1')
    expect(s.stdout).toContain('witness gate plan auth-refresh-plan-1 --fresh')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/gate-park.test.ts -t "status reports" --poolOptions.forks.maxForks=4`
Expected: FAIL — no `parked` row in the output.

- [ ] **Step 3: Add `reopenCommand` to `src/rounds.ts`**

```ts
// What un-parks a gate stopped under D124. Below the bound a fresh run is the act — the
// content is unchanged, so a plain re-gate would answer `changed-nothing`. At the bound
// the gate short-circuits before invoking anything, so `--fresh` is the D67 lie: the only
// live acts there are the endgame set, which liveExits already knows.
export function reopenCommand(
  gate: string, target: string, entries: Entry[], upstream: string | undefined,
): string {
  return boundReached(entries, gate)
    ? liveExits(gate, target, entries, false, upstream)
    : `witness gate ${gate} ${target} --fresh`
}
```

- [ ] **Step 4: Add `parkedGates` to `src/verbs/next.ts`**

```ts
// D124's reporting half. A parked flow that `next` silently skips is a disappearance, so
// `status` names every one of them. The anchor comes from the run the stop disposed of —
// the human parked something specific, and "parked" without "on what" is not a report.
export function parkedGates(
  root: string, canon: Canon,
): Array<{ gate: string; target: string; round: number; anchor: string; reopen: string }> {
  const out: Array<{ gate: string; target: string; round: number; anchor: string; reopen: string }> = []
  const seen: Array<{ id: string; gates: readonly string[] }> = [
    ...effortStreams(root).map((slug) => ({ id: slug, gates: ['decompose'] as const })),
    ...canon.docs.filter((d) => d.meta.type === 'plan')
      .map((d) => ({ id: String(d.meta.id), gates: ['plan', 'implement', 'ship'] as const })),
    ...canon.docs.filter((d) => d.meta.type === 'spec')
      .map((d) => ({ id: String(d.meta.id), gates: ['design'] as const })),
  ]
  for (const { id, gates } of seen) {
    const entries = readStream(root, id)
    for (const gate of gates) {
      const last = lastGateRun(entries, gate)
      if (!last) continue
      const disposition = entries.slice(entries.lastIndexOf(last as unknown as Entry) + 1)
        .filter((e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === gate)
        .map((e) => e as unknown as DecisionEntry)
        .at(-1)
      if (disposition?.decision !== 'stop') continue
      const anchors = (last.verdicts ?? [])
        .flatMap((rv) => rv.findings.filter((f) => f.blocking))
        .map((f) => (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`))
      const spec = gateSpec(gate)
      out.push({
        gate, target: id, round: last.round,
        anchor: anchors[0] ?? last.standing ?? last.outcome,
        reopen: reopenCommand(gate, id, entries, spec?.upstreamOf?.(root, canon, id)),
      })
    }
  }
  return out
}
```

Add the imports this needs to `src/verbs/next.ts`: `lastGateRun` and `reopenCommand` from `../rounds.js`, `gateSpec` from `../gate.js`, `effortStreams` from `../journal.js` (check each — several are already imported).

- [ ] **Step 5: Render it in `status`**

In `src/verbs/dashboard.ts`, after the efforts table and before the `canon:` line, add:

```ts
  const parked = parkedGates(root, canon)
  if (parked.length > 0) {
    rows('parked', ['gate', 'target', 'round', 'anchor', 'reopen'],
      parked as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  }
```

Import `parkedGates` from `./next.js`.

- [ ] **Step 6: Run the test and the dashboard suite**

Run: `npx vitest run tests/gate-park.test.ts tests/dashboard.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/rounds.ts src/verbs/next.ts src/verbs/dashboard.ts tests/gate-park.test.ts
git commit -m "feat(status): parked flows are reported, never silently skipped (D124)"
```

---

### Task 3: A parked gate can be un-parked

Parking must be reversible or it is abandonment with extra steps.

**Files:**
- Test: `tests/gate-park.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-2.
- Produces: nothing new — this task proves the cycle closes.

- [ ] **Step 1: Write the test**

Append to `tests/gate-park.test.ts`:

```ts
describe('parking is reversible', () => {
  it('a fresh run un-parks the gate and next offers it again', async () => {
    const repo = await stoppedPlanGate()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])
    expect((await repo.cli(['next'])).stdout).not.toContain('auth-refresh-plan-1')

    const scenario = fakeScenario()
    putVerdict(scenario, BLOCKING)
    const g = await repo.cli(['gate', 'plan', 'auth-refresh-plan-1', '--fresh'], { env: gateEnv(scenario) })
    expect(g.code).toBe(1)

    const after = await repo.cli(['next'])
    expect(after.stdout).toContain('witness decide plan auth-refresh-plan-1 --show')
  })

  it('a revise after a stop also un-parks it', async () => {
    const repo = await stoppedPlanGate()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--revise', '--note', 'reconsidered'])
    const after = await repo.cli(['next'])
    expect(after.stdout).toContain('auth-refresh-plan-1')
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/gate-park.test.ts -t "parking is reversible" --poolOptions.forks.maxForks=4`
Expected: PASS — Task 1's read-by-position (`.at(-1)`) already makes a later revise win over the stop, and a fresh run appends a new gate-run above the stop.

If the first case fails because `--fresh` does not append (the run is cached), the cause is `appendKind` treating the re-run as `resume`. `--fresh` bypasses the cache by design (`gate.ts:291`); if it does not, stop and report rather than working around it — that is a separate defect.

- [ ] **Step 3: Commit**

```bash
git add tests/gate-park.test.ts
git commit -m "test(park): the stop → park → reopen cycle closes (D124)"
```

---

### Task 4: A malformed round is not a decision

`pendingDecision` returns any run whose outcome is not `passed`, so a round in which the battery emitted only schema violations routes to `--show` and offers `--approve` — stamping an artifact on zero judgment.

**Files:**
- Modify: `src/rounds.ts:209-219`
- Test: `tests/gate-park.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `pendingDecision(entries, gate)` skips runs whose `outcome === 'malformed'` and continues scanning; it returns the last run that actually produced a verdict, or `undefined`.

- [ ] **Step 1: Write the failing test**

Append to `tests/gate-park.test.ts`:

```ts
const MALFORMED = { coverage: [{ anchor: 'unscoped', note: 'read' }], findings: [] }

describe('a malformed round is not a disposition', () => {
  it('next routes to the gate, not to decide --show', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    const scenario = fakeScenario()
    putVerdict(scenario, MALFORMED)
    const g = await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
    expect(g.stdout).toContain('outcome: malformed')

    const n = await repo.cli(['next'])
    expect(n.stdout).toContain('witness gate plan auth-refresh-plan-1')
    expect(n.stdout).not.toContain('decide plan auth-refresh-plan-1 --show')
  })

  it('decide --approve on a malformed-only stream refuses', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    const scenario = fakeScenario()
    putVerdict(scenario, MALFORMED)
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
    const d = await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve'])
    expect(d.code).toBe(2)
    expect(d.stderr).toContain('nothing-pending')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/gate-park.test.ts -t "malformed round" --poolOptions.forks.maxForks=4`
Expected: FAIL — `next` answers `decide … --show` and `--approve` succeeds.

- [ ] **Step 3: Skip malformed in `pendingDecision`**

Replace the loop body in `src/rounds.ts`:

```ts
export function pendingDecision(entries: Entry[], gate: string): GateRunEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (isDecision(e, gate)) return undefined
    if (isRun(e, gate)) {
      const run = e as unknown as GateRunEntry
      // D126. A malformed round parsed NO verdict, so there is nothing to dispose of:
      // offering `--approve` there stamps the artifact on zero judgment and `--revise`
      // sends the author to fix something no reviewer read. The remedy is a re-run (free —
      // malformed rounds never spend the budget) or the config change `malformed-streak`
      // names. Keep scanning: an older real verdict below it is still owed a decision.
      if (run.outcome === 'malformed') continue
      return run.outcome === 'passed' ? undefined : run
    }
  }
  return undefined
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/gate-park.test.ts -t "malformed round" --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 5: Run the full suite and triage**

Run: `npx vitest run --poolOptions.forks.maxForks=4`
Expected: PASS. Tests that decided on a malformed run were exercising the defect; update them to use a `stopped` outcome and note each in the commit body.

- [ ] **Step 6: Commit**

```bash
git add src/rounds.ts tests/gate-park.test.ts
git commit -m "fix(rounds): a malformed round is not a pending decision (D126)"
```

---

## Self-Review

**Spec coverage.** D124 — Tasks 1 (predicate), 2 (reporting), 3 (reversibility). D126 — Task 4. D126's other half, *the option list ranks live acts rather than `decide` verbs*, is the block's data model and lives in Plan B; this plan only removes the state that made it necessary.

**Placeholder scan.** No TBDs. Every step names the file, the code, the command, and the expected result. Task 3's failure branch names the suspected cause and says to report rather than work around it.

**Type consistency.** `parkedGates` returns the exact field names the `rows()` call renders (`gate`, `target`, `round`, `anchor`, `reopen`). `reopenCommand`'s fifth-argument shape matches `liveExits(gate, target, entries, stale, upstream)` from 0.10.1. `gateSettled` keeps its `(entries, gate, currentSha?)` signature — no caller changes.

**Risk this plan carries.** Task 1 changes routing for every gate in every repo. The blast radius is bounded by one property: a flow only disappears from `next` if a human explicitly ran `--stop` on it, and Task 2 guarantees it is still named in `status`. If the full-suite triage in Task 1 Step 5 turns up a failure that is *not* a test pinning old behavior, stop — it means something else depended on stop being inert.
