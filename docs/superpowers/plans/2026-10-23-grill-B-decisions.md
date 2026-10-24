# Grill Part B: numbered decisions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The recap carries numbered decisions `d1…`. A spec names the decisions it carries, decompose checks that every one landed, the plan stage reads them, the plan critic blocks a plan that contradicts one, and a changed carried decision re-queues the plans that pin it. An effort with no decisions stays byte-for-byte as it is today.

**Architecture:** Three seams.
- **Data.** `decisions` on the recap entry and `carries` on a spec's write entry, validated the way goals and `covers` are (rows 37, 38).
- **One reading of what a doc carries.** `carriedDecisions(root, doc)` reads the write that made the doc's current content. That write is D168's `writeAct`, so this adds no second derivation. The same reading feeds `read --decisions`, the plan critic's prompt and the basis.
- **One basis.** `src/basis.ts` compares a plan's pins with its parent everywhere a pin is compared. The plan pins `decisions-from` beside `derives-from`, the way `design-from` pins the look (row 70). The pin is absent when nothing is carried, so every existing plan keeps its bytes, its reviewed identity and its place in the queue (c2).

**Tech Stack:** TypeScript (ESM), vitest, pnpm, git; the witness CLI and its plugin skills.

**Spec:** `docs/superpowers/specs/2026-10-23-grill-design.md`: §4.5, the rows 38, 52 and 198 in §5, the B lines of §8, and §9–§11. Read §4.5 before Task 1. Part A (`2026-10-23-grill-A-conversations.md`) shipped as 0.22.0 (PR #50), and this plan is re-read against it at main @ `afc9e54`. Part C (`2026-10-23-grill-C-grill.md`) builds on this plan.

## Builder's calls (§10 left these open; each is load-bearing)

1. **The basis is two pins, not one hashed value.** `derives-from` stays the spec's content sha, because six readers resolve it in git history:
   - write's delta criteria and `witness diff`, which resolve `baseForSpec`'s pin (`src/history.ts:51`) with `contentAtSha` (`src/verbs/write.ts:418`, `src/verbs/diff.ts:48`);
   - `check`'s `pin-unresolvable` (`src/verbs/check.ts:180-183`);
   - abandon's `writeAct(root, parentId, pin)` (`src/abandon.ts:488-490`);
   - the PR body (`src/ship.ts:83`);
   - ship's drift re-pin (`src/gates/ship.ts:86-89`).

   A hashed basis written there would break all six. The new `decisions-from` is the sha of the carried decisions, and it is present only when at least one decision is carried.
2. **"The latest write of its latest effort"** means the write that made the doc's current content: `writeAct(root, id, canonicalSha(doc))` (`src/abandon.ts:40`, D168). Two efforts can write identical content with different `carries`, for example an approach decision carried without a Behavior change. The later act wins.
3. **`witness read <effort> --decisions` accepts every effort, not only chores.** A probe on main showed that `witness log <effort>` prints only `class=feature goals=1 non_goals=1 slices=1`, with no texts and no constraints count. So the decompose skill has no CLI read of the decisions it must carry. An effort slug is still the only non-canon id `read` takes (§11).
4. **A chore plan pins its parent's basis like any other plan.** The chore's own decisions go into its critic prompt and its reviewed identity (call 6), never into a pin.
   - Suppose the chore's decisions were pinned in `decisions-from` instead. A chore plan on spec S would then become S's base plan with a pin S's carried set never matches, and `next` would re-queue S forever.
   - **Residual:** a changed chore decision lapses only a draft chore plan's gate. An approved or in-flight chore plan is neither re-queued nor warned.
5. **A plan's write entry journals the carried decision texts (`decisions`).** That lets `witness diff` print a per-decision delta. Frontmatter holds only the sha (position) and the journal holds the texts (history), the same split as `derives-from` pinning content that git keeps.
6. **The plan gate's reviewed identity gains a decisions term** (`planDecisionsTerm`): the parent's current carried-decisions sha, plus a chore plan's own chore decisions. The term covers decisions the critic now reads.
   - A changed decision therefore lapses a stopped or settled plan gate, exactly as a spec amendment does (rows 47, 75).
   - With no decisions on either side, the identity's bytes are today's.
   - Constraints and non-goals stay prompt context, outside the identity, so an old effort's plans keep theirs (c2).
7. **`decision-coverage` is always in the check list.** It passes with `the recap carries no decisions` when there are none.
   - The decompose prompt's decision table and its context term appear only when the recap carries decisions, so an old effort's prompt is unchanged.
   - **Carries join decompose's reviewed identity** (`effortReviewedSha`), per spec line, only when that spec carries something. Otherwise a carries-only rewrite resumes into row 112's `cached` round, which replays the critic's old verdict, so lens 9 would never judge the new mapping.
   - The code review probed this with `covers`: the round was `cached` and the reviewer call count stayed at 1. `covers` keeps that trade, which row 112 records.
8. **An amendment re-arms decompose even when every spec is approved.** This is a pre-existing break of row 52, found by a probe on main:
   - **The probe:** recap, write `card-pay` (covers `g1`), approve, then `recap --amend` adding `g2`. `next` still printed `next: witness write card-pay-plan-1 …`.
   - **The cause:** `next`'s fixture shortcut (`specsApproved`, `src/verbs/next.ts:801-803`) treats specs that are past draft as proof that decompose settled, even though the recap moved after the gate's last round.
   - **What breaks without the fix:** an amended decision would never be checked for landing, and Part C's §4.8 (a decision born in design) depends on this re-arm.
   - **The fix, in three parts:**
     1. **The shortcut no longer stands for an amendment nothing has settled.** That is when the effort holds ≥ 2 recaps and the last one comes after its last *settling* decompose event: a `gate-run` with outcome `passed`, or a `human-decision` `approve`.
        - Measured against the last gate run instead, a stopped round followed by `revise` handed control back to the shortcut, and `next` routed the plan write again (spec review, reproduced).
     2. **A finished effort keeps the shortcut:** every spec it wrote is `live` and no plan on them is unfinished.
        - Re-arming one would spend a critic round on shipped work. Under autonomy a blocking finding would then send a headless decompose session to rewrite live specs and re-queue their plans (c2).
        - A finished effort's change is a new effort.
        - **Residual:** amending a finished effort re-arms nothing, so a decision it adds lands in no spec.
     3. **While an effort owes decompose, the design rung and the plan queue skip the specs it wrote.**
        - Otherwise drive would plan a spec mid-re-slice. A lane scoped to the spec never meets its effort's decompose rung (`admits(e.slug)` is false there), and a ui spec's plan write refuses `design-not-approved` once the re-slice rewrites the spec.
        - And the chat would open a design session on the pre-amendment spec. Under autonomy, A's `humanAction` sets the effort's decompose aside as drive's work and walks on to the look. Drive itself never designs (row 194).
        - Flows, draft-plan gates and starts keep row 18's soft lock.
   - **Upgrade effect, probed read-only:**
     - Under part 1, fewhats has one effort amended since a settling round: `device-lifecycle`. Its class flipped fix→feature at entry 15, after the approve at entry 10.
     - It is finished (four specs live, four plans done), so part 2 keeps it as it is.
     - The two chore efforts never reach the decompose rung. hear-your-customer has no amended effort.
     - So the upgrade shows nothing new (§4.11).
     - Rejected: gating the rule on the CLI version that wrote the amendment (`w`). It has no precedent, and it would keep the broken reading alive for old data.

## Global Constraints

- **Witness-only.** Never modify fewhats.com or any other consumer. Task 7's differential reads a throwaway `git clone --local`.
- **Base and branch:** main @ `afc9e54` (`chore(release): 0.22.0`, after PR #50's merge), on branch `decisions`. Release 0.23.0 is cut by the user (`pnpm release minor`) after the merge, because the classifier blocks the agent from running it.
- **Judge the suite by AssertionError count, not by exit code.** 3–4 `onTaskUpdate` worker timeouts make vitest exit 1 even when every test is green.
- **Settling under CI.** GitHub sets `CI=true`. A test that expects `next` to settle passes `{ env: fixtureEnv() }`.
- **c2, byte for byte:**
  - a recap with no decisions (absent or `[]`) journals no `decisions` key;
  - a spec write with no `carries` journals no `carries` key;
  - a plan whose parent carries nothing gets no `decisions-from` line, and its write entry gets no `decisions` key;
  - `planPairSha(plan, parent, undefined)` equals today's `planPairSha(plan, parent)`.
- **DESIGN rows.** Amend touched rows in place with `**Amended by 198:**` or `**Touched by 198:**`. Row 198 is new. Row 197 is Part C's, so leave the gap; C inserts 197 above 198.
- **No new config key.**
- **Copy, verbatim** (`<…>` is filled in; `pin7(x)` is `short(x)`, or `none` when `x` is absent):
  - refusal `unknown-decision` (field `carries[<i>]`): want `a decision id from the latest recap: <d-ids, space-separated, or (none)>`
  - refusal `stale-decisions` (field `decisions-from`): want `the decisions <parent> carries are at <pin7(computed)> — omit decisions-from; witness write stamps it`
  - check `decision-coverage`:
    - `<n> decisions carried`
    - `the recap carries no decisions`
    - `uncarried decisions: <ids>`
  - check `pin-fresh`:
    - the decisions clause: `decisions-from <pin7(pinned)> but <parent> carries decisions at <pin7(current)> — rewrite the plan (witness write re-stamps the pins)`
    - the ok detail gains ` · decisions <short>` when the parent carries decisions
  - check `mid-flight-amendment`, when only the decisions moved: `the decisions <parent> carries moved off the pin — the plan was derived under the old ones · witness diff <parent>`
  - `witness diff`:
    - `delta: decisions only — the spec content is unchanged since the last plan`
    - `decisions: moved since <plan-id>`
    - rows `decisions-delta[<k>]{id,change,text}:` with `change` one of `added | changed | removed`
    - `decisions: moved since <plan-id> — witness read <spec-id> --decisions` when the base plan's write holds no texts
    - on an empty base: `decisions: <n> carried — all are the delta · witness read <spec-id> --decisions`
  - `read --decisions` headers:
    - `carried-by: <effort>`
    - `carried-by: none — no journaled write made this content`
    - `effort: <slug> · <class>`
  - prompt headings:
    - `### Decision coverage (journaled)`
    - `### Decisions <parent> carries — witness read <parent> --decisions`
    - `### The chore's recap — witness read <effort> --decisions`
- **Reviewers.** Spawn any reviewer with model opus.

## Consumed from Part A (0.22.0, read at `afc9e54`)

B relies on these Part A results, each checked against the shipped code:
- **`src/verbs/recap.ts` has one path for every recap.** It has no `manual` option, no autonomy branch and no `autonomyRefusal` or `sentBack`. Its marker is `{ op: 'recap(<effort>)', files: [stream], journal: { stream, line } }` (`:156`). B adds `decisions` to the `entry` above it (`:147-151`).
- **`GateSpec.resolve(root, ctx, canon, cfg, target)`** has five parameters, and `GateRun` is gone (`src/gate.ts:72`). B's edits to `gates/plan.ts` and `gates/decompose.ts` keep that signature.
- **One ladder, every walker.** Each of these walks `computeNext`:
  - drive, to fill its lanes (`src/drive.ts:632`) and to take a target back (`:392`);
  - `next`'s mirror of drive's fill, which decides `launch:` (`driveHasWork`, `src/verbs/next.ts:968`);
  - a drive child's `next`, scoped to its `WITNESS_DRIVE` target;
  - an autonomous chat's `humanAction` (`:987`), looking for the human's item.

  Task 2's re-arm and skip live in `computeNext` alone, so every walker sees them. Task 2's test 6 pins the child and the chat.
- **DESIGN rows 194–196** (`DESIGN.md:549-551`) each open their Choice with `Amends …`. A's rationale-trail sentence ends line `:351` and reads *Rows 194–196 (⊜) added 2026-10-23 — the drive and brainstorm grill (Q1–Q8), Part A: …*. Row 198 and B's sentence copy both shapes (Task 6).

B consumes none of A's new names: `conversationStage`, `humanAction`, `nextAsk(root)`, the parked-free `AskStatus` and `Aside.key0`. Part C consumes the last four, and `conversationStage` stays A's alone. B adds no human route, no ask logic and no drive code.

A's five deferred minors are not B's work:
- row 172's stale recap-check mention;
- no test for `outside` on an old recap-check ask;
- the `taken back · witness check` log wording;
- a drive child whose scoped `next` turns into a conversation is not told `drive: done`;
- a chat with only a trust grant renders `decide --show`.

**Line numbers are main @ `afc9e54`.** Part A moved three files B touches, and their numbers below were re-read after A:
- `src/verbs/recap.ts`: the recap check's removal moved `RecapInput` and `validateRecap` by −2, the entry by −26 and the output by −32.
- `src/verbs/next.ts`: A's tier-3 and design-rung edits moved `specsApproved` by −15, and `unrealizedDelta` and the plans-first `planSha` by −10.
- `README.md`: the verb rows moved by +2.

Every other number this plan gives held through A.

## Review Focus

1. **An upgraded consumer** (fewhats as 0.22.0 reads it: plans, no decisions). Every plan file stays byte-identical, nothing re-queues, and `next`, `status`, `index` and `diff <spec>` print exactly what 0.22.0 printed. That includes its finished, amended `device-lifecycle`. → Tasks 3, 4, and 7's differential.
2. **Two efforts wrote identical spec content with different `carries`.** The later act's decisions are carried, not the alphabetically first effort's. → Task 3, `the later of two efforts that wrote the same content wins`.
3. **An amendment removes a decision a spec carried.** The write keeps the id as history, `read --decisions` omits it, and the basis moves, so the plan re-queues. → Tasks 3 and 4.
4. **A chore plan on a spec that carries decisions.** Its `decisions-from` is the spec's set. Its critic reads both the parent's decisions and the chore's whole recap. `next` does not re-queue the spec. → Tasks 3 and 5.
5. **A doc no journaled write made** (a hand edit committed with the trailer, an adopt). It carries nothing, `read --decisions` says so, and nothing crashes. → Tasks 3 and 5.

---

### Task 0: Branch, plan commit and baseline

- [ ] **Step 1:** `git switch main && git pull && git switch -c decisions`. Confirm `git log --oneline -2` shows `afc9e54 chore(release): 0.22.0` above `632b1e8 Merge pull request #50`.
  - If main has moved past `afc9e54`, re-find the lines this plan names before using them:
    - `grep -n "export interface RecapInput\|export function validateRecap\|t: 'recap' as const\|ctx.out(kv('goals'" src/verbs/recap.ts`
    - `grep -n "const specsApproved =\|for (const spec of specs) {\|const planless = canon.docs\|const unrealizedDelta =\|const planSha = parent ?" src/verbs/next.ts`
- [ ] **Step 2: Commit this plan,** as Part A's branch opened with its own (`22eb433`). Part C's plan stays untracked, because it is re-read against B once B lands. `git add docs/superpowers/plans/2026-10-23-grill-B-decisions.md && git commit -m "docs: Part B's plan — numbered decisions (D198)"`
- [ ] **Step 3: Baseline.** `pnpm typecheck` exits 0, and `pnpm test` shows 0 AssertionError. Note the test count; 0.22.0's run gave 2043 passed.

### Task 1: The recap carries decisions, and a spec write carries them (rows 37, 38)

**Files:**
- Modify:
  - `src/journal.ts:36-45`: `RecapEntry` gains `decisions?: Array<{ id: string; text: string }>`.
  - `src/verbs/recap.ts`:
    - `RecapInput` (`:15-25`) gains `decisions?`;
    - `validateRecap` (`:50-67`) adds `out.push(...idTextList(e.decisions, 'decisions', 'd', false))` after constraints (`:62`);
    - the `entry` (`:147-151`) gains `...(recap.decisions?.length ? { decisions: recap.decisions } : {})`;
    - the output prints `decisions: <n>` after `goals:` (`:165`) when n > 0;
    - the `amended:` value (`:167`) becomes `latest recap wins; coverage and decisions re-validate against it`.
  - `src/verbs/write.ts`:
    - `Manifest` (`:22-35`) gains `carries?: unknown`;
    - `Built` (`:37-42`) gains `carries: string[]`;
    - `buildSpecMeta` (`:50-54`) validates `carries` as it validates `covers`;
    - the write entry (`:250`) becomes `{ covers: built.covers, ...(built.carries.length ? { carries: built.carries } : {}) }` for non-plans.
  - `src/reviewed.ts:74-86`: `WriteInfo` and `effortWrites` gain `carries?: string[]`. The latest write wins, as for `covers`.
  - `src/verbs/log.ts:17-24`: the recap detail inserts ` decisions=<n>` after `goals=<n>` when n > 0. The write detail appends ` carries=<a+b>` after `covers`.
- Test: `tests/recap.test.ts`, `tests/write-spec.test.ts`, `tests/log.test.ts`

**Interfaces — produces:** `RecapEntry.decisions?`, `WriteInfo.carries?`, and the write entry's `carries` (specs only, journal only, never frontmatter).

- [ ] **Step 1: Write the failing tests.** Each file declares `const D = [{ id: 'd1', text: 'Rotation is server-side' }, { id: 'd2', text: 'Rotate at 80% of the TTL' }]`.

```ts
// tests/recap.test.ts
it('decisions are numbered like goals and journaled only when present', async () => {
  const repo = await seededRepo({ noRecap: true })
  const r = await repo.cli(['recap', '--file', repo.writeRecap({ decisions: D })])
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('decisions: 2')
  expect(latestRecap(repo.root, 'auth-hardening')?.decisions).toEqual(D)
  for (const [bad, rule] of [[[{ id: 'x1', text: 'a' }], 'id-prefix'], [[D[0], D[0]], 'id-unique'], [[{ id: 'd1', text: ' ' }], 'required']] as const) {
    const res = await repo.cli(['recap', '--amend', '--file', repo.writeRecap({ decisions: bad })])
    expect(res.code).toBe(2); expect(res.stderr).toContain(rule)
  }
  const bare = await seededRepo({ noRecap: true })
  await bare.cli(['recap', '--file', bare.writeRecap({ decisions: [] })])
  expect('decisions' in latestRecap(bare.root, 'auth-hardening')!).toBe(false)
})

// tests/write-spec.test.ts
it('carries names recap decisions and is journaled beside covers, never in frontmatter', async () => {
  const repo = await seededRepo()
  await repo.cli(['recap', '--amend', '--file', repo.writeRecap({ decisions: D })])
  expect((await writeSpec(repo, 'auth-refresh', { carries: ['d1'] })).code).toBe(0)
  const last = () => readStream(repo.root, 'auth-hardening').filter((e) => e.t === 'write').at(-1)!
  expect(last().carries).toEqual(['d1'])
  expect(repo.read('specs/auth-refresh.md')).not.toContain('carries')
  const bad = await writeSpec(repo, 'auth-refresh', { carries: ['d9'] })
  expect(bad.code).toBe(2); expect(bad.stderr).toContain('unknown-decision'); expect(bad.stderr).toContain('d1 d2')
  await writeSpec(repo, 'auth-refresh')
  expect('carries' in last()).toBe(false)
})

// tests/log.test.ts
it('names decisions on the recap and carries on the write', async () => { /* recap with D, writeSpec carries ['d1','d2'];
  `log auth-hardening` contains 'decisions=2' and 'carries=d1+d2' */ })
```

- [ ] **Step 2: Run them and see them fail.** `pnpm exec vitest run tests/recap.test.ts tests/write-spec.test.ts tests/log.test.ts` → FAIL.
- [ ] **Step 3: Implement** as listed in Files.
- [ ] **Step 4: Run them and see them pass.** Same command → PASS. `pnpm typecheck` exits 0.
- [ ] **Step 5: Commit.** `git commit -am "feat: the recap carries numbered decisions; a spec write carries them (D198)"`

### Task 2: Decompose checks that every decision landed, and an amendment re-arms it (rows 38, 52)

**Files:**
- Modify:
  - `src/verbs/next.ts`: the efforts loop (`:772-816`) with its shortcut (`specsApproved`, `:803`) and condition (`:805-806`), the design rung (`:818-847`) and the `planless` filters (`:865-873`). Builder's call 8, in one derivation:
    - **`amendedSinceSettled(entries: Entry[]): boolean`** is true when there are ≥ 2 `recap` entries and the last one's index is greater than the last index of a settling decompose event. A settling event is a `gate-run` with `gate: 'decompose'` and `outcome: 'passed'`, or a `human-decision` with `gate: 'decompose'` and `decision: 'approve'`; −1 when there is none.
    - **`effortFinished(specs: CanonDoc[], plans: CanonDoc[]): boolean`** is true when every spec is `live` and no plan whose `parent` is one of them is unfinished (`planFinished`).
    - **`decomposeOwed(root, canon, e, specs, plans): boolean`** is the efforts loop's existing condition, `!specsApproved && !gateSettled(…, effortSha) && !gateParked(…)`. Its `specsApproved` gains `&& (!amendedSinceSettled(e.entries) || effortFinished(…))`. The loop calls it, which changes no other branch.
    - **`reslicing: Set<string>`:** before the design rung, compute the slugs of the live, non-chore efforts with ≥ 1 write for which `decomposeOwed` holds. This is computed over all efforts, ignoring `admits`, because a scoped walk must still know.
    - **The design rung and the `planless` filter** skip a spec that any effort in `reslicing` wrote (`effortWrites(root, slug).has(id)`).

    The comments name rows 52 and 18 and Builder's call 8. The queue's comment *Reaching this rung proves decompose is settled* (`:860`) holds only for a walk that admits the effort; it gains that a scoped walk relies on `reslicing`.
  - `src/reviewed.ts:116-125`: in `effortReviewedSha`, a spec's line gains `:carries=<ids joined by +>` when its latest write in this effort carries something (Builder's call 7). With no carries the bytes are today's.
  - `src/gates/decompose.ts`:
    - after `spec-coverage` (`:55-56`), add the `decision-coverage` check;
    - after `### Goal coverage (journaled)` (`:84`), add the decision table;
    - the snapshot context (`:93`) gains the table as a third part, only when there is one.
  - `prompts/slicing-critic.md`:
    - add lens **9. Decision fidelity** after lens 8;
    - the reviewed-content sentence (`:20`) names the decision table;
    - the intro (`:3`) adds decision-coverage totality to the mechanical checks.
  - `tests/prompts.test.ts:21-26`: add `'Decision fidelity'` to the lens list.
- Test: `tests/gate-decompose.test.ts`, `tests/reviewed.test.ts`, `tests/next-authoring.test.ts`, `tests/next-scope.test.ts`

**Rules:**
- `decisions = recap.decisions ?? []`.
- `carried` = the union of `writes.get(<spec>)?.carries ?? []` over `docs`.
- The check fails with `uncarried decisions: <ids>`. There is no reverse rule: a spec may carry nothing.
- The table has one line per spec: `<spec>: carries <ids>`, or `(none)`.

**Lens 9's content:**
- A spec that contradicts a decision it carries is blocking.
- A decision that states observable behavior must appear in the `## Behavior` of every spec that carries it. Missing is blocking.
- An approach decision needs no Behavior line, but no spec may contradict it.
- Anchor findings to the spec's heading.

- [ ] **Step 1: Write the failing tests** in `tests/gate-decompose.test.ts`. Use the file's `cover`, `runsOf` and `fakeCtx`, plus `const amend = (repo, decisions) => repo.cli(['recap', '--amend', '--file', repo.writeRecap({ decisions })])`.
  1. `decision-coverage fails on a decision no spec carries, and a carries-only fix is judged afresh`:
     - amend with `D`, then `writeSpec(repo, 'auth-refresh', { carries: ['d1'] })`, then run the gate;
     - the `decision-coverage` check has `ok` false and its detail is `uncarried decisions: d2`;
     - rewrite with `carries: ['d1', 'd2']`, with the content unchanged, and run the gate again;
     - the second run's `reviewed_sha` differs and the round is not `cached` (its entry's `cached` field is falsy). The check has `ok` true and the detail `2 decisions carried`.
     - `callCount(scenario)` grew, and the latest `slicing-critic` call's stdin (`readFileSync(join(callFor(scenario, 'slicing-critic')!, 'stdin'), 'utf8')`) contains `### Decision coverage (journaled)` and `auth-refresh: carries d1 d2`.
  2. `tests/reviewed.test.ts` › `carries join the effort's identity only when present`:
     - amend with `D`, `writeSpec` without `carries`, and record `effortReviewedSha(…).sha` as `s1`;
     - rewrite the same content with `carries: ['d1']`; the sha is no longer `s1`;
     - rewrite it again without `carries`; the sha is `s1` again, so a decision-free effort's bytes are today's (c2).
  3. `an effort with no decisions passes decision-coverage and its critic reads no decision table`:
     - with no amend, the check's detail is `the recap carries no decisions`;
     - stdin does not contain `### Decision coverage (journaled)`. Match the heading, not the words: the prompt text itself names the table.
  4. In `tests/next-authoring.test.ts` › `next — doc-gate lapse`, add `an amendment re-arms decompose until a round settles it (row 52)`. That file has no `amend`, `D`, `gateEnv`, `putVerdict` or `fakeScenario` yet, so declare `amend` and `D` as above and import the rest from `./helpers.js`.
     - `seededRepo()`, `writeSpec(repo, 'auth-refresh')`, `approve(repo, 'auth-refresh')`;
     - `nextLine(repo)` contains `witness write auth-refresh-plan-1`;
     - `amend(repo, D)`; `next` contains `next: witness gate decompose --effort auth-hardening` and not `auth-refresh-plan-1`;
     - run the gate with a clean verdict (it stops, because `decision-coverage` fails), then `decide decompose auth-hardening --revise --note "carry the decisions"`;
     - `next` now contains `witness write <spec-id> --effort auth-hardening` and `stage: decompose`, not the plan write. This is the case the spec review reproduced.
     - rewrite with `carries: ['d1', 'd2']`, run the gate, then `decide decompose auth-hardening --approve`; `next` contains `witness write auth-refresh-plan-1` again.
  5. `next-authoring.test.ts` › `amending a finished effort re-arms nothing`:
     - `writeSpec`, `approve`, `writePlan`, `flipStatus(plan, 'done')`, `stampLive(spec)`;
     - `amend(repo, D)`; `next` does not contain `gate decompose`.
  6. `next-scope.test.ts` › `a spec its effort is re-slicing waits for the re-slice`. This file has no `amend` or `D` either, so declare both; it already imports `autonomyOn` and `fixtureEnv`.
     - **A drive child, plain spec:**
       - set up as test 4 does up to its `amend`, before any gate: `seededRepo()`, `writeSpec(repo, 'auth-refresh')`, `approve(repo, 'auth-refresh')`, `amend(repo, D)`;
       - `nextLine(repo, { env: { WITNESS_DRIVE: 'auth-refresh' } })` contains `next: witness check` and `drive: done — nothing more is owed for auth-refresh`;
       - it contains no `witness write auth-refresh-plan-1`.
     - **A ui spec, as a drive child and in the chat:**
       - a fresh `seededRepo()`, then `writeSpec(repo, 'billing-page', { ui: true, criteria: [{ id: 'ac-b', test: '@spec:billing-page' }] })`, `approve(repo, 'billing-page')`, `amend(repo, D)`, `autonomyOn(repo)`;
       - `nextLine(repo, { env: fixtureEnv({ WITNESS_DRIVE: 'billing-page' }) })` contains `drive: done — nothing more is owed for billing-page` and no `witness design billing-page`;
       - the chat, `nextLine(repo, { env: fixtureEnv() })`, contains `next: witness gate decompose --effort auth-hardening` and `launch: witness drive --detach`, and no `witness design billing-page`.
       - **Probed at `afc9e54`** with a one-line re-arm and no skip: the child printed `next: witness design billing-page --file <html>` and no `drive: done`, and the chat printed the same line beside `launch:`. This is the case A made reachable: `humanAction` sets the gate aside as drive's work and routes the chat to the look.
       - **The child pins the `planless` half too.** With the design rung skipped alone, the child fell through to `witness write billing-page-plan-1`, because `plannableParent` does not check the look. With both halves, it printed `next: witness check` and `drive: done`, and the chat printed the gate beside `launch:`.
