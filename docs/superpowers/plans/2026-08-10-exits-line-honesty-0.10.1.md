# Exits-line honesty (D119, D120, D129) — 0.10.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the set of decisions witness offers a human come from one place, render as commands that can actually be pasted, and never contain an unresolved placeholder.

**Architecture:** `liveExits` in `src/rounds.ts` is already the single pure function answering *which decisions are legal right now*. Four render sites in CLI code bypass it with hand-copied strings, one renders it through `toon.ts`'s `kv()` which escapes quotes and commas, and its `upstream` argument defaults to the literal string `<id>`. This release routes every site through `liveExits`, gives commands a raw (unescaped) emitter, and adds an `upstreamOf` hook to `GateSpec` so each gate resolves its own upstream id from canon the caller already loaded. No gate outcome, routing rule, or journal field changes.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥20, vitest (`pool: 'forks'`), biome for lint/format.

## Global Constraints

- **Version:** this release is `0.10.1`. `package.json` and the pin inside all 8 payload files move together — the payload is copied verbatim by `installPayload` (`src/install.ts:107`), so a repo whose skills pin `@0.10.0` will never run this CLI until the pin moves.
- **No gate-outcome changes.** Nothing in this release may touch `roundsSinceApprove`, `boundReached`, `repairGranted`, `appendKind`, `keyOf`, `gateSettled`, `pendingDecision`, or any journal entry shape. If a change appears to require one, stop and report — it belongs in 0.11.0.
- **Import specifiers end in `.js`** even for TypeScript sources (`import { kv } from '../toon.js'`). This is an ESM package.
- **Never run `git commit` outside the steps that say to.** Each task ends with exactly one commit.
- **Run the suite with a bounded fork pool:** `npx vitest run --poolOptions.forks.maxForks=4`. The default pool size causes IPC timeouts on this suite and produces false failures.
- **`<why>` is the one placeholder allowed to survive this release**, and only where the anchoring gate-run has no blocking findings and no failed checks. `<id>` and `<effort>` must never appear in any rendered command after Task 4. The flagged-option rendering that would remove `<why>` entirely is D129's other half and ships with the option-row block in 0.11.0.

---

## File Structure

| File | Responsibility after this release |
|---|---|
| `src/toon.ts` | Adds `cmd(key, command)` — a key/value line whose value is emitted raw. Commands only; `kv` keeps escaping everything else. |
| `src/rounds.ts` | `liveExits` gains a required `upstream: string \| undefined` parameter (no default), omits the `--upstream` option when it is `undefined`, adds `witness abandon` at the bound, and prefills `--revise --note` from the anchoring run via a new `notePrefill`. |
| `src/gate.ts` | `GateSpec` gains `upstreamOf`. `renderGateRun` accepts a resolved `upstream` in `opts`. The two bound-hit branches and the `changed-nothing` branch call `liveExits`. |
| `src/gates/{plan,implement,ship,design,decompose}.ts` | Each implements `upstreamOf` for its own gate. |
| `src/ship.ts` | The approve-only line is deleted; awaiting-decision calls `liveExits`. |
| `src/verbs/decide.ts` | Resolves upstream at all five `liveExits` call sites; emits exits through `cmd` instead of `kv`. |
| `src/verbs/next.ts` | Drops the `'<effort>'` fallback; passes `undefined` instead. |
| `tests/exits-line.test.ts` | New. Regression tests per site plus the cross-site property test. |

---

### Task 1: A raw emitter for commands

Commands must not be escaped. `esc` (`src/toon.ts:3`) quotes any value containing `,` or `"`, so `decide --show` renders `exits: "witness decide … --revise --note ""<why>"" …"` — unpasteable — while the same string printed by `gate.ts` through a template literal renders clean.

**Files:**
- Modify: `src/toon.ts`
- Modify: `src/verbs/decide.ts:50`, `:102`, `:124`
- Test: `tests/exits-line.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `cmd(key: string, command: string): string` exported from `src/toon.ts`. Returns `` `${key}: ${command}` `` with no escaping. Later tasks use it wherever a command is printed.

- [ ] **Step 1: Write the failing test**

Create `tests/exits-line.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { cmd, kv } from '../src/rounds.js'   // placeholder import — corrected in step 3
```

That import is deliberately wrong; write the file as follows instead:

```ts
import { describe, expect, it } from 'vitest'
import { cmd, kv } from '../src/toon.js'

