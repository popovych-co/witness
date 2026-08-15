# Next Knows Where You Are Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `next` stops printing a session handoff to the session that is already in `home:`, and when an implement approval lapses it names *what moved* instead of two shas nobody can act on.

**Architecture:** Three independent edits, no new dependencies. `worktree.ts` gains `atHome(cwd, home)` — a realpath comparison — and `next`'s print block emits `run:`/`relay:` only when the answer is no. The implement gate journals `diff_sha`, the diff half of its composite reviewed identity, so a later lapse can say whether the **worktree** or the **plan** moved; without it the two are indistinguishable one turn later. `evidence.ts` gains `whitespaceOnlyFiles`, which asks git the question directly (`-w --ignore-blank-lines`), so a lapse caused by a formatter says so and names the files.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, biome. No new dependencies.

**Spec:** none separate — the field diagnosis is recorded in *Measured evidence* below and lands in `DESIGN.md` as rows 134–136 (Task 5).

## Global Constraints

- **No behaviour may move a routing answer.** The stage, target and home `next` computes are unchanged by every task here. Only what is *printed alongside* them changes.
- **`plugin/commands/witness.md` pins `npx -y @popovych.co/witness@0.12.0`** — stamped by `scripts/sync-versions.mjs`. Do not hand-edit the version; do not bump it in this plan.
- **`tests/dead-fields.test.ts` is a standing gate:** every field on a `*Entry` interface in `src/rounds.ts` or `src/journal.ts` needs a reader outside its declaring module, or an explicit `WRITE_ONLY` entry with a stated reason. Task 2 adds a field; Task 3 is its reader. Task 2 alone leaves the suite red — that is expected and stated in the task.
- **`tests/skills.test.ts` asserts skill prose properties** (no exit-set strings in skill bodies, row 128). Task 1 edits skill prose; re-run that suite.
- Verification is what CI runs (`.github/workflows/ci.yml:18-19`): `pnpm run build` (that is `tsc`, the typecheck) then `pnpm exec vitest run`. **There is no `lint` script** — `pnpm lint` falls through to whatever `lint` is on PATH (on this box, Android's), so it silently reports someone else's usage text. `biome.jsonc` exists but CI does not invoke it; run `pnpm exec biome check src tests` if you want the formatter's opinion, and do not treat it as a gate.
- **`vitest` collects `.claude/worktrees/*/tests/**` too.** A superpowers worktree left in the tree (today: `.claude/worktrees/canon-single-home`) runs its own stale copy of the suite against its own `src/`. Pre-existing, unrelated to this plan, and harmless here — but it doubles the wall clock and its results say nothing about your change. Read the file paths in the output.

---

## The report

Two sessions, ping-ponging, with a real `witness` repo behind them (`know-your-customer-mvp`, plan `voice-and-copy-plan-2`):

```
worktree session: "Implement gate passed and the flow advanced to ship, whose home: is
                   the primary root — a different session from this worktree."
                   run: cd '<root>' && pi '/witness'
root session:     "$WITNESS next routes this stage to a different session home.
                   Stage: implement gate for voice-and-copy-plan-2
                   Note: implement approval lapsed — judged @dadb171, worktree now
                         @60ad79c — re-gate to judge the current tree
                   Home: <worktree> (not this cwd)"
                   run: cd '<worktree>' && pi '/witness'
```

Reported as: *"it navigates me to the root dir and then the root dir navigates me back."*

## Measured evidence

Measured 2026-08-15 against the live repository, with `dist/` 0.12.0.

**`next` is not the disagreement.** Run from both checkouts, back to back, it answers byte-identically:

```
$ (cd <root>          && node dist/bin.js next)
$ (cd <root>/.witness/worktrees/voice-and-copy-plan-2 && node dist/bin.js next)
next: witness gate implement voice-and-copy-plan-2
target: voice-and-copy-plan-2
note: "implement approval lapsed — judged @dadb171, worktree now @60ad79c — re-gate …"
home: /…/worktrees/voice-and-copy-plan-2
run: cd '/…/worktrees/voice-and-copy-plan-2' && claude --model claude-opus-5 '/witness'
relay: /clear then /witness
```

`tests/flows.test.ts:76` already pins that invariant and it holds. **Note the last two lines: they were printed to a session standing in that exact directory.**

**What actually moved.** The journal (`.witness/journal/voice-and-copy-plan-2.jsonl`):

| # | entry | round | outcome | `reviewed_sha` | `checks.diff` |
|---|---|---|---|---|---|
| 10 | gate-run implement | 2 | passed | `a5dc97c` | 1 file changed vs b12c813 |
| 11 | gate-run implement | 1 | stopped | `60ad79c` | **2** files changed vs b12c813 |
| 12 | human-decision | 1 | revise | — | anchor: `…/report/report.ts` |
| 13 | test-evidence green | — | — | — | — |
| 14 | gate-run implement | 2 | **passed** | `dadb171` | 1 file changed vs b12c813 |
| — | *live tree at diagnosis* | — | — | **`60ad79c`** | **2** files changed |

Recomputed from `dist/` against the live worktree: `implementReviewedSha` = `60ad79c`, matching the note. The tree is byte-identical to entry #11's — the one a reviewer had already **blocked** (#12, anchored on `report.ts`).

The second changed file's entire diff:

```diff
--- a/packages/app-schemas/src/report/report.ts
+++ b/packages/app-schemas/src/report/report.ts
-						path: [
-							"segmentDepth", index, slot, entryIndex, "evidenceRefs", refIndex,
-						],
+						path: ["segmentDepth", index, slot, entryIndex, "evidenceRefs", refIndex],
```

Whitespace. `mtime` on both changed files is `11:44:21`, twenty-seven seconds **after** the passing gate entry was journaled (`11:43:54`) — something reformatted the file after the gate passed. Only those two files in the whole worktree are newer than the gate run.

**Ruled out — base movement.** `main` advanced `b12c813 → b880608`, but every commit in that range is witness's own (`.witness/journal/*`, `docs/plans/*`), so `stateOnlyAdvance` (`src/gitio.ts:58`, row 96b) correctly declined to rebase and the base term never moved. Row 96b works; this is not it.

**The loop, then:**

```
worktree  gate passed @dadb171  → next: stage ship, home root      → hand off
   ↓  report.ts reformatted (whitespace)
root      sha now 60ad79c       → gate lapsed, home worktree       → hand off
   ↓  re-gate spends a round; the reviewer blocks report.ts again (as at #12)
worktree  revise → revert → pass → next: stage ship, home root     → hand off
   ↓  repeat
```

Witness did not start the loop. It supplied two of its three legs.

## The two defects

**A — `next` prints a handoff to the cwd it was printed in.** `src/verbs/next.ts:738-742`:

```ts
if (action.home) {
  ctx.out(kv('home', action.home))
  ctx.out(kv('run', handoffLine(harness, action.home, action.model)))
  ctx.out(kv('relay', relayLine(harness)))
}
```

`ctx.cwd` appears twice in that file — `:689` to resolve the root, `:725` to infer the flow — and **never** in a comparison against `action.home`. The equality test is delegated to the model by `plugin/commands/witness.md:30`: *"`home:` present and ≠ your cwd"*. So the CLI holds both halves of a comparison it declines to make, and hands the model a paste-ready `cd` to where it already is. One fumbled compare — a symlinked path, a trailing slash, a cwd the session has drifted from — and the session hands the human a `cd` to their own directory and ends its turn. That is a self-loop with no state change, and it is the half of the report that has nothing to do with shas.

This is the defect row 129 already names elsewhere: *a rendered command runs*. A `run:` line that relocates a session to its current location does not.

**B — the lapse note names shas, not causes.** `src/verbs/next.ts:90-96` prints `judged @dadb171, worktree now @60ad79c`. Neither number is actionable, and the sentence is not always even true: `implementReviewedSha` is `H(diffReviewedSha, planContentSha)` (`src/reviewed.ts:41`), so **re-authoring the plan moves it with a byte-identical worktree** while the note still says *"worktree now @…"*. And in the reported case the whole cause was a formatter, which the CLI can detect exactly (`git diff -w`) and did not mention.

## What this plan deliberately does not do

**It does not change the reviewed identity.** Row 96a's position — the reviewed identity is *the diff the battery read* — is correct, and a reformat genuinely changes the text a reviewer would read. Normalising whitespace out of `diffReviewedSha` would silently replay verdicts across markdown, YAML, template literals and snapshot fixtures, where whitespace *is* content. The gate keeps re-arming; the note starts saying why, which is what lets a human revert in one move instead of re-gating.

**It is not row 118's reverted band-aid.** Rows 116–118 record a fix that made `next` **refuse** a handoff on a version-skew diagnosis, reverted because *"a refusal there polices one verb's handoff"* while `check` answers the question for the whole repository. Task 1 is a different act:

| | row 118's reverted fix | Task 1 |
|---|---|---|
| routing answer | withheld | unchanged — same stage, target, home |
| knowledge used | version skew, owned by `check` | `ctx.cwd` and `action.home`, both already in hand |
| shape | a refusal (exit non-zero) | one line not printed |
| what a session loses | the ability to proceed | an instruction to go where it is |

Nothing is diagnosed and nothing is refused. A handoff that would relocate a session to its own cwd stops being emitted.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/worktree.ts` | add `atHome` | the path-identity question, beside `worktreePath`/`worktreeFlow` which already own worktree paths. Cannot live in `next.ts`: it is a fact about paths, and `next.ts` is a router |
| `src/verbs/next.ts` | `run()` print block; `lapseNote` | the two print-site defects |
| `src/rounds.ts` | `GateRunEntry.diff_sha?` | entry shape (one of the two `DECLARING` files `dead-fields.test.ts` reads) |
| `src/gate.ts` | `GateInput.diffSha?` + entry spread | the single funnel every gate writes through |
| `src/gates/implement.ts` | pass `diffSha` | the only gate whose identity is composite |
| `src/evidence.ts` | add `whitespaceOnlyFiles` | beside `changedFiles`/`diffBase`, which own "what does the diff contain" |
| `plugin/commands/witness.md` | lines 23 + 30 | the loop's contract with the CLI |
| `tests/next-home.test.ts` | **create** | Task 1 |
| `tests/implement-identity.test.ts` | extend | Tasks 3 + 4 — it already owns "what re-arms the implement gate" |
| `tests/flows.test.ts:219` | amend | pins the bug today; must be re-pinned |
| `DESIGN.md` | rows 134–136 + log paragraph | Task 5 |

---

### Task 1: `next` answers whether this session is already home

**Files:**
- Create: `tests/next-home.test.ts`
- Modify: `src/worktree.ts` (add `atHome` after `worktreeFlow`, ~line 27)
- Modify: `src/verbs/next.ts:738-742` (the print block) and its import line 14
- Modify: `plugin/commands/witness.md:23` and `:30`
- Modify: `tests/flows.test.ts:219-229` (asserts the defect)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `atHome(cwd: string, home: string): boolean` — exported from `src/worktree.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/next-home.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { changedFiles, diffBase } from '../src/evidence.js'
import { loadConfig } from '../src/config.js'
import { fakeCtx, fakeScenario, gateEnv, nextLine, putVerdict, shippableRepo } from './helpers.js'
import { worktreePath } from '../src/worktree.js'

// The same battery fake flows.test.ts and implement-identity.test.ts drive the gate with.
async function settleImplementGate(repo: { root: string }, wt: string, planId: string): Promise<void> {
  const cfg = loadConfig(repo.root)
  const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
  const files = changedFiles(wt, base.ok ? base.value : '')
  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })), findings: [] })
  const code = await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'implement', planId,
    { fresh: false, manual: false })
  if (code !== 0) throw new Error(`implement gate did not settle: exit ${code}`)
}