- [ ] **Step 2: Run and see FAIL.** `pnpm exec vitest run tests/gate-decompose.test.ts tests/reviewed.test.ts tests/prompts.test.ts tests/next-authoring.test.ts tests/next-scope.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see PASS.** Same command, plus these, which must stay green:
  - `tests/arbiter-ask.test.ts`: the arbiter still reads the recap whole via `canonicalJson`;
  - `tests/next.test.ts tests/next-live-queue.test.ts tests/fixtures.test.ts`: un-amended efforts keep the shortcut.
- [ ] **Step 5: Commit.** `git commit -am "feat: decompose checks every decision landed; an amendment re-arms it (D198)"`

### Task 3: What a doc carries, and the plan's second pin

**Files:**
- Create `src/decisions.ts`: `RecapDecision` (not `Decision`, which `src/recommend.ts:25` already exports and `next.ts:27` imports), `carriedDecisions`, `decisionsSha`. It imports `writeAct` from `./abandon.js`. This makes no cycle:
  - `abandon.ts`'s static import closure (40 modules at `afc9e54`, re-probed after A deleted `recap-check.ts`) reaches none of the modules that will import `decisions.ts` or `basis.ts`: next, write, check, diff, read, the gates;
  - `design.ts` → `reviewed.ts` is in that closure, so `reviewed.ts` must never import `decisions.ts`, which is why `planPairSha` takes the sha as a parameter.
- Create `src/basis.ts`: `Basis`, `specBasis`, `planBasis`, `basisMoved`.
- Modify:
  - `src/verbs/write.ts`:
    - `buildPlanMeta` (`:306-409`) stamps `decisions-from` and refuses `stale-decisions`;
    - `Built` gains `decisions?: RecapDecision[]`;
    - `Manifest` gains `'decisions-from'?: unknown`;
    - both `buildPlanMeta` returns (`:313`, `:408`) gain `carries: []`, which Task 1's `Built.carries` requires;
    - the plan's write entry (`:250`) gains `...(built.decisions ? { decisions: built.decisions } : {})`.
  - `src/schemas.ts:83-85`: a `decisions-from` shape check, a copy of `design-from`'s (`64-hex carried-decisions sha`).
  - `src/fm.ts:11-14`: `'decisions-from'` goes after `'design-from'` in `FIELD_ORDER`.
  - `src/history.ts:19-51`: `BaseResolution` gains `decisions?: string`, from the base plan's `decisions-from`.
  - `src/reviewed.ts`:
    - `planPairSha` (`:127-132`) gains a third parameter;
    - `WriteInfo` gains `decisions?: Array<{ id: string; text: string }>`, inline so that `reviewed.ts` never imports `decisions.ts`, and `effortWrites` reads it.
- Test: create `tests/decisions.test.ts`; `tests/write-plan.test.ts`, `tests/reviewed.test.ts:175-187`, `tests/schemas.test.ts`

**Interfaces — produces:**

```ts
// src/decisions.ts
export interface RecapDecision { id: string; text: string }
export function carriedDecisions(root: string, doc: CanonDoc): { effort: string; decisions: RecapDecision[] } | undefined
export function decisionsSha(decisions: readonly RecapDecision[]): string | undefined   // undefined for []; else sha256(canonicalJson(decisions))
// src/basis.ts
export interface Basis { spec: string; decisions?: string }
export function specBasis(root: string, doc: CanonDoc): Basis       // { spec: canonicalSha, decisions?: decisionsSha(carried) }
export function planBasis(plan: CanonDoc): Basis                    // { spec: derives-from, decisions?: decisions-from }
export function basisMoved(pinned: Basis, current: Basis): Array<'spec' | 'decisions'>   // [] = fresh; absent equals absent
// The decisions term of a plan's reviewed identity (Builder's call 6, plus the spec review's chore finding):
// specBasis(root, parent).decisions — and, for a plan whose effort is a chore, its chore recap's decisions too
// (decisionsSha over both, tagged {parent, chore}); undefined when neither carries any. Never a pin: a chore's
// decisions in `decisions-from` would re-queue the parent spec forever (Builder's call 4).
export function planDecisionsTerm(root: string, plan: CanonDoc, parent: CanonDoc): string | undefined
// src/reviewed.ts
export function planPairSha(plan: CanonDoc, parent: CanonDoc, decisions?: string): string
```

**`carriedDecisions`, in this order:**
1. Take `sha = canonicalSha(doc)` and find the efforts whose stream holds a `write` of `(id, sha)`.
2. With none, return `undefined`. With one, take it. With several, take `writeAct(root, id, sha)!.effort`; git blame is paid only in this rare case.
3. `carries` is the last such write line in that stream (`?? []`).
4. `decisions` = `(latestRecap(root, effort)?.decisions ?? []).filter((d) => carries.includes(d.id))`, in recap order. An id the latest recap lacks is history (§7).

**`planPairSha`:** with `decisions` undefined it hashes exactly today's two parts; otherwise it appends `\ndecisions:<sha>`.

**The plan write:**
- `decisionsFrom = decisionsSha(carriedDecisions(root, parent)?.decisions ?? [])`.
- A supplied `manifest['decisions-from']` that differs from it refuses `stale-decisions`.
- `meta['decisions-from']` is set only when the sha is defined.
- `built.decisions` is set only when the list is non-empty.

- [ ] **Step 1: Write the failing tests.** `tests/decisions.test.ts` declares `const amend = (repo, ds) => repo.cli(['recap', '--amend', '--file', repo.writeRecap({ decisions: ds })])` and `const doc = (repo, id) => findById(loadCanon(repo.root), id)!`.
  1. `a spec carries the decisions of the write that made its content`: amend with `D`, then `writeSpec … carries ['d2']`. `carriedDecisions` returns `{ effort: 'auth-hardening', decisions: [D[1]] }`.
  2. `the later of two efforts that wrote the same content wins (D168)`:
     - effort 1 carries `d1` = `'first says A'`;
     - write `r2.json` as `{ ...RECAP, effort: 'second', decisions: [{ id: 'd1', text: 'second says B' }] }` and run `recap --file r2.json`;
     - `writeSpec(repo, 'auth-refresh', { carries: ['d1'] }, SPEC_BODY, 'second')` writes the same content;
     - the result is `{ effort: 'second', decisions: [{ id: 'd1', text: 'second says B' }] }`.
  3. `an id the latest recap dropped is history, never carried`: carry `['d1', 'd2']`, then amend with only `[D[0]]`. The carried ids are `['d1']`.
  4. `a doc no journaled write made carries nothing`: `repo.setMeta('auth-refresh', { summary: 'hand edited' })` (a trailered commit, no write). The result is `undefined`.
  5. `a decision the doc does not carry leaves its basis alone`: carry `['d1']`, record `specBasis(root, doc)`, then amend with `[...D, { id: 'd3', text: 'Audit every rotation' }]`. `specBasis` is unchanged (`toEqual`), so adding an uncarried decision re-queues no plan.
  6. `basisMoved compares term by term`:
     - `basisMoved({ spec: 'a' }, { spec: 'a' })` is `[]`;
     - `basisMoved({ spec: 'a' }, { spec: 'a', decisions: 'x' })` is `['decisions']`;
     - `basisMoved({ spec: 'a', decisions: 'x' }, { spec: 'b' })` is `['spec', 'decisions']`.

  In `tests/write-plan.test.ts`:
  - `a plan pins the decisions its parent carries`:
    - amend with `D`, then `writeSpec … carries ['d1']`, `approve`, `writePlan`;
    - the frontmatter's `decisions-from` is `decisionsSha([D[0]])`;
    - the plan's write entry has `decisions: [D[0]]`;
    - a second `writePlan` with `'decisions-from': 'f'.repeat(64)` exits 2 with `stale-decisions`.
  - `a parent that carries nothing leaves the plan as it was`: the plan file does not contain `decisions-from`, and the plan's write entry has no `decisions` key.

  In `tests/reviewed.test.ts` `planPairSha`:
  - `planPairSha(plan, parent, undefined)` is `toBe(base)`;
  - `planPairSha(plan, parent, 'a'.repeat(64))` is `not.toBe(base)`.

  In `tests/schemas.test.ts`: a plan with `'decisions-from': 'zz'` fails validation with field `decisions-from` and rule `shape`.
- [ ] **Step 2: Run and see FAIL.** `pnpm exec vitest run tests/decisions.test.ts tests/write-plan.test.ts tests/reviewed.test.ts tests/schemas.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see PASS.** Also run `tests/abandon.test.ts tests/diff.test.ts tests/protocol/pipeline.test.ts`, which must still be green (`writeAct`, `baseForSpec` and write entries are unchanged for decision-free data). `pnpm typecheck` exits 0.
- [ ] **Step 5: Commit.** `git commit -am "feat: a plan pins the decisions its parent carries (D198)"`