describe('cmd emits commands raw', () => {
  it('does not quote a command containing double quotes', () => {
    const line = cmd('exits', 'witness decide plan p1 --revise --note "<why>" | --stop')
    expect(line).toBe('exits: witness decide plan p1 --revise --note "<why>" | --stop')
  })

  it('does not quote a command containing a comma', () => {
    expect(cmd('run', 'witness dismiss s1 --note "a, b"')).toBe('run: witness dismiss s1 --note "a, b"')
  })

  it('kv still escapes non-command values', () => {
    expect(kv('note', 'spent, and an edit forfeits approve')).toBe('note: "spent, and an edit forfeits approve"')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/exits-line.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — `"cmd" is not exported by "src/toon.ts"`.

- [ ] **Step 3: Add `cmd` to `src/toon.ts`**

Append below `kv`:

```ts
// Commands are the one value class that must survive verbatim: `esc` quotes anything
// containing `,` or `"`, and `--revise --note "<why>"` contains both — so the exits line
// reached humans as `exits: "witness decide … --note ""<why>"" …"`, which pastes into a
// shell as an empty --note. The gate printed the same string clean through a template
// literal, so this is one string with two renderings (D120). Structured values keep `kv`.
export function cmd(key: string, command: string): string {
  return `${key}: ${command}`
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/exits-line.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS (3 tests).

- [ ] **Step 5: Switch `decide.ts`'s three exits lines to `cmd`**

In `src/verbs/decide.ts`, add `cmd` to the existing toon import:

```ts
import { cmd, kv, rows } from '../toon.js'
```

Replace all three occurrences of the exits line — at `:50` (inside `renderBound`, which uses `ctx.err`), `:102` (the `--show` reopened branch) and `:124` (the `--show` pending branch):

```ts
ctx.err(cmd('exits', liveExits(gate, target, entries, stale)))
```
```ts
ctx.out(cmd('exits', liveExits(gate, target, entries, stale)))
```
```ts
ctx.out(cmd('exits', liveExits(gate, target, entries, stale)))
```

(The `liveExits` argument list changes in Task 3; leave it alone for now.)

- [ ] **Step 6: Add the end-to-end regression test**

Append to `tests/exits-line.test.ts`:

```ts
import { approve, fakeScenario, gateEnv, putVerdict, seededRepo, writePlan, writeSpec } from './helpers.js'

const BLOCKING = {
  coverage: [
    { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
    { anchor: 'auth-refresh > ## Behavior', note: 'read' },
  ],
  findings: [{ blocking: true, anchor: 'auth-refresh-plan-1 > ## Step: s1', claim: 'step is untestable' }],
}

async function stoppedPlanGate() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  const scenario = fakeScenario()
  putVerdict(scenario, BLOCKING)
  await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
  return repo
}

describe('decide --show prints a pasteable exits line', () => {
  it('does not wrap or double the quotes', async () => {
    const repo = await stoppedPlanGate()
    const s = await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--show'])
    const line = s.stdout.split('\n').find((l) => l.startsWith('exits:'))!
    expect(line).not.toContain('""')
    expect(line.startsWith('exits: "')).toBe(false)
    expect(line).toContain('witness decide plan auth-refresh-plan-1 --approve')
  })
})
```

- [ ] **Step 7: Run the new test plus the existing decide suites**

Run: `npx vitest run tests/exits-line.test.ts tests/decide.test.ts tests/decide-show.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. If `decide-show.test.ts` fails on a quoted-string assertion, that assertion was pinning the defect — update it to the unquoted form and note it in the commit body.

- [ ] **Step 8: Commit**

```bash
git add src/toon.ts src/verbs/decide.ts tests/exits-line.test.ts tests/decide-show.test.ts
git commit -m "fix(toon): commands emit raw, never escaped (D120)"
```

---

### Task 2: Each gate resolves its own upstream

`liveExits`'s `upstream` parameter defaults to the literal `'<id>'`, defended by a comment claiming the gate and decide surfaces cannot resolve it. They can: `decide.ts` loads canon at `:75` and every gate's upstream is a lookup.

**Files:**
- Modify: `src/gate.ts` (the `GateSpec` interface, near `currentSha` at `:65`)
- Modify: `src/gates/plan.ts`, `src/gates/implement.ts`, `src/gates/ship.ts`, `src/gates/design.ts`, `src/gates/decompose.ts`
- Test: `tests/exits-line.test.ts`

**Interfaces:**
- Consumes: `cmd` from Task 1 (not used here).
- Produces: `GateSpec.upstreamOf?(root: string, canon: Canon, target: string): string | undefined` — the id `--revise --upstream` should name for this gate and target. `undefined` means no upstream can be resolved, which Task 3 treats as *the option is not legal*, never as a placeholder.

- [ ] **Step 1: Write the failing test**

Append to `tests/exits-line.test.ts`:

```ts
import { loadCanon } from '../src/scan.js'
import { gateSpec } from '../src/gate.js'
import '../src/gates/index.js'

describe('every gate resolves its own upstream', () => {
  it('plan resolves to the parent spec; implement and ship resolve to the plan', async () => {
    const repo = await stoppedPlanGate()
    const canon = loadCanon(repo.root)
    expect(gateSpec('plan')!.upstreamOf!(repo.root, canon, 'auth-refresh-plan-1')).toBe('auth-refresh')
    expect(gateSpec('implement')!.upstreamOf!(repo.root, canon, 'auth-refresh-plan-1')).toBe('auth-refresh-plan-1')
    expect(gateSpec('ship')!.upstreamOf!(repo.root, canon, 'auth-refresh-plan-1')).toBe('auth-refresh-plan-1')
  })

  it('decompose resolves to the effort itself', async () => {
    const repo = await stoppedPlanGate()
    const canon = loadCanon(repo.root)
    expect(gateSpec('decompose')!.upstreamOf!(repo.root, canon, repo.effort)).toBe(repo.effort)
  })

  it('design resolves to the owning effort, and undefined when none owns it', async () => {
    const repo = await stoppedPlanGate()
    const canon = loadCanon(repo.root)
    expect(gateSpec('design')!.upstreamOf!(repo.root, canon, 'auth-refresh')).toBe(repo.effort)
    expect(gateSpec('design')!.upstreamOf!(repo.root, canon, 'no-such-spec')).toBeUndefined()
  })

  it('plan returns undefined for an unknown plan', async () => {
    const repo = await stoppedPlanGate()
    const canon = loadCanon(repo.root)
    expect(gateSpec('plan')!.upstreamOf!(repo.root, canon, 'no-such-plan')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/exits-line.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — `upstreamOf` is not a property of `GateSpec` (TypeScript error, or `undefined is not a function` at runtime).

- [ ] **Step 3: Declare the hook on `GateSpec`**

In `src/gate.ts`, directly below the `currentSha` declaration (`:65`):

```ts
  // The id `--revise --upstream` names for this gate. Resolved from canon the caller has
  // already loaded — `liveExits` used to default this to the literal string `<id>`, and a
  // default that produces an unrunnable command is how the placeholder reached every
  // screen (D129). `undefined` means no upstream exists, which makes the option ILLEGAL
  // rather than unresolved: `decide` refuses it with `unknown-owner`, so `liveExits` omits
  // it instead of printing a command the CLI would decline.
  upstreamOf?(root: string, canon: Canon, target: string): string | undefined
```

- [ ] **Step 4: Implement it in all five gates**

`src/gates/plan.ts` — add below `currentSha` (`:88-92`):

```ts
  upstreamOf(_root, canon, planId) {
    const plan = findById(canon, planId)
    return plan && plan.meta.type === 'plan' ? String(plan.meta.parent) : undefined
  },
```

`src/gates/implement.ts` and `src/gates/ship.ts` — add below each `currentSha`. The implement and ship gates judge a plan's code, so their upstream is the plan itself (reopening the plan stage):

```ts
  upstreamOf(_root, canon, planId) {
    const plan = findById(canon, planId)
    return plan && plan.meta.type === 'plan' ? planId : undefined
  },
```

`src/gates/decompose.ts` — add below `currentSha` (`:97-99`). Upstream from decompose is the scope itself, which `decide` routes to `witness recap --amend`:

```ts
  upstreamOf(root, _canon, effort) {
    return streamExists(root, effort) ? effort : undefined
  },
```

`src/gates/design.ts` — add below `currentSha` (`:74-80`). Upstream from the design gate is the spec's slicing, which reopens the owning effort's decompose:

```ts
  upstreamOf(root, canon, specId) {
    const spec = findById(canon, specId)
    return spec && spec.meta.type === 'spec' ? effortOf(root, specId) : undefined
  },
```

`design.ts` does not currently import `effortOf`. Add it:

```ts
import { effortOf } from '../reviewed.js'
```

`ship.ts` and `implement.ts` already import `findById`; `decompose.ts` already imports `streamExists`. Verify each import exists before adding a duplicate.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run tests/exits-line.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npx biome check src tests`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/gate.ts src/gates tests/exits-line.test.ts
git commit -m "feat(gate): every gate resolves its own upstream id (D129)"
```

---

### Task 3: `liveExits` requires an upstream, adds `abandon`, prefills the note

**Files:**
- Modify: `src/rounds.ts:188-207`
- Test: `tests/exits-line.test.ts`

**Interfaces:**
- Consumes: `GateSpec.upstreamOf` from Task 2 (callers use it; `liveExits` just receives the result).
- Produces:
  - `liveExits(gate: string, target: string, entries: Entry[], stale: boolean, upstream: string | undefined): string` — the fifth parameter is now **required**, with no default.
  - `notePrefill(entries: Entry[], gate: string): string` — the text to put inside `--note "…"`, or the literal `<why>` when the anchoring run offers no facts.

- [ ] **Step 1: Write the failing test**

Append to `tests/exits-line.test.ts`:

```ts
import { liveExits, notePrefill } from '../src/rounds.js'
import { readStream } from '../src/journal.js'

describe('liveExits', () => {
  it('omits the upstream option when no upstream resolves', async () => {
    const repo = await stoppedPlanGate()
    const entries = readStream(repo.root, 'auth-refresh-plan-1')
    const line = liveExits('plan', 'auth-refresh-plan-1', entries, false, undefined)
    expect(line).not.toContain('--upstream')
    expect(line).toContain('--approve')
  })

  it('names the resolved upstream when one is given', async () => {
    const repo = await stoppedPlanGate()
    const entries = readStream(repo.root, 'auth-refresh-plan-1')
    const line = liveExits('plan', 'auth-refresh-plan-1', entries, false, 'auth-refresh')
    expect(line).toContain('--revise --upstream auth-refresh')
    expect(line).not.toContain('<id>')
  })

  it('prefills the note from the anchoring run findings', async () => {
    const repo = await stoppedPlanGate()
    const entries = readStream(repo.root, 'auth-refresh-plan-1')
    expect(notePrefill(entries, 'plan')).toContain('auth-refresh-plan-1 > ## Step: s1')
    expect(liveExits('plan', 'auth-refresh-plan-1', entries, false, 'auth-refresh')).not.toContain('<why>')
  })

  it('falls back to <why> when the run offers no facts', () => {
    expect(notePrefill([], 'plan')).toBe('<why>')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/exits-line.test.ts -t liveExits --poolOptions.forks.maxForks=4`
Expected: FAIL — `notePrefill` is not exported.

- [ ] **Step 3: Add `notePrefill` above `liveExits` in `src/rounds.ts`**

```ts
const PREFILL_MAX = 120
const PREFILL_ANCHORS = 3

// What goes inside `--revise --note "…"`. An index of the anchoring run, never a judgment:
// the author already receives the whole verdict in `decide`'s revise-context, so this
// exists to make the command runnable (D129), not to tell them anything new. `<why>` is
// the honest fallback when the run holds no facts — a clean standing stop, where the
// reason is the human's and the CLI has none. That placeholder is removed in 0.11.0 by the
// flagged-option rendering, which needs the option-row block to express it.
export function notePrefill(entries: Entry[], gate: string): string {
  const last = lastGateRun(entries, gate)
  if (!last) return '<why>'
  const anchors = (last.verdicts ?? [])
    .flatMap((rv) => rv.findings.filter((f) => f.blocking))
    .map((f) => (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`))
  const unique = [...new Set(anchors)]
  if (unique.length === 0) {
    const failed = last.checks.filter((c) => !c.ok).map((c) => c.name)
    if (failed.length === 0) return '<why>'
    return `failed checks: ${failed.join(', ')}`.slice(0, PREFILL_MAX)
  }
  const shown = unique.slice(0, PREFILL_ANCHORS)
  const more = unique.length - shown.length
  const text = `${unique.length} blocking finding${unique.length === 1 ? '' : 's'}: ` +
    shown.join(', ') + (more > 0 ? ` +${more} more` : '')
  return text.slice(0, PREFILL_MAX)
}
```

- [ ] **Step 4: Rewrite `liveExits`**

Replace the whole function body (`src/rounds.ts:188-207`), keeping the existing comment block above it and appending to it:

```ts
// `upstream` is REQUIRED and has no default: it used to default to the literal `<id>`,
// which shipped an unrunnable command on every screen (D129). `undefined` means no
// upstream exists — `decide` refuses that with `unknown-owner`, so the option is not legal
// and is omitted rather than printed as a placeholder.
export function liveExits(
  gate: string, target: string, entries: Entry[], stale: boolean, upstream: string | undefined,
): string {
  const d = `witness decide ${gate} ${target}`
  const up = upstream === undefined ? [] : [`--revise --upstream ${upstream}`]
  const note = `--revise --note "${notePrefill(entries, gate)}"`
  if (boundReached(entries, gate)) {
    // Row 109: the repair grant is an exit exactly while it is unspent. `witness abandon`
    // joins the set here because the hardcoded branch this replaces printed it (`help: or
    // discard the plan`) and nothing else offers it — and under D124 `--stop` becomes
    // *park*, which would otherwise leave the bound screen with no discarding act at all.
    const repair = repairGranted(entries, gate) ? [] : ['--revise --repair']
    const approve = stale ? [] : ['--approve --override']
    return [`${d} ${[...approve, ...up, ...repair, '--stop'].join(' | ')}`,
      `witness abandon ${target}`].join(' | ')
  }
  if (stale) return `witness gate ${gate} ${target}`
  return `${d} ${['--approve', note, ...up, '--stop'].join(' | ')}`
}
```

Note the shape change: the exits string is built from a list rather than four template literals, so an omitted option leaves no stray `| |`.

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/exits-line.test.ts -t liveExits --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 6: Confirm the compiler now names every unmigrated call site**

Run: `npx tsc --noEmit`
Expected: FAIL with "Expected 5 arguments, but got 4" at `src/gate.ts:144`, `src/verbs/decide.ts:50`, `:102`, `:124`, `:172`, `:265`. This is the intended state — Task 4 fixes them. Do not commit yet.

- [ ] **Step 7: Commit only after Task 4**

This task's code does not compile on its own. Proceed directly to Task 4 and commit both together. (Stated explicitly so nobody "fixes" the build by restoring the default parameter.)

---

### Task 4: Thread the resolved upstream through every call site

**Files:**
- Modify: `src/gate.ts:101-146` (`renderGateRun`)
- Modify: `src/verbs/decide.ts:43-52` (`renderBound`), `:102`, `:124`, `:172`, `:265`
- Modify: `src/verbs/next.ts:389`
- Test: `tests/exits-line.test.ts`

**Interfaces:**
- Consumes: `GateSpec.upstreamOf` (Task 2), `liveExits(…, upstream)` (Task 3).
- Produces: `renderGateRun(ctx, entry, mode, opts)` where `opts` gains `upstream?: string` — the resolved id, supplied by the caller. `renderGateRun` stays a pure formatter and never loads canon itself.

- [ ] **Step 1: Write the failing test**

Append to `tests/exits-line.test.ts`:

```ts
describe('no rendered exits line contains a placeholder', () => {
  it('gate, decide --show and next all name a real upstream', async () => {
    const repo = await stoppedPlanGate()
    const show = await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--show'])
    const next = await repo.cli(['next'])
    for (const out of [show.stdout, next.stdout]) {
      expect(out).not.toContain('<id>')
      expect(out).not.toContain('<effort>')
    }
    expect(show.stdout).toContain('--revise --upstream auth-refresh')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/exits-line.test.ts -t placeholder --poolOptions.forks.maxForks=4`
Expected: FAIL (the build is broken from Task 3; the failure is a compile error naming the unmigrated sites).

- [ ] **Step 3: Give `renderGateRun` the upstream**

In `src/gate.ts`, change the signature (`:101-104`):

```ts
export function renderGateRun(
  ctx: Ctx, entry: GateRunEntry, mode: 'ran' | 'resume',
  opts: { entries?: Entry[]; help?: boolean; upstream?: string } = {},
): void {
```

and the help line (`:144`):

```ts
    if (opts.help !== false) ctx.out(cmd('help', liveExits(entry.gate, entry.artifact, entries, false, opts.upstream)))
```

Add `cmd` to the toon import at the top of `src/gate.ts`.

- [ ] **Step 4: Resolve upstream inside `runGate` and pass it down**

`runGate` already holds `root`, `canon` and `spec`. Immediately after `const input = inputR.value` (`src/gate.ts:181`), add:

```ts
  // Resolved once for every render this run performs — the entry renderers stay pure
  // formatters (they take the id, they never look it up).
  const upstreamId = spec.upstreamOf?.(root, canon, target)
```

Then pass it at both `renderGateRun` call sites inside `runGate` (the `resume` branch at `:272` and the final render): add `upstream: upstreamId` to the `opts` object.

- [ ] **Step 5: Migrate the five `decide.ts` sites**

`renderBound` (`:43-52`) needs the id passed in. Change its signature and its exits line:

```ts
function renderBound(
  ctx: Ctx, gate: string, target: string, entries: Entry[], stale: boolean,
  upstream: string | undefined, note?: string,
): number {
  ctx.err(kv('gate', gate))
  ctx.err(kv('target', target))
  ctx.err(kv('state', `bound reached — ${roundsSinceApprove(entries, gate)} rounds; the gate will not run again`))
  if (note !== undefined) ctx.err(kv('note', note))
  ctx.err(cmd('exits', liveExits(gate, target, entries, stale, upstream)))
  return EXIT.REFUSED
}
```

In `run`, after `const canon = loadCanon(root)` (`:75`), add:

```ts
  const upstreamId = spec.upstreamOf?.(root, canon, target)
```

Then update each site:
- `:102` → `ctx.out(cmd('exits', liveExits(gate, target, entries, stale, upstreamId)))`
- `:124` → `ctx.out(cmd('exits', liveExits(gate, target, entries, stale, upstreamId)))`
- `:117` → `renderGateRun(ctx, last, 'ran', { entries, help: false, upstream: upstreamId })`
- `:172` → `liveExits(gate, target, entries, false, upstreamId)`
- `:265` → `liveExits(gate, target, entries, true, upstreamId)`
- `:209` → `renderBound(ctx, gate, target, entries, nowSha !== undefined && nowSha !== last.reviewed_sha, upstreamId)`
- `:220` → `renderBound(ctx, gate, target, entries, …, upstreamId, 'upstream reopens the parent and resets the budget; --repair buys one more round here')`
- `:399` → `renderGateRun(ctx, anchor, 'ran', { entries, help: false, upstream: upstreamId })`

- [ ] **Step 6: Drop the `'<effort>'` fallback in `next.ts:389`**

```ts
        line: liveExits('design', id, entries, false, effortOf(root, id)),
```

The surrounding `const eff = effortOf(root, id)` becomes unused — remove it, or inline as above.

- [ ] **Step 7: Typecheck, then run the full suite**

Run: `npx tsc --noEmit && npx vitest run --poolOptions.forks.maxForks=4`
Expected: PASS. Tests that asserted `<id>` in an exits line were pinning the defect — update them to the resolved id and note each in the commit body.

- [ ] **Step 8: Commit Tasks 3 and 4 together**

```bash
git add src/rounds.ts src/gate.ts src/verbs/decide.ts src/verbs/next.ts tests
git commit -m "feat(rounds): liveExits requires a resolved upstream, offers abandon at the bound (D119, D129)"
```

---

### Task 5: Collapse `gate.ts`'s hand-copied sets

Round 3 of a gate prints the complete bound set through `liveExits`; round 4 prints a hand-copied one missing `--revise --repair`. Verified by probe — the repair grant row 109 added disappears one round after it becomes relevant.

**Files:**
- Modify: `src/gate.ts:277-292` (`changed-nothing` and the first bound branch), `:423-430` (the second bound branch)
- Test: `tests/exits-line.test.ts`

**Interfaces:**
- Consumes: `liveExits(…, upstream)` (Task 3), `upstreamId` local (Task 4).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `tests/exits-line.test.ts`:

```ts
const STEPS = { steps: [{ id: 's1', title: 'rotate', criteria: ['ac-rotate'] }] }

describe('the bound-hit branch offers the same set as liveExits', () => {
  it('names the repair grant and abandon at round 4', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    const scenario = fakeScenario()
    putVerdict(scenario, BLOCKING)
    let last = ''
    for (let i = 1; i <= 4; i++) {
      await writePlan(repo, 'auth-refresh-plan-1', STEPS, `## Step: s1\nAttempt ${i}.\n`)
      const g = await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
      last = g.stdout
    }
    expect(last).toContain('--revise --repair')
    expect(last).toContain('witness abandon auth-refresh-plan-1')
    expect(last).not.toContain('<id>')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/exits-line.test.ts -t "bound-hit" --poolOptions.forks.maxForks=4`
Expected: FAIL — the round-4 output has no `--revise --repair`.

- [ ] **Step 3: Replace the first bound branch (`src/gate.ts:283-289`)**

```ts
  if (boundReached(entries, spec.gate)) {
    ctx.out(kv('gate', spec.gate))
    ctx.out(kv('outcome', `round bound reached (${roundsSinceApprove(entries, spec.gate)} rounds since last approve)`))
    ctx.out(cmd('help', liveExits(spec.gate, target, entries, false, upstreamId)))
    return EXIT.BLOCKED
  }
```

The `help: or discard the plan: witness abandon …` line is deleted — `liveExits` now carries `abandon` at the bound (Task 3), so keeping it would restore the split this task closes.

- [ ] **Step 4: Replace the second bound branch (`src/gate.ts:423-429`)**

Identical body, using `entriesNow` for the count since that branch re-reads the stream:

```ts
    if (boundReached(entriesNow, spec.gate)) {
      ctx.out(kv('gate', spec.gate))
      ctx.out(kv('outcome', `round bound reached (${roundsSinceApprove(entriesNow, spec.gate)} rounds since last approve)`))
      ctx.out(cmd('help', liveExits(spec.gate, target, entriesNow, false, upstreamId)))
      return EXIT.BLOCKED
    }
```

- [ ] **Step 5: Give `changed-nothing` a real set (`src/gate.ts:277-281`)**

```ts
  if (kind.kind === 'changed-nothing') {
    ctx.out(kv('gate', spec.gate))
    ctx.out(kv('outcome', 'revise changed nothing — reviewed content is identical to the last round'))
    // The owed work is an EDIT, so the exits are the decisions that remain legal without
    // one — the same set every other screen shows, rather than prose naming two of four.
    ctx.out(cmd('help', liveExits(spec.gate, target, entries, false, upstreamId)))
    return EXIT.FINDINGS
  }
```

- [ ] **Step 6: Run the test and the gate suites**

Run: `npx vitest run tests/exits-line.test.ts tests/gate-plan.test.ts tests/decide.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/gate.ts tests/exits-line.test.ts
git commit -m "fix(gate): bound and changed-nothing branches ask liveExits (D119)"
```

---

### Task 6: Collapse `ship.ts`'s two lines

The ship gate phase prints an approve-only line *directly beneath* the gate's own complete one — two answers to one question in consecutive lines — and awaiting-decision prints a third set omitting `--revise --upstream`.

**Files:**
- Modify: `src/ship.ts:224-233`
- Test: `tests/exits-line.test.ts`

**Interfaces:**
- Consumes: `liveExits(…, upstream)`, `gateSpec('ship').upstreamOf`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `tests/exits-line.test.ts`:

```ts
import { runShip } from '../src/ship.js'
import { runGate } from '../src/gate.js'
import { addOrigin, fakeCtx, shippableRepo } from './helpers.js'

const CLEAN = {
  coverage: [
    { anchor: '.gitignore', note: 'read' },
    { anchor: 'package.json', note: 'read' },
    { anchor: 'src/token.ts', note: 'read' },
    { anchor: 'tests/token.test.ts', note: 'read' },
  ],
  findings: [],
}

describe('ship prints one exits set', () => {
  it('gate phase prints no second approve-only line; awaiting-decision names upstream', async () => {
    const seed = await shippableRepo()
    addOrigin(seed.repo)
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const outs: string[] = []
    const ctx = fakeCtx(seed.repo.root, { env: gateEnv(scenario), out: (l) => outs.push(l) })
    await runGate(ctx, 'implement', seed.planId, { fresh: false, manual: false })

    outs.length = 0
    await runShip(ctx, seed.planId)
    const gateHelps = outs.filter((l) => l.startsWith('help:'))
    expect(gateHelps).toHaveLength(1)
    expect(gateHelps[0]).toContain('--revise --upstream')

    outs.length = 0
    await runShip(ctx, seed.planId)
    const awaiting = outs.filter((l) => l.startsWith('help:'))
    expect(awaiting).toHaveLength(1)
    expect(awaiting[0]).toContain('--revise --upstream')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/exits-line.test.ts -t "ship prints one" --poolOptions.forks.maxForks=4`
Expected: FAIL — the gate phase emits 2 help lines; awaiting-decision's has no `--upstream`.

- [ ] **Step 3: Delete the approve-only line and migrate awaiting-decision**

In `src/ship.ts`, add to the toon import: `import { cmd, kv } from './toon.js'`. Then, in the `gate` phase, delete this line entirely (`:226`):

```ts
    ctx.out(`help: witness decide ship ${planId} --approve to send the PR — ship always stops`)
```

The gate's own render already prints the complete set. Replace the awaiting-decision branch (`:229-232`):

```ts
  if (phase === 'awaiting-decision') {
    ctx.out(kv('ship', `${planId} awaits the ship decision`))
    ctx.out(cmd('help', liveExits('ship', planId, entries, false, gateSpec('ship')?.upstreamOf?.(root, canon, planId))))
    return EXIT.FINDINGS
  }
```

Add the imports `liveExits` and `gateSpec` from `./gate.js` if not already present.

- [ ] **Step 4: Run the test and the ship suites**

Run: `npx vitest run tests/exits-line.test.ts tests/ship-lanes.test.ts tests/ship-pr.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. `ship-lanes.test.ts` may assert on the deleted approve-only line — if so it was pinning the duplicate; delete that assertion and note it in the commit body.

- [ ] **Step 5: Commit**

```bash
git add src/ship.ts tests/exits-line.test.ts tests/ship-lanes.test.ts
git commit -m "fix(ship): one exits set per screen (D119)"
```

---

### Task 7: The property test

A sweep alone recurs — `liveExits`'s own comment says it was written to abolish three hand-copied triples, and four were live three releases later. This is the guard that makes the next copy fail.

**Files:**
- Test: `tests/exits-line.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Write the property test**

Append to `tests/exits-line.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', 'src')
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })

describe('no source builds its own exits set', () => {
  it('only rounds.ts composes decision verbs into a set', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      if (file.endsWith(join('src', 'rounds.ts'))) continue
      const text = readFileSync(file, 'utf8')
      for (const [i, line] of text.split('\n').entries()) {
        if (line.trimStart().startsWith('//')) continue
        // A set is two or more decision flags joined by ` | ` in one string literal.
        const flags = (line.match(/--(approve|revise|stop|override|repair)/g) ?? []).length
        if (flags >= 2 && line.includes(' | ')) offenders.push(`${file}:${i + 1}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/exits-line.test.ts -t "no source builds" --poolOptions.forks.maxForks=4`
Expected: PASS. If it names a file, that file is a copy Tasks 5-6 missed — migrate it rather than adding an exemption.

- [ ] **Step 3: Add the placeholder property across live surfaces**

```ts
describe('no rendered command carries an unresolved id', () => {
  it('holds across gate, decide --show, next and status', async () => {
    const repo = await stoppedPlanGate()
    for (const argv of [
      ['decide', 'plan', 'auth-refresh-plan-1', '--show'],
      ['next'],
      ['status'],
    ]) {
      const r = await repo.cli(argv)
      expect(r.stdout, argv.join(' ')).not.toContain('<id>')
      expect(r.stdout, argv.join(' ')).not.toContain('<effort>')
    }
  })
})
```

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run --poolOptions.forks.maxForks=4`
Expected: PASS, with the count at or above the 889 the 0.10.0 release recorded plus the tests added here.

- [ ] **Step 5: Commit**

```bash
git add tests/exits-line.test.ts
git commit -m "test(exits): one home and no placeholders, as properties (D119, D129)"
```

---

### Task 8: Release 0.10.1

The payload is copied verbatim (`src/install.ts:107-129`), so the pin inside each skill file is what selects the CLI a downstream repo runs. Without this task the fixes above reach nobody.

**Files:**
- Modify: `package.json` (`version`)
- Modify: `plugin/commands/witness.md`, `plugin/hooks/session-dashboard.sh`, `plugin/skills/witness-brainstorm/SKILL.md`, `plugin/skills/witness-decompose/SKILL.md`, `plugin/skills/witness-design/SKILL.md`, `plugin/skills/witness-implement/SKILL.md`, `plugin/skills/witness-plan/SKILL.md`, `plugin/skills/witness-ship/SKILL.md` — **8 files**, not the 6 skills plus the command: `plugin/hooks/session-dashboard.sh` carries the pin too and is easy to miss
- Modify: `DESIGN.md` (rows 119, 120, 129 — mark built)

**Interfaces:**
- Consumes: everything above.
- Produces: `@popovych.co/witness@0.10.1`.

- [ ] **Step 1: Verify the current pin count**

Run: `grep -rn "witness@0.10.0" plugin | wc -l`
Expected: `8`. If it is not 8, stop — a payload file was added or removed and this list is stale.

- [ ] **Step 2: Bump the pin in all 8 payload files**

Run:
```bash
grep -rl "witness@0.10.0" plugin | xargs sed -i '' 's/witness@0.10.0/witness@0.10.1/g'
grep -rn "witness@0.10.1" plugin | wc -l
```
Expected: `8`.

- [ ] **Step 3: Bump `package.json`**

Set `"version": "0.10.1"`.

- [ ] **Step 4: Run the full suite**

Run: `npx tsc --noEmit && npx biome check src tests && npx vitest run --poolOptions.forks.maxForks=4`
Expected: PASS. `tests/skills.test.ts` and `tests/command.test.ts` assert the pin prefix, not the version, so they should not need editing — if one fails, it is asserting a literal version and should assert `version()` from `src/cli.ts` instead.

- [ ] **Step 5: Mark the rows built in `DESIGN.md`**

In the `⊗` status paragraph, record that 0.10.1 shipped rows 119, 120 and 129. The payload claim has already been corrected in the design (no release in this system is CLI-only) — do not re-correct it.

- [ ] **Step 6: Commit**

```bash
git add package.json plugin DESIGN.md
git commit -m "chore(release): 0.10.1 — exits-line honesty (D119, D120, D129)"
```

- [ ] **Step 7: Open the PR**

```bash
git push -u origin exits-line-honesty-0.10.1
gh pr create --title "0.10.1 — exits-line honesty (D119, D120, D129)" --body "$(cat <<'EOF'
One exits set, one home; commands emit raw; every upstream resolved.

- D119: gate.ts's two bound branches, ship.ts's approve-only line and its
  awaiting-decision line all call liveExits. changed-nothing gains a real set.
  `witness abandon` joins liveExits at the bound — the hardcoded branch offered
  it and liveExits never did.
- D120: commands emit through `cmd`, never `kv`. `esc` quotes on `,` or `"`, so
  the below-bound set mangled (`--note ""<why>""`) and the bound set did not — a
  defect that appeared and disappeared with gate state.
- D129: `liveExits`'s `upstream = '<id>'` default is deleted and the parameter is
  required; each gate resolves its own via `GateSpec.upstreamOf`; `--revise --note`
  is prefilled from the anchoring run. `<why>` survives only where the run holds
  no facts, and is removed in 0.11.0 by the flagged-option rendering.

Properties added: no source outside rounds.ts composes a decision set; no
rendered command carries `<id>` or `<effort>`.

No gate outcome, routing rule or journal field changes.
EOF
)"
```

**Do not merge.** Merging is the human's act.

---

## Self-Review

**Spec coverage.** D119 — Tasks 3 (abandon), 5 (gate.ts ×2 plus changed-nothing), 6 (ship.ts ×2), 7 (the property). D120 — Task 1, with the escaping scoped to commands so `kv` keeps escaping structured values. D129 — Tasks 2 (per-gate resolution), 3 (required parameter, note prefill), 4 (every call site), 7 (the placeholder property). The five skill-prose copies are **not** here: they are D128, which ships with 0.11.0's key-agnostic ground rule.

**Known gap, stated rather than hidden.** `<why>` still renders at a clean standing stop, where the CLI holds no facts to prefill from. D129's full property — *no rendered command contains `<…>` unless flagged* — cannot hold until the option-row block exists to carry the flag, so this release asserts the narrower `<id>`/`<effort>` property. Task 7's test encodes exactly that, and the constraint block says so.

**Type consistency.** `upstreamOf(root, canon, target)` mirrors `currentSha(root, canon, cfg, target)` minus `cfg`, which no gate needs for this lookup. `liveExits`'s fifth parameter is `string | undefined` everywhere. `notePrefill(entries, gate)` returns `string`, never `undefined`, so callers never branch on it. `renderGateRun`'s `opts.upstream` is `string | undefined` and optional, so existing test call sites that omit it still compile.

**Sequencing note.** Task 3 deliberately leaves the build broken and Task 4 repairs it — the compiler enumerating the unmigrated call sites is the migration checklist, and restoring the default parameter to "fix the build" would reintroduce the defect. This is called out in Task 3, Step 7.
