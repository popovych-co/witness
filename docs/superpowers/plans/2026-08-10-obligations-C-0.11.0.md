# Obligations: a deferral names its discharge and the debt is state (D122) — Plan C of 4 for 0.11.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Taking a deferral — `--approve --override` or `--revise --repair` — mints a durable obligation that later batteries must judge with in view, that survives the flow which created it, and that closes by evidence or by an explicit dismissal carrying an enumerated cause.

**Architecture:** A new append-only entry family (`deferral`, `deferral-moved`, `deferral-retyped`, `deferral-discharged`, `deferral-dismissed`) keyed by a minted `d-<8hex>` id; state is a fold over entries carrying that id. Open obligations are injected into every subsequent battery on that artifact, reusing `pinsBlock`'s mechanism and joining `prompts_sha` — worded as the **inverse of a pin**: a pin says *do not re-litigate*, an obligation says *this was deferred; if you can still see it, report it*. When a plan reaches `done` at the lazy stamp, still-open obligations are re-booked onto the parent spec, which outlives it. Nothing is hard-blocked.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥20, vitest (`pool: 'forks'`), biome.

## Global Constraints

- **Part of the 0.11.0 release. Do not bump `package.json` or any payload pin** — Plan D owns the release.
- **Prerequisites: 0.10.1, Plan A and Plan B merged.** This plan consumes Plan B's `Depth` labels and the `anchor` field on `DecisionEntry`. If `src/recommend.ts` does not exist, stop.
- **Nothing here blocks anything.** No refusal, no gate outcome, no routing tier may depend on an open obligation. The bite is the battery injection; a block would be a second refusal for a fact the battery raises itself, and would make `--approve --override` at implement pointless.
- **Append-only.** An obligation's state is never mutated in place — every transition is a new entry in the same fold. This is the same discipline as every other journal fact.
- **All writes go through `withTxn` + `acquireLock`** and land in one state commit, exactly as `satisfy` and `decide` do. A partially written obligation is worse than none.
- **Run the suite with a bounded fork pool:** `npx vitest run --poolOptions.forks.maxForks=4`.
- **One commit per task.**

---

## File Structure

| File | Responsibility |
|---|---|
| `src/deferral.ts` | New. The entry types, `mintDeferral`, `openDeferrals` (the fold), `deferralsBlock` (the injected prompt section), and the reason enum. |
| `src/journal.ts` | `EntryType` gains the five deferral types. |
| `src/verbs/decide.ts` | Mints an obligation when the decision is a deferral. |
| `src/gate.ts` | Injects open obligations into every lens and joins them to `prompts_sha`. |
| `src/stamp.ts` | `lazyStamp` re-books still-open obligations onto the parent spec at `plan → done`. |
| `src/verbs/dismiss.ts` | New verb. |
| `src/cli.ts` | Registers `dismiss`. |
| `src/verbs/dashboard.ts` | Renders the ledger. |
| `src/verbs/next.ts` | Adds the `note:` on rows concerning an artifact carrying open obligations. |
| `tests/deferral.test.ts` | New. |

---

### Task 1: The entry family and the fold

**Files:**
- Create: `src/deferral.ts`
- Modify: `src/journal.ts` (`EntryType`)
- Test: `tests/deferral.test.ts` (create)

**Interfaces:**
- Consumes: `Entry`, `readStream`, `appendEntry` from `src/journal.js`.
- Produces:

```ts
export type DeferralKind = 'artifact-debt' | 'lens-suspicion'
export type DismissCause = 'superseded' | 'lens-retired' | 'judged-wrong'

export interface DeferralEntry {
  v: 1
  t: 'deferral'
  id: string                 // d-<8hex>, stable across the move
  artifact: string
  gate: string
  round: number
  anchor: string
  kind: DeferralKind
  caused_by_run: string      // the gate-run's run_id
  moved_from?: string        // set on the copy written to the parent stream
}

export function newDeferralId(): string
export function openDeferrals(entries: Entry[]): DeferralEntry[]
export function deferralsBlock(open: DeferralEntry[]): string
```

- [ ] **Step 1: Write the failing test**