### Task 4: Every pin comparer reads the basis (§4.5 Staleness, §10)

**Files:**
- Modify:
  - `src/gates/plan.ts`:
    - `pin-fresh` (`:50-55`) uses `basisMoved(planBasis(plan), specBasis(root, parent))`;
    - `reviewedSha` (`:81`) and `currentSha` (`:97-101`, use its `root` argument) become `planPairSha(plan, parent, planDecisionsTerm(root, plan, parent))`.
  - `src/gates/decompose.ts:58-65`: `amendment-ack`'s `staleChildren` filter becomes `basisMoved(planBasis(p), specBasis(root, parent)).length > 0`.
  - `src/verbs/next.ts`:
    - `unrealizedDelta` (`:861-864`) becomes `base.kind === 'empty' || basisMoved({ spec: base.sha!, ...(base.decisions ? { decisions: base.decisions } : {}) }, specBasis(root, d)).length > 0`;
    - the plans-first `planSha` (`:904`) passes `planDecisionsTerm(root, plan, parent)`.
  - `src/verbs/check.ts:186-193`: `mid-flight-amendment` fires on a non-empty `basisMoved`. Its detail is today's when `'spec'` moved, and the decisions-only copy otherwise.
  - `src/verbs/diff.ts`: the decisions block (rules below).