// Line-prefixed, never `toContain`: `run:` and `home:` both occur inside note prose, and a
// substring assertion would pass on the wrong line in exactly the case worth catching.
const row = (out: string, prefix: string): string | undefined =>
  out.split('\n').find((l) => l.startsWith(prefix))

describe('next answers whether this session is already home', () => {
  it('omits run: and relay: when home: is the cwd', async () => {
    const { repo, wt } = await shippableRepo()

    const res = await repo.cli(['next'], { cwd: wt })

    expect(res.code).toBe(0)
    expect(row(res.stdout, `home: ${wt}`)).toBeDefined()
    expect(row(res.stdout, 'run: ')).toBeUndefined()
    expect(row(res.stdout, 'relay: ')).toBeUndefined()

    await repo.cli(['clean'])
  })

  it('still prints run: and relay: when home: is another checkout', async () => {
    const { repo, planId } = await shippableRepo()
    const wt = worktreePath(repo.root, planId)

    const out = await nextLine(repo)   // asked from the primary root

    expect(row(out, `home: ${wt}`)).toBeDefined()
    expect(row(out, `run: cd '${wt}'`)).toBeDefined()
    expect(row(out, 'relay: ')).toBeDefined()

    await repo.cli(['clean'])
  })

  it('omits the handoff for a ship row asked from the primary root', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)

    const out = await nextLine(repo)

    expect(out).toContain(`witness ship ${planId}`)
    expect(row(out, `home: ${repo.root}`)).toBeDefined()
    expect(row(out, 'run: ')).toBeUndefined()

    await repo.cli(['clean'])
  })

  // The comparison is between PATHS, not between strings. `primaryRoot` answers with git's
  // physical path while `ctx.cwd` is whatever the human typed — and on macOS every `/tmp`
  // and `/var` path is a symlink, so a raw `===` reports a session sitting in its own home
  // as one that must be relocated. That is the field failure, not a hypothetical.
  it('resolves symlinks before deciding — a symlinked cwd is still home', async () => {
    const { repo, wt } = await shippableRepo()
    const link = join(mkdtempSync(join(tmpdir(), 'witness-link-')), 'wt')
    symlinkSync(wt, link)

    const res = await repo.cli(['next'], { cwd: link })

    expect(res.code).toBe(0)
    expect(row(res.stdout, `home: ${wt}`)).toBeDefined()
    expect(row(res.stdout, 'run: ')).toBeUndefined()

    await repo.cli(['clean'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/next-home.test.ts`

Expected: 3 of 4 FAIL. `omits run: and relay: when home: is the cwd`, `omits the handoff for a ship row…` and `resolves symlinks…` fail on `expected 'run: cd …' to be undefined` — the CLI prints the handoff unconditionally. `still prints run: and relay: when home: is another checkout` PASSES already; it is the guard that the fix does not over-reach.

- [ ] **Step 3: Add `atHome` to `src/worktree.ts`**

Add to the import on line 1: `realpathSync`. Add to the import on line 2: `resolve`. Then, after `worktreeFlow` (line 27):

```ts
// Whether the session asking is already in `home`. A PATH comparison, not a string one:
// `primaryRoot` answers with git's physical path (`rev-parse --show-toplevel` resolves
// symlinks) while `ctx.cwd` is whatever the human typed, and on macOS every `/tmp` and
// `/var` path is a symlink — so a raw `===` reports a session sitting in its own home as a
// session that must be relocated, which is the handoff loop this predicate exists to close.
//
// realpathSync throws on a path that does not exist; `resolve` is the fallback because a
// home that is not on disk is not one you are standing in, and the comparison must still
// answer rather than throw inside `next`'s print block.
export function atHome(cwd: string, home: string): boolean {
  const real = (p: string): string => {
    try { return realpathSync(p) } catch { return resolve(p) }
  }
  return real(cwd) === real(home)
}
```

- [ ] **Step 4: Gate the handoff in `src/verbs/next.ts`**

Line 14 becomes:

```ts
import { atHome, worktreeFlow, worktreePath } from '../worktree.js'
```

Lines 738-742 become:

```ts
  // Whether this session is already in `home:` is a fact the CLI holds both halves of, so
  // it answers it here rather than printing the handoff and leaving the comparison to the
  // model. A `run:` line that cds to the directory it was printed in is row 129's defect —
  // a rendered command that does not run — and it is what let the engine bounce a human
  // between two checkouts with nothing changing in between.
  //
  // NOT rows 116-118's reverted band-aid. That fix made `next` REFUSE a handoff on a
  // version-skew diagnosis owned by `check`. This withholds no knowledge and changes no
  // routing answer: the stage, the target and the home are identical either way, and only
  // the instruction to a session that is already there stops being printed.
  if (action.home) {
    ctx.out(kv('home', action.home))
    if (!atHome(ctx.cwd, action.home)) {
      ctx.out(kv('run', handoffLine(harness, action.home, action.model)))
      ctx.out(kv('relay', relayLine(harness)))
    }
  }
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `pnpm vitest run tests/next-home.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Re-pin the test that asserted the defect**

`tests/flows.test.ts:219-229` asks from the primary root and asserts a `run:` line whose target *is* the primary root. Replace that test with:

```ts
  it('ship row hands off home: primary root, and omits the handoff when asked from it', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)   // flow advances to ship
    const fromWorktree = (await repo.cli(['next'], { cwd: wt })).stdout
    expect(fromWorktree).toContain(`witness ship ${planId}`)
    expect(fromWorktree).toContain(`home: ${repo.root}`)
    expect(fromWorktree).toContain(`run: cd '${repo.root}' && claude '/witness'`)
    expect(fromWorktree).not.toContain('--model')   // session-default ship model → no flag

    // asked from the root itself, the same row carries no handoff: there is nowhere to go
    const fromRoot = await nextLine(repo)
    expect(fromRoot).toContain(`home: ${repo.root}`)
    expect(fromRoot.split('\n').find((l) => l.startsWith('run: '))).toBeUndefined()

    await repo.cli(['clean'])
  })
```

- [ ] **Step 7: Update the loop's contract in `plugin/commands/witness.md`**

Line 23 — replace the sentence describing the trio:

```
2. Read its TOON lines: `next:` (a command line), and optional `stage:`, `target:`, `note:`, `home:` (the directory this action's session belongs in), `run:` (the paste-ready handoff command) and `relay:` (how a session continues in a fresh context in the same `home:`). **`run:` and `relay:` are printed only when `home:` is a different session from yours — the CLI compares it against your cwd, resolving symlinks, so you never make that comparison yourself.** `run:` and `relay:` are rendered by the CLI for the harness you are running on — never rewrite them, never substitute a command you remember.
```

Line 30 — the row keys on the printed line, not on a comparison:

```
| a `run:` line is printed | This stage belongs to a different session; the CLI already compared `home:` against your cwd. Print the `run:` line verbatim for the human (if this session is `--manual`-armed, change the argument to `'/witness --manual'`), say that work continues in the fresh session, and **END YOUR TURN**. Never use a stage skill or run the `next:` command from the wrong `home:` — a fresh session is the execution model, and it is the only one. A `home:` line with no `run:` under it means you are already there: read on and act. |
```

- [ ] **Step 8: Run the affected suites**

Run: `pnpm vitest run tests/next-home.test.ts tests/flows.test.ts tests/next.test.ts tests/command.test.ts tests/skills.test.ts`

Expected: all pass. `tests/command.test.ts:46` asserts the command body matches ``/`home:`/`` — still true. `tests/next.test.ts:49` and `:58` ask from the primary root about a *worktree* home, so their `run:`/`relay:` assertions are unaffected.

- [ ] **Step 9: Commit**

```bash
git add src/worktree.ts src/verbs/next.ts plugin/commands/witness.md tests/next-home.test.ts tests/flows.test.ts
git commit -m "fix(next): the CLI decides whether you are already home (D134)"
```

---

### Task 2: The implement gate journals its diff term

A lapse cannot say *what* moved unless the record splits the composite. `reviewed_sha` at implement is `H(diffReviewedSha, planContentSha)`; with only the composite stored, "the tree moved" and "the plan was re-authored" are the same observation one turn later. The diff term is **not** reconstructable after the fact — the judged diff no longer exists.

`artifact_sha` is deliberately not reused for this. It is `canonicalSha(plan.meta, plan.body)`, which counts `derives-from`; the identity's plan term is `planContentSha`, which excludes it precisely so ship's in-transaction repin does not self-invalidate (row 96, `src/sha.ts:32-37`). Splitting on `artifact_sha` would report "the plan was re-authored" for a repin — the exact case `tests/implement-identity.test.ts:54` pins as a non-lapse.

**Files:**
- Modify: `src/rounds.ts` (after `artifact_sha?: string`, line 42)
- Modify: `src/gate.ts` (`GateInput`, after `artifactSha?: string` line 43; entry spread, after line 478)
- Modify: `src/gates/implement.ts` (imports, and the `ok<GateInput>` return at line 162-173)

**Interfaces:**
- Consumes: nothing.
- Produces: `GateRunEntry.diff_sha?: string` (read by Task 3), `GateInput.diffSha?: string`.

- [ ] **Step 1: Declare the field on the entry**

`src/rounds.ts`, immediately after `artifact_sha?: string` (line 42):

```ts
  // The DIFF half of a code gate's composite reviewed identity (`diffReviewedSha`),
  // journaled beside the composite so a later lapse can name WHICH term moved. At implement
  // `reviewed_sha` is H(diff, planContent): with only the composite recorded, "the worktree
  // moved" and "the plan was re-authored" are indistinguishable, and the lapse note blamed
  // the worktree for both. Not derivable after the fact — the judged diff is gone.
  // Optional because every entry written before row 135 lacks it; its reader
  // (`next.ts`'s lapseNote) falls back to naming both shas, which is the honest answer
  // for a record that cannot say.
  diff_sha?: string
```

- [ ] **Step 2: Declare it on the gate input**

`src/gate.ts`, immediately after `artifactSha?: string` (line 43):

```ts
  diffSha?: string
```

And in the `GateRunEntry` literal, immediately after the `artifact_sha` spread (line 478):

```ts
      ...(input.diffSha ? { diff_sha: input.diffSha } : {}),
```

- [ ] **Step 3: Supply it from the implement gate**

`src/gates/implement.ts` — add `diffReviewedSha` to the existing `../reviewed.js` import. Then in the `ok<GateInput>({…})` return (line 162), add the field directly under `reviewedSha`:

```ts
    return ok<GateInput>({
      class: ((recap?.class as GateInput['class']) ?? 'feature'),
      reviewedSha: implementReviewedSha(wt, base, plan),
      // the diff term of the line above, so a lapse can attribute itself (row 135)
      diffSha: diffReviewedSha(wt, base),
      artifactSha: canonicalSha(plan.meta, plan.body),
```

- [ ] **Step 4: Run the gate suites and confirm the field is written**

Run: `pnpm vitest run tests/gate-implement.test.ts tests/implement-identity.test.ts`
Expected: PASS — this task adds an optional output field and changes no behaviour.

Run: `pnpm vitest run tests/dead-fields.test.ts`
Expected: **FAIL** — `diff_sha` has no reader outside `rounds.ts` yet. This is correct and Task 3 closes it. Do not add a `WRITE_ONLY` entry to silence it.

- [ ] **Step 5: Commit**

```bash
git add src/rounds.ts src/gate.ts src/gates/implement.ts
git commit -m "feat(gate): implement journals the diff half of its identity (D135)"
```

---

### Task 3: The lapse note names which term moved

**Files:**
- Modify: `src/verbs/next.ts` (`lapseNote`, lines 84-96; its call site in `flowAction`, line 233; imports line 10)
- Modify: `tests/implement-identity.test.ts` (extend `the implement gate re-arms on plan content`)

**Interfaces:**
- Consumes: `GateRunEntry.diff_sha` (Task 2); `diffReviewedSha(runRoot, base)` from `src/reviewed.ts` (already exported).
- Produces: `LapseCause` (module-private); `lapseNote(entries, gate, currentSha, cause)` — a fourth parameter, a **thunk**.

- [ ] **Step 1: Write the failing tests**

Append to the `describe('the implement gate re-arms on plan content', …)` block in `tests/implement-identity.test.ts`:

```ts
  it('names the plan, not the worktree, when the plan is what moved', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)
    expect(await nextLine(repo)).toContain(`witness ship ${planId}`)

    const rewritten = await writePlan(repo, planId, {
      steps: [{ id: 's1', title: 'rotate tokens on refresh, bounded to 15m', criteria: ['ac-rotate'] }],
    })
    expect(rewritten.code).toBe(0)

    const out = await nextLine(repo)

    expect(out).toContain('approval lapsed')
    expect(out).toContain('the plan was re-authored')
    // the worktree is untouched, and the note must not say otherwise
    expect(out).not.toContain('the worktree moved')

    await repo.cli(['clean'])
  })

  it('names the worktree when the tree is what moved', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)
    expect(await nextLine(repo)).toContain(`witness ship ${planId}`)

    writeFileSync(join(wt, 'src', 'sneaked-in.ts'), 'export const x = 1\n')

    const out = await nextLine(repo)

    expect(out).toContain('approval lapsed')
    expect(out).toContain('the worktree moved')
    expect(out).not.toContain('the plan was re-authored')

    await repo.cli(['clean'])
  })
```

Add to that file's imports: `import { writeFileSync } from 'node:fs'` and `import { join } from 'node:path'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/implement-identity.test.ts`
Expected: both new tests FAIL on `expected '…judged @… , worktree now @…' to contain 'the plan was re-authored'` / `'the worktree moved'`. The two existing tests in the block still pass.

- [ ] **Step 3: Teach `lapseNote` to attribute itself**

In `src/verbs/next.ts`, add `diffReviewedSha` to the existing `../reviewed.js` import (line 10). Replace `lapseNote` (lines 84-96) with:

```ts
// D75 re-arms a gate whose reviewed sha has moved — under row 96 that is the diff moving
// or the base moving, no longer any file in the worktree. Correct either way, but the row
// it produces is a bare `gate implement`, indistinguishable from a CLI stuck on a stale
// answer. A human who just watched that gate pass reads it as the latter, and
// with a second session in the worktree answering `ship` the pair looks like a deadlock
// with no error anywhere. The lapse is a fact the CLI already knows; say it.
//
// Row 134: say WHICH fact. `reviewed_sha` at implement is H(diff, planContent), so two
// different events with two different remedies produce one moved number — and the note
// said "worktree now @…" for both, which is false half the time. `diff_sha` (row 135) is
// what makes the split exact; entries predating it fall back to naming the shas, the
// honest answer for a record that cannot say.
interface LapseCause { diffSha: string; whitespaceOnly: string[] }

function lapseNote(
  entries: Entry[], gate: string, currentSha: string | undefined,
  // A THUNK: the cause costs two `git diff` invocations, and `next` runs every turn while
  // a lapse is rare. Nothing below the guards may be paid for on the settled path.
  cause: () => LapseCause | undefined,
): string | undefined {
  const last = lastGateRun(entries, gate)
  if (!last || currentSha === undefined || last.reviewed_sha === currentSha) return undefined
  // sha-free: asks "was it ever settled", which is the only thing that can lapse
  if (!gateSettled(entries, gate)) return undefined
  const shas = `judged @${last.reviewed_sha.slice(0, 7)}, now @${currentSha.slice(0, 7)}`
  const c = cause()
  if (c === undefined || last.diff_sha === undefined) {
    return `${gate} approval lapsed — ${shas} — re-gate to judge the current tree`
  }
  if (last.diff_sha === c.diffSha) {
    return `${gate} approval lapsed — the plan was re-authored, the worktree is unchanged (${shas}) — re-gate to judge the current plan`
  }
  return `${gate} approval lapsed — the worktree moved (${shas}) — re-gate to judge the current tree`
}
```

- [ ] **Step 4: Supply the cause at the call site**

In `flowAction` (`src/verbs/next.ts`), the final `return` (lines 231-234) becomes:

```ts
  return {
    line: `witness gate implement ${id}`, target: id, ...inWorktree,
    ...noteOf(
      lapseNote(entries, 'implement', diffSha,
        () => (baseR.ok ? { diffSha: diffReviewedSha(wt, baseR.value), whitespaceOnly: [] } : undefined)),
      judgeNote(entries, 'implement', judge)),
  }
```

`whitespaceOnly` is filled in by Task 4; it is declared here because the shape belongs to the cause, and a second edit to the same literal is cheaper than a second interface.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/implement-identity.test.ts tests/flows.test.ts tests/dead-fields.test.ts`
Expected: all PASS. `dead-fields` goes green here — `diff_sha` now has a reader outside `rounds.ts`. `flows.test.ts:51`'s `expect(out).toContain('approval lapsed')` still holds (the prefix is unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/verbs/next.ts tests/implement-identity.test.ts
git commit -m "fix(next): a lapse names which term moved (D135)"
```

---

### Task 4: The lapse note names the paths that moved

> **Amended while building, 2026-08-15.** This task was planned as a *whitespace-only*
> clause and its premise was refuted by measurement before any of it shipped. Three
> predicates were tried against the reporting worktree:
>
> | Predicate | Result on the reported reformat |
> |---|---|
> | `git diff --name-only -w --ignore-blank-lines` | **useless** — `--name-only` reports blob-level differences, so the whitespace flags never suppress a path |
> | `git diff --numstat -w --ignore-blank-lines` | omits genuinely whitespace-only paths correctly, but reports the reported change as `1 insertion / 8 deletions` |
> | whitespace-stripped compare of base blob vs worktree file | still differs |
>
> Cause: collapsing the array literal onto one line also **drops its trailing comma**. The
> change is *formatting-only*, which is not the same predicate as *whitespace-only*, and
> only a language-aware tokeniser separates them. Witness will not tokenise TypeScript,
> YAML and Markdown.
>
> Shipping the clause anyway would have been worse than shipping nothing: it misses its own
> motivating case, and a reader who learns the clause exists reads its **absence** as
> *something substantive changed* — false exactly when it matters.
>
> Replaced with: name the changed paths. Exact, language-agnostic, and free — `flowAction`
> already computed the list for the evidence report. It points at the same culprit, because
> the human reads a path they never touched and goes looking for what wrote it. The steps
> below are the amended ones.

**Files:**
- Modify: `src/verbs/next.ts` (`LapseCause.changed`, `LAPSE_PATHS`, `lapseNote`'s worktree branch, the call site's thunk)
- Modify: `tests/implement-identity.test.ts`

**Interfaces:**
- Consumes: `files` — the `changedFiles(wt, base)` list `flowAction` computes at line 199.
- Produces: nothing exported; `LapseCause` and `LAPSE_PATHS` stay module-private.

- [x] **Step 1: Write the failing tests** — `names the changed paths when the worktree moved` and `counts the paths it did not list` in `tests/implement-identity.test.ts`.
- [x] **Step 2: Verify they fail** — the note carried no `changed vs base:` clause.
- [x] **Step 3: Widen `LapseCause` to `{ diffSha, changed }`; add `LAPSE_PATHS = 6`.**
- [x] **Step 4: Emit the clause**, capped with `(+N more)` — never a silent truncation.
- [x] **Step 5: Verify green** — 7/7 in `tests/implement-identity.test.ts`.
- [x] **Step 6: Commit.**

<details>
<summary>Superseded original (whitespace-only detection) — kept for the record</summary>

#### Task 4 (superseded): The lapse note names whitespace-only edits

**Files:**
- Modify: `src/evidence.ts` (add `whitespaceOnlyFiles` after `changedFiles`, line 153)
- Modify: `src/verbs/next.ts` (`lapseNote`'s worktree branch; the call site from Task 3)
- Modify: `tests/implement-identity.test.ts`

**Interfaces:**
- Consumes: `LapseCause.whitespaceOnly` (Task 3 declared it, empty).
- Produces: `whitespaceOnlyFiles(runRoot: string, base: string): string[]`.

- [ ] **Step 1: Write the failing test**

Append to the same `describe` block in `tests/implement-identity.test.ts`:

```ts
  // The reported loop's ignition: a formatter rewrote one array literal in a file already
  // in the diff, twenty-seven seconds after the gate passed. The gate re-arming is correct
  // (row 96a — the identity IS the diff the battery read); saying nothing about a cause the
  // CLI can compute exactly is not.
  it('names a whitespace-only edit as what moved the tree', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)
    expect(await nextLine(repo)).toContain(`witness ship ${planId}`)

    // A file that EXISTS at base is the only shape a whitespace-only change can take: an
    // added file is wholly new content and `-w` cannot suppress it, so shippableRepo's
    // fixture (which lands on the branch) cannot carry this case. `witness.config.yaml` is
    // committed on main BEFORE `start` cuts the worktree, and it is not a `stateDirs` path,
    // so row 132's sparse-checkout leaves it visible and modifiable in the worktree.
    //
    // A TRAILING space, not indentation: `-w` ignores both, but YAML indentation is
    // semantic and `evidence.ts:52` reads this file from the worktree.
    const rel = 'witness.config.yaml'
    writeFileSync(join(wt, rel), readFileSync(join(wt, rel), 'utf8').replace('\nship:', ' \nship:'))

    const out = await nextLine(repo)

    expect(out).toContain('approval lapsed')
    expect(out).toContain('the worktree moved')
    expect(out).toContain(`whitespace-only vs base: ${rel}`)

    await repo.cli(['clean'])
  })