Create `tests/deferral.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { deferralsBlock, newDeferralId, openDeferrals, type DeferralEntry } from '../src/deferral.js'
import type { Entry } from '../src/journal.js'

const mint = (id: string, over: Partial<DeferralEntry> = {}): Entry => ({
  v: 1, t: 'deferral', id, artifact: 'p1', gate: 'implement', round: 3,
  anchor: 'src/token.ts#rotate', kind: 'artifact-debt', caused_by_run: 'r-1', ...over,
} as unknown as Entry)

describe('newDeferralId', () => {
  it('mints the d-<8hex> shape and does not repeat', () => {
    const a = newDeferralId()
    expect(a).toMatch(/^d-[0-9a-f]{8}$/)
    expect(a).not.toBe(newDeferralId())
  })
})

describe('openDeferrals folds the entry family', () => {
  it('returns a minted obligation', () => {
    expect(openDeferrals([mint('d-1')]).map((d) => d.id)).toEqual(['d-1'])
  })

  it('drops one discharged by evidence', () => {
    const e = [mint('d-1'), { v: 1, t: 'deferral-discharged', id: 'd-1' } as unknown as Entry]
    expect(openDeferrals(e)).toEqual([])
  })

  it('drops one dismissed', () => {
    const e = [mint('d-1'), { v: 1, t: 'deferral-dismissed', id: 'd-1', cause: 'lens-retired', note: 'x' } as unknown as Entry]
    expect(openDeferrals(e)).toEqual([])
  })

  it('drops one that moved away from this stream', () => {
    const e = [mint('d-1'), { v: 1, t: 'deferral-moved', id: 'd-1', to: 'auth-refresh' } as unknown as Entry]
    expect(openDeferrals(e)).toEqual([])
  })

  it('honors a retype', () => {
    const e = [mint('d-1', { kind: 'lens-suspicion' }),
      { v: 1, t: 'deferral-retyped', id: 'd-1', kind: 'artifact-debt' } as unknown as Entry]
    expect(openDeferrals(e)[0]!.kind).toBe('artifact-debt')
  })

  it('keeps two obligations on the same anchor distinct', () => {
    expect(openDeferrals([mint('d-1'), mint('d-2')]).length).toBe(2)
  })
})

describe('deferralsBlock is the inverse of a pin', () => {
  it('solicits findings rather than suppressing them', () => {
    const text = deferralsBlock([mint('d-1') as unknown as DeferralEntry])
    expect(text).toContain('src/token.ts#rotate')
    expect(text).toMatch(/report/i)
    expect(text).toMatch(/silence/i)
    expect(text).not.toMatch(/do not re-litigate/i)
  })

  it('is empty for no obligations', () => {
    expect(deferralsBlock([])).toBe('')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/deferral.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — `src/deferral.ts` does not exist.

- [ ] **Step 3: Create `src/deferral.ts`**

```ts
import { randomBytes } from 'node:crypto'
import type { Entry } from './journal.js'

export type DeferralKind = 'artifact-debt' | 'lens-suspicion'
export type DismissCause = 'superseded' | 'lens-retired' | 'judged-wrong'
export const DISMISS_CAUSES: readonly DismissCause[] = ['superseded', 'lens-retired', 'judged-wrong']

export interface DeferralEntry {
  v: 1
  t: 'deferral'
  id: string
  artifact: string
  gate: string
  round: number
  anchor: string
  kind: DeferralKind
  caused_by_run: string
  moved_from?: string
}

// D122. A minted id, never a derived ordinal: the debt is re-booked onto the parent spec
// when its flow completes, and a per-stream ordinal renumbers when it changes homes — so
// "how long has this been open" becomes unanswerable across the move, and age is the only
// thing separating a fresh deferral from a chronic one. Same shape as `newRunId`.
export const newDeferralId = (): string => `d-${randomBytes(4).toString('hex')}`

// State is an append-only FOLD, never a mutation: `deferral` opens, `deferral-moved`
// closes it on THIS stream (it continues on another), `deferral-retyped` changes only its
// kind, and discharge/dismiss close it for good.
export function openDeferrals(entries: Entry[]): DeferralEntry[] {
  const open = new Map<string, DeferralEntry>()
  for (const e of entries) {
    const id = typeof e.id === 'string' ? e.id : undefined
    if (id === undefined) continue
    if (e.t === 'deferral') open.set(id, e as unknown as DeferralEntry)
    else if (e.t === 'deferral-moved' || e.t === 'deferral-discharged' || e.t === 'deferral-dismissed') open.delete(id)
    else if (e.t === 'deferral-retyped') {
      const cur = open.get(id)
      if (cur) open.set(id, { ...cur, kind: e.kind as DeferralKind })
    }
  }
  return [...open.values()]
}