- Test: `tests/gate-plan.test.ts`, `tests/gate-decompose.test.ts`, `tests/next-live-queue.test.ts`, `tests/diff.test.ts`, `tests/check.test.ts`

**Interfaces — consumes:** Task 3's `specBasis`, `planBasis`, `basisMoved`, `planDecisionsTerm`, `carriedDecisions`, `WriteInfo.decisions`, `BaseResolution.decisions`.

**`pin-fresh`:** it is ok iff nothing moved. The failing detail joins the moved terms' clauses with ` · `, the spec clause first and verbatim from today.

**One decision delta:** Task 4 exports `decisionDelta(root: string, basePlanId: string, spec: CanonDoc): Array<{ id: string; change: 'added' | 'changed' | 'removed'; text: string }> | undefined`.
- It returns `undefined` when the base plan's write holds no texts.
- `witness diff` uses it, and so does the plan gate's delta block (Task 5).

**`diff`, after its `base:` line:**
- `moved = basisMoved(…)`. `[]` keeps `delta: none — no delta since the last plan`.
- `['decisions']` alone prints `delta: decisions only — …`, then the block.
- With `'spec'` in `moved`, the git diff prints as today, then the block if `'decisions'` moved too.
- **The block:**
  - `decisions: moved since <plan-id>`;
  - then rows comparing the base plan's journaled `decisions` (`effortWrites(root, effortOf(root, planId)).get(planId)?.decisions`) with the current carried set;
  - the rows are ordered added, then changed, then removed, by id; a removed row shows the old text;
  - with no journaled texts, print the `— witness read <spec> --decisions` variant instead.