```

Add `readFileSync` to that file's `node:fs` import.

If `.replace('\nship:', ' \nship:')` does not match (the fixture's config layout changed), assert the substitution happened before continuing rather than letting the test pass vacuously:

```ts
    const before = readFileSync(join(wt, rel), 'utf8')
    const after = before.replace('\nship:', ' \nship:')
    expect(after).not.toBe(before)
    writeFileSync(join(wt, rel), after)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/implement-identity.test.ts -t 'whitespace-only'`
Expected: FAIL on `expected '…the worktree moved (judged @…, now @…)…' to contain 'whitespace-only vs base: src/legacy.ts'`.

- [ ] **Step 3: Ask git the question**

`src/evidence.ts`, after `changedFiles` (line 153):

```ts
// Paths whose ONLY change vs base is whitespace. `-w --ignore-blank-lines` is git's own
// answer to "would this diff be empty if formatting did not count", so a path in the plain
// name-list and absent from that one changed nothing a reviewer reads.
//
// Modified paths only, by construction. An ADDED file is wholly new content, so it appears
// in both lists and is never reported — correct, since there is no earlier version of it to
// have been reformatted. Untracked files are absent from both for the same reason, which is
// why this deliberately does not reuse `changedFiles` (that one unions them in).
//
// This does NOT feed the reviewed identity. Row 96a's position stands — the identity is the
// diff the battery read, and whitespace IS content in markdown, YAML, template literals and
// snapshot fixtures. The gate still re-arms; this only lets the note say why.
export function whitespaceOnlyFiles(runRoot: string, base: string): string[] {
  const all = git(runRoot, 'diff', '--name-only', base).split('\n').filter(Boolean)
  const substantive = new Set(
    git(runRoot, 'diff', '--name-only', '-w', '--ignore-blank-lines', base)
      .split('\n').filter(Boolean))
  return all.filter((f) => !substantive.has(f)).sort()
}
```

- [ ] **Step 4: Say it in the note**

In `src/verbs/next.ts`, add `whitespaceOnlyFiles` to the existing `../evidence.js` import (line 11). The worktree branch of `lapseNote` becomes:

```ts
  const ws = c.whitespaceOnly.length > 0
    ? ` · whitespace-only vs base: ${c.whitespaceOnly.join(' ')} — reverting them restores the judged tree`
    : ''
  return `${gate} approval lapsed — the worktree moved (${shas}) — re-gate to judge the current tree${ws}`