// Injected into every lens, exactly as `pinsBlock` is, and joined to `prompts_sha` so a new
// obligation invalidates the verdict cache and the next round cannot judge without it.
// Deliberately the INVERSE of a pin: a pin tells reviewers not to re-litigate, this tells
// them to report the thing if it is still there. Pins suppress findings; obligations
// solicit them — which is what makes the discharge automatic and evidence-shaped.
export function deferralsBlock(open: DeferralEntry[]): string {
  if (open.length === 0) return ''
  return '## Open deferrals (human overrides — report these if they still hold)\n\n' +
    'A human approved this artifact over the findings below rather than fixing them. They are ' +
    'NOT settled policy and they are NOT pins. If the defect is still present, report it as a ' +
    'finding and anchor it exactly as listed. If it is gone, say so in your coverage. Silence ' +
    'is read as "still present".\n\n' +
    open.map((d, i) => `${i + 1}. ${d.anchor} — ${d.gate} round ${d.round} (${d.id})`).join('\n') + '\n\n'
}
```

- [ ] **Step 4: Register the entry types**

In `src/journal.ts`, extend `EntryType`:

```ts
  | 'dispatch' | 'policy-pin'
  | 'deferral' | 'deferral-moved' | 'deferral-retyped' | 'deferral-discharged' | 'deferral-dismissed'
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/deferral.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add src/deferral.ts src/journal.ts tests/deferral.test.ts
git commit -m "feat(deferral): the entry family, the fold and the inverted pin block (D122)"
```

---

### Task 2: Taking a deferral mints an obligation

**Files:**
- Modify: `src/verbs/decide.ts`
- Test: `tests/deferral.test.ts`

**Interfaces:**
- Consumes: `newDeferralId`, `DeferralEntry` (Task 1); the anchoring run and `upstreamId` already in scope in `decide.ts`.
- Produces: `--approve --override` and `--revise --repair` each append one `deferral` entry per blocking anchor on the anchoring run, inside the same transaction as the decision.

- [ ] **Step 1: Write the failing test**

```ts
import { approve, fakeScenario, gateEnv, putVerdict, seededRepo, writePlan, writeSpec } from './helpers.js'
import { readStream } from '../src/journal.js'

const BLOCKING = {
  coverage: [
    { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
    { anchor: 'auth-refresh > ## Behavior', note: 'read' },
  ],
  findings: [{ blocking: true, anchor: 'auth-refresh-plan-1 > ## Step: s1', claim: 'untestable' }],
}
const STEPS = { steps: [{ id: 's1', title: 'rotate', criteria: ['ac-rotate'] }] }

async function atBound() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  const scenario = fakeScenario()
  putVerdict(scenario, BLOCKING)
  for (let i = 1; i <= 3; i++) {
    await writePlan(repo, 'auth-refresh-plan-1', STEPS, `## Step: s1\nAttempt ${i}.\n`)
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
  }
  return repo
}