- **An empty base** whose spec carries decisions adds the `all are the delta` line.

- [ ] **Step 1: Write the failing tests.**

  **Shared setup:** `decided()` = `seededRepo({ noRecap: true })`, then `recap --file writeRecap({ decisions: [{ id: 'd1', text: 'Rotation is server-side' }] })`. This is a birth recap, not an amendment, so the fixture shortcut holds. Then `writeSpec … carries ['d1']`, `approve`, `writePlan(repo, 'auth-refresh-plan-1')`. `turn(repo, text)` amends `d1`'s text to `text`.
  1. `gate-plan.test.ts` › `a changed carried decision fails pin-fresh and re-keys the verdict`:
     - gate → passed; then `turn(repo, 'Rotation is client-side')`; gate → exit 1;
     - the two runs' `reviewed_sha` differ;
     - `pin-fresh` has `ok` false, and its detail contains `decisions-from` and `but auth-refresh carries decisions at`.
  2. `next-live-queue.test.ts` › `a changed carried decision re-queues the spec of a done plan`:
     - after `flipStatus(… 'done')` and `stampLive`, `next` has no `witness write auth-refresh-plan-2`;
     - after `turn(…)`, `next` contains it, because the effort is finished and Task 2's re-arm leaves it alone.
  3. `diff.test.ts` › `prints the decision delta when only the decisions moved`. After 2's `turn`, the output contains all of:
     - `delta: decisions only — the spec content is unchanged since the last plan`
     - `decisions: moved since auth-refresh-plan-1`
     - `decisions-delta[1]{id,change,text}:`
     - `  d1,changed,Rotation is client-side`
  4. `gate-decompose.test.ts` › `amendment-ack names an in-progress plan whose carried decisions moved`: `decided`, `flipStatus(plan, 'in-progress')`, `turn`, then the decompose gate. `amendment-ack` has `ok` false, and its detail contains `auth-refresh-plan-1`.
  5. `check.test.ts` › `warns when an in-progress plan's carried decisions moved`: the output contains `mid-flight-amendment` and `the decisions auth-refresh carries moved off the pin`.
  6. `gate-plan.test.ts` › `a changed chore decision re-keys its chore plan's gate`:
     - build the chore setup: `seededRepo({ preexisting: ['auth-refresh'] })`, a chore recap `tidy` with `decisions: [{ id: 'd1', text: 'Keep the public API' }]`, and `writePlan(repo, 'auth-refresh-plan-1', {}, PLAN_BODY, 'tidy')`. Task 5's chore case reuses it.
     - gate it;
     - amend `tidy`'s `d1` text, then gate again;
     - two runs, with different `reviewed_sha`;
     - the plan file is unchanged: no `decisions-from` (Builder's call 4).
- [ ] **Step 2: Run and see FAIL.** `pnpm exec vitest run tests/gate-plan.test.ts tests/gate-decompose.test.ts tests/next-live-queue.test.ts tests/diff.test.ts tests/check.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see PASS.** Also `tests/next.test.ts tests/next-authoring.test.ts tests/stamp.test.ts tests/ship-pr.test.ts`. The stamp's `pinFresh` and ship's re-pin stay on `derives-from` on purpose, because the drift lane verifies content, not decisions.
- [ ] **Step 5: Commit.** `git commit -am "feat: every pin comparer reads one basis — a changed decision re-queues its plans (D198)"`

### Task 5: `witness read --decisions`, and the plan critic reads them

**Files:**
- Modify:
  - `src/decisions.ts`: add `decisionLines` and `recapLines`.
  - `src/verbs/read.ts`:
    - the `decisions` option (`:51-54`);
    - the usage string (`:56`) becomes `usage: witness read <id> [--design] [--outline] [--lines <a>-<b>] [--decisions]`;
    - the mode branch comes before the `!doc` refusal (`:64-68`), or an effort slug refuses `unknown-id` before the branch can read its recap.
  - `src/cli.ts:92`: the same usage in `VERB_USAGE` (`tests/verb-usage.test.ts` pins the pair).
  - `src/gates/plan.ts`:
    - the `promptBody` (`:69-75`) gains the decisions section between `### Delta base` and `### Plan:`, plus the chore section for a chore effort;
    - **the `### Delta base` block also carries the decision delta.** When `basisMoved(…)` against the base plan names `'decisions'`, it appends `decisions moved since <base-plan>:` and the `decisionDelta` rows.
      - Without this, a plan re-queued because only decisions moved is told "realize what changed since" a pin equal to the current spec. Its delta criteria are empty, so nothing checks that it realizes the change (g4, spec review).
    - the snapshot context (`:82`) gains the section text.
  - `prompts/plan-critic.md`:
    - lens **4. Decision fidelity**;
    - the reviewed-content sentence (`:11`) names the decisions block.
  - `tests/prompts.test.ts:28-30`: add `'Decision fidelity'` to the plan lenses.
- Test: `tests/read.test.ts`, `tests/gate-plan.test.ts`

**Interfaces — produces:**

```ts
export function decisionLines(root: string, doc: CanonDoc): string[]  // carried-by: …, then rows decisions · constraints · non_goals (fields id,text), each even when empty
export function recapLines(recap: RecapEntry): string[]               // effort: <slug> · <class>, then rows goals · decisions · constraints · non_goals, then list('slices', …) — the whole recap, slices included
```

**`read --decisions` rules:**
- **It runs alone.** Given with `--design`, `--outline` or `--lines`, it refuses `v('--decisions', 'exclusive', <the others>, "witness read <id> --decisions alone — a separate mode, never mixed into the artifact's lines")`.
- **A spec or principles** prints `decisionLines`.
- **A plan** refuses `v('id', 'not-a-spec', '<id> is a plan', "its parent's — witness read <parent> --decisions")`.
- **No canon doc** with `latestRecap(root, id)` defined prints `recapLines`.
- **Anything else** keeps `unknown-id`, with the want `an id from witness index — or an effort slug with --decisions`.

**Lens 4's content:**
- The block lists what the parent's slicing settled and its effort's standing limits. A chore plan also gets the chore's whole recap.
- A step whose body builds what a non-goal rules out, breaks a constraint, or takes an approach a decision ruled out is blocking.
- When the delta block lists decisions added or changed since the previous plan, a plan whose steps realize none of them is blocking.
- Otherwise, silence is not contradiction.
- Anchor findings to `<plan-id> > ## Step: <id>`.

- [ ] **Step 1: Write the failing tests.** The recap in each case is `writeRecap({ decisions: [D[0]], constraints: [{ id: 'c1', text: 'No new dependencies' }], non_goals: [{ id: 'n1', text: 'No SSO changes' }] })`, and the spec carries `['d1']`.
  1. `read.test.ts` › `--decisions prints what a spec carries with its effort's limits`: `stdout.split('\n')` equals
     `['carried-by: auth-hardening', 'decisions[1]{id,text}:', '  d1,Rotation is server-side', 'constraints[1]{id,text}:', '  c1,No new dependencies', 'non_goals[1]{id,text}:', '  n1,No SSO changes']`.
  2. `--decisions on an effort prints its whole recap`: line 0 is `effort: auth-hardening · feature`; it holds `goals[1]{id,text}:`, `  g1,Refresh tokens rotate before expiry`, and the recap's `slices[` line.
  3. `--decisions is its own mode`:
     - with `--outline` it exits 2 with `exclusive`;
     - `read auth-refresh --outline` contains no `decisions[`, and `read auth-refresh --lines 1-3` equals the first three lines of `read auth-refresh` (both modes unchanged, §8);
     - `read auth-refresh-plan-1 --decisions` exits 2 with `not-a-spec`;
     - `read nope --decisions` exits 2 with `unknown-id`;
     - after `setMeta(… summary)`, the output starts with `carried-by: none — no journaled write made this content`.
  4. `gate-plan.test.ts` › `the plan critic reads the parent's decisions, and a chore plan also reads its recap`. Read `stdin = readFileSync(join(callFor(scenario, 'plan-critic')!, 'stdin'), 'utf8')`.
     - **Feature:** stdin contains `### Decisions auth-refresh carries — witness read auth-refresh --decisions` and `  d1,Rotation is server-side`.
     - **Chore:** with Task 4's chore setup, stdin contains `### The chore's recap — witness read tidy --decisions` and `effort: tidy · chore`.
  5. `gate-plan.test.ts` › `a plan re-queued for decisions alone reads the decision delta`:
     - use Task 4's `decided` + done plan + `turn`, then `writePlan(repo, 'auth-refresh-plan-2')` and gate it;
     - plan-critic stdin contains `decisions moved since auth-refresh-plan-1:` and `  d1,changed,Rotation is client-side`.
- [ ] **Step 2: Run and see FAIL.** `pnpm exec vitest run tests/read.test.ts tests/gate-plan.test.ts tests/prompts.test.ts tests/verb-usage.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see PASS.** Same command. `pnpm typecheck` exits 0.
- [ ] **Step 5: Commit.** `git commit -am "feat: witness read --decisions, and the plan critic blocks a contradicted decision (D198)"`

### Task 6: Skills, README and DESIGN rows

**Files:**
- `plugin/skills/witness-decompose/SKILL.md`:
  - **Inputs:** `:30` becomes `$WITNESS read <effort> --decisions   # the latest recap: class, goals g*, decisions d*, constraints c*, non-goals n*`.
  - **Manifest example:** it gains `"carries": ["d1"]`.
  - **A new bullet beside `covers`:** *`carries`: the recap decision ids this spec realizes. Every decision is carried by ≥ 1 spec (the gate's `decision-coverage`). A behavior decision is stated in that spec's `## Behavior`; an approach decision is not contradicted. The journal holds it, never frontmatter.*
  - **The totality self-check (`:50`):** it adds *every decision carried by ≥ 1 spec*, and *a decision no slice can carry was filed wrong — it is a constraint or a non-goal; say so at the gate stop, where `--revise --upstream` re-opens the recap*.
- `plugin/skills/witness-plan/SKILL.md`:
  - **Inputs (`:36-42`):** add `$WITNESS read <spec-id> --decisions   # the decisions the spec carries + its effort's constraints and non-goals — the plan contradicts none (the critic blocks it)` and `$WITNESS read <effort> --decisions   # a chore plan: the chore's whole recap, too`.
  - **`:50`:** *`derives-from` and `decisions-from` are stamped by the CLI … never put either in the manifest; a supplied stale pin refuses.*
  - **`:97`:** *a parent amended mid-flight, or a decision it carries changed, fails `pin-fresh`.*
- `tests/skills.test.ts:60-113`:
  - decompose contains `"carries"`, `decision-coverage` and `read <effort> --decisions`;
  - plan contains `--decisions` and `decisions-from`.
- `README.md` verb rows (`:277-280`):
  - `recap`: *… a scope recap — class, goals, non-goals, constraints and numbered decisions; births the effort journal*;
  - `write`: *…; a spec's `covers` and `carries` map it to the recap's goals and decisions*;
  - `diff`: *…, and the decisions that moved since that plan*;
  - `read`: gains `[--decisions]` and *`--decisions` prints the decisions a spec carries with its effort's constraints and non-goals, or an effort's whole recap*.
- `DESIGN.md`:
  - **The stage table:**
    - row 2 (`:29`) adds *+ **decision coverage**: every recap decision carried by ≥1 spec (`carries`, manifest-only)*;
    - row 3 (`:31`) adds *+ a `decisions-from` pin when the parent carries decisions* and *the plan critic blocks a contradicted decision, constraint or non-goal*.
  - **The effort prose (`:76`, `:79`):**
    - the set-level facts gain *the decision-carrying mapping*;
    - `covers` validation reads *`covers` and `carries`*;
    - fix the notation: `witness recap --amend <effort>` → `witness recap --amend --file <recap.json>` (the recap names its effort; probe: `--amend e1` refuses `Unexpected argument 'e1'`).
  - **Row 30:** `**Touched by 198:**` *the plan also pins `decisions-from` when its parent carries decisions; ship's re-pin stays on `derives-from`, since the drift lane verifies content, not decisions*.
  - **Row 38:** `**Amended by 198:**` *decision coverage rides the same rail — `carries: [d-ids]` per manifest, journaled beside `covers`, never frontmatter; write refuses `unknown-decision`; the gate's `decision-coverage` needs every decision carried by ≥1 spec, with no reverse rule*.
  - **Row 52:** `**Amended by 198:**` *an amendment re-validates `carries` against the latest recap as it does `covers`; a removed decision stays history in the writes that carried it; and it re-arms decompose even when every spec is past draft — `next`'s fixture shortcut no longer outlives a recap the gate has not judged (Builder's call 8)*. Fix the same `--amend <effort>` notation.
  - **Row 198** goes after row 196 (`:551`) in the shape of rows 194–196: `| 198 ⊜ | The recap carries numbered decisions to the stage that acts on them | Amends 38 and 52; touches 30. <Choice> | <Why> |`.
    - its Choice is §4.5 plus Builder's calls 1–7 (call 8 is recorded in row 52);
    - its Why is spec §1's fifth bullet, P5's unused alternatives, and the `log` probe in call 3.
  - **The rationale trail (`:351`):** after A's sentence, which ends the line, add *Row 198 (⊜) added <date> — the drive and brainstorm grill (Q3), Part B: the recap's numbered decisions reach the stage that acts on them (`docs/superpowers/specs/2026-10-23-grill-design.md` §4.5; amended: 38, 52; touched: 30).*
  - **Open / deferred** (`:555`): add
    - *a changed chore decision lapses only a draft chore plan's gate; an approved or in-flight chore plan is not re-queued or warned (Builder's call 4)*;
    - *amending a finished effort re-arms nothing, so a decision it adds lands in no spec; a finished effort's change is a new effort (Builder's call 8)*;
    - *a later effort's write of a spec hands the plan stage that effort's decisions alone, while the earlier effort's `decision-coverage` still counts its own as carried*;
    - *the two decision lenses carry no calibration seed yet*.