```

And the call site's thunk fills the field:

```ts
      lapseNote(entries, 'implement', diffSha,
        () => (baseR.ok
          ? {
              diffSha: diffReviewedSha(wt, baseR.value),
              whitespaceOnly: whitespaceOnlyFiles(wt, baseR.value),
            }
          : undefined)),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/implement-identity.test.ts tests/flows.test.ts`
Expected: all PASS. The `sneaked-in.ts` test from Task 3 still asserts `the worktree moved` with no whitespace clause — an added file is never whitespace-only, which is the guard that Step 3's "modified paths only" comment is actually true.

- [ ] **Step 6: Commit**

```bash
git add src/evidence.ts src/verbs/next.ts tests/implement-identity.test.ts
git commit -m "fix(next): a lapse names the whitespace-only edits that caused it (D136)"
```

</details>

---

### Task 5: Record the rows

**Files:**
- Modify: `DESIGN.md` (the Decision log preamble paragraph, line 308; three new table rows after row 133, line 445)

- [ ] **Step 1: Extend the Decision log preamble**

Append to the end of the paragraph at `DESIGN.md:308`:

```
Rows 134–136 (⊖) added 2026-08-15 — post-incident amendment, no grill: the two-session handoff bounce reported against 0.12.0, where `next` printed a paste-ready relocation to the session already standing in `home:` and a lapse note blamed the worktree for a move the plan had made. Distinct from rows 116–118's reverted band-aid, which made `next` *refuse* a handoff on a diagnosis owned by `check`: nothing here withholds a routing answer, and the stage, target and home are identical before and after.
```

- [ ] **Step 2: Add the three rows**

After row 133 (`DESIGN.md:445`):

```
| 134 ⊖ | A handoff goes somewhere else | `next` compares `action.home` against `ctx.cwd` through `atHome` (realpath both sides — `primaryRoot` answers with git's physical path while the cwd is whatever the human typed, and every macOS `/tmp` and `/var` path is a symlink) and prints `run:`/`relay:` only when they differ. `home:` still prints either way, so a session can confirm it is in the right place. `/witness`'s routing row keys on **`run:` being printed**, not on a comparison the model performs | The CLI held both halves of the comparison and delegated it to the model, then handed that model a paste-ready `cd` to its own directory. Row 129 already names the defect — *a rendered command runs*, and one that relocates a session to where it is does not. Measured 2026-08-15: run inside the worktree, `next` emitted `run: cd '<that worktree>' && claude '/witness'`, and a session that reads its cwd loosely ends its turn and bounces the human with no state change |
| 135 ⊖ | A lapse says which term moved | Implement journals `diff_sha` — the diff half of its composite identity — beside `reviewed_sha`, and `lapseNote` reads it: equal means the **plan** was re-authored and the worktree is untouched, unequal means the **worktree** moved. Entries written before this fall back to naming both shas. `artifact_sha` is deliberately not reused: it counts `derives-from`, which `planContentSha` excludes precisely so ship's in-transaction repin does not self-invalidate (row 96), so splitting on it would report a re-author for a repin | `reviewed_sha` at implement is H(diff, planContent), so two events with two different remedies produce one moved number — and the note said `worktree now @…` for both, which is false whenever a plan amend is what moved it. The diff term is not reconstructable after the fact: the judged diff no longer exists, so it has to be recorded at the run |
| 136 ⊖ | A formatter says its own name | `whitespaceOnlyFiles` asks git directly (`diff --name-only -w --ignore-blank-lines` subtracted from `diff --name-only`) and the lapse note names those paths with the remedy. Modified paths only by construction — an added file is wholly new content, so `-w` cannot suppress it and it is never reported. The reviewed identity is **unchanged**: row 96a's position stands, whitespace is content in markdown, YAML, template literals and snapshot fixtures, and normalising it out would replay verdicts against text no reviewer read | Measured 2026-08-15 on `voice-and-copy-plan-2`: the gate passed at `dadb171` with one changed file and the tree read `60ad79c` with two twenty-seven seconds later, the whole second diff being one array literal unwrapped by a formatter — returning the tree byte-for-byte to a state a reviewer had already blocked. Re-arming was correct; being silent about a cause the CLI can compute exactly cost a round out of `ROUND_BOUND` and a session hop per cycle |
```

- [ ] **Step 3: Run what CI runs**

Run: `pnpm run build && pnpm exec vitest run`
Expected: `tsc` clean, all suites pass.

- [ ] **Step 4: Commit**

```bash
git add DESIGN.md
git commit -m "docs(design): next knows where you are, and a lapse names its cause (D134, D135, D136)"
```

---

## Out of scope, stated

- **The formatter itself.** Something in the reporting repo rewrites `report.ts` after a passing gate — only those two files in the worktree are newer than the gate run, and there is no prettier or biome config at that repo's root. That is theirs to find; rows 134–136 make it *visible* rather than silent. Row 136's note is the instrument.
- **Ship's reviewed identity.** `gates/ship.ts` deliberately omits the sha term (row 92) and has no lapse note to improve. `diffSha` is supplied by the implement gate only.
- **A runnable revert.** The note names the whitespace-only paths but does not render `git checkout -- <paths>` as a command. `run:` is reserved for session handoff, and witness does not mutate a human's worktree from a routing verb.