describe('taking a deferral mints an obligation', () => {
  it('an override at the bound mints one per blocking anchor', async () => {
    const repo = await atBound()
    const r = await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    expect(r.code).toBe(0)
    const minted = readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'deferral')
    expect(minted).toHaveLength(1)
    expect((minted[0] as any).anchor).toBe('auth-refresh-plan-1 > ## Step: s1')
    expect((minted[0] as any).kind).toBe('artifact-debt')
    expect((minted[0] as any).id).toMatch(/^d-[0-9a-f]{8}$/)
    expect(r.stdout).toContain('obligation')
  })

  it('a plain approve mints nothing', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    const scenario = fakeScenario()
    putVerdict(scenario, { ...BLOCKING, findings: [] })
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve'])
    expect(readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'deferral')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/deferral.test.ts -t "mints an obligation" --poolOptions.forks.maxForks=4`
Expected: FAIL — no `deferral` entries.

- [ ] **Step 3: Mint inside `decide`'s transaction**

In `src/verbs/decide.ts`, after `pinEntries` is built:

```ts
  // D122. A deferral is `--approve --override` (ships with the cause alive) or
  // `--revise --repair` (buys a round without answering anything). One obligation per
  // blocking anchor on the run being disposed of, pointing at the run rather than copying
  // its findings — those already have a home. Kind is `lens-suspicion` when every
  // occurrence of the anchor came from ONE lens across genuinely changed content: that
  // pattern is a tool problem, and filing it as an artifact debt sends the human to fix
  // code that was never wrong.
  const deferring = (decision === 'approve' && override) || repair
  const deferralEntries = deferring
    ? [...new Set((anchor.verdicts ?? []).flatMap((rv) => rv.findings.filter((f) => f.blocking)
        .map((f) => (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`))))]
        .map((a) => {
          const lenses = new Set((anchor.verdicts ?? [])
            .filter((rv) => rv.findings.some((f) => f.blocking &&
              (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`) === a))
            .map((rv) => rv.reviewer))
          return {
            v: 1 as const, t: 'deferral' as const, id: newDeferralId(), artifact: target,
            gate, round: anchor.round, anchor: a,
            kind: (lenses.size === 1 && anchorRecurrence(entries, gate, a) >= 2
              ? 'lens-suspicion' : 'artifact-debt') as DeferralKind,
            caused_by_run: anchor.run_id,
          }
        })
    : []
```

Add them to the transaction beside the pins — `journalMulti.push({ stream: target, line: entryLine(d) })` and `appendEntry(root, target, d)` inside `withTxn` — and report each after the commit:

```ts
  for (const d of deferralEntries) {
    ctx.out(kv('obligation', `${d.id} — ${d.anchor} · ${d.kind} · open until a later ${gate} run no longer reports it, or witness dismiss ${target} --deferral ${d.id} --cause <superseded|lens-retired|judged-wrong> --note "<why>"`))
  }
```

Import `newDeferralId`, `type DeferralKind` from `../deferral.js` and `anchorRecurrence` from `../rounds.js`.

- [ ] **Step 4: Run the test and the decide suite**

Run: `npx vitest run tests/deferral.test.ts tests/decide.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/decide.ts tests/deferral.test.ts
git commit -m "feat(decide): a deferral mints its obligation in the same transaction (D122)"
```

---

### Task 3: Open obligations reach the battery

**Files:**
- Modify: `src/gate.ts`
- Test: `tests/deferral.test.ts`

**Interfaces:**
- Consumes: `openDeferrals`, `deferralsBlock` (Task 1).
- Produces: every lens prompt carries the deferrals block, and `prompts_sha` includes it — so minting an obligation invalidates the verdict cache for that artifact.

- [ ] **Step 1: Write the failing test**

```ts
import { promptsSha } from '../src/reviewer.js'

describe('open obligations reach the battery', () => {
  it('a minted obligation changes prompts_sha, so the next round cannot be cached', async () => {
    const repo = await atBound()
    const before = (readStream(repo.root, 'auth-refresh-plan-1')
      .filter((e) => e.t === 'gate-run').at(-1) as any).prompts_sha
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    // re-gate after the override: a new round must be `fresh`, never cached
    await writePlan(repo, 'auth-refresh-plan-1', STEPS, '## Step: s1\nAfter override.\n')
    const scenario = fakeScenario()
    putVerdict(scenario, BLOCKING)
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1', '--fresh'], { env: gateEnv(scenario) })
    const after = (readStream(repo.root, 'auth-refresh-plan-1')
      .filter((e) => e.t === 'gate-run').at(-1) as any).prompts_sha
    expect(after).not.toBe(before)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/deferral.test.ts -t "reach the battery" --poolOptions.forks.maxForks=4`
Expected: FAIL — `prompts_sha` is unchanged; the block is not injected.

- [ ] **Step 3: Inject beside the pins**

In `src/gate.ts`, where `pinsText` is built (`:190`):

```ts
  const pinsText = pinsBlock(pins)
  // D122. Open obligations join the prompt exactly as pins do, and join `prompts_sha` for
  // the same reason: an obligation the battery did not see is an obligation nothing can
  // discharge. Minting one therefore guarantees the next round re-invokes the battery,
  // which is the intended cost of an override rather than an accident of the cache.
  const deferralsText = deferralsBlock(openDeferrals(entries))
```

Compose both into each lens's prompt wherever `pinsText` is used, and extend the key:

```ts
    prompts_sha: promptsSha(lenses, [pinsText, deferralsText].filter((s) => s !== '').join('') || undefined),
```

Import `openDeferrals`, `deferralsBlock` from `./deferral.js`.

- [ ] **Step 4: Run the test and the docs-injection suite**

Run: `npx vitest run tests/deferral.test.ts tests/docs-injection.test.ts tests/gate-plan.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gate.ts tests/deferral.test.ts
git commit -m "feat(gate): open obligations are injected into every battery (D122)"
```

---

### Task 4: An obligation outlives its flow

**Files:**
- Modify: `src/stamp.ts` (`lazyStamp`)
- Test: `tests/deferral.test.ts`

**Interfaces:**
- Consumes: `openDeferrals`, `newDeferralId` is NOT used here — the id is preserved.
- Produces: at `plan → done`, each still-open obligation writes `deferral-moved` on the plan stream and a `deferral` carrying the same `id` and `moved_from` on the parent spec stream, in the merge-stamp transaction.

- [ ] **Step 1: Write the failing test**

```ts
describe('an obligation outlives its flow', () => {
  it('re-books onto the parent spec when the plan reaches done', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    const id = (readStream(repo.root, 'auth-refresh-plan-1').find((e) => e.t === 'deferral') as any).id

    // simulate the merge stamp's effect directly: the plan reaches done
    repo.setMeta('auth-refresh-plan-1', { status: 'in-progress', pr: 7 })
    // ghState fakes the PR as MERGED for lazyStamp
    const scenario = fakeScenario()
    const { ghState } = await import('./helpers.js')
    ghState(scenario, 7, 'MERGED')
    await repo.cli(['status'], { env: gateEnv(scenario) })

    const planStream = readStream(repo.root, 'auth-refresh-plan-1')
    const specStream = readStream(repo.root, 'auth-refresh')
    expect(planStream.some((e) => e.t === 'deferral-moved' && (e as any).id === id)).toBe(true)
    const moved = specStream.find((e) => e.t === 'deferral' && (e as any).id === id) as any
    expect(moved).toBeDefined()
    expect(moved.moved_from).toBe('auth-refresh-plan-1')
    expect(openDeferrals(planStream)).toHaveLength(0)
    expect(openDeferrals(specStream).map((d) => d.id)).toEqual([id])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/deferral.test.ts -t "outlives its flow" --poolOptions.forks.maxForks=4`
Expected: FAIL — nothing moves.

- [ ] **Step 3: Re-book in `lazyStamp`**

In `src/stamp.ts`, inside the merged branch where `planStamp` and `specStamp` are prepared, before the transaction:

```ts
    // D122. The flow that could discharge this obligation is about to disappear: the plan
    // goes `done` and nothing will ever gate it again, so a ship-time override would be
    // undischargeable by construction. The debt moves to the parent spec, which outlives
    // it and which the next effort touching this area will meet. The id is PRESERVED —
    // a debt that is renumbered when it changes homes cannot be aged across the move.
    const carried = openDeferrals(readStream(root, planId))
    const parentId = parent ? String(parent.meta.id) : undefined
    const moves = parentId === undefined ? [] : carried.flatMap((d) => [
      { stream: planId, entry: { v: 1 as const, t: 'deferral-moved' as const, id: d.id, to: parentId } },
      { stream: parentId, entry: { ...d, artifact: parentId, moved_from: planId } },
    ])
```

Add each `moves` entry to the transaction's `journalMulti` and its `files`, and append them inside the `withTxn` callback beside the stamps. Import `openDeferrals` from `./deferral.js` and `readStream` if not already imported.

- [ ] **Step 4: Run the test and the stamp suite**

Run: `npx vitest run tests/deferral.test.ts tests/stamp*.test.ts tests/flows.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stamp.ts tests/deferral.test.ts
git commit -m "feat(stamp): an open obligation re-books onto the parent spec at merge (D122)"
```

---

### Task 5: `witness dismiss`

**Files:**
- Create: `src/verbs/dismiss.ts`
- Modify: `src/cli.ts` (verb table)
- Test: `tests/deferral.test.ts`

**Interfaces:**
- Consumes: `openDeferrals`, `DISMISS_CAUSES` (Task 1).
- Produces: `witness dismiss <artifact> --deferral <id|index> --cause <superseded|lens-retired|judged-wrong> --note "<why>"`, appending one `deferral-dismissed` entry in one transaction.

- [ ] **Step 1: Write the failing test**

```ts
describe('witness dismiss', () => {
  it('closes an obligation by id with an enumerated cause', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    const id = (readStream(repo.root, 'auth-refresh-plan-1').find((e) => e.t === 'deferral') as any).id
    const r = await repo.cli(['dismiss', 'auth-refresh-plan-1', '--deferral', id,
      '--cause', 'lens-retired', '--note', 'plan-critic left the battery'])
    expect(r.code).toBe(0)
    expect(openDeferrals(readStream(repo.root, 'auth-refresh-plan-1'))).toHaveLength(0)
  })

  it('accepts the display index as well as the id', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    const r = await repo.cli(['dismiss', 'auth-refresh-plan-1', '--deferral', '1',
      '--cause', 'judged-wrong', '--note', 'the finding is wrong'])
    expect(r.code).toBe(0)
  })

  it('refuses without a cause, with the enum in want', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    const r = await repo.cli(['dismiss', 'auth-refresh-plan-1', '--deferral', '1', '--note', 'x'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('cause-required')
    expect(r.stderr).toContain('superseded')
  })

  it('refuses an unknown id and an already-closed one by name', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    const bad = await repo.cli(['dismiss', 'auth-refresh-plan-1', '--deferral', 'd-deadbeef',
      '--cause', 'superseded', '--note', 'x'])
    expect(bad.stderr).toContain('unknown-deferral')
    const id = (readStream(repo.root, 'auth-refresh-plan-1').find((e) => e.t === 'deferral') as any).id
    await repo.cli(['dismiss', 'auth-refresh-plan-1', '--deferral', id, '--cause', 'superseded', '--note', 'x'])
    const again = await repo.cli(['dismiss', 'auth-refresh-plan-1', '--deferral', id, '--cause', 'superseded', '--note', 'x'])
    expect(again.stderr).toContain('already-dismissed')
  })

  it('refuses without a note', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    const r = await repo.cli(['dismiss', 'auth-refresh-plan-1', '--deferral', '1', '--cause', 'superseded'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('note-required')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/deferral.test.ts -t "witness dismiss" --poolOptions.forks.maxForks=4`
Expected: FAIL — unknown verb.

- [ ] **Step 3: Create `src/verbs/dismiss.ts`**

```ts
import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { DISMISS_CAUSES, openDeferrals, type DismissCause } from '../deferral.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { appendEntry, entryLine, journalRel, readStream, streamExists } from '../journal.js'
import { acquireLock } from '../lock.js'
import { renderRefusal, v } from '../refusal.js'
import { kv } from '../toon.js'
import { guardTxn, withTxn } from '../txn.js'

// D122. A SEPARATE verb, not a `decide` flag: an obligation outlives its gate — it is
// re-booked onto the parent spec when the flow completes — and `decide <gate> <target>`
// cannot address a debt whose gate is finished and whose target is `done`. Shaped on
// `witness satisfy`: id, ordinal-or-name, a required reason, one transaction.
export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { deferral: { type: 'string' }, cause: { type: 'string' }, note: { type: 'string' } },
    allowPositionals: true,
  })
  const artifact = positionals[0]
  if (!artifact || !values.deferral) {
    ctx.err('usage: witness dismiss <artifact> --deferral <id|index> --cause <superseded|lens-retired|judged-wrong> --note "<why>"')
    return EXIT.REFUSED
  }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  if (!streamExists(root, artifact)) {
    renderRefusal([v('artifact', 'unknown-stream', artifact, 'an id with a journal stream')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const entries = readStream(root, artifact)
  const open = openDeferrals(entries)
  const byIndex = /^[0-9]+$/.test(values.deferral) ? open[Number(values.deferral) - 1] : undefined
  const target = byIndex ?? open.find((d) => d.id === values.deferral)
  if (!target) {
    // `already-dismissed` is named separately from `unknown-deferral` and
    // `already-discharged` because they call for different next acts, and because a
    // discharge is the GOOD outcome — reporting it as "unknown" would hide a success.
    const everMinted = entries.some((e) => e.t === 'deferral' && e.id === values.deferral)
    const dismissed = entries.some((e) => e.t === 'deferral-dismissed' && e.id === values.deferral)
    const discharged = entries.some((e) => e.t === 'deferral-discharged' && e.id === values.deferral)
    const rule = dismissed ? 'already-dismissed' : discharged ? 'already-discharged' : 'unknown-deferral'
    renderRefusal([v('--deferral', rule, values.deferral,
      everMinted
        ? 'an obligation still open on this artifact — witness status lists them'
        : `one of: ${open.map((d, i) => `${i + 1}=${d.id}`).join(' · ') || '(none open)'}`)])
      .forEach(ctx.err)
    return EXIT.REFUSED
  }
  if (!values.cause || !DISMISS_CAUSES.includes(values.cause as DismissCause)) {
    renderRefusal([v('--cause', 'cause-required', values.cause ?? '(none)', DISMISS_CAUSES.join(' | '))]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  if (!values.note || values.note.trim() === '') {
    renderRefusal([v('--note', 'note-required', '(empty)',
      'why no battery can close this one — the cause names the class, the note names the case')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const entry = {
    v: 1 as const, t: 'deferral-dismissed' as const, id: target.id, artifact,
    cause: values.cause, note: values.note.trim(),
  }
  const lockR = acquireLock(root)
  if (!lockR.ok) { renderRefusal(lockR.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    const txn = withTxn(root, {
      op: `dismiss(${artifact})`, files: [journalRel(artifact)],
      journalMulti: [{ stream: artifact, line: entryLine(entry as unknown as { t: 'deferral-dismissed'; [k: string]: unknown }) }],
    }, () => {
      appendEntry(root, artifact, entry as unknown as { t: 'deferral-dismissed'; [k: string]: unknown })
      return stateCommit(root, [journalRel(artifact)], `dismiss(${artifact}): ${target.id} ${values.cause}`)
    })
    if (!txn.ok) { renderRefusal(txn.violations).forEach(ctx.err); return EXIT.REFUSED }
  } finally {
    lockR.value()
  }
  ctx.out(kv('dismissed', `${artifact} ${target.id} — ${values.cause}`))
  ctx.out(kv('note', 'evidence never closed this one; the journal records that'))
  return EXIT.OK
}
```

- [ ] **Step 4: Register the verb**

In `src/cli.ts`, add `dismiss` to the verb table beside `satisfy`, following the existing dynamic-import pattern used by its neighbors.

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/deferral.test.ts -t "witness dismiss" --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/verbs/dismiss.ts src/cli.ts tests/deferral.test.ts
git commit -m "feat(dismiss): close an obligation with an enumerated cause (D122)"
```

---

### Task 6: The ledger, and the note in `next`

**Files:**
- Modify: `src/verbs/dashboard.ts`
- Modify: `src/verbs/next.ts`
- Test: `tests/deferral.test.ts`

**Interfaces:**
- Consumes: `openDeferrals`.
- Produces: `deferralRows(root, canon)` in `src/verbs/dashboard.ts`; a `note:` on `next` rows whose artifact (or its parent) carries open obligations.

- [ ] **Step 1: Write the failing test**

```ts
describe('the ledger', () => {
  it('status lists open obligations aged in rounds', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    const s = await repo.cli(['status'])
    expect(s.stdout).toContain('deferrals')
    expect(s.stdout).toContain('artifact-debt')
    expect(s.stdout).toContain('src/token.ts#rotate'.slice(0, 0) + 'auth-refresh-plan-1 > ## Step: s1')
    expect(s.stdout).not.toMatch(/days|weeks|ago/)
  })

  it('next names an open obligation on the row that concerns it', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    const n = await repo.cli(['next'])
    if (n.stdout.includes('auth-refresh-plan-1')) expect(n.stdout).toContain('deferral')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/deferral.test.ts -t "the ledger" --poolOptions.forks.maxForks=4`
Expected: FAIL — no ledger.

- [ ] **Step 3: Add the ledger to `status`**

```ts
// D122. Aged in ROUNDS, never in wall-clock: this CLI has no timestamps anywhere — the
// gate-run entry carries none — so "61 rounds" is derivable and "3 weeks" is not.
export function deferralRows(
  root: string, canon: Canon,
): Array<{ id: string; artifact: string; gate: string; anchor: string; kind: string; age: string }> {
  const streams = new Set([...effortStreams(root), ...canon.docs.map((d) => String(d.meta.id))])
  const out = []
  for (const id of streams) {
    const entries = readStream(root, id)
    for (const d of openDeferrals(entries)) {
      const since = entries.filter((e) => e.t === 'gate-run' && (e as unknown as GateRunEntry).artifact === d.artifact).length - d.round
      out.push({
        id: d.id, artifact: d.artifact, gate: d.gate, anchor: d.anchor, kind: d.kind,
        age: `${Math.max(0, since)} round(s)${d.moved_from ? ` · moved from ${d.moved_from}` : ''}`,
      })
    }
  }
  return out
}
```

Render with `rows('deferrals', ['id', 'artifact', 'gate', 'anchor', 'kind', 'age'], …)` after the parked table.

- [ ] **Step 4: Add the note in `next`**

Where a routing row is built for a plan or spec, append to its note:

```ts
// D122. Orientation, never a ladder tier: routing the human to the dismissal verb would
// teach closure-by-assertion at the one place the design means closure-by-evidence. The
// real bite is the battery injection, which no round can skip.
const owed = openDeferrals(readStream(root, id))
const parentOwed = parentId ? openDeferrals(readStream(root, parentId)) : []
const deferralNote = owed.length + parentOwed.length > 0
  ? `${owed.length + parentOwed.length} open deferral(s) — ${[...owed, ...parentOwed].map((d) => d.id).join(' ')} · witness status`
  : undefined
```

and pass `deferralNote` through the existing `noteOf(...)` composition.

- [ ] **Step 5: Run the suite**

Run: `npx vitest run --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/verbs/dashboard.ts src/verbs/next.ts tests/deferral.test.ts
git commit -m "feat(status): the obligation ledger, and orientation in next (D122)"
```

---

### Task 7: Discharge by evidence

**Files:**
- Modify: `src/gate.ts` (after a run is journaled)
- Test: `tests/deferral.test.ts`

**Interfaces:**
- Consumes: `openDeferrals`.
- Produces: a passing or clean gate run on an artifact appends `deferral-discharged` for every open obligation whose anchor the run did not report.

- [ ] **Step 1: Write the failing test**

```ts
describe('discharge by evidence', () => {
  it('a later run that no longer reports the anchor closes the obligation', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    expect(openDeferrals(readStream(repo.root, 'auth-refresh-plan-1'))).toHaveLength(1)

    await writePlan(repo, 'auth-refresh-plan-1', STEPS, '## Step: s1\nFixed.\n')
    const clean = fakeScenario()
    putVerdict(clean, {
      coverage: [
        { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
        { anchor: 'auth-refresh > ## Behavior', note: 'read' },
      ],
      findings: [],
    })
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1', '--fresh'], { env: gateEnv(clean) })
    expect(openDeferrals(readStream(repo.root, 'auth-refresh-plan-1'))).toHaveLength(0)
  })

  it('a run that still reports the anchor leaves it open', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    await writePlan(repo, 'auth-refresh-plan-1', STEPS, '## Step: s1\nStill broken.\n')
    const scenario = fakeScenario()
    putVerdict(scenario, BLOCKING)
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1', '--fresh'], { env: gateEnv(scenario) })
    expect(openDeferrals(readStream(repo.root, 'auth-refresh-plan-1'))).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/deferral.test.ts -t "discharge by evidence" --poolOptions.forks.maxForks=4`
Expected: FAIL — the obligation stays open.

- [ ] **Step 3: Discharge inside the gate-run transaction**

In `src/gate.ts`, where the `GateRunEntry` is appended, extend the same transaction:

```ts
    // D122. The honest closure: a battery LOOKED and no longer found it. Only a run that
    // actually judged this anchor's artifact can discharge — a malformed round judged
    // nothing and must never close a debt, which is the same reason it does not spend the
    // budget. Silence in a real verdict is the evidence; that is what the injected block
    // tells the reviewer.
    const reported = new Set((entry.verdicts ?? []).flatMap((rv) => rv.findings
      .map((f) => (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`))))
    const discharged = entry.outcome === 'malformed' ? []
      : openDeferrals(entriesNow).filter((d) => !reported.has(d.anchor))
        .map((d) => ({ v: 1 as const, t: 'deferral-discharged' as const, id: d.id, artifact: target, by_run: entry.run_id }))
```

Append each inside the same `withTxn` callback and add their lines to `journalMulti`. Report them:

```ts
    for (const d of discharged) ctx.out(kv('discharged', `${d.id} — no longer reported by this round`))
```

- [ ] **Step 4: Run the test and the full suite**

Run: `npx vitest run --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gate.ts tests/deferral.test.ts
git commit -m "feat(gate): a battery that no longer reports an anchor discharges its obligation (D122)"
```

---

## Self-Review

**Spec coverage.** D122 — Task 1 (entry family, fold, inverted-pin block), 2 (minting, typed), 3 (injection joining `prompts_sha`), 4 (re-booking at merge), 5 (`witness dismiss` with the enumerated cause and the full refusal set), 6 (ledger aged in rounds, `note:` in `next` and explicitly *not* a ladder tier), 7 (discharge by evidence).

**Placeholder scan.** No TBDs. Every refusal rule is named. The one judgement call left to the implementer is where `deferralsText` composes into each lens prompt in Task 3 Step 3 — the existing `pinsText` usage is the template, and there is exactly one such site.

**Type consistency.** `DeferralEntry` field names are identical in Tasks 1, 2, 4, 6 and 7. `openDeferrals` is the only reader of the fold everywhere. `deferralRows` returns exactly the six fields its `rows()` call renders. `newDeferralId` is used only at minting — Task 4 preserves the id deliberately, which is the point of the whole identity decision.

**Risk, stated plainly.** This is the largest and least-probed plan in the set. Two things to watch in the first real run:

1. **Injection cost.** Task 3 makes every override guarantee a full battery re-run on the next round, because `prompts_sha` moves. That is the designed cost, but it will show as tokens in the first field report.
2. **Over-eager discharge.** Task 7 closes an obligation whenever a non-malformed run does not report its anchor. If a lens is dropped from the battery — a class-scaled battery, or a `skipLenses` entry — the anchor cannot be reported and the debt closes without anyone looking. That is a real hole; the narrow fix is to require that the discharging run's battery included the lens that raised the finding. It is not in this plan because the `deferral` entry does not record the lens. **If the first field run shows spurious discharges, add `lens` to the mint in Task 2 and gate the discharge on it** — and record that as a new DESIGN row rather than a quiet patch.