- [ ] **Step 1:** Edit `tests/skills.test.ts` as above. Run `pnpm exec vitest run tests/skills.test.ts` → FAIL.
- [ ] **Step 2:** Edit the two skills, `README.md` and `DESIGN.md`.
- [ ] **Step 3:** `pnpm exec vitest run tests/skills.test.ts tests/verb-usage.test.ts tests/prompts.test.ts` → PASS.
- [ ] **Step 4: Commit.** `git commit -am "docs: numbered decisions — skills, README, rows 30, 38, 52, 198 (D198)"`

### Task 7: Verify and hand over

- [ ] **Step 1: Full suite and typecheck.** `pnpm typecheck` exits 0. Run `pnpm test`, then `grep -c AssertionError` on its output, which must give 0. The passed count is Task 0's plus B's new cases.
- [ ] **Step 2: Read-only fewhats differential (c2).** Run `pnpm build`, then `git clone --local ~/x/personal/fewhats.com "$SCRATCH/fw"`, where `$SCRATCH` is the session's scratchpad directory. In the clone, with `CI=true`, run each of these with `npx -y @popovych.co/witness@0.22.0` and with `node <repo>/dist/bin.js`, and diff the outputs:
  - `next`, `status`, `index`;
  - `diff <id>` for every spec `index` lists;
  - `log <effort>` for every effort.

  **Expected: no difference.** fewhats has no decisions, and its one effort amended since a settling round (`device-lifecycle`) is finished, so Builder's call 8 leaves it alone. Any line that differs is a c2 defect: explain it and fix it before going on.

  Also run `git -C "$SCRATCH/fw" status --porcelain`, which must print nothing.
- [ ] **Step 3: Reviews.** Two opus reviewers, from different angles: code against this plan (pins, the cycle-free import, byte-identity), and behavior against spec §4.5 plus Review Focus 1–5. Re-run every finding before acting on it, then do one fix pass, red to green.
- [ ] **Step 4 (HUMAN):** push and open the PR (the agent does this when asked). The user merges, then runs `pnpm release minor` → 0.23.0.
