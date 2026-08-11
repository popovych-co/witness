# The decision block (D121, D123, D129 flagged half, D130) — Plan B of 4 for 0.11.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every place the CLI asks a human to choose renders the choices as ranked, runnable option rows — recommendation first, with why, when, tradeoff and depth — computed from journal facts alone.

**Architecture:** A new pure module `src/recommend.ts` holds an **ordered first-match rule table** over journal state and returns a structured `Decision` (a list of `Option`s with one marked recommended). A renderer turns it into option rows. Every surface that today prints an exits line prints the block instead. The `human-decision` entry records `recommended`, `rule` and (when the matched rule is anchor-scoped) `anchor`; none is read by any gate predicate, and `status` reports each rule's override rate so the recommender is auditable.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥20, vitest (`pool: 'forks'`), biome.

## Global Constraints

- **Part of the 0.11.0 release. Do not bump `package.json` or any payload pin** — Plan D owns the release.
- **Prerequisites: 0.10.1 merged, and Plan A merged.** This plan calls `liveExits(gate, target, entries, stale, upstream)`, uses `cmd()`, recommends `--stop` (which only parks after Plan A), and assumes malformed rounds no longer produce a pending decision. If `witness decide <gate> <target> --stop` still leaves `next` offering the flow, stop — Plan A has not landed.
- **The recommender never reads what a finding says.** It reads structured fields only: `blocking`, `anchor`, `contradicts_pin`, `outcome`, `standing`, `manual`, check `ok`, and journal state. Any code that inspects `claim` text is a defect, not an improvement.
- **Nothing here may change a gate outcome.** `recommended`, `rule` and `anchor` must never appear in `keyOf`, `roundsSinceApprove`, `boundReached`, `repairGranted`, `appendKind`, `gateSettled` or the streak brakes. Task 7 asserts this.
- **Run the suite with a bounded fork pool:** `npx vitest run --poolOptions.forks.maxForks=4`.
- **One commit per task.** Never `git commit` outside the steps that say to.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/recommend.ts` | New. The `Option`/`Decision` types, the ordered rule table, `recommend()`, and `renderDecision()`. Pure — takes journal entries and resolved ids, returns data. |
| `src/rounds.ts` | Adds `anchorRecurrence` (within-window grade) and `ladderSpent` (cross-window fact). `DecisionEntry` gains `recommended`, `rule`, `anchor`. |
| `src/gate.ts` | `renderGateRun` renders the block instead of the `help:` exits line. |
| `src/verbs/decide.ts` | `--show` and `renderBound` render the block; the write path journals `recommended`/`rule`/`anchor`. |
| `src/ship.ts` | Awaiting-decision renders the block. |
| `src/verbs/next.ts` | `multiple ready` and the pending-transaction fork render the block. |
| `src/verbs/recover.ts` | Renders the block for `--complete` / `--rollback`. |
| `src/verbs/dashboard.ts` | Renders the `recommender` accuracy table. |
| `tests/recommend.test.ts` | New. One test per rule, plus the properties. |

---

### Task 1: The option model and its renderer

**Files:**
- Create: `src/recommend.ts`
- Test: `tests/recommend.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces — every later task depends on these exact names:

```ts
export type Depth = 'root' | 'deferral' | 'terminal'

export interface Option {
  command: string            // fully resolved and runnable, or flagged below
  depth: Depth
  why?: string               // recommended option only
  when?: string              // non-recommended options
  tradeoff?: string          // non-recommended options
  note?: string              // execution caveat, never a second argument for the option
  runnable: boolean          // false ⇒ carries an unresolved placeholder; never recommended
  judgeFirst?: string        // reserved stops only
}

export interface Decision {
  key: string                // the TOON key: 'decide' | 'next' | 'choose' | 'recover'
  options: Option[]          // options[0] is the recommendation
  rule: string               // the id of the rule that matched
  anchor?: string            // set when the matched rule is anchor-scoped
}

export function renderDecision(d: Decision): string[]
```

- [ ] **Step 1: Write the failing test**

Create `tests/recommend.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { renderDecision, type Decision } from '../src/recommend.js'

const D: Decision = {
  key: 'decide',
  rule: 'blocking-here',
  anchor: 'p1 > ## Step: s1',
  options: [
    {
      command: 'witness decide plan p1 --revise --note "1 blocking finding: p1 > ## Step: s1"',
      depth: 'root', runnable: true,
      why: '1 blocking finding anchored inside this plan; round 1 of 3',
    },
    {
      command: 'witness decide plan p1 --revise --upstream auth-refresh',
      depth: 'root', runnable: true,
      when: 'the criterion the step maps to is itself untestable',
      tradeoff: 'reopens decompose and resets this budget',
      note: 'auth-refresh is a spec, so the reopen is booked on its owning effort',
    },
    { command: 'witness decide plan p1 --stop', depth: 'terminal', runnable: true, when: 'this plan should not continue' },
  ],
}

describe('renderDecision', () => {
  it('numbers the options and marks the first as recommended', () => {
    const lines = renderDecision(D)
    expect(lines[0]).toBe('decide: 3 options · 1 is recommended')
    expect(lines[1]).toBe('1 · recommended · root')
    expect(lines[2]).toBe('   witness decide plan p1 --revise --note "1 blocking finding: p1 > ## Step: s1"')
    expect(lines[3]).toBe('   why: 1 blocking finding anchored inside this plan; round 1 of 3')
  })

  it('emits a run: line byte-identical to option 1', () => {
    const lines = renderDecision(D)
    expect(lines.at(-1)).toBe(`run: ${D.options[0]!.command}`)
  })

  it('renders when/tradeoff/note on alternatives and never quotes a command', () => {
    const out = renderDecision(D).join('\n')
    expect(out).toContain('   when: the criterion the step maps to is itself untestable')
    expect(out).toContain('   tradeoff: reopens decompose and resets this budget')
    expect(out).toContain('   note: auth-refresh is a spec')
    expect(out).not.toContain('""')
  })

  it('flags an unrunnable option and emits no run: line when option 1 is unrunnable', () => {
    const lines = renderDecision({
      ...D,
      options: [{ command: 'witness decide plan p1 --revise --upstream <effort>', depth: 'root', runnable: false, why: 'x' }],
    })
    expect(lines[1]).toBe('1 · recommended · root · not runnable')
    expect(lines.some((l) => l.startsWith('run: '))).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/recommend.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — `src/recommend.ts` does not exist.

- [ ] **Step 3: Create `src/recommend.ts` with the types and renderer**

```ts
// D121. The block: every set of live options renders ranked, with runnable commands.
// This module is PURE — it takes journal entries and ids the caller already resolved and
// returns data. It never loads canon, never reads a finding's claim text, and never
// decides anything a gate predicate consumes.

