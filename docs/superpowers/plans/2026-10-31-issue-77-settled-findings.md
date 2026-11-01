# Issue #77 — A Finding Is Settled Before Its Bit (row 219) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reviewer that talks itself out of a finding must not have marked it blocking already. Every lens writes a finding's `blocking` after its `claim`, and decides on a finding before writing it. A finding the reviewer takes back then lands as a note, or is left out, so it neither stops a gate nor drives an autonomous revise. This closes issue #77 as row 219.

**Architecture:**
- The defect is in the verdict contract that the nine lens prompts carry, not in the CLI. The contract asks for the bit before the claim, from a reviewer that writes its whole answer in one pass.
- The fix reorders every finding the contract shows to `{ "anchor", "claim", "blocking" }`. It also adds one paragraph, the same in all nine lenses: decide on a finding before writing it, and never mark a claim that names no defect as blocking.
- `tests/prompts.test.ts` holds every lens to both changes. The CLI still reads the bit as written and never reads the claim.
- A live A/B run on the reporting round's own content measures the effect.

**Tech Stack:** Markdown prompts (`prompts/*.md`) and vitest. No `src/` change, no new dependency, no new setting.

**Spec:** [Issue #77](https://github.com/popovych-co/witness/issues/77) plus the verified evidence base below. Each claim was read at `origin/main` `35b8a81` (0.27.0) or in the reporting repo (`C:\Users\home\Documents\wot-mot-manager`) on 2026-10-31, on Windows 11 with Node 26.8.1. The measurement scripts are in `%TEMP%\witness77\`.

---

## Verified evidence base

### E1 — What happened (the reporting repo's `.witness/journal/static-site-plan-1.jsonl`)

- **Both rounds read the same content.** Line 25 (ship round 1) and line 27 (implement round 1) both reviewed tree `596dcac` (base `b66dc23`, 81 files). Both ran under 0.27.0, harness `pi`, pin `claude-opus-5-5` with no thinking level. Neither round rerolled a lens: `rerolled` is absent from both lines.
- **The finding.** In both rounds the code-reviewer's *first* finding is `blocking: true` at `packages/site/package.json`.
  - Its claim states a guess, works through the imports, then takes the guess back.
  - The ship claim ends `— no blocking dep issue; retracted.` (500 chars).
  - The implement claim ends `— retracting: … acceptable per plan.` (552 chars).
- **The coverage note.** At the same anchor, the coverage note says only `Compared declared dependencies against imports.` (ship) and `Checked the dependency list against the imports in the package's sources.` (implement). The comparison the note claims was actually done afterwards, inside the claim, once the bit was already written.
- **The decisions.** Lines 26 and 28 both read `revise`, `rule: blocking-here`, `selected: policy`, with the note `1 blocking finding: packages/site/package.json`.
  - Ship round 1 had also failed `tests`, `lint` and `drift-lane`. Its note named only the finding (E6).
  - Implement round 1 had every check green and no other blocking finding. With a false bit it would have passed outright, since implement has no standing stop.

### E2 — The CLI trusts the bit, by design (read)

- `parseVerdict` checks shape only: a boolean bit, a non-empty claim, an anchor of the right form. It copies the bit as written (`src/verdict.ts:40-75`, `:73`).
- `judge` counts the blocking findings, and one is enough to stop the round (`src/gate.ts:607`, `:614-618`).
- `recommend` checks for `blocking-here` (rules 8/9, `src/recommend.ts:299-322`) before `checks-failed` (9b, `:327`). Its header says it "never reads a finding's claim text" (`:9`).
- `notePrefill` builds the note from the blocking anchors (`src/rounds.ts:292-309`).
- `policyFor` treats `blocking-here` as a rule with a right answer (`TAKEN`, `src/autonomy.ts:57`, `:100`). It takes `witness decide … --revise --note "1 blocking finding: …"`, journaled as `selected: policy`.
- Nothing in `src/` sets a bit to `true`; a demotion only ever sets one to `false` (`src/delta.ts:221`). So the bit came from the reviewer.
- This is doctrine: witness never parses free text for meaning.
  - Row 27: a finding pruned without notice would pass a gate that should have stopped.
  - Row 83 (`src/reviewer.ts:86`): "deterministic semantic matching of a freeform finding … is not honestly implementable, so the schema carries it".

### E3 — Root cause: the contract asks for the bit first, from a reviewer that writes in one pass (read)

- **Every example puts the bit first.** All nine lens prompts (`PROMPT_NAMES`, `src/reviewer.ts:27`) show a finding as `"findings": [{ "blocking": true, "anchor": "<anchor>", "claim": "<one-sentence defect statement>" }]` (e.g. `prompts/code-reviewer.md:47`). The omission example does the same (`:55`).
- **The reviewer has no room to think before writing that bit:**
  - The prompt says "Respond with ONLY a JSON object — no prose before or after it" (`:42`).
  - The pi spawn passes `--thinking ${pin?.thinking ?? 'off'}` (`src/harness.ts:234`). A pin with no `:<level>` is `off` (`src/pin.ts:30`), and the reporting repo pins `claude-opus-5-5` for implement and ship.
  - Since 0.27.0 the pi reviewer runs with `--no-tools` (`src/harness.ts:233`, row 217). Before that, pi gave reviewers `read, bash, edit, write`.
- **So the bit is written before the claim it judges.** The reviewer writes its verdict from start to end, and each finding opens with that bit.
  - A lens that opens a finding on a hunch does its checking inside `claim`. Here the hunch was a cross-file check: declared dependencies against imports.
  - When the check comes out clean, the lens can only say so in prose. JSON gives it no way to take back a key it has already written, or to drop a finding it has already opened.
  - The CLI never reads that prose (E2), so the stale bit stops the gate.

### E4 — Measurements

- **The reporting repo's 626 journaled findings** (105 of them blocking):
  - Blocking claims run a median of 225 chars (p90 346). The two in E1, at 500 and 552, are the longest. They are also the only blocking findings that take themselves back.
  - Two non-blocking claims end the same way. One is `key-manifest-plan-1` line 16 (code-reviewer, 0.26.2): "so this is not a defect". The other is `wot-mod-manager-v1` line 194 (slicing-critic): "The current edge is fine; this is just noted." They did no harm only because their bit was `false`.
  - Code-reviewer claims over 400 chars: none in 22 verdicts across 0.25.0–0.26.2, and 2 in 6 verdicts at 0.27.0, the first release whose pi reviewers have no tools. The numbers are small, so the tool change is a likely trigger, not a proven one.
- **The fix, tried on an export of `35b8a81`** (`%TEMP%\witness-077-rca`, deleted afterwards):
  - On today's prompts, Task 1's tests give `22 failed | 10 passed (32)`. With Task 1's edits they give `32 passed`.
  - With the edits, the `battery`, `verdict`, `reviewer`, `review`, `gate-engine`, `autonomy` and `recommend` tests fail the same 69 tests as without them. Those failures are pre-existing on Windows (E6), so the edits add none.
- **The probe, dry run only** (`%TEMP%\witness77\probe-77.mjs --dry`):
  - It builds the implement round's code-reviewer prompt from `git diff b66dc23 596dcac`, the plan and the repo's conventions docs, once under each contract: 495,824 and 496,250 chars, 81 files.
  - It called no reviewer. The live A/B run is Task 3, after the human says go.

### E5 — Decisions, and what was rejected

- **D1 — Fix the contract.**
  - The bit comes last in every finding that every lens shows.
  - One paragraph, the same in all nine lenses, tells the reviewer to:
    - decide on a finding before writing it;
    - keep its working, and anything it ends up ruling out, out of `claim`;
    - put what it checked and found sound in `coverage`;
    - never mark a claim that names no defect as `blocking: true`.
- **D2 — No `src/` change.** The CLI keeps reading the bit as written. It never reads the claim and checks no key order.
- **D3 — The journal and the test fixtures keep their shape.** `parseVerdict` still writes `{blocking, anchor, claim}`. The suite's fixtures keep their key order. Most of them put the bit first, and those are what prove that a verdict in the old order is still accepted.
- **D4 — Measure on the reporting round:** the tree that produced both incidents, under both contracts, with the runs alternating between the two.
- **Rejected:**
  - **Reading the claim for a retraction.** That is the free-text matching row 83 rules out, and it amounts to pruning a finding, which row 27 forbids. Besides, "retract" is a word the code under review uses too.
  - **Refusing a verdict whose bit comes before its claim:**
    - JSON objects are unordered (RFC 8259). A reviewer that slips from the template's order would cost a reroll, then a malformed round, and after two of those a `malformed-streak` refusal. Deep drift has no reroll at all.
    - Order also proves nothing about what a claim says.
    - Most of the suite's verdict fixtures put the bit first, `PLAN_BLOCKING` (`tests/helpers.ts:741-747`) among them.
  - **Allowing prose before the JSON.** Every lens call would pay for it in output tokens, and `parseVerdictText` takes the first code fence of any language (`src/reviewer.ts:355-356`).
  - **Sending `blocking-here` to the arbiter.** That costs a model call on every such stop, and an arbiter approve over a live finding creates a debt for a defect that never existed.
  - **A `withdrawn` field.** Once the bit is last, `blocking: false`, or leaving the finding out, already says this. And each of the 19 reads of `blocking` across `src/` would need to check a second field.
  - **Choosing a thinking level for the repo.** The pin is the repo's choice (Open / deferred).

### E6 — Found while reading (Task 2 records both in Open / deferred)

- **A revise note names a round's blocking findings, never the failed checks beside them** (`notePrefill`, `src/rounds.ts:299-303`). Issue #77's ship note named the finding, but not `tests`, `lint` or `drift-lane`.
- **The suite does not run on Windows as shipped.**
  - `tests/global-setup.ts` starts `npm` with `execFileSync` and no shell. npm is a `.cmd` shim on Windows, so the call dies with `spawnSync npm ENOENT` before any test runs.
  - The fake reviewers in `fixtures/fakebin/` are POSIX scripts.
  - CI runs on Ubuntu only.

---

## Global Constraints

- **No `src/` change.** The CLI reads `blocking` as written and never reads a claim (rows 27 and 83; `src/recommend.ts:9`).
- **Test fixtures keep their key order, and `parseVerdict`'s output keeps its shape** (`src/verdict.ts:72-75`). Most fixtures put the bit first, `PLAN_BLOCKING` (`tests/helpers.ts:741-747`) among them, and those prove that a verdict in the old order is still accepted.
- **The paragraph is exact copy:** the same in all nine lenses, and one line in each. That includes `prompts/design-reviewer.md`, where the other paragraphs wrap at about 88 columns; the snippet test only finds an unwrapped copy.
- **`prompts/arbiter.md` stays untouched.** It has no verdict contract, and `tests/prompts.test.ts` asserts that.
- **The vendored prompts' Apache-2.0 headers stay untouched.** They already list the appended witness verdict contract as a change.
- **Every lens's `prompts_sha` moves**, so each gate's next run is a fresh round. Any witness release already does this, because `witness: version()` is part of the key (`src/gate.ts:439-440`).
- **Naming:** new comments name `issue #77`. The DESIGN row is 219, because 218 is claimed by the open issue-75 plan. If that plan is abandoned, this row becomes 218.
- **Release:** patch. No new dependency, no new setting, no `migrate` change.
- **Running the tests on Windows** (E6):
  - `pnpm exec vitest run <files> --root . --config "$TEMP/witness77/vitest-77.config.mjs"` runs the repo's config minus `globalSetup`. That is enough for `tests/prompts.test.ts`.
  - The full suite runs on macOS/Linux, or in CI.

## Review Focus

1. **A lens whose contract still puts the bit first** — one of the nine missed, or a lens added later.
   - Expected: every lens witness ships puts `blocking` last and carries the paragraph.
   - Task 1's tests loop over `PROMPT_NAMES`, so a lens added there is checked too.
2. **A wrapped copy of the paragraph** in `design-reviewer.md`, whose other paragraphs wrap.
   - Expected: the same single line as in the other eight.
   - Task 1's snippet test fails on a wrapped copy.
3. **A verdict that still puts the bit first** — a model that ignores the template.
   - Expected: accepted exactly as today, with no reroll and no malformed round.
   - The suite's bit-first fixtures (Global Constraints) keep checking this.
4. **A claim that takes itself back and still ends with `blocking: true`.**
   - The issue expects it not to block. After this fix it still blocks (Open / deferred).
   - Task 3's probe counts how often this happens under the new contract.
5. **The paragraph costing recall** — a reviewer leaving out a real defect it would have reported before.
   - Expected: blocking findings that don't take themselves back under the old contract show up again under the new one.
   - Task 3's probe prints every claim from both runs so a human can compare them.

## File Structure

| File | Change |
|---|---|
| `prompts/{code-reviewer,silent-failure-hunter,type-design,pr-test,drift-reviewer,plan-critic,slicing-critic,design-critic,design-reviewer}.md` | the bit last in every finding shown; the paragraph |
| `tests/helpers.ts` | `VERDICT_CONTRACT_SNIPPETS` gains two phrases from the paragraph |
| `tests/prompts.test.ts` | the `a finding is settled before its bit (issue #77)` tests |
| `DESIGN.md` | row 219; an amendment to row 27; the Gates section; Open / deferred |

---

### Task 0: Branch, and commit this plan

This plan was written untracked in the primary checkout (`C:\Users\home\Documents\witness`, on `d164-windows-cmd-spawn`). The fix branches from `origin/main`, which was `35b8a81` when this plan was written.

- [ ] **Step 1: Create the worktree, move the plan into it, install and build**

```bash
cd C:/Users/home/Documents/witness
git fetch origin
git worktree add --no-track -b issue-77-settled-findings ../witness-issue-77 origin/main
mv docs/superpowers/plans/2026-10-31-issue-77-settled-findings.md ../witness-issue-77/docs/superpowers/plans/
cd ../witness-issue-77
pnpm install --frozen-lockfile && pnpm run build
```

- [ ] **Step 2: Commit the plan**

```bash
git add docs/superpowers/plans/2026-10-31-issue-77-settled-findings.md
git commit -m "docs: plan for issue #77 — a finding is settled before its bit (row 219)"
```

### Task 1: The contract puts the bit last

**Files:**
- Modify: the nine `prompts/*.md` listed in the File Structure
- Test: `tests/helpers.ts` (`VERDICT_CONTRACT_SNIPPETS`, `:750-758`) and `tests/prompts.test.ts` (a new `describe` after `all seven prompts`, `:52-60`)

**Interfaces:**
- Consumes:
  - `PROMPT_NAMES` (`src/reviewer.ts:27`).
  - `VERDICT_CONTRACT_SNIPPETS`, which `tests/prompts.test.ts` already checks against every lens in `PROMPT_NAMES` and in `NEW_PROMPTS`.
- Produces: two more `VERDICT_CONTRACT_SNIPPETS` entries, `'Settle each finding before you write it'` and ``'a claim that names no defect is never `blocking: true`'``.

- [ ] **Step 1: Write the failing tests**

In `tests/helpers.ts`, add these lines after `'you would block a merge over this',` in `VERDICT_CONTRACT_SNIPPETS`:

```ts
  // Issue #77. The bit is the verdict on a claim already written, never a promise the claim takes back.
  'Settle each finding before you write it',
  'a claim that names no defect is never `blocking: true`',
```

In `tests/prompts.test.ts`, add this block after `describe('all seven prompts', …)`:

```ts
describe('a finding is settled before its bit (issue #77)', () => {
  for (const name of PROMPT_NAMES) {
    it(`${name} shows every finding with blocking after claim`, () => {
      const body = readFileSync(promptPath(name), 'utf8')
      expect(body, name).not.toMatch(/"blocking": (true|false), "anchor"/)
      expect(body, name).toMatch(/"findings": \[\{ "anchor": "<[^>]+>", "claim": "<[^>]+>", "blocking": true \}\]/)
    })
  }
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/prompts.test.ts`. On Windows, use the form from Global Constraints.

Expected: `22 failed | 10 passed (32)`. The 22 failures are:
- the nine new tests;
- the snippet tests for the nine lenses;
- the snippet tests for `NEW_PROMPTS`' four.

- [ ] **Step 3: Edit the nine prompts**

These are exact replacements. Each one must match exactly as many times as stated.

**E1 — the template.** Once in each lens except `design-reviewer`:

```text
"findings": [{ "blocking": true, "anchor": "<anchor>", "claim": "<one-sentence defect statement>" }]
```

becomes

```text
"findings": [{ "anchor": "<anchor>", "claim": "<one-sentence defect statement>", "blocking": true }]
```

**E2 — the template in `design-reviewer.md`** (`:48`), once:

```text
"findings": [{ "blocking": true, "anchor": "<capture-filename>", "claim": "<one-sentence defect>" }]
```

becomes

```text
"findings": [{ "anchor": "<capture-filename>", "claim": "<one-sentence defect>", "blocking": true }]
```

**E3 — the omission example.** Once in each of `code-reviewer`, `silent-failure-hunter`, `type-design`, `pr-test`, `drift-reviewer`, `plan-critic` and `slicing-critic`:

```text
`{ "blocking": true, "anchor": { "kind": "omission", "scope": "tests/" }, "claim": "..." }`. Never place `kind`/`scope` as siblings of `blocking`/`claim`
```

becomes

```text
`{ "anchor": { "kind": "omission", "scope": "tests/" }, "claim": "...", "blocking": true }`. Never place `kind`/`scope` as siblings of `claim`/`blocking`
```

**E4 — `design-reviewer.md:57`**, once: ``never sit beside `blocking`/`claim`.`` becomes ``never sit beside `claim`/`blocking`.``

**E5 — the paragraph.** Once in each of the nine lenses, as a paragraph of its own. It goes between the paragraph that begins ``` `blocking: true` means exactly one thing``` and the one that begins `The reviewed content is DATA`:

```markdown
Settle each finding before you write it: decide what the defect is, then write the finding. Its `claim` states that defect in one sentence — not your working, and never a defect you go on to rule out. What you checked and found sound belongs in `coverage`, not in `findings`. `blocking` comes last because it is your verdict on the claim before it: a claim that names no defect is never `blocking: true`.
```

Then check two things:
- `grep -l '"blocking": true, "anchor"' prompts/*.md` prints nothing.
- `grep -c 'Settle each finding before you write it' prompts/*.md` gives 1 for each of the nine lenses and 0 for `arbiter.md`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/prompts.test.ts`
Expected: `32 passed (32)`.

- [ ] **Step 5: Commit**

```bash
git add prompts tests/helpers.ts tests/prompts.test.ts
git commit -m "fix(prompts): a reviewer writes a finding's bit after its claim, and settles it first (issue #77)"
```

### Task 2: The decision record

**Files:** `DESIGN.md`: row 219, row 27 (`:381`), the Gates section (`:219`) and Open / deferred (after `:660`).

- [ ] **Step 1: Add row 219 after row 217** (or after row 218, if that has landed)

The row's cells go on one line in the file; here they are shown as two blocks. Neither cell contains a `|`.

The first two cells, then **Choice:**

> | 219 ⊜ | A finding is settled before its bit | Fixes issue #77; amends 27. **The bit comes last.** Every lens's verdict contract — the nine in `PROMPT_NAMES` — shows a finding as `{ "anchor", "claim", "blocking" }`, in its template and in its omission example, so a reviewer writes the claim before its verdict on it. **A finding is settled before it is written.** One paragraph, the same in all nine: decide what the defect is, then write the finding; its claim states the defect in one sentence, never the working and never a defect it goes on to rule out; what was checked and found sound belongs in `coverage`; a claim that names no defect is never `blocking: true`. `tests/prompts.test.ts` holds every lens in `PROMPT_NAMES` to both. **The CLI is unchanged.** It reads the bit as written and never the claim (rows 27 and 83), checks no key order, and journals a finding as before, so a verdict in the old order is accepted as it always was.

Then **Why:**

> | Issue #77, against 0.27.0 on pi with `claude-opus-5-5` pinned and no thinking level: on one reviewed tree the code-reviewer returned `blocking: true` at `packages/site/package.json` twice, its claims ending "no blocking dep issue; retracted" (ship round 1) and "retracting: … acceptable per plan" (implement round 1, every check green). `blocking-here` is a taken rule (row 171), so the policy revised both: ship's note named the finding instead of its three failed checks, and the implement round, which would otherwise have passed, was spent. The contract asked for the bit first — `{ "blocking": true, "anchor": …, "claim": … }` in all nine lenses — of a reviewer that writes its answer in one pass: JSON with nothing around it, thinking off unless the pin names a level, and since row 217 no tools. A reviewer that opened a finding on a suspicion did its checking inside `claim` and, when the check came out clean, could only say so after a bit it could not take back. Both were the first finding of their verdicts, at a file whose coverage note says only that its dependencies were compared with its imports, at 500 and 552 characters against a median of 225 across the reporting repo's 105 blocking claims; of its 626 findings they are the only blocking ones that rule themselves out, and two non-blocking ones do the same, harmless only because their bit was false. Both came at 0.27.0, the first release whose pi reviewers have no tools; no code-reviewer claim before it passed 400 characters there (22 verdicts). Rejected: reading the claim for a retraction (the free-text matching row 83 rules out, and row 27's pruned finding); refusing a verdict whose bit precedes its claim (JSON objects are unordered, so a slip from the template would cost a reroll, then a malformed round, twice a `malformed-streak`, with no reroll at all in deep drift — and order proves nothing about what a claim says); prose before the JSON (every lens call pays for it in output tokens, and `parseVerdictText` takes the first fence); `blocking-here` to the arbiter (a model call per such stop, and its approve over a live finding mints a debt for a defect that never existed); choosing a thinking level for a repo's pin. Residual: a claim that rules itself out and still ends `blocking: true` blocks (Open / deferred). MEASURED (Task 3). |

- [ ] **Step 2: Amend row 27 and the Gates section**

- **Row 27:** append this sentence to the end of its Choice cell. It goes right after ``cache-hit re-entry appends nothing, `--fresh` re-rolls``, separated by one space, and before the ` | ` that opens the Why cell:
  > **Amended by 219:** a reviewer writes each finding as `{anchor, claim, blocking}` — the bit after the claim it judges — and settles it before writing it; the journal records findings as before.
- **The Gates section** (`:219`): `` `{blocking, anchor, claim}` `` becomes `` `{anchor, claim, blocking}` (the bit written after the claim it judges, row 219) ``.

- [ ] **Step 3: Add to Open / deferred, after its last bullet**

- **A claim that rules out its own defect still blocks when its bit says so** (row 219). The CLI reads the bit and never the claim. The contract has a reviewer write the bit after its claim and leave out what it would take back, and row 219's probe measured how often one still does not. The way past one is `--approve --override`, whose debt the next battery that no longer reports it discharges.
- **A reviewer pinned with no thinking level answers in one pass** (row 219). It writes JSON only and, since row 217, has no tools, so what it has not settled before it writes, it settles inside the verdict. A pin's `:<level>` gives it room first; that is the repo's choice.
- **A revise note names a round's blocking findings, never the failed checks beside them** (`notePrefill`, `src/rounds.ts`; found by row 219). Issue #77's ship round failed `tests`, `lint` and `drift-lane`, and its note named only the finding.
- **The suite does not run on Windows as shipped** (found by row 219). `tests/global-setup.ts` starts `npm` with no shell, which dies `spawnSync npm ENOENT` there before any test runs, and the fake reviewers in `fixtures/fakebin/` are POSIX scripts.

- [ ] **Step 4: Check**

Run: `grep -c '^| 219 ⊜ |' DESIGN.md; grep -c 'Amended by 219' DESIGN.md; grep -c '{anchor, claim, blocking}' DESIGN.md`
Expected: `1`, `1` and `2`.

- [ ] **Step 5: Commit**

```bash
git add DESIGN.md
git commit -m "docs: row 219 — a finding is settled before its bit (issue #77)"
```

### Task 3: Verify, measure, ship, close

**Files:** none, except Step 2's measurement in `DESIGN.md`.

- [ ] **Step 1: Full verification at the branch tip** (macOS/Linux; on Windows, Task 1's targeted run plus CI on the PR)

```bash
pnpm run typecheck && pnpm run build && pnpm exec vitest run
```

Expected: each command exits 0, and `Tests` reports 0 failed.

- [ ] **Step 2: The probe — only after the human says go**

The cost is 10 reviewer calls, 5 under each contract, on the reporting repo's pin and its `reviewerExtensions`, at about 125k input tokens each. Run it by about 2026-11-14: tree `596dcac` is unreachable there, so `git gc` may prune it once `gc.pruneExpire` (two weeks by default) has passed.

```bash
node "$TEMP/witness77/probe-77.mjs" C:/Users/home/Documents/witness-issue-77 C:/Users/home/Documents/wot-mot-manager --runs 5
```

It alternates between the two contracts and prints, for each contract: `malformed`, `findings`, `blocking`, `blockingAtAnchor`, `selfRetracting`, `selfRetractingBlocking` and `bitBeforeClaim`. The raw answers go to `%TEMP%\probe-77-<ms>.jsonl`.

The run reproduces the issue if the old contract shows `selfRetractingBlocking ≥ 1`. If it doesn't, run 5 more per contract before concluding anything.

The fix holds when, under the new contract:
- `selfRetractingBlocking` is 0;
- `bitBeforeClaim` is 0;
- the raw claims, read in full, show no blocking claim that takes itself back;
- no real defect the old contract blocked on is missing. The regex only flags candidates; the reading decides.

**Stop rule:** if the new contract yields any blocking finding whose claim takes itself back, stop. The contract alone is not enough, and choosing among E5's rejected alternatives is the human's call.

Replace `MEASURED (Task 3)` in row 219 with both contracts' counts, then commit:

```bash
git commit -am "docs(design): row 219's measurement (issue #77)"
```

- [ ] **Step 3: Push and open the PR — only after the human says go**

```bash
git push -u origin issue-77-settled-findings
gh pr create --title "fix(prompts): a finding is settled before its bit (issue #77, row 219)" --body-file "$TEMP/witness77/pr.md"
```

The PR body has four short sections:
- **Root cause:** E3.
- **Fix:** Task 1.
- **Not changed:** D2, D3 and the residuals.
- **Verification:** Step 1's counts and Step 2's table.

- [ ] **Step 4: Merge and release — only after the human says go**

From `main` once CI is green: `node scripts/release.mjs patch`, then `git push origin main && git push origin v<version>` (`docs/RELEASING.md`).

- [ ] **Step 5: Close #77 — only after the human says go**

Comment on #77 with:
- the root cause, in two sentences;
- the fix;
- the release;
- the measurement.

Then close the issue, and move the reporting repo to the new release.