export type Depth = 'root' | 'deferral' | 'terminal'

export interface Option {
  command: string
  depth: Depth
  why?: string
  when?: string
  tradeoff?: string
  note?: string
  runnable: boolean
  judgeFirst?: string
}

export interface Decision {
  key: string
  options: Option[]
  rule: string
  anchor?: string
}

// Commands are emitted raw (D120): `esc` would quote the `--note "…"` argument and the
// line would paste into a shell as an empty note.
export function renderDecision(d: Decision): string[] {
  const n = d.options.length
  const out = [`${d.key}: ${n} option${n === 1 ? '' : 's'} · 1 is recommended`]
  d.options.forEach((o, i) => {
    const tags = [String(i + 1), ...(i === 0 ? ['recommended'] : []), o.depth,
      ...(o.runnable ? [] : ['not runnable'])]
    out.push(tags.join(' · '))
    out.push(`   ${o.command}`)
    if (o.why) out.push(`   why: ${o.why}`)
    if (o.judgeFirst) out.push(`   judge-first: ${o.judgeFirst}`)
    if (o.when) out.push(`   when: ${o.when}`)
    if (o.tradeoff) out.push(`   tradeoff: ${o.tradeoff}`)
    if (o.note) out.push(`   note: ${o.note}`)
  })
  // No run: line when the recommendation cannot be pasted — a run: that needs editing is
  // the promise this block exists to keep, broken.
  if (d.options[0]?.runnable) out.push(`run: ${d.options[0]!.command}`)
  return out
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/recommend.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/recommend.ts tests/recommend.test.ts
git commit -m "feat(recommend): the option model and its renderer (D121)"
```

---

### Task 2: Recurrence — two memories

**Files:**
- Modify: `src/rounds.ts`
- Test: `tests/recommend.test.ts`

**Interfaces:**
- Consumes: `runsSinceReset`, `lastResetIndex` (already in `rounds.ts`), `fellBack`.
- Produces:
  - `anchorRecurrence(entries: Entry[], gate: string, anchor: string): number` — occurrences of `anchor` across rounds with **distinct** `reviewed_sha` **inside the current budget window**, excluding malformed and fallen-back rounds and excluding findings carrying `contradicts_pin`.
  - `ladderSpent(entries: Entry[], gate: string, anchor: string): boolean` — whether a `revise-upstream` decision carrying this `anchor` exists **anywhere** in the stream.

- [ ] **Step 1: Write the failing test**

Append to `tests/recommend.test.ts`:

```ts
import { anchorRecurrence, ladderSpent } from '../src/rounds.js'
import type { Entry } from '../src/journal.js'

const run = (round: number, sha: string, anchor: string, extra: Record<string, unknown> = {}): Entry => ({
  v: 1, t: 'gate-run', gate: 'plan', artifact: 'p1', round, run_id: `r-${round}`,
  reviewed_sha: sha, prompts_sha: 'ps', witness: '0.11.0', model: 'm', pin: 'm',
  harness: 'claude-code', calibration: 'none', checks: [], outcome: 'stopped',
  verdicts: [{ reviewer: 'plan-critic', findings: [{ blocking: true, anchor, claim: 'x' }], coverage: [] }],
  ...extra,
} as unknown as Entry)

const decision = (d: string, extra: Record<string, unknown> = {}): Entry =>
  ({ v: 1, t: 'human-decision', gate: 'plan', artifact: 'p1', round: 1, decision: d, ...extra } as unknown as Entry)

describe('anchorRecurrence', () => {
  it('counts distinct reviewed shas only', () => {
    const e = [run(1, 'a', 'S'), run(2, 'a', 'S'), run(3, 'b', 'S')]
    expect(anchorRecurrence(e, 'plan', 'S')).toBe(2)
  })

  it('excludes malformed and fallen-back rounds', () => {
    const e = [run(1, 'a', 'S'), run(2, 'b', 'S', { outcome: 'malformed' }), run(3, 'c', 'S', { pin: 'other' })]
    expect(anchorRecurrence(e, 'plan', 'S')).toBe(1)
  })

  it('excludes findings that contradict a pin', () => {
    const e = [run(1, 'a', 'S'), run(2, 'b', 'S')]
    ;(e[1] as any).verdicts[0].findings[0].contradicts_pin = 1
    expect(anchorRecurrence(e, 'plan', 'S')).toBe(1)
  })

  it('restarts at the window boundary', () => {
    const e = [run(1, 'a', 'S'), run(2, 'b', 'S'), decision('revise-upstream'), run(3, 'c', 'S')]
    expect(anchorRecurrence(e, 'plan', 'S')).toBe(1)
  })
})

describe('ladderSpent', () => {
  it('sees an upstream taken for this anchor in a closed window', () => {
    const e = [run(1, 'a', 'S'), decision('revise-upstream', { anchor: 'S' }), run(2, 'b', 'S')]
    expect(ladderSpent(e, 'plan', 'S')).toBe(true)
    expect(ladderSpent(e, 'plan', 'OTHER')).toBe(false)
  })

  it('is false when the upstream carried no anchor', () => {
    const e = [run(1, 'a', 'S'), decision('revise-upstream'), run(2, 'b', 'S')]
    expect(ladderSpent(e, 'plan', 'S')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/recommend.test.ts -t "anchorRecurrence" --poolOptions.forks.maxForks=4`
Expected: FAIL — not exported.

- [ ] **Step 3: Add both to `src/rounds.ts`**

```ts
const anchorsOf = (r: GateRunEntry): string[] =>
  (r.verdicts ?? []).flatMap((rv) => rv.findings
    // D123: a pin contradiction is row 83's standing stop with its own handling. Counting
    // it as recurrence would read row 82's r1↔r2 reviewer contradiction as a bad fix by
    // the author, which is exactly backwards.
    .filter((f) => f.blocking && f.contradicts_pin === undefined)
    .map((f) => (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`)))

// D123, memory one: how many honest attempts have failed at this seam IN THE CURRENT GAME.
// Distinct shas only — a resumed or unchanged round is not an attempt. Malformed and
// fallen-back rounds are excluded for the same reason row 67 and row 107 exempt them from
// the budget: witness failed to deliver a judgment, which is not evidence about the seam.
export function anchorRecurrence(entries: Entry[], gate: string, anchor: string): number {
  const seen = new Set<string>()
  for (const r of runsSinceReset(entries, gate)) {
    if (r.outcome === 'malformed' || fellBack(r)) continue
    if (!anchorsOf(r).includes(anchor)) continue
    seen.add(r.reviewed_sha)
  }
  return seen.size
}

// D123, memory two: was the depth ladder ALREADY tried for this anchor. Cross-window by
// necessity — `revise-upstream` IS a window reset (lastResetIndex), so the window erases
// the very fact this answers. Without it the once-per-anchor cap is underivable and the
// recommender can point at upstream every window forever, resetting the budget each time:
// incident c2692b93's shape.
export function ladderSpent(entries: Entry[], gate: string, anchor: string): boolean {
  return entries.some((e) =>
    isDecision(e, gate) &&
    (e as unknown as DecisionEntry).decision === 'revise-upstream' &&
    (e as unknown as DecisionEntry).anchor === anchor)
}
```

Add `anchor?: string` to `DecisionEntry` (`src/rounds.ts:48`), documented:

```ts
  // D121/D123. The anchor the decision was PRESENTED against — what the block showed, not
  // what the human was thinking about, consistent with `recommended` sitting beside
  // `decision`. Read by ladderSpent; the only one of the three new fields with a consumer.
  anchor?: string
  // D121. What the block recommended and which rule produced it. Never read by any gate
  // predicate — `status` aggregates them (D130) and nothing else touches them.
  recommended?: string
  rule?: string
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/recommend.test.ts -t "Recurrence\|anchorRecurrence\|ladderSpent" --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rounds.ts tests/recommend.test.ts
git commit -m "feat(rounds): recurrence grade and ladder-spent, two memories (D123)"
```

---

### Task 3: The ordered rule table

**Files:**
- Modify: `src/recommend.ts`
- Test: `tests/recommend.test.ts`

**Interfaces:**
- Consumes: `Option`/`Decision` (Task 1), `anchorRecurrence`/`ladderSpent` (Task 2), `liveExits`, `boundReached`, `repairGranted`, `notePrefill`, `lastGateRun`.
- Produces:

```ts
export interface GateContext {
  gate: string
  target: string
  entries: Entry[]
  upstream: string | undefined
  stale: boolean
}
export function recommend(ctx: GateContext): Decision | undefined
```

`undefined` means no decision exists at this state (nothing pending, or stale below the bound where the only act is a re-gate — the caller renders that act itself).

- [ ] **Step 1: Write the failing test — one case per rule**

Append to `tests/recommend.test.ts`:

```ts
import { recommend } from '../src/recommend.js'

const ctxFor = (entries: Entry[], over: Partial<{ upstream: string; stale: boolean }> = {}) => ({
  gate: 'plan', target: 'p1', entries, upstream: over.upstream ?? 'auth-refresh', stale: over.stale ?? false,
})

describe('the rule table is ordered and total', () => {
  it('blocking-here: one blocking finding anchored in this artifact', () => {
    const d = recommend(ctxFor([run(1, 'a', 'p1 > ## Step: s1')]))!
    expect(d.rule).toBe('blocking-here')
    expect(d.options[0]!.command).toContain('--revise --note')
    expect(d.options[0]!.depth).toBe('root')
    expect(d.anchor).toBe('p1 > ## Step: s1')
  })

  it('blocking-parent: every blocking anchor names the parent', () => {
    const d = recommend(ctxFor([run(1, 'a', 'auth-refresh > ## Behavior')]))!
    expect(d.rule).toBe('blocking-parent')
    expect(d.options[0]!.command).toContain('--revise --upstream auth-refresh')
  })

  it('anchor-recurrence-2: escalates, and patch-again drops to alternative', () => {
    const d = recommend(ctxFor([run(1, 'a', 'p1 > ## Step: s1'), run(2, 'b', 'p1 > ## Step: s1')]))!
    expect(d.rule).toBe('anchor-recurrence-2')
    expect(d.options[0]!.command).toContain('--revise --upstream auth-refresh')
    expect(d.options[1]!.command).toContain('--revise --note')
  })

  it('ladder-spent: upstream already taken for this anchor', () => {
    const e = [run(1, 'a', 'S'), decision('revise-upstream', { anchor: 'S' }),
      run(2, 'b', 'S'), run(3, 'c', 'S'), run(4, 'd', 'S')]
    const d = recommend(ctxFor(e))!
    expect(d.rule).toBe('ladder-spent')
    expect(d.options[0]!.command).toContain('--stop')
    expect(d.options[0]!.depth).toBe('terminal')
    expect(d.options[1]!.depth).toBe('deferral')
    expect(d.options[1]!.tradeoff).toBeTruthy()
  })

  it('non-blocking-only: approve', () => {
    const r = run(1, 'a', 'S')
    ;(r as any).verdicts[0].findings[0].blocking = false
    const d = recommend(ctxFor([r]))!
    expect(d.rule).toBe('non-blocking-only')
    expect(d.options[0]!.command).toBe('witness decide plan p1 --approve')
  })

  it('reserved-stop-clean: approve with judge-first', () => {
    const r = run(1, 'a', 'S')
    ;(r as any).verdicts[0].findings = []
    ;(r as any).standing = 'ship always stops'
    const d = recommend({ ...ctxFor([r]), gate: 'ship' })!
    expect(d.rule).toBe('reserved-stop-clean')
    expect(d.options[0]!.judgeFirst).toBeTruthy()
  })

  it('manual-stop: green, no standing stop, stopped anyway', () => {
    const r = run(1, 'a', 'S')
    ;(r as any).verdicts[0].findings = []
    ;(r as any).manual = true
    const d = recommend(ctxFor([r]))!
    expect(d.rule).toBe('manual-stop')
    expect(d.options[0]!.command).toBe('witness decide plan p1 --approve')
    expect(d.options[0]!.judgeFirst).toBeUndefined()
    expect(d.options[0]!.why).toContain('--manual')
  })

  it('every option carrying deferral depth names a discharge', () => {
    const e = [run(1, 'a', 'S'), decision('revise-upstream', { anchor: 'S' }),
      run(2, 'b', 'S'), run(3, 'c', 'S'), run(4, 'd', 'S')]
    for (const o of recommend(ctxFor(e))!.options) {
      if (o.depth === 'deferral') expect(o.note ?? o.tradeoff).toMatch(/discharge|obligation|until/i)
    }
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/recommend.test.ts -t "rule table" --poolOptions.forks.maxForks=4`
Expected: FAIL — `recommend` is not exported.

- [ ] **Step 3: Implement the table**

Append to `src/recommend.ts`:

```ts
import { readStream } from './journal.js'
import type { Entry } from './journal.js'
import {
  ROUND_BOUND, anchorRecurrence, boundReached, fellBack, ladderSpent, lastGateRun,
  liveExits, notePrefill, repairGranted, roundBudget, roundsSinceApprove,
  type GateRunEntry,
} from './rounds.js'

export interface GateContext {
  gate: string
  target: string
  entries: Entry[]
  upstream: string | undefined
  stale: boolean
}

const RESERVED = new Set(['ship', 'design'])

const blockingAnchors = (r: GateRunEntry): string[] =>
  (r.verdicts ?? []).flatMap((rv) => rv.findings.filter((f) => f.blocking)
    .map((f) => (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`)))

const opt = (command: string, depth: Depth, rest: Partial<Option> = {}): Option =>
  ({ command, depth, runnable: !/<[^>]+>/.test(command), ...rest })

// The rule table is an ORDERED FIRST-MATCH list (D121). The id of the rule that matched is
// what the journal records, so a wrong recommendation is attributable to one line here
// rather than to a weighting — and each rule is testable from one journal state.
// Order: malformed · stale-below-bound · ladder-spent · bound+recurrence · bound ·
//        recurrence · pin-contradiction · blocking-parent · blocking-here ·
//        non-blocking-only · reserved-stop-clean · manual-stop
export function recommend(ctx: GateContext): Decision | undefined {
  const { gate, target, entries, upstream, stale } = ctx
  const last = lastGateRun(entries, gate)
  if (!last) return undefined

  const d = `witness decide ${gate} ${target}`
  const up = upstream === undefined ? `${d} --revise --upstream <effort>` : `${d} --revise --upstream ${upstream}`
  const note = `${d} --revise --note "${notePrefill(entries, gate)}"`
  const atBound = boundReached(entries, gate)
  const budget = roundBudget(entries, gate)
  const spent = roundsSinceApprove(entries, gate)
  const rounds = `round ${spent} of ${budget}`

  const stopOpt = opt(`${d} --stop`, 'terminal', {
    when: 'this work should not continue as scoped',
    tradeoff: 'parks the flow — next stops offering it and reopening is an explicit act',
  })
  const overrideOpt = opt(`${d} --approve --override`, 'deferral', {
    when: 'you have read the finding and judge it wrong',
    tradeoff: 'stamps the artifact over a live blocking finding; mints an obligation that stays open in status until a later battery no longer reports it (the discharge)',
  })
  const repairOpt = opt(`${d} --revise --repair`, 'deferral', {
    when: 'the edit you just made is the fix and you want it verified rather than assumed',
    tradeoff: 'buys exactly one round; the discharge is that round passing, and the grant does not refresh until an approve, a revise-upstream or a passed run',
  })

  // 1 — malformed. D126 removed it from pendingDecision, so reaching here means a caller
  // asked anyway; answer with the acts that actually help rather than four dispositions.
  if (last.outcome === 'malformed') {
    return {
      key: 'next', rule: 'malformed-rerun',
      options: [
        opt(`witness gate ${gate} ${target}`, 'root', {
          why: `the battery emitted ${last.malformed?.length ?? 0} schema violation(s) and no verdict — this round judged nothing, and malformed rounds do not spend the budget, so re-running is free`,
          note: 'a second malformed round on the same pin and prompts trips malformed-streak, which names the config remedy',
        }),
        opt(`witness calibrate ${last.model} --only ${gate}`, 'root', {
          when: 'the battery has malformed more than once — the lens or the model is at fault, not the artifact',
          tradeoff: 'spends a calibration run; nothing about this artifact changes',
        }),
      ],
    }
  }

  // 2 — stale below the bound: no decision exists, the caller renders the re-gate act.
  if (stale && !atBound) return undefined

  const anchors = blockingAnchors(last)
  const primary = anchors[0]
  const recurrence = primary === undefined ? 0 : anchorRecurrence(entries, gate, primary)
  const spentLadder = primary !== undefined && ladderSpent(entries, gate, primary)

  // 3 — the ladder is spent for this anchor.
  if (primary !== undefined && spentLadder && recurrence >= 1) {
    return {
      key: 'decide', rule: 'ladder-spent', anchor: primary,
      options: [
        { ...stopOpt, why: `${primary} has recurred across budget windows and the upstream reset already happened for it — the stage above was re-authored and the finding survived, so the depth ladder is spent`, when: undefined, tradeoff: undefined },
        { ...overrideOpt, when: 'the recurring finding comes from one lens while the content genuinely changed each round — that pattern is a lens problem, files a lens suspicion rather than a debt against the artifact' },
      ],
    }
  }

  // 4 — at the bound with a recurring anchor: escalate.
  if (atBound && primary !== undefined && recurrence >= 2) {
    return {
      key: 'decide', rule: 'bound-recurrence', anchor: primary,
      options: [
        opt(up, 'root', { why: `${primary} survived ${recurrence} rounds across distinct reviewed shas — patching here has failed every time, and upstream is unspent for this anchor` }),
        overrideOpt,
        ...(repairGranted(entries, gate) ? [] : [repairOpt]),
        stopOpt,
      ],
    }
  }

  // 5 — at the bound otherwise.
  if (atBound) {
    return {
      key: 'decide', rule: stale ? 'bound-stale' : 'bound', anchor: primary,
      options: [
        ...(stale ? [] : [opt(`${d} --approve --override`, 'deferral', {
          why: `the round budget is spent (${spent} of ${budget}) and the gate will not run again; nothing below the bound remains`,
          tradeoff: overrideOpt.tradeoff,
        })]),
        ...(stale ? [opt(up, 'root', { why: `verdict and content disagree, so --approve is not offered — no battery read the current bytes — and the gate will not re-run` })] : [opt(up, 'root', { when: 'the parent artifact is what is wrong' , tradeoff: 'reopens the parent stage and resets this budget' })]),
        ...(repairGranted(entries, gate) ? [] : [repairOpt]),
        stopOpt,
        opt(`witness abandon ${target}`, 'terminal', {
          when: 'this work should be discarded, not parked',
          tradeoff: 'irreversible — unlike --stop, nothing reopens it',
        }),
      ],
    }
  }

  // 6 — recurrence below the bound: escalate, patch-again becomes the alternative.
  if (primary !== undefined && recurrence >= 2) {
    return {
      key: 'decide', rule: `anchor-recurrence-${recurrence}`, anchor: primary,
      options: [
        opt(up, 'root', { why: `${primary} was found in ${recurrence} rounds across distinct reviewed shas — one honest fix already failed at this seam, so the likelier fault is above it` }),
        opt(note, 'root', { when: 'the previous fix was the wrong fix and you now know the right one', tradeoff: `spends ${rounds}; recurring again leaves only the endgame set` }),
        stopOpt,
      ],
    }
  }

  // 7 — a pin contradiction is a standing stop with its own handling.
  const pinned = (last.verdicts ?? []).flatMap((rv) => rv.findings).find((f) => f.contradicts_pin !== undefined)
  if (pinned !== undefined) {
    return {
      key: 'decide', rule: 'pin-contradiction',
      options: [
        opt(note, 'root', { why: `a finding contradicts policy pin #${pinned.contradicts_pin} — the gate escalated the conflict rather than burning a round on it, and only you can settle which side holds` }),
        opt(`${d} --approve`, 'root', { when: 'the pin still holds and the finding is the thing that is wrong', tradeoff: 'the lens will raise it again on the next round unless the pin is restated' }),
        stopOpt,
      ],
    }
  }

  // 8 / 9 — blocking findings, by where they anchor.
  if (anchors.length > 0) {
    const parented = upstream !== undefined && anchors.every((a) => a.startsWith(`${upstream} `) || a.startsWith(`${upstream}>`))
    return parented
      ? {
          key: 'decide', rule: 'blocking-parent', anchor: primary,
          options: [
            opt(up, 'root', { why: `${anchors.length} of ${anchors.length} blocking findings anchor to ${upstream}, not to this artifact — it is faithful to a parent that is wrong` }),
            opt(note, 'root', { when: 'this artifact can route around the parent gap without the parent changing', tradeoff: 'leaves the parent wrong for everything else that derives from it' }),
            stopOpt,
          ],
        }
      : {
          key: 'decide', rule: 'blocking-here', anchor: primary,
          options: [
            opt(note, 'root', { why: `${anchors.length} blocking finding${anchors.length === 1 ? '' : 's'} anchored inside this artifact (${anchors.slice(0, 2).join(', ')}); ${rounds}` }),
            opt(up, 'root', { when: 'the finding is only true because the parent asks for something unbuildable here', tradeoff: 'reopens the parent stage and resets this budget; a wrong upstream spends a whole stage cycle' }),
            stopOpt,
          ],
        }
  }

  const checksFailed = last.checks.filter((c) => !c.ok)
  const nonBlocking = (last.verdicts ?? []).flatMap((rv) => rv.findings).length

  // 10 — non-blocking findings only.
  if (checksFailed.length === 0 && nonBlocking > 0) {
    return {
      key: 'decide', rule: 'non-blocking-only',
      options: [
        opt(`${d} --approve`, 'root', { why: `${nonBlocking} finding${nonBlocking === 1 ? '' : 's'}, none blocking; all ${last.checks.length} checks green` }),
        opt(note, 'root', { when: 'a non-blocking finding is one you want fixed before it becomes load-bearing', tradeoff: `spends ${rounds} on findings the battery already judged non-blocking` }),
        stopOpt,
      ],
    }
  }

  // 11 — a reserved stop with clean evidence.
  if (checksFailed.length === 0 && last.standing !== undefined) {
    return {
      key: 'decide', rule: 'reserved-stop-clean',
      options: [
        opt(`${d} --approve`, 'root', {
          why: `${last.checks.length} of ${last.checks.length} checks green, 0 findings — approve is what the evidence supports`,
          judgeFirst: RESERVED.has(gate)
            ? (gate === 'ship'
              ? 'whether this change should exist. The lenses judged the code against the plan; nothing judged the plan against the product, and no lens can'
              : 'the look itself — the critic judged canon-compliance and coverage, not whether this is the right design')
            : 'whether this cut is how you would ship it. Coverage is checked; the shape of the cut is not',
        }),
        opt(note, 'root', { when: 'the evidence is right and the thing itself is wrong', tradeoff: `costs ${rounds}; the gate re-runs on your edit` }),
        stopOpt,
      ],
    }
  }

  // 12 — stopped, clean, no standing stop: the --manual flag is the only reason.
  return {
    key: 'decide', rule: 'manual-stop',
    options: [
      opt(`${d} --approve`, 'root', {
        why: `${last.checks.length - checksFailed.length} of ${last.checks.length} checks green, 0 blocking findings — nothing in the evidence stopped this round; the stop is the --manual flag armed for this run`,
      }),
      opt(note, 'root', { when: 'you armed --manual because you expect the battery to miss something and you can name it', tradeoff: `spends ${rounds} on a round the evidence passed` }),
      stopOpt,
    ],
  }
}
```

- [ ] **Step 4: Run the rule-table tests**

Run: `npx vitest run tests/recommend.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recommend.ts tests/recommend.test.ts
git commit -m "feat(recommend): the ordered first-match rule table (D121, D123)"
```

---

### Task 4: Every decision surface renders the block

**Files:**
- Modify: `src/gate.ts` (`renderGateRun`, the bound branches, `changed-nothing`)
- Modify: `src/verbs/decide.ts` (`renderBound`, `--show`)
- Modify: `src/ship.ts` (awaiting-decision)
- Test: `tests/recommend.test.ts`

**Interfaces:**
- Consumes: `recommend`, `renderDecision`, and each site's already-resolved `upstreamId` from 0.10.1.
- Produces: the `help:`/`exits:` lines are replaced by block lines at every gate surface. `liveExits` remains for `next`'s bound rows and `reopenCommand`.

- [ ] **Step 1: Write the failing test**

Append to `tests/recommend.test.ts`:

```ts
import { approve, fakeScenario, gateEnv, putVerdict, seededRepo, writePlan, writeSpec } from './helpers.js'

const BLOCKING = {
  coverage: [
    { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
    { anchor: 'auth-refresh > ## Behavior', note: 'read' },
  ],
  findings: [{ blocking: true, anchor: 'auth-refresh-plan-1 > ## Step: s1', claim: 'step is untestable' }],
}

async function stopped() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  const scenario = fakeScenario()
  putVerdict(scenario, BLOCKING)
  const g = await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
  return { repo, gateOut: g.stdout }
}

describe('every decision surface renders the block', () => {
  it('the gate stop and decide --show both carry ranked options and a run: line', async () => {
    const { repo, gateOut } = await stopped()
    const show = (await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--show'])).stdout
    for (const out of [gateOut, show]) {
      expect(out).toMatch(/decide: \d+ options · 1 is recommended/)
      expect(out).toContain('1 · recommended · root')
      expect(out).toContain('   why: ')
      expect(out).toMatch(/^run: witness decide plan auth-refresh-plan-1 /m)
      expect(out).not.toContain('<id>')
    }
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/recommend.test.ts -t "every decision surface" --poolOptions.forks.maxForks=4`
Expected: FAIL — the surfaces still print `help:`/`exits:` lines.

- [ ] **Step 3: Render the block in `renderGateRun`**

In `src/gate.ts`, replace the help line (the `liveExits` call added in 0.10.1):

```ts
    // D121: the exits line stated which commands would not refuse and never which to take,
    // so --approve read as the default at stops with a live blocking finding. The block
    // ranks them. `undefined` means no decision exists at this state — the caller owns
    // rendering the act instead.
    if (opts.help !== false) {
      const d = recommend({ gate: entry.gate, target: entry.artifact, entries, upstream: opts.upstream, stale: false })
      if (d) renderDecision(d).forEach((l) => ctx.out(l))
      else ctx.out(cmd('help', liveExits(entry.gate, entry.artifact, entries, false, opts.upstream)))
    }
```

Apply the same replacement at `gate.ts`'s two bound branches and the `changed-nothing` branch (all three currently call `cmd('help', liveExits(...))` after 0.10.1). Each already has `upstreamId` in scope.

- [ ] **Step 4: Render the block in `decide.ts`**

`renderBound` — replace the exits line:

```ts
  const d = recommend({ gate, target, entries, upstream, stale })
  if (d) renderDecision(d).forEach((l) => ctx.err(l))
  else ctx.err(cmd('exits', liveExits(gate, target, entries, stale, upstream)))
```

`--show`'s pending branch (after `renderGateRun(…, { entries, help: false, upstream: upstreamId })`) — replace its exits line with the same pattern using `ctx.out`. The reopened and settled branches keep their existing shape: a reopened gate's decision is "run the gate", and a settled one is terminal.

- [ ] **Step 5: Render the block in `ship.ts`'s awaiting-decision**

```ts
  if (phase === 'awaiting-decision') {
    ctx.out(kv('ship', `${planId} awaits the ship decision`))
    const up = gateSpec('ship')?.upstreamOf?.(root, canon, planId)
    const d = recommend({ gate: 'ship', target: planId, entries, upstream: up, stale: false })
    if (d) renderDecision(d).forEach((l) => ctx.out(l))
    else ctx.out(cmd('help', liveExits('ship', planId, entries, false, up)))
    return EXIT.FINDINGS
  }
```

- [ ] **Step 6: Run the test and the full suite**

Run: `npx vitest run --poolOptions.forks.maxForks=4`
Expected: PASS. Tests asserting the old `help:`/`exits:` shape were pinning a format the block replaces — update them to assert an option row and note each in the commit body. **Do not** delete an assertion that checked a specific command is offered; re-express it against the block.

- [ ] **Step 7: Commit**

```bash
git add src/gate.ts src/verbs/decide.ts src/ship.ts tests
git commit -m "feat(gate): every decision surface renders ranked options (D121)"
```

---

### Task 5: `next` and `recover` render their own choices

**Files:**
- Modify: `src/verbs/next.ts` (`multiple ready`, the pending-transaction line)
- Modify: `src/verbs/recover.ts`
- Test: `tests/recommend.test.ts`

**Interfaces:**
- Consumes: `Decision`, `renderDecision`.
- Produces: `readyChoice(...)` in `src/verbs/next.ts` and `recoverChoice(...)` in `src/verbs/recover.ts`, both returning a `Decision`.

- [ ] **Step 1: Write the failing test**

```ts
describe('next and recover rank their own choices', () => {
  it('multiple ready ranks by direct dependents and says what it cannot see', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'token-store')
    await writeSpec(repo, 'auth-refresh', { depends: ['token-store'], ui: true })
    await writeSpec(repo, 'session-index', { depends: ['token-store'] })
    for (const id of ['token-store', 'auth-refresh', 'session-index']) approve(repo, id)
    const n = await repo.cli(['next'])
    if (!n.stdout.includes('choose:')) return          // only asserts when several are ready
    expect(n.stdout).toContain('choose: 3 options · 1 is recommended')
    expect(n.stdout).toContain('token-store')
    expect(n.stdout).toContain('judge-first: ')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/recommend.test.ts -t "next and recover" --poolOptions.forks.maxForks=4`
Expected: FAIL — `next` emits a bare `note: multiple ready — choose: …`.

- [ ] **Step 3: Rank ready specs in `next.ts`**

Replace the `multiple ready — choose` note construction with a `Decision`:

```ts
// D121. Ranked by DIRECT dependents descending — a count a human can check against the
// frontmatter by eye, where a transitive closure would be a number nobody can verify.
// `ui` first as tie-break: the design stage inserts a human-latency step ahead of its plan.
// Spec id last, for determinism.
export function readyChoice(canon: Canon, ready: string[]): Decision {
  const dependents = (id: string) =>
    canon.docs.filter((d) => (d.meta.depends as string[] | undefined)?.includes(id)).length
  const ranked = [...ready].sort((a, b) =>
    dependents(b) - dependents(a) ||
    Number(Boolean(findById(canon, b)?.meta.ui)) - Number(Boolean(findById(canon, a)?.meta.ui)) ||
    a.localeCompare(b))
  const flat = ranked.every((id) => dependents(id) === dependents(ranked[0]!))
  return {
    key: 'choose', rule: 'multiple-ready',
    options: ranked.map((id, i) => {
      const n = dependents(id)
      return {
        command: id, depth: 'root' as const, runnable: true,
        ...(i === 0
          ? {
              why: flat
                ? `the dependency graph does not distinguish these — ranked by ui flag, then by id`
                : `${n} of the ${ready.length} ready specs depend on it directly; planning it later means re-planning them`,
              judgeFirst: 'which slice matters this week. This ranks the dependency graph, which is all the CLI can see — product priority outranks it',
            }
          : {
              when: findById(canon, id)?.meta.ui
                ? 'you want the ui-flagged slice moving early — the design stage adds a human-latency step ahead of its plan'
                : `it has ${n} direct dependent(s) and you would rather start there`,
              tradeoff: n < dependents(ranked[0]!) ? 'its plan may need revision once the more-depended-on slice lands' : 'none material',
            }),
      }
    }),
  }
}
```

Render it where the note was built, and keep the `next:` line itself unchanged — the block is additional, not a replacement for the routing row.

- [ ] **Step 4: Rank the recovery fork in `recover.ts`**

```ts
// The interrupted transaction's own state ranks this: `completeTxn` is idempotent about
// the journal append (it compares the last line), so if the line already landed the write
// finished and only the commit is missing.
export function recoverChoice(root: string, marker: TxnMarker): Decision {
  const items = [...(marker.journal ? [marker.journal] : []), ...(marker.journalMulti ?? [])]
  const landed = items.filter(({ stream, line }) => {
    const p = join(root, journalRel(stream))
    return existsSync(p) && readFileSync(p, 'utf8').split('\n').filter(Boolean).at(-1) === line
  }).length
  const complete = landed === items.length && items.length > 0
  return {
    key: 'recover', rule: complete ? 'txn-write-landed' : 'txn-write-partial',
    options: complete
      ? [
          { command: 'witness recover --complete', depth: 'root', runnable: true,
            why: `${landed} of ${items.length} journal line(s) are already on disk and ${marker.files.length} file(s) are written — the transaction finished and only the state commit is missing; completing makes git match what the journal already records` },
          { command: 'witness recover --rollback', depth: 'root', runnable: true,
            when: 'you no longer want the operation that was interrupted',
            tradeoff: `reverts ${marker.files.length} file(s) and drops the journal append — the operation must be retaken` },
        ]
      : [
          { command: 'witness recover --rollback', depth: 'root', runnable: true,
            why: `only ${landed} of ${items.length} journal line(s) landed — the transaction was interrupted mid-write, and rolling back to a known state is safer than committing a partial one` },
          { command: 'witness recover --complete', depth: 'root', runnable: true,
            when: 'you have inspected the files and the partial state is what you want',
            tradeoff: 'commits a transaction that never finished writing; the journal and the tree may disagree' },
        ],
  }
}
```

Render it in `recover.ts` where the bare `help: witness recover --complete | --rollback` line is printed, and in `next.ts`'s pending-transaction branch.

- [ ] **Step 5: Run the test and the recover suite**

Run: `npx vitest run tests/recommend.test.ts tests/txn*.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/verbs/next.ts src/verbs/recover.ts tests/recommend.test.ts
git commit -m "feat(next): multiple-ready and recovery choices are ranked (D121)"
```

---

### Task 6: The decision records what was recommended

**Files:**
- Modify: `src/verbs/decide.ts` (the write path, around the `DecisionEntry` construction)
- Test: `tests/recommend.test.ts`

**Interfaces:**
- Consumes: `recommend` (Task 3), the `DecisionEntry` fields added in Task 2.
- Produces: every `human-decision` entry written by `decide` carries `recommended` and `rule`, plus `anchor` when the matched rule is anchor-scoped.

- [ ] **Step 1: Write the failing test**

```ts
import { readStream } from '../src/journal.js'

describe('the decision records what was recommended', () => {
  it('journals recommended, rule and anchor', async () => {
    const { repo } = await stopped()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--revise', '--note', 'ok'])
    const d = readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'human-decision').at(-1)! as any
    expect(d.recommended).toBe('revise')
    expect(d.rule).toBe('blocking-here')
    expect(d.anchor).toBe('auth-refresh-plan-1 > ## Step: s1')
  })

  it('records divergence when the human takes another option', async () => {
    const { repo } = await stopped()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])
    const d = readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'human-decision').at(-1)! as any
    expect(d.decision).toBe('stop')
    expect(d.recommended).toBe('revise')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/recommend.test.ts -t "records what was recommended" --poolOptions.forks.maxForks=4`
Expected: FAIL — the fields are absent.

- [ ] **Step 3: Populate the fields at the write path**

In `src/verbs/decide.ts`, before the `entry` construction:

```ts
  // D121. Recorded, never consumed: divergence between what the block recommended and what
  // the human chose is the only feedback loop the recommender has, and without the record
  // it is transcript archaeology. `recommended` is the VERB of option 1 — the shape of
  // `decision` — so the two are directly comparable in a log query.
  const rec = recommend({ gate, target, entries, upstream: upstreamId, stale: false })
  const recommendedVerb = rec?.options[0]?.command.match(/--(approve|revise|stop)/)?.[1]
```

and extend the entry literal:

```ts
    ...(recommendedVerb ? { recommended: recommendedVerb } : {}),
    ...(rec?.rule ? { rule: rec.rule } : {}),
    ...(rec?.anchor ? { anchor: rec.anchor } : {}),
```

Note: `recommended` records the **verb**, not the full command — the full command contains a prefilled note that changes with the findings, which would make two identical recommendations look different in a query.

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/recommend.test.ts -t "records what was recommended" --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/decide.ts tests/recommend.test.ts
git commit -m "feat(decide): journal what the block recommended (D121)"
```

---

### Task 7: `status` reports the recommender's accuracy, and the inertness property

**Files:**
- Modify: `src/verbs/dashboard.ts`
- Test: `tests/recommend.test.ts`

**Interfaces:**
- Consumes: the journal fields from Task 6.
- Produces: `recommenderRows(root: string, canon: Canon): Array<{ rule: string; fired: number; overridden: number }>` exported from `src/verbs/dashboard.ts`.

- [ ] **Step 1: Write the failing test**

```ts
describe('status reports the recommender by rule', () => {
  it('counts firings and overrides, never per-human compliance', async () => {
    const { repo } = await stopped()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])
    const s = await repo.cli(['status'])
    // below the minimum sample the table is suppressed
    expect(s.stdout).not.toContain('recommender')
    expect(s.stdout).not.toMatch(/followed|compliance/i)
  })
})

describe('the new fields are inert', () => {
  it('no gate predicate reads recommended or rule', () => {
    const text = ['rounds.ts', 'gate.ts', 'verbs/next.ts', 'stamp.ts']
      .map((f) => readFileSync(join(__dirname, '..', 'src', f), 'utf8')).join('\n')
    const predicates = text.split('\n').filter((l) =>
      /keyOf|roundsSinceApprove|boundReached|repairGranted|appendKind|gateSettled/.test(l))
    expect(predicates.join('\n')).not.toMatch(/\.recommended|\.rule\b/)
  })
})
```

- [ ] **Step 2: Run it and confirm the second case passes and the first needs the suppression**

Run: `npx vitest run tests/recommend.test.ts -t "recommender\|inert" --poolOptions.forks.maxForks=4`
Expected: the inertness test PASSES immediately (nothing reads the fields yet); the suppression test passes trivially. Both are guards — keep them.

- [ ] **Step 3: Add the aggregation**

```ts
const RECOMMENDER_MIN_SAMPLE = 5

// D130. The subject is THE RULE, never the human: `reserved-stop-clean · fired 9 ·
// overridden 7` says *this rule is wrong*. A per-human compliance figure would be the same
// data with the opposite effect — conformity pressure at exactly the three stops where
// independent judgment is the point. Suppressed below a minimum sample: a percentage over
// three decisions measures nothing and reads as authority.
export function recommenderRows(
  root: string, canon: Canon,
): Array<{ rule: string; fired: number; overridden: number }> {
  const tally = new Map<string, { fired: number; overridden: number }>()
  const streams = [...effortStreams(root), ...canon.docs.map((d) => String(d.meta.id))]
  for (const id of new Set(streams)) {
    for (const e of readStream(root, id)) {
      if (e.t !== 'human-decision') continue
      const d = e as unknown as DecisionEntry & { recommended?: string; rule?: string }
      if (!d.rule || !d.recommended) continue
      const row = tally.get(d.rule) ?? { fired: 0, overridden: 0 }
      row.fired += 1
      if (!d.decision.startsWith(d.recommended)) row.overridden += 1
      tally.set(d.rule, row)
    }
  }
  return [...tally.entries()]
    .filter(([, r]) => r.fired >= RECOMMENDER_MIN_SAMPLE)
    .map(([rule, r]) => ({ rule, ...r }))
    .sort((a, b) => b.overridden - a.overridden || a.rule.localeCompare(b.rule))
}
```

Render it in `status`, after the parked table from Plan A:

```ts
  const rec = recommenderRows(root, canon)
  if (rec.length > 0) {
    rows('recommender', ['rule', 'fired', 'overridden'], rec as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  }
```

Note `d.decision.startsWith(d.recommended)` — `revise-upstream` counts as following a `revise` recommendation only when the recommended command was the upstream one; if this proves too loose in the field, tighten it to compare full verbs and record the change in DESIGN.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/dashboard.ts tests/recommend.test.ts
git commit -m "feat(status): the recommender's accuracy, by rule (D130)"
```

---

### Task 8: The properties

**Files:**
- Test: `tests/recommend.test.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the property tests**

```ts
describe('block properties', () => {
  const states: Array<[string, Entry[]]> = [
    ['blocking-here', [run(1, 'a', 'p1 > ## Step: s1')]],
    ['blocking-parent', [run(1, 'a', 'auth-refresh > ## Behavior')]],
    ['recurrence', [run(1, 'a', 'p1 > ## Step: s1'), run(2, 'b', 'p1 > ## Step: s1')]],
    ['bound', [run(1, 'a', 'S'), run(2, 'b', 'S2'), run(3, 'c', 'S3')]],
  ]

  it('exactly one rule matches, and every recommendation is runnable', () => {
    for (const [name, entries] of states) {
      const d = recommend(ctxFor(entries))
      expect(d, name).toBeDefined()
      expect(d!.rule, name).toBeTruthy()
      expect(d!.options[0]!.runnable, name).toBe(true)
      expect(d!.options[0]!.command, name).not.toMatch(/<[^>]+>/)
    }
  })

  it('every option appears once and every deferral names a discharge', () => {
    for (const [name, entries] of states) {
      const d = recommend(ctxFor(entries))!
      const commands = d.options.map((o) => o.command)
      expect(new Set(commands).size, name).toBe(commands.length)
      for (const o of d.options) {
        if (o.depth === 'deferral') expect(`${o.tradeoff ?? ''}${o.note ?? ''}`, `${name}/${o.command}`).toMatch(/discharge|obligation|until|grant/i)
      }
    }
  })

  it('the recommendation is always a member of the live set', () => {
    for (const [name, entries] of states) {
      const d = recommend(ctxFor(entries))!
      const live = liveExits('plan', 'p1', entries, false, 'auth-refresh')
      const flag = d.options[0]!.command.replace('witness decide plan p1 ', '').split(' "')[0]
      expect(live, name).toContain(flag.split(' ').slice(0, 2).join(' '))
    }
  })
})
```

- [ ] **Step 2: Run them**

Run: `npx vitest run tests/recommend.test.ts -t "block properties" --poolOptions.forks.maxForks=4`
Expected: PASS. A failure names the rule and the property — fix the rule, never the property.

- [ ] **Step 3: Run the whole suite one last time**

Run: `npx tsc --noEmit && npx biome check src tests && npx vitest run --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/recommend.test.ts
git commit -m "test(recommend): runnability, uniqueness, discharge and liveness as properties (D121, D129)"
```

---

## Self-Review

**Spec coverage.** D121 — Tasks 1 (model/renderer), 3 (ordered table incl. `manual-stop` and `reserved-stop-clean` with `judge-first`), 4 (gate surfaces), 5 (`next`, `recover`), 6 (journal fields). D123 — Task 2 (two memories) and Task 3's rules 3, 4, 6. D129's flagged half — Task 1 (`runnable`, the suppressed `run:` line) and Task 8's property. D130 — Task 7. D126's *live acts* half — Task 3's rule 1, which returns `witness gate` and `witness calibrate` rather than `decide` verbs.

**Known gap.** `--revise --note` still prefills from findings only; at a `reserved-stop-clean` or `manual-stop` state `notePrefill` returns `<why>`, so that option renders `runnable: false`. The recommendation at those states is `--approve`, which is runnable, so the property in Task 8 holds — but the alternative carries a placeholder by design, and the flag is how it says so.

**Type consistency.** `Option`/`Decision` field names are used identically in Tasks 1, 3, 5 and 8. `GateContext` is `{ gate, target, entries, upstream, stale }` at every call site. `recommend` returns `Decision | undefined`, and every caller handles `undefined` by falling back to `liveExits`. `recommenderRows` returns exactly the three fields the `rows()` call renders.

**Risk.** Task 3's table is the largest single piece of new logic in the release, and the rules are ordered by hand. Task 8's "exactly one rule matches" property is the guard, but it only covers the four states enumerated there — if the field reports a state that matches no rule, the fall-through is `manual-stop`, which would be a wrong but harmless label rather than a crash. That is the intended failure direction and it is why the table ends with a catch rather than a throw.
