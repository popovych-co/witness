# Issue #34 — A Spec Leaves Canon Without Stranding What Points At It (D166) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a spec's departure from canon one complete act that can be undone, so nothing that points at a departed spec is stranded. That means:
- no permanent `unknown-parent`;
- no stranded or orphaned plans, and no spec nothing can remove;
- no lost obligations, no orphaned designs, and no re-bound ids;
- canon never forgets shipped behavior;
- a crash leaves state that recovery reads correctly.

This is row D166, closing issue #34.

**Architecture:** A spec leaves canon through exactly two verbs:
- the re-slice (`write` with `supersedes`, rows 5/62), which journals `superseded`;
- abandon's unwind of a spec its own effort created (row 29), which journals `removed`.

Today each implements the act partially and differently, guards only the `depends` edge into the spec, and neither can be taken back. `src/departure.ts` becomes the single home of the act:
- how a departure is read (`canonExit`);
- what leaves with a spec (`prepareDeparture`);
- how a departure is taken back (`prepareReturns`);
- which ids it retires (`idRetired`).

Both verbs settle every reference into the departing spec:
- **Plans:** the re-slice refuses while a plan still moves; the unwind keeps content another plan stands on, and an effort's final abandon refuses where a keep could never be taken back.
- **The design:** leaves or is restored with the spec.
- **Debts:** follow the successor.
- **The predecessor:** taking back a re-slice brings it back.

`check` and `status` read departures as lineage. Crash recovery has one derivation of what landed.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict` + `noUncheckedIndexedAccess`). Tests are vitest 3.2.7, driving the real CLI in-process against throwaway git repos (`tests/helpers.ts`). Biome has its formatter and linter deliberately off. No new dependencies.

**Spec:** [Issue #34](https://github.com/popovych-co/witness/issues/34) plus the verified evidence base below. The human's direction for scope was "the most architecturally correct", so this plan fixes the act the issue exposed, not only its reported symptom.

Every claim was probed against `main` at `43d9ab0` (0.14.6) in throwaway repos and, read-only, against the reporting repo. The plan was then attacked by two independent adversarial passes, one against the recorded design and one against behavior. Every defect they reported was reproduced or confirmed by reading before it was fixed here (E8).

---

## Verified evidence base

### E1 — The reported symptom, and the same symptom from other doors (probed)

Temporary vitest probes drove the real CLI (`main(ctx, args)`) in throwaway repos, using witness verbs only:

| Probe | Flow | Result |
|---|---|---|
| P1 (the issue) | plan `in-progress` → re-slice its spec → `abandon` the plan | re-slice **accepted**; `check` `unknown-parent` exit 1 before and after the abandon; `next` routed the plan into `test-evidence` while `gate implement` refused it |
| P2 | plan **`done`**, spec `live` → re-slice | **accepted**; `check` clean before, `unknown-parent` after |
| P3 | plan `draft` → re-slice | **accepted**; `gate plan` and re-authoring with the same parent both refuse |
| P8 | new spec + its only plan → `abandon <plan>` | spec unwound (`removed`); `check` `unknown-parent` exit 1, with no re-slice anywhere |
| P5 | plan-1 `done` (spec `live`), plan-2 draft → `abandon plan-2` | the **shipped** spec is deleted |
| P6 | plan-1 `approved`, plan-2 draft → `abandon plan-2` | spec deleted under plan-1 |
| P4 (control) | no plan → re-slice | clean |

A spec turns `live` only when a plan merges (`src/stamp.ts:75-79`). So P2 means re-slicing **any shipped spec** broke `check` for good, and that is exactly the "extraction out of a live spec" the decompose rules prescribe (`DESIGN.md:45`, `plugin/skills/witness-decompose/SKILL.md:47`). P8's flow is the plainest abandon in the product. Its existing test (`tests/abandon.test.ts:31`) never runs `check`.

### E2 — Root cause: one act, implemented twice and half each time, with no way back (probed)

| What points at a departing spec | Re-slice today (`src/verbs/write.ts`) | Unwind today (`src/abandon.ts`) | Probe |
|---|---|---|---|
| `depends` from other docs | refuses (`write.ts:169-176`) | refuses (`abandon.ts:54-61`) | — |
| `parent` from plans still moving | **nothing** → zombie plan | **nothing** → zombie plan | P1, P3, P6 |
| `parent` from `done` plans | **nothing** → `check` error forever | deletes or restores content a plan **shipped** | P2, P5, F3 |
| the design (`designs/<id>.html`) | deleted (`write.ts:213-229`) | delete: **left in canon** (F1); restore: **left at the amended look** (F7) | F1, F7 |
| open obligations moved onto the spec at merge (D122) | **dropped from `status`** while still open on the departed stream (`dashboard.ts:52` never reads it) | the same, for an unwound spec's own debts | F2, F4b |
| the id | **reusable** by `write` and `adopt`: re-binds finished plans and the diff base | reusable | F4, F4c |
| the predecessor, when the write that re-sliced it is taken back | — | **never restored**: abandoning the effort that re-sliced a shipped spec leaves canon describing none of what shipped, and the id retired | B1 |

On the reading side, `src/verbs/check.ts:110-115` resolves every plan's parent against live canon only. Row 62 already resolves `supersedes:` and `--lineage` against the journal, and `check`'s own `orphan-journal` text says "frozen lineage" (`check.ts:227`).

**Why the design missed it.** Row 29 and row 62 both reasoned about the `depends` edge and nothing else. Row 29's own definition, "selectively reverts the … state commit", already implies the way back, because a re-slice's commit also deleted the predecessor.

**Found underneath:**
- **Recovery duplicated lines.** `completeTxn` (`src/txn.ts:54-62`) and its twin `recoverChoice` (`src/verbs/recover.ts:17-23`) compare each pending journal line with its stream's *last* line. A transaction that appends two lines to one stream was duplicated on `recover --complete`, and was ranked "partial", so `next` recommended `--rollback` for a transaction that had fully landed. The merge stamp writes that shape today whenever a merge moves a debt.
- **`rename` left the old path behind.** It moves the id and the journal but keeps the file path, so a later create under the old id **overwrote** the renamed doc (pre-existing, probed).

### E3 — No operator remedy today (verified)

- A `done` plan refuses re-authoring (`write.ts:319-322`) and cannot be abandoned (`abandon.ts:168`).
- Re-authoring an abandoned plan revives it to `draft` (`write.ts:323`) and needs a live parent (`write.ts:266-271`).
- `rename` needs the old doc (`rename.ts:35`).
- `adopt` reads the file (`adopt.ts:31`), so a hand deletion is unadoptable.
- A hand-edited `parent:` trades the error for `pin-unresolvable` (`check.ts:119-122`).

### E4 — The reporting repo, read-only

The issue's repo is `~/x/personal/fewhats.com`:
- `onboarding-setup-plan-1` is `abandoned` under `parent: onboarding-setup`;
- that stream ends `superseded by setup-card`;
- a second departed stream (`thread-mirror-pacing`) holds no debts;
- there are no orphan designs.

`know-your-customer-mvp` has no departures. This repo's build, run there with `CI=1 WITNESS_REGISTRY=off`, printed the issue's error: `1 errors`, exit 1, plus both `orphan-journal` warns. `CI` disables the lazy stamp, `check`'s only write path (`src/stamp.ts:61`).

### E5 — Design decisions, and what was rejected

- **One module.** `src/departure.ts` holds `canonExit` (the stream's *latest* status entry, when it is `superseded` or `removed`; callers consult canon first), `departedStreams`, `prepareDeparture`, `prepareReturns` and `idRetired`. Latest, not any: a taken-back departure, or a removed spec written again, is followed by a later status and reads as present. `write`'s supersedes test and `log --lineage` read departures through `canonExit` too, so it is the one reading.
- **Two predicates** in `src/scan.ts`:
  - `planFinished` (`done` or `abandoned`): the one derivation `check.ts:159` and `next.ts:704-705` spelled out inline.
  - `plansOn(canon, specId, { exclude, pin })`: the plans that stand on a spec.
- **Re-slice: refuse only plans still moving** (`dangling-parent`). Reported in one refusal with `dangling-depends`, because every refusal costs a first-try attempt. Finished plans never hold it: the successor carries the content. The row is marked a human's decision (`humanCall`). Its trailer says stop instead of "fix each row and re-run" (row 108's principle: the self-repair line is false where nothing is the reader's to fix). The `want` names no command, and the decompose skill says to stop. The target must be a spec (`not-a-spec`), since re-slicing a plan or the principles deleted them irreversibly.
- **Unwind: keep, don't refuse.** Content another plan stands on is kept: `plansOn(…, { exclude: abandonSet, pin })`, delete and restore alike.
  - The check runs after "newest-first" (row 84) and before every precondition of the unwind itself, because a kept spec unwinds nothing and dangles nothing.
  - The pair-parent keep is discharged later by the writing effort's next abandon act.
  - `abandon <effort>` is that effort's last act. There, a keep is allowed only when permanent, meaning a standing plan **shipped** it. Otherwise it refuses `still-standing` until the other plan finishes or goes, because a keep there would leave a spec no verb can remove.
- **What leaves with a spec.** `prepareDeparture` covers the spec file, its design when present, and its stream, for both verbs. The restore branch puts the design back as it stood before the commit being taken back. It reads bytes through `gitBlob`, because the git wrapper strips a trailing newline and a design is hashed as bytes.
- **Obligations.** A re-slice moves the superseded spec's open debts to the successor (D122's rule, through one `deferralMoves` the merge stamp shares). `status` also reads departed streams, and `check` warns `stranded-deferral` (naming `dismiss --cause superseded`) for a departed stream still holding open debts. Auto-closing them was rejected as closure-by-assertion (D122).
- **The way back** (`prepareReturns`). When the unwind takes back the write whose state commit departed a spec, that spec comes back: its file and design as they stood before that commit, a status entry ending the departure, and the debts that had followed it. If another successor of the same re-slice still stands, the write is kept instead. The split goes back whole, through the effort that made it.
- **Identity.** A new artifact (`write` create, or `adopt`) may not take:
  - a superseded spec's id;
  - an effort's slug, or witness's `floor` stream (their streams share the directory);
  - a path another doc holds.

  The refusals are `id-taken` / `path-taken`. The one re-use is a spec its own abandon unwound, written again as a spec. A stray stream (a hand-deleted doc) does not hold its id, so `next` and `write` cannot disagree about a plan id.
- **`check` reads departures.** A finished plan's parent resolves in the departed stream, except a `done` plan under `removed`. That is a pre-D166 unwind that deleted shipped behavior, so it stays an error that names the remedy. A moving plan under a departed parent is an error naming the way out. A parent with no departure entry is a stray. A departed stream is lineage, not `orphan-journal`, and witness's own `floor` stream is never an orphan.
- **The pin is skipped, not re-resolved,** for a finished plan under a departed parent. Nothing reads it there: every other `derives-from` reader serves a moving plan under a live parent, and `baseForSpec` queries live ids only. The departure never journaled the path the pin would resolve against.
- **Recovery.** `landedJournal` is the one derivation of what a crash left. `completeTxn` appends only each stream's missing tail, and `recoverChoice` ranks by the same count.

### E6 — Adjacent, deliberately not changed (recorded in Task 9's Open / deferred)

1. `next`'s rule A (`next.ts:528`) routes on parse and schema errors only.
2. Designs orphaned by pre-166 unwinds are not detected. Neither known consumer has one, and no verb removes a canon file with a trailer.
3. `rename` does not rewrite other streams' references to the old id (a predecessor's `by:`, `deferral-moved to:`). Pre-existing; `path-taken` closes its data-loss half.
4. `log --lineage` follows only a split's first successor. Pre-existing; display only.
5. A plan at an older pin under a `done` newer-pin sibling cannot be abandoned directly. Pre-existing; re-authoring it first works.

### E7 — This plan was dry-run before it was handed over

On 2026-10-19, every `ts`/`markdown` code block in Tasks 1–9 was applied verbatim, by script, to a detached scratch worktree of `43d9ab0`. It went task by task in order: each task's test blocks, then its source blocks. Every replace-anchor was asserted to occur exactly once.

- **One anchor fixed first.** The first run caught a non-unique anchor: `dashboard.ts`'s stream set also appears in `recommenderRows`. Task 2 was fixed before the run recorded here.
- **Per task:** the tests failed first for exactly the reasons the "Expected" lines state, and passed after the task's source blocks. The boundary tests (Task 3's re-slice design; Task 8's unwound-spec re-use and stray stream) passed before and after. `tsc --noEmit` was clean after every task.
- **Full suite:** `Test Files 133 passed`, `Tests 1197 passed | 8 skipped` (41 of them new), 0 `AssertionError`, and 5 `[vitest-worker]` timeouts (the known noise). The `tsc` build and `biome` exited 0.
- **DESIGN.md:** Task 9's edits each landed once, with row 166 after 165, four cells, and the legend on line 308.
- **Reporting repo, read-only, with that build:** `checks: 41 docs · 1799 commits audited · 0 errors`, exit 0, with no `unknown-parent` and no `orphan-journal`.
- **Byte-identical to `main`'s build:** `status`, `next`, `index` and `log --all` on both fewhats.com and know-your-customer-mvp, and `check` on the latter.

If a step's result differs from its "Expected", the code moved under the plan. Stop and re-derive; do not force it.

### E8 — The two adversarial passes, and what each finding became

| Finding | Task |
|---|---|
| keep across efforts left a spec no verb can remove | 5 (`still-standing`) |
| `recover` ranked a landed multi-line txn as partial | 1 (`landedJournal`) |
| `adopt` brought a retired id back | 8 |
| an unwound spec's debts left `status` | 2 (ledger reads departed streams) |
| `dangling-parent` told the reader to self-repair and to abandon | 4 (`humanCall`, no command) |
| "frozen" was false (bookkeeping appends after a departure) | 3, 9 (reworded) |
| the restore left the amended design | 3 |
| DESIGN.md:92 contradicted itself | 9 |
| the decompose skill never mentioned `id-taken` | 8 |
| **abandoning the effort that re-sliced a shipped spec lost it for good** | 7 (the way back) |
| following `dangling-parent`'s advice could unwind the spec, then `unknown-supersedes` | 2 (any departure is terminal) |
| a stray plan stream made `next` and `write` loop | 8 (strays hold no id) |
| a `done` plan under `removed` (pre-166) read clean | 2 (error naming the loss) |
| `supersedes:` deleted principles or a plan | 4 (`not-a-spec`) |
| an effort-slug spec id met a generic refusal | 8 (message, skill) |
| `floor` was called a stray | 2, 8 |
| (pre-existing) `rename` + create overwrote the renamed doc | 8 (`path-taken`) |

---

## Global Constraints

- Branch `d166-spec-departure`, cut from `main` at `43d9ab0` (0.14.6).
- Row **166**, mark **⊜**, dated **2026-10-19**, "post-incident amendment, no grill". It amends rows **29, 62, 69 and 122**.
- After every task, run the targeted vitest files the task names. At the end (Task 10), run the full `pnpm test`, `pnpm run typecheck`, `pnpm run build` and `npx biome check .`.
- **Reading `pnpm test`:** it exits 1 even when every test passes, because of a few `[vitest-worker]: Timeout calling "onTaskUpdate"` errors attached to no test. Judge by the summary (`Tests N passed`, 0 failed) and by `grep -c AssertionError` = 0.
- House style (`biome.jsonc` header): 2-space indent, single quotes, hand-wrapped lines, and no semicolons in `src/` and most tests. `tests/skills.test.ts` uses semicolons; match the file.
- **No commas in new output text.** `esc()` (`src/toon.ts:1-4`) quotes any value containing `,` or `"`. New details, `want`s and `kv` values use `·` and `—`.
- Out of scope, do not change:
  - gate semantics;
  - the lazy stamp's behavior (its debt move is refactored onto the shared rule, not changed);
  - `baseForSpec`;
  - `next`'s routing ladder (only the inline predicate becomes `planFinished`);
  - `rename`'s own behavior;
  - journal entry shapes. Every entry written here (`status`, `deferral`, `deferral-moved`) already exists, and no fields are added.
- Commits are conventional, with the row in the subject, a descriptive body, and the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test helpers (read `tests/helpers.ts` first): `seededRepo({ preexisting })`, `writeSpec`, `writePlan`, `writeDesign`, `DESIGN_HTML`, `approve`, `stampLive`, `repo.flipStatus`, `repo.setMeta`, `repo.git`, `repo.read`, `repo.cli`, `shippableRepo`, `fakeScenario`, `ghState`, `gateEnv`, `PLAN_BODY`, `type TestRepo`. In tests, canon lives at `specs/`, `plans/` and `designs/`. A hand commit is witness-legal with `-m 'Witness-State: 1'`.
- Pushing, the PR and the release are outward-facing. The human says go before each.

## Review Focus

Each item is pinned by a test in the owning task, but these five are the most likely to bite:

1. **Abandoning the effort that re-sliced a shipped spec.** The shipped spec must come back byte for byte, with its debts. → Task 7, test 1.
2. **A keep no later act can take back.** `abandon <effort>` must refuse while only another effort's moving plan stands, and must take the spec back once that plan goes. → Task 5, test 4.
3. **Ship, then re-slice before the stamp lands.** `dangling-parent` until one `check` stamps the plan `done`. → Task 4, test 3.
4. **Stray vs lineage.** A hand-deleted parent stays a bare `unknown-parent` (Task 2, test 5), and a stray stream holds no id (Task 8, test 6).
5. **A crash between two lines on one stream.** Completion and the recommendation both read it correctly. → Task 1.

## File Structure

| File | Change |
|---|---|
| `src/txn.ts` | `landedJournal`; `completeTxn` appends only each stream's missing tail |
| `src/verbs/recover.ts` | `recoverChoice` counts through `landedJournal` |
| `src/departure.ts` | **new**: `canonExit`, `departedStreams`, `Departure`/`prepareDeparture`, `Return`/`prepareReturns`, `idRetired` |
| `src/scan.ts` | `planFinished`, `plansOn` |
| `src/gitio.ts` | `gitBlob` (bytes as git stores them) |
| `src/refusal.ts` | `Violation.human`, `humanCall`, a truthful trailer |
| `src/deferral.ts` | `deferralMoves` (one rule for a debt changing homes) |
| `src/stamp.ts` | uses `deferralMoves` (no behavior change) |
| `src/verbs/check.ts` | parent lineage; `orphan-journal` / `stranded-deferral`; `floor`; `planFinished` |
| `src/verbs/next.ts` | `planFinished` (no behavior change) |
| `src/verbs/dashboard.ts` | ledger reads departed streams |
| `src/verbs/log.ts` | `successorOf` reads `canonExit` |
| `src/verbs/write.ts` | supersedes reads any departure; departs through `prepareDeparture`; `dangling-parent`; `not-a-spec`; debts move; `id-taken` / `path-taken` |
| `src/abandon.ts` | departs through `prepareDeparture`; restores the design; keep rule; the way back |
| `src/verbs/abandon.ts` | routes keeps; `kept:`; `still-standing` on the effort path |
| `src/verbs/adopt.ts` | `idRetired` |
| `plugin/skills/witness-decompose/SKILL.md` | `dangling-parent` is a human stop; `id-taken` / `path-taken` |
| tests | `txn`, `departure` (new), `check`, `reslice`, `abandon`, `deferral`, `skills` |
| `DESIGN.md` | legend, row 166, five prose edits, five Open / deferred bullets |

---

### Task 1: Recovery has one derivation of what landed

**Files:**
- Modify: `src/txn.ts:54-62`, `src/verbs/recover.ts:3-4, 8-9, 12-23` and two `why` strings
- Test: `tests/txn.test.ts`

**Interfaces:**
- Produces: `export function landedJournal(root: string, marker: TxnMarker): Array<{ stream: string; lines: string[]; landed: number }>` in `src/txn.ts`. `completeTxn` and `recoverChoice` keep their signatures.

- [ ] **Step 0: Branch and commit this plan**

```bash
git checkout main && git pull --ff-only
git checkout -b d166-spec-departure
git add docs/superpowers/plans/2026-10-19-issue-34-spec-departure.md
git commit -m "docs(plans): issue #34 -- a spec leaves canon without stranding what points at it (D166)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 1: Write the failing tests**

In `tests/txn.test.ts`, replace line 5:

```ts
import { completeTxn, guardTxn, pendingTxn, rollbackTxn, withTxn } from '../src/txn.js'
```

with:

```ts
import { completeTxn, guardTxn, pendingTxn, rollbackTxn, withTxn } from '../src/txn.js'
import { recoverChoice } from '../src/verbs/recover.js'
```

Inside `describe('recovery', …)`, insert directly before the line `  it('complete resolves id streams into the journal dir, never the repo root', () => {`:

```ts
  it('complete appends only the missing tail when one stream takes several lines (D166)', () => {
    const a = '{"v":1,"t":"status","artifact":"p","to":"done"}'
    const b = '{"v":1,"t":"deferral-moved","id":"d-1","to":"s"}'
    // the crash can land before either append, between them, or after both
    for (const landed of [[], [a], [a, b]]) {
      const repo = seeded()
      repo.write('.witness/journal/p.jsonl', ['{"seed":1}', ...landed].join('\n') + '\n')
      repo.write('.witness/txn.json', JSON.stringify({
        op: 'merge-stamp', files: ['.witness/journal/p.jsonl'],
        journalMulti: [{ stream: 'p', line: a }, { stream: 'p', line: b }],
      }))
      expect(completeTxn(repo.root, pendingTxn(repo.root)!).ok).toBe(true)
      expect(readFileSync(join(repo.root, '.witness/journal/p.jsonl'), 'utf8')).toBe(`{"seed":1}\n${a}\n${b}\n`)
    }
  })

  it('recover reads several lines on one stream the way complete does (D166)', () => {
    const a = '{"v":1,"t":"status","artifact":"p","to":"done"}'
    const b = '{"v":1,"t":"deferral-moved","id":"d-1","to":"s"}'
    const marker = {
      op: 'merge-stamp', files: ['.witness/journal/p.jsonl'],
      journalMulti: [{ stream: 'p', line: a }, { stream: 'p', line: b }],
    }
    const repo = seeded()
    repo.write('.witness/journal/p.jsonl', `{"seed":1}\n${a}\n${b}\n`)
    expect(recoverChoice(repo.root, marker).rule).toBe('txn-write-landed')   // finished: complete it
    repo.write('.witness/journal/p.jsonl', `{"seed":1}\n${a}\n`)
    expect(recoverChoice(repo.root, marker).rule).toBe('txn-write-partial')  // interrupted mid-write
  })

```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/txn.test.ts`
Expected: both new tests FAIL.
- `complete` writes both lines twice when both had landed.
- `recover` ranks the fully landed marker `txn-write-partial`.

- [ ] **Step 3: Implement `landedJournal` (`src/txn.ts`)**

Replace `src/txn.ts:54-62`:

```ts
export function completeTxn(root: string, marker: TxnMarker): Result<{ sha: string }> {
  const items = [...(marker.journal ? [marker.journal] : []), ...(marker.journalMulti ?? [])]
  if (items.length) mkdirSync(join(root, '.witness', 'journal'), { recursive: true })
  for (const { stream, line } of items) {
    const p = join(root, journalRel(stream))
    const current = existsSync(p) ? readFileSync(p, 'utf8') : ''
    const lastLine = current.split('\n').filter(Boolean).at(-1)
    if (lastLine !== line) appendFileSync(p, line + '\n')
  }
```

with:

```ts
// D166. What a crash left of a transaction's journal, per stream: the marker's pending lines
// for that stream, in order, and how many of them the stream already ends with. One
// transaction may append SEVERAL lines to one stream — the merge stamp's status and its
// deferral moves, a re-slice's departure and its moves — and the crash can land after any
// prefix of them. `completeTxn` appends the rest; `recover` ranks --complete over --rollback
// when nothing is missing. One derivation for both: comparing each line with the stream's
// last line re-appended every earlier line, and counted it as missing.
export function landedJournal(root: string, marker: TxnMarker): Array<{ stream: string; lines: string[]; landed: number }> {
  const pending = new Map<string, string[]>()
  for (const { stream, line } of [...(marker.journal ? [marker.journal] : []), ...(marker.journalMulti ?? [])]) {
    pending.set(stream, [...(pending.get(stream) ?? []), line])
  }
  return [...pending].map(([stream, lines]) => {
    const p = join(root, journalRel(stream))
    const current = (existsSync(p) ? readFileSync(p, 'utf8') : '').split('\n').filter(Boolean)
    let landed = Math.min(lines.length, current.length)
    while (landed > 0 && current.slice(-landed).join('\n') !== lines.slice(0, landed).join('\n')) landed--
    return { stream, lines, landed }
  })
}

export function completeTxn(root: string, marker: TxnMarker): Result<{ sha: string }> {
  const streams = landedJournal(root, marker)
  if (streams.length) mkdirSync(join(root, '.witness', 'journal'), { recursive: true })
  for (const { stream, lines, landed } of streams) {
    for (const line of lines.slice(landed)) appendFileSync(join(root, journalRel(stream)), line + '\n')
  }
```

- [ ] **Step 4: `recover` counts the same way (`src/verbs/recover.ts`)**

(a) Replace:

```ts
import { dirtyStatePaths, primaryRoot } from '../gitio.js'
import { journalRel } from '../journal.js'
```

with:

```ts
import { dirtyStatePaths, primaryRoot } from '../gitio.js'
```

(b) Replace:

```ts
import { completeTxn, pendingTxn, rollbackTxn, type TxnMarker } from '../txn.js'
import { existsSync, readFileSync, rmSync } from 'node:fs'
```

with:

```ts
import { completeTxn, landedJournal, pendingTxn, rollbackTxn, type TxnMarker } from '../txn.js'
import { rmSync } from 'node:fs'
```

(c) Replace:

```ts
// D121. The interrupted transaction's own state ranks this: `completeTxn` is idempotent
// about the journal append (it compares the last line), so if the line already landed the
// write finished and only the commit is missing. `--complete | --rollback` named the two
// flags and neither the right answer nor the cost of guessing wrong — at the one prompt a
// human meets while looking at a crash.
export function recoverChoice(root: string, marker: TxnMarker): Decision {
  const items = [...(marker.journal ? [marker.journal] : []), ...(marker.journalMulti ?? [])]
  const landed = items.filter(({ stream, line }) => {
    const p = join(root, journalRel(stream))
    return existsSync(p) && readFileSync(p, 'utf8').split('\n').filter(Boolean).at(-1) === line
  }).length
  const complete = landed === items.length && items.length > 0
```

with:

```ts
// D121. The interrupted transaction's own state ranks this: `completeTxn` appends only the
// journal lines that have not landed, so if every one already landed the write finished and
// only the commit is missing. `--complete | --rollback` named the two flags and neither the
// right answer nor the cost of guessing wrong — at the one prompt a human meets while
// looking at a crash. D166: the count is `landedJournal`'s, the derivation `completeTxn`
// uses, so a stream that takes several lines reads the same to both.
export function recoverChoice(root: string, marker: TxnMarker): Decision {
  const streams = landedJournal(root, marker)
  const total = streams.reduce((n, s) => n + s.lines.length, 0)
  const landed = streams.reduce((n, s) => n + s.landed, 0)
  const complete = landed === total && total > 0
```

(d) In the first option's `why`, replace:

```ts
`${landed} of ${items.length} journal line(s) are already on disk
```

with:

```ts
`${landed} of ${total} journal line(s) are already on disk
```

(e) In the second option's `why`, replace:

```ts
only ${landed} of ${items.length} journal line(s) landed
```

with:

```ts
only ${landed} of ${total} journal line(s) landed
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm vitest run tests/txn.test.ts tests/stamp.test.ts tests/deferral.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm run typecheck` (expected exit 0).

```bash
git add src/txn.ts src/verbs/recover.ts tests/txn.test.ts
git commit -F - <<'EOF'
fix(txn): one derivation of what a crash left (D166)

completeTxn and recoverChoice each compared a pending journal line with
its stream's last line. A transaction that appends two lines to one
stream -- the merge stamp's status and its deferral moves -- was written
twice by recover --complete when the crash landed after both, and
ranked partial by recover, which then recommended rolling back a
transaction that had finished. landedJournal groups the pending lines
per stream and counts the prefix the stream already ends with; both
consumers read it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: A departure is read as lineage — by `check`, `status`, `write` and `log`

**Files:**
- Create: `src/departure.ts`, `tests/departure.test.ts`
- Modify:
  - `src/scan.ts` (after `plannableParent`, `scan.ts:65-68`)
  - `src/verbs/check.ts:12, 23, 110-115, 159, 226-227`
  - `src/verbs/next.ts:7, 704-705`
  - `src/verbs/dashboard.ts:4, 52-53`
  - `src/verbs/write.ts:6, 160-167`
  - `src/verbs/log.ts:6, 55-59`
- Test: `tests/check.test.ts`, `tests/reslice.test.ts`

**Interfaces:**
- Produces, in `src/departure.ts`:
  - `canonExit(entries: Entry[]): StatusEntry | undefined`
  - `departedStreams(root: string, canon: Canon): string[]`
- Produces, in `src/scan.ts`: `planFinished(doc: CanonDoc): boolean`
- `check` rules:
  - `unknown-parent`, lineage-aware; a `done` plan under `removed` stays an error;
  - `orphan-journal`, strays only, never `floor`;
  - `stranded-deferral`.
- `status` lists open debts on departed streams.
- `write` treats any departure as a terminal `supersedes` target.

- [ ] **Step 1: Write the failing `canonExit` tests**

Create `tests/departure.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { canonExit } from '../src/departure.js'
import type { Entry } from '../src/journal.js'

describe('canonExit (D166)', () => {
  const status = (to: string, extra: Record<string, unknown> = {}): Entry =>
    ({ v: 1, t: 'status', artifact: 'a', from: 'approved', to, cause: 'gate-approve', ...extra })

  it('is the status entry with which an artifact left canon', () => {
    expect(canonExit([status('approved'), status('superseded', { cause: 'supersede', by: 'b' })]))
      .toMatchObject({ to: 'superseded', by: 'b' })
    expect(canonExit([status('live'), status('removed', { cause: 'abandon' })]))
      .toMatchObject({ to: 'removed', cause: 'abandon' })
  })

  it('is nothing for a stream that never left, or that a later status brought back', () => {
    expect(canonExit([])).toBeUndefined()
    expect(canonExit([status('approved')])).toBeUndefined()
    expect(canonExit([status('removed'), status('approved')])).toBeUndefined()
    expect(canonExit([status('superseded'), status('live', { from: 'superseded', cause: 'abandon' })])).toBeUndefined()
  })

  it('reads status entries only', () => {
    expect(canonExit([status('superseded'), { v: 1, t: 'drift-check', artifact: 'a' }]))
      .toMatchObject({ to: 'superseded' })
  })
})
```

Run: `pnpm vitest run tests/departure.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/departure.js'`.

- [ ] **Step 2: Create `src/departure.ts`**

```ts
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readStream, type Entry, type StatusEntry } from './journal.js'
import { findById, type Canon } from './scan.js'

// D166. A spec leaves canon through exactly two verbs — the re-slice (row 62), which
// journals `superseded` and names the successor, and abandon's unwind of a spec its own
// effort created (row 29), which journals `removed`. This module is the one home for that
// act: how a departure is read, what it takes out of canon, how it is taken back, and which
// ids it retires. What may still point INTO a departing spec is settled by the two verbs
// that depart one.

// The status entry with which an artifact LEFT canon, if a witness verb took it out: the
// stream's LATEST status entry, when it is a departure. Latest, not any — a departure taken
// back, or a removed spec written again, is followed by a later status and reads as present.
// Callers consult canon first: this answers only for an id that canon no longer holds.
export function canonExit(entries: Entry[]): StatusEntry | undefined {
  const last = entries.filter((e) => e.t === 'status').at(-1) as unknown as StatusEntry | undefined
  return last !== undefined && (last.to === 'superseded' || last.to === 'removed') ? last : undefined
}

// Every stream whose artifact left canon. An obligation recorded there is still open until it
// is dismissed (D122), so the ledger reads these streams too.
export function departedStreams(root: string, canon: Canon): string[] {
  const dir = join(root, '.witness', 'journal')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length))
    .filter((id) => !findById(canon, id) && canonExit(readStream(root, id)) !== undefined)
}
```

Run: `pnpm vitest run tests/departure.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing `check`, `status` and `write` tests**

`tests/check.test.ts` — replace the helpers import at line 12:

```ts
import { SPEC_META, approve, fakeScenario, gateEnv, seededRepo, shippableRepo, undoCanonExclusion, writePlan, writeSpec } from './helpers.js'
```

with:

```ts
import { SPEC_META, approve, fakeScenario, gateEnv, seededRepo, shippableRepo, stampLive, undoCanonExclusion, writePlan, writeSpec } from './helpers.js'
```

Append at the end of the file:

```ts
// D166 / issue #34. A spec leaves canon through two verbs, and its stream records the
// departure. A plan that no longer moves keeps its parent there; a stream that departed is
// lineage, not an orphan. These drive the real verbs, except where a test must build a state
// the fixed verbs can no longer reach — then by hand, and said.
describe('check — a departure is lineage (D166)', () => {
  const SETUP_CARD = { criteria: [{ id: 'ac-setup', test: '@spec:setup-card' }] }

  it('accepts a done plan whose parent a re-slice superseded, and reads its stream as lineage', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')                        // shipped: the documented re-slice target
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
    const res = await repo.cli(['check'])
    expect(res.stdout).not.toContain('unknown-parent')
    expect(res.stdout).not.toContain('pin-unresolvable')
    expect(res.stdout).not.toContain('orphan-journal')
    expect(res.code).toBe(0)
  })

  it('accepts an abandoned plan whose parent a re-slice superseded — the issue #34 end state', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })   // live before this effort: abandon unwinds nothing
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    expect((await repo.cli(['start', 'auth-refresh-plan-1'])).code).toBe(0)
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
    const res = await repo.cli(['check'])
    expect(res.stdout).not.toContain('unknown-parent')
    expect(res.code).toBe(0)
  })

  it('accepts an abandoned plan whose parent the abandon itself unwound — the plainest abandon', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')                  // created by this effort
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)   // unwinds the spec: `removed`
    const res = await repo.cli(['check'])
    expect(res.stdout).not.toContain('unknown-parent')
    expect(res.stdout).not.toContain('orphan-journal')
    expect(res.code).toBe(0)
  })

  it('a plan still moving under a departed parent is an error that names the way out', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    // A re-slice from before D166, built by hand: the fixed `write` refuses to make this state.
    repo.git('rm', '-q', 'specs/auth-refresh.md')
    appendEntry(repo.root, 'auth-refresh', {
      t: 'status', artifact: 'auth-refresh', from: 'approved', to: 'superseded', cause: 'supersede', by: 'setup-card',
    })
    repo.git('add', '.witness/journal/auth-refresh.jsonl')
    repo.git('commit', '-q', '-m', 'write(setup-card): create spec', '-m', 'Witness-State: 1')
    const res = await repo.cli(['check'])
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('unknown-parent')
    expect(res.stdout).toContain('superseded by setup-card while this plan is approved')
    expect(res.stdout).toContain('witness abandon auth-refresh-plan-1')
    // the way out it names works: abandoning finishes the plan, and a finished plan reads the journal
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)
    const after = await repo.cli(['check'])
    expect(after.stdout).not.toContain('unknown-parent')
    expect(after.code).toBe(0)
  })

  it('a parent deleted by hand stays a bare unknown-parent, and its stream a stray', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'done')
    // the stream exists and its last word is `live` — existence is not a departure
    appendEntry(repo.root, 'auth-refresh', { t: 'status', artifact: 'auth-refresh', from: 'approved', to: 'live', cause: 'merge' })
    repo.git('rm', '-q', 'specs/auth-refresh.md')
    repo.git('add', '.witness/journal/auth-refresh.jsonl')
    repo.git('commit', '-q', '-m', 'hand delete', '-m', 'Witness-State: 1')
    const res = await repo.cli(['check'])
    expect(res.code).toBe(1)
    expect(res.stdout).toMatch(/unknown-parent,auth-refresh$/m)
    expect(res.stdout).toContain('orphan-journal')
    expect(res.stdout).toContain('records no departure — a stray')
  })

  it('a departed stream that still holds an open obligation is listed and warned until dismissed', async () => {
    const repo = await seededRepo()
    // a departure from before D166 moved nothing: the obligation stayed on the departed stream
    appendEntry(repo.root, 'old-spec', {
      t: 'deferral', id: 'd-0000beef', artifact: 'old-spec', gate: 'design', round: 1,
      anchor: 'old-spec > ## Behavior', kind: 'artifact-debt', caused_by_run: 'r-1',
    })
    appendEntry(repo.root, 'old-spec', { t: 'status', artifact: 'old-spec', from: 'live', to: 'superseded', cause: 'supersede', by: 'new-spec' })
    repo.git('add', '.witness/journal/old-spec.jsonl')
    repo.git('commit', '-q', '-m', 'legacy departure', '-m', 'Witness-State: 1')
    const res = await repo.cli(['check'])
    expect(res.stdout).toContain('stranded-deferral')
    expect(res.stdout).toContain('d-0000beef')
    expect(res.stdout).toContain('--cause superseded')
    expect(res.stdout).not.toContain('orphan-journal')
    expect((await repo.cli(['status'])).stdout).toContain('d-0000beef')   // the ledger lists it too
    expect((await repo.cli(['dismiss', 'old-spec', '--deferral', 'd-0000beef', '--cause', 'superseded', '--note', 'pre-D166 re-slice'])).code).toBe(0)
    const after = await repo.cli(['check'])
    expect(after.stdout).not.toContain('stranded-deferral')
    expect(after.stdout).not.toContain('orphan-journal')
    expect((await repo.cli(['status'])).stdout).not.toContain('d-0000beef')
  })

  it('witness\'s own floor stream is not an orphan', async () => {
    const repo = await seededRepo()
    appendEntry(repo.root, 'floor', { t: 'policy-pin', key: 'floor', pin: '0.14.0', note: 'probe' })
    repo.git('add', '.witness/journal/floor.jsonl')
    repo.git('commit', '-q', '-m', 'floor pin', '-m', 'Witness-State: 1')
    expect((await repo.cli(['check'])).stdout).not.toContain('orphan-journal')
  })

  it('a done plan under a removed parent stays an error: that unwind deleted shipped behavior', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')
    // An unwind from before D166, built by hand: the fixed abandon keeps a spec a done plan stands on.
    repo.git('rm', '-q', 'specs/auth-refresh.md')
    appendEntry(repo.root, 'auth-refresh', { t: 'status', artifact: 'auth-refresh', from: 'live', to: 'removed', cause: 'abandon' })
    repo.git('add', '.witness/journal/auth-refresh.jsonl')
    repo.git('commit', '-q', '-m', 'abandon(auth-refresh-plan-2)', '-m', 'Witness-State: 1')
    const res = await repo.cli(['check'])
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('removed by abandon after this plan shipped it')
    // the way out it names: the same spec written again under its own id, then approved
    expect((await writeSpec(repo, 'auth-refresh')).code).toBe(0)
    approve(repo, 'auth-refresh')
    expect((await repo.cli(['check'])).code).toBe(0)
  })
})
```

`tests/reslice.test.ts` — replace the helpers import at line 6:

```ts
import { approve, seededRepo, writeSpec } from './helpers.js'
```

with:

```ts
import { approve, seededRepo, writePlan, writeSpec } from './helpers.js'
```

Append at the end of the file:

```ts
const SETUP_CARD = { criteria: [{ id: 'ac-setup', test: '@spec:setup-card' }] }

// D166. A re-slice names its predecessor; any departure of that predecessor is terminal here,
// because there is nothing left to delete either way.
describe('reading a departure (D166)', () => {
  it('a re-slice may name a spec its own abandon already unwound', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')                  // created by this effort
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)   // unwinds the spec: removed
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
  })
})
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm vitest run tests/check.test.ts tests/reslice.test.ts -t D166`
Expected: all nine FAIL.
- Tests 1–4 still see `unknown-parent` (test 4's detail is the bare id).
- Test 5 sees the old `orphan-journal` text.
- Test 6 sees `orphan-journal`, with no `stranded-deferral` and nothing in `status`.
- Test 7 sees `orphan-journal` for `floor`.
- Test 8 sees exit 0.
- The re-slice is refused `unknown-supersedes`.

- [ ] **Step 5: `planFinished` (`src/scan.ts`)**

Directly after `plannableParent` (`scan.ts:65-68`):

```ts
export function plannableParent(doc: CanonDoc): boolean {
  const s = String(doc.meta.status)
  return doc.meta.type === 'principles' ? s === 'approved' : s === 'approved' || s === 'live'
}
```

add:

```ts

// D166. The one derivation of "this plan no longer moves": `done` merged and `abandoned` was
// withdrawn. check's stray-worktree rule, next's plan queue and the re-slice's guard all ask
// exactly this.
export function planFinished(doc: CanonDoc): boolean {
  const s = String(doc.meta.status)
  return s === 'done' || s === 'abandoned'
}
```

- [ ] **Step 6: `check` reads departures (`src/verbs/check.ts`)**

(a) Line 12 — replace:

```ts
import { designPending } from '../design.js'
```

with:

```ts
import { openDeferrals } from '../deferral.js'
import { canonExit } from '../departure.js'
import { designPending } from '../design.js'
import { FLOOR_STREAM } from '../floor.js'
```

(b) Line 23 — replace:

```ts
import { findById, findCycle, loadCanon } from '../scan.js'
```

with:

```ts
import { findById, findCycle, loadCanon, planFinished } from '../scan.js'
```

(c) Lines 110-115 — replace:

```ts
  for (const plan of canon.docs.filter((d) => d.meta.type === 'plan')) {
    const parent = typeof plan.meta.parent === 'string' ? findById(canon, plan.meta.parent) : undefined
    if (!parent) {
      findings.push(f('error', 'invariants', `${plan.rel}: parent`, 'unknown-parent', String(plan.meta.parent)))
      continue
    }
```

with:

```ts
  for (const plan of canon.docs.filter((d) => d.meta.type === 'plan')) {
    const parent = typeof plan.meta.parent === 'string' ? findById(canon, plan.meta.parent) : undefined
    if (!parent) {
      // D166. A plan that no longer moves keeps its parent in the departed spec's stream — the
      // rule row 62 already applies to `supersedes:` and `--lineage`. Its pin is not
      // re-verified: nothing reads a finished plan's pin once its parent is history, and the
      // departure never journaled the path it would resolve against. Two cases stay errors: a
      // plan still moving (every gate reads its parent), and a `done` plan under `removed` —
      // only a re-slice may take shipped content out of canon, so that is a pre-D166 unwind
      // that deleted built behavior. No departure entry at all is a stray, as before.
      const exit = typeof plan.meta.parent === 'string' ? canonExit(readStream(root, plan.meta.parent)) : undefined
      const status = String(plan.meta.status)
      if (exit !== undefined && (status === 'abandoned' || (status === 'done' && exit.to === 'superseded'))) continue
      findings.push(f('error', 'invariants', `${plan.rel}: parent`, 'unknown-parent', exit === undefined
        ? String(plan.meta.parent)
        : status === 'done'
          ? `${String(plan.meta.parent)} removed by abandon after this plan shipped it — canon lost built behavior; write that spec again under this id`
          : `${String(plan.meta.parent)} ${exit.to} by ${exit.by ?? exit.cause} while this plan is ${status} — witness abandon ${String(plan.meta.id)} · or re-author it under a live parent`))
      continue
    }
```

(d) Line 159 — replace:

```ts
    if (!doc || ['done', 'abandoned'].includes(String(doc.meta.status))) {
```

with:

```ts
    if (!doc || planFinished(doc)) {
```

(e) Lines 226-227 — replace:

```ts
      if (entries[0]?.t === 'recap') continue
      if (!findById(canon, id)) findings.push(f('warn', 'journal', file, 'orphan-journal', 'stream matches no doc (frozen lineage or stray)'))
```

with:

```ts
      if (entries[0]?.t === 'recap' || id === FLOOR_STREAM) continue
      if (findById(canon, id)) continue
      // D166. A departed spec's stream is not an orphan — it is lineage by construction, what a
      // finished plan's parent and `log --lineage` resolve against. It speaks only while it
      // still holds open obligations: a re-slice moves them to the successor, but an unwind has
      // no successor, and a departure from before D166 moved nothing. `superseded` is the
      // dismissal cause that fits either: the thing the obligation was about no longer exists.
      // A stream with no departure entry is what this rule was always for: a stray.
      const exit = canonExit(entries)
      if (exit === undefined) {
        findings.push(f('warn', 'journal', file, 'orphan-journal', 'stream matches no doc and records no departure — a stray'))
        continue
      }
      const owed = openDeferrals(entries)
      if (owed.length > 0) {
        findings.push(f('warn', 'journal', id, 'stranded-deferral',
          `${owed.length} open deferral(s) on a spec that left canon (${exit.to} by ${exit.by ?? exit.cause}): ${owed.map((d) => d.id).join(' ')} — witness dismiss ${id} --deferral <id> --cause superseded --note <why>`))
      }
```

- [ ] **Step 7: The same predicate in `next`, the ledger in `status`, and the one reading in `write` and `log`**

`src/verbs/next.ts` line 7 — replace:

```ts
import { findById, loadCanon, plannableParent, type Canon, type CanonDoc } from '../scan.js'
```

with:

```ts
import { findById, loadCanon, planFinished, plannableParent, type Canon, type CanonDoc } from '../scan.js'
```

and lines 704-705 — replace:

```ts
    .filter((d) => !plans.some((p) => String(p.meta.parent) === String(d.meta.id) &&
      !['done', 'abandoned'].includes(String(p.meta.status))))
```

with:

```ts
    .filter((d) => !plans.some((p) => String(p.meta.parent) === String(d.meta.id) && !planFinished(p)))
```

`src/verbs/dashboard.ts` line 4 — replace:

```ts
import { designArtifactCurrent, designPending } from '../design.js'
```

with:

```ts
import { departedStreams } from '../departure.js'
import { designArtifactCurrent, designPending } from '../design.js'
```

and lines 52-53, in `deferralRows` (`recommenderRows` at line 106 builds the same set for override statistics and is left alone) — replace:

```ts
  const streams = new Set([...effortStreams(root), ...canon.docs.map((d) => String(d.meta.id))])
  const out: Array<{ id: string; artifact: string; gate: string; anchor: string; kind: string; age: string }> = []
```

with:

```ts
  // D166. A departed spec's stream is the third source: an obligation recorded there is still
  // open until it is dismissed, and `status` is where every open obligation is listed (D122).
  const streams = new Set([...effortStreams(root), ...canon.docs.map((d) => String(d.meta.id)), ...departedStreams(root, canon)])
  const out: Array<{ id: string; artifact: string; gate: string; anchor: string; kind: string; age: string }> = []
```

`src/verbs/write.ts` line 6 — replace:

```ts
import { designPending, designRel, designStamp } from '../design.js'
```

with:

```ts
import { canonExit } from '../departure.js'
import { designPending, designRel, designStamp } from '../design.js'
```

and lines 160-167 — replace:

```ts
      const target = findById(canon, supersedes)
      if (!target) {
        const alreadyTerminal = readStream(root, supersedes)
          .some((e) => e.t === 'status' && (e as unknown as StatusEntry).to === 'superseded')
        if (!alreadyTerminal) {
          return refuseWrite([v('supersedes', 'unknown-supersedes', supersedes,
            'an existing spec (or one already journal-terminal)')])
        }
```

with:

```ts
      const target = findById(canon, supersedes)
      if (!target) {
        // D166. Any departure is terminal here — a spec its abandon unwound as well as one
        // already superseded: either way there is nothing left to delete. Abandoning the plan
        // a `dangling-parent` refusal names can unwind the very spec this write re-slices.
        if (canonExit(readStream(root, supersedes)) === undefined) {
          return refuseWrite([v('supersedes', 'unknown-supersedes', supersedes,
            'an existing spec (or one that already left canon)')])
        }
```

`src/verbs/log.ts` line 6 — replace:

```ts
import { journalRel, readStream, streamExists, type Entry, type StatusEntry } from '../journal.js'
```

with:

```ts
import { canonExit } from '../departure.js'
import { journalRel, readStream, streamExists, type Entry } from '../journal.js'
```

and lines 55-59 — replace:

```ts
function successorOf(root: string, id: string): string | undefined {
  const terminal = readStream(root, id).find(
    (e) => e.t === 'status' && (e as unknown as StatusEntry).to === 'superseded') as unknown as StatusEntry | undefined
  return terminal?.by
}
```

with:

```ts
// D166. Read through `canonExit`, the one reading of a departure: a re-slice that was taken
// back is no longer a lineage step.
function successorOf(root: string, id: string): string | undefined {
  const exit = canonExit(readStream(root, id))
  return exit?.to === 'superseded' ? exit.by : undefined
}
```

- [ ] **Step 8: Run to verify they pass**

Run: `pnpm vitest run tests/departure.test.ts tests/check.test.ts tests/reslice.test.ts tests/next-live-queue.test.ts tests/deferral.test.ts`
Expected: PASS. That includes the nine D166 tests and every pre-existing test, including `'warns on orphan artifact journals'` (its ghost stream records no departure) and the `log --lineage` test.

- [ ] **Step 9: Typecheck and commit**

Run: `pnpm run typecheck` (expected exit 0).

```bash
git add src/departure.ts src/scan.ts src/verbs/check.ts src/verbs/next.ts src/verbs/dashboard.ts src/verbs/write.ts src/verbs/log.ts tests/departure.test.ts tests/check.test.ts tests/reslice.test.ts
git commit -F - <<'EOF'
fix(check): a departed spec's stream is lineage (D166)

check resolved every plan's parent against live canon only. Two verbs
take a spec out of canon on purpose, so every plan under such a spec --
done and abandoned ones included -- read as unknown-parent for good
(issue #34), and so did the plainest abandon.

canonExit (the new departure.ts) is the one reading of a departure:
check resolves a finished plan's parent in the stream (a done plan
under removed stays an error -- that unwind deleted shipped behavior);
a moving plan's stays an error naming the way out; a hand deletion
stays a stray. A departed stream is lineage, not an orphan, unless it
holds open obligations (stranded-deferral), which status now lists;
witness's own floor stream is never an orphan. write accepts naming a
spec that already left canon either way, and log --lineage reads the
same departure. planFinished is the one derivation of done-or-abandoned.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: One departure for both verbs — the design leaves, or goes back, with its spec

**Files:**
- Modify:
  - `src/departure.ts` (imports; `Departure`, `prepareDeparture`)
  - `src/gitio.ts` (`gitBlob`, after `tryGit`)
  - `src/verbs/write.ts` (imports; the re-slice declaration, construction, files and transaction)
  - `src/abandon.ts` (imports; `SpecRevert`; the delete and restore branches; `executeAbandon`)
- Test: `tests/reslice.test.ts`, `tests/abandon.test.ts`

**Interfaces:**
- Consumes: `canonExit` (Task 2), and Task 2's `check` (tests assert exit 0).
- Produces:
  - in `src/departure.ts`: `export interface Departure { entry: StatusEntry; files: string[]; remove: () => void }` and `export function prepareDeparture(root: string, paths: CanonPaths, spec: CanonDoc, entry: StatusEntry): Departure`;
  - in `src/gitio.ts`: `export function gitBlob(root: string, rev: string, rel: string): Buffer | undefined`;
  - `SpecRevert` becomes `{ …restore…; design?: { rel: string; prior: Buffer | undefined } } | { doc: CanonDoc; action: 'delete'; departure: Departure }`. Tasks 5 and 7 build on this exact text.

- [ ] **Step 1: Pin the re-slice's existing behavior, then write the failing unwind tests**

`tests/reslice.test.ts` — replace the helpers import (as Task 2 left it):

```ts
import { approve, seededRepo, writePlan, writeSpec } from './helpers.js'
```

with:

```ts
import { approve, seededRepo, writeDesign, writePlan, writeSpec } from './helpers.js'
```

Append at the end of the file:

```ts
// D166. A spec leaves canon through one door, so the re-slice and the unwind take the same
// things out with it. This pins the re-slice's half, which predates the shared door.
describe('one departure, both verbs (D166)', () => {
  it('a re-slice takes the superseded spec\'s design out of canon with it', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-tokens', { ui: true, ...TOKENS_CRITERIA })
    expect((await writeDesign(repo, 'auth-tokens')).code).toBe(0)
    approve(repo, 'auth-tokens')
    expect((await writeSpec(repo, 'token-rotation', { supersedes: 'auth-tokens', ...ROTATION_CRITERIA })).code).toBe(0)
    expect(existsSync(join(repo.root, 'designs/auth-tokens.html'))).toBe(false)
    const files = repo.git('show', '--no-renames', '--name-only', '--format=', 'HEAD').trim().split('\n')
    expect(files).toContain('designs/auth-tokens.html')
  })
})
```

`tests/abandon.test.ts` — replace line 1:

```ts
import { existsSync } from 'node:fs'
```

with:

```ts
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
```

and the helpers import at line 6:

```ts
import { approve, seededRepo, writeSpec, writePlan, PLAN_BODY } from './helpers.js'
```

with:

```ts
import { approve, DESIGN_HTML, seededRepo, stampLive, writeDesign, writeSpec, writePlan, PLAN_BODY, type TestRepo } from './helpers.js'
```

Append at the end of the file:

```ts
// A second effort, so a test can put plans or amendments under a different owner.
async function recapEffort(repo: TestRepo, slug: string): Promise<void> {
  repo.write(`recap-${slug}.json`, JSON.stringify({
    effort: slug, class: 'feature', goals: [{ id: 'g1', text: `${slug} goal` }],
    non_goals: [], constraints: [], slices: [],
  }))
  const r = await repo.cli(['recap', '--file', `recap-${slug}.json`])
  rmSync(join(repo.root, `recap-${slug}.json`), { force: true })
  if (r.code !== 0) throw new Error(`recap ${slug}: ${r.stderr}`)
}

// D166. The unwind departs a spec through the same door the re-slice uses, and a restore takes
// the look back with the content it was drawn for.
describe('one departure, both verbs (D166)', () => {
  it('an unwound ui spec takes its design out of canon with it', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ui: true })
    expect((await writeDesign(repo, 'auth-refresh')).code).toBe(0)
    expect(existsSync(join(repo.root, 'designs/auth-refresh.html'))).toBe(true)
    expect((await repo.cli(['abandon', 'auth-hardening'])).code).toBe(0)   // unwinds the spec it created
    expect(existsSync(join(repo.root, 'designs/auth-refresh.html'))).toBe(false)
    expect(repo.git('show', '--name-only', '--format=', 'HEAD').split('\n')).toContain('designs/auth-refresh.html')
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('an unwound amendment puts its spec\'s design back, byte for byte', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking', { ui: true, criteria: [{ id: 'ac-b', test: '@spec:booking' }] })
    const v1 = DESIGN_HTML.replace('New service', 'Look one')
    expect((await writeDesign(repo, 'booking', v1)).code).toBe(0)
    approve(repo, 'booking')
    stampLive(repo, 'booking')
    await recapEffort(repo, 'redesign')
    expect((await writeSpec(repo, 'booking', { ui: true, summary: 'Bookings · amended', criteria: [{ id: 'ac-b', test: '@spec:booking' }] }, undefined, 'redesign')).code).toBe(0)
    expect((await writeDesign(repo, 'booking', DESIGN_HTML.replace('New service', 'Look two'))).code).toBe(0)
    expect((await repo.cli(['abandon', 'redesign'])).code).toBe(0)
    expect(repo.read('designs/booking.html')).toBe(v1)
  })
})
```

- [ ] **Step 2: Run them**

Run: `pnpm vitest run tests/reslice.test.ts tests/abandon.test.ts -t D166`
Expected:
- the re-slice test PASSES (it characterizes existing behavior);
- both unwind tests FAIL: the design is still on disk after the unwind, and the restore leaves "Look two".

- [ ] **Step 3: `gitBlob` (`src/gitio.ts`)**

Directly after `tryGit` (it ends `    return { ok: false, out: String(err.stdout || err.stderr || e).trim() }` / `  }` / `}`), add:

```ts

// D166. The bytes git stores for a path at a revision, untouched. `git()` strips one trailing
// newline, which is right for command output and wrong for a file put back from history: a
// design is hashed as bytes, so a restored look must be the look that was stored.
export function gitBlob(root: string, rev: string, rel: string): Buffer | undefined {
  try {
    return execFileSync('git', ['show', `${rev}:${rel}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: GIT_MAX_BUFFER })
  } catch {
    return undefined
  }
}
```

- [ ] **Step 4: The departure act (`src/departure.ts`)**

Replace the import block:

```ts
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readStream, type Entry, type StatusEntry } from './journal.js'
import { findById, type Canon } from './scan.js'
```

with:

```ts
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonPaths } from './config.js'
import { designRel } from './design.js'
import { journalRel, readStream, type Entry, type StatusEntry } from './journal.js'
import { findById, type Canon, type CanonDoc } from './scan.js'
```

Append at the end of the file:

```ts

export interface Departure {
  entry: StatusEntry      // journaled on the spec's own stream; it stays the stream's last status entry
  files: string[]         // every state path the departure touches: the spec, its design, its stream
  remove: () => void      // unlinks what leaves canon with the spec
}

// What leaves canon WITH a spec. Its design is spec-scoped (row 69) and goes with it: the
// re-slice always deleted it, while the unwind left a ui spec's look behind in canon after the
// spec it described was gone. A design is listed only when present, because a state commit
// cannot stage a path that never existed.
export function prepareDeparture(root: string, paths: CanonPaths, spec: CanonDoc, entry: StatusEntry): Departure {
  const design = designRel(paths, String(spec.meta.id))
  const leaving = [spec.rel, ...(existsSync(join(root, design)) ? [design] : [])]
  return {
    entry,
    files: [...leaving, journalRel(String(spec.meta.id))],
    remove: () => { for (const rel of leaving) unlinkSync(join(root, rel)) },
  }
}
```

- [ ] **Step 5: The re-slice departs through it (`src/verbs/write.ts`, no behavior change)**

(a) Replace `import { existsSync, readFileSync, unlinkSync } from 'node:fs'` with:

```ts
import { readFileSync } from 'node:fs'
```

(b) Replace `import { canonExit } from '../departure.js'` with:

```ts
import { canonExit, prepareDeparture, type Departure } from '../departure.js'
```

(c) Replace `import { designPending, designRel, designStamp } from '../design.js'` with:

```ts
import { designPending, designStamp } from '../design.js'
```

(d) Replace:

```ts
import { appendEntry, entryLine, journalRel, latestRecap, readStream, streamExists, type RecapEntry, type StatusEntry } from '../journal.js'
```

with:

```ts
import { appendEntry, entryLine, journalRel, latestRecap, readStream, streamExists, type RecapEntry } from '../journal.js'
```

(e) Replace:

```ts
    let reslice: { doc: CanonDoc; entry: StatusEntry; line: string } | undefined
```

with:

```ts
    let reslice: Departure | undefined
```

(f) Replace:

```ts
        const entry: StatusEntry = {
          v: 1, t: 'status', artifact: supersedes, from: String(target.meta.status),
          to: 'superseded', cause: 'supersede', by: id!,
        }
        reslice = { doc: target, entry, line: entryLine(entry as unknown as { t: 'status'; [k: string]: unknown }) }
```

with:

```ts
        reslice = prepareDeparture(root, cfg.value.paths, target, {
          v: 1, t: 'status', artifact: supersedes, from: String(target.meta.status),
          to: 'superseded', cause: 'supersede', by: id!,
        })
```

(g) Replace:

```ts
    const supersededDesignRel = reslice ? designRel(cfg.value.paths, reslice.entry.artifact) : undefined
    const files = [rel, stream,
      ...(reslice ? [reslice.doc.rel, journalRel(reslice.entry.artifact)] : []),
      ...(supersededDesignRel && existsSync(join(root, supersededDesignRel)) ? [supersededDesignRel] : []),
    ]
    const res = withTxn(root, {
      op: `write(${id})`, files, journal: { stream: effort, line },
      ...(reslice ? { journalMulti: [{ stream: reslice.entry.artifact, line: reslice.line }] } : {}),
    }, () => {
      writeDoc(join(root, rel), { meta: built.meta, body })
      crashPoint(ctx.env, 'artifact-write')
      if (reslice) {
        unlinkSync(join(root, reslice.doc.rel))
        const supersededDesign = designRel(cfg.value.paths, reslice.entry.artifact)
        if (existsSync(join(root, supersededDesign))) {
          unlinkSync(join(root, supersededDesign))
        }
        appendEntry(root, reslice.entry.artifact, reslice.entry as unknown as { t: 'status'; [k: string]: unknown })
        crashPoint(ctx.env, 'reslice-commit')
      }
```

with:

```ts
    const files = [rel, stream, ...(reslice?.files ?? [])]
    const res = withTxn(root, {
      op: `write(${id})`, files, journal: { stream: effort, line },
      ...(reslice ? { journalMulti: [{ stream: reslice.entry.artifact, line: entryLine(reslice.entry as unknown as { t: 'status'; [k: string]: unknown }) }] } : {}),
    }, () => {
      writeDoc(join(root, rel), { meta: built.meta, body })
      crashPoint(ctx.env, 'artifact-write')
      if (reslice) {
        reslice.remove()
        appendEntry(root, reslice.entry.artifact, reslice.entry as unknown as { t: 'status'; [k: string]: unknown })
        crashPoint(ctx.env, 'reslice-commit')
      }
```

- [ ] **Step 6: The unwind departs through it, and its restore takes the look back (`src/abandon.ts`)**

(a) Replace `import { unlinkSync, writeFileSync } from 'node:fs'` with:

```ts
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
```

(b) Replace `import type { Ctx } from './cli.js'` with:

```ts
import type { Ctx } from './cli.js'
import { prepareDeparture, type Departure } from './departure.js'
import { designRel } from './design.js'
```

(c) Replace `import { tryGit, stateCommit } from './gitio.js'` with:

```ts
import { gitBlob, tryGit, stateCommit } from './gitio.js'
```

(d) Replace:

```ts
export type SpecRevert =
  | { doc: CanonDoc; action: 'restore'; content: string; toStatus: string }
  | { doc: CanonDoc; action: 'delete' }
```

with:

```ts
export type SpecRevert =
  | { doc: CanonDoc; action: 'restore'; content: string; toStatus: string; design?: { rel: string; prior: Buffer | undefined } }
  | { doc: CanonDoc; action: 'delete'; departure: Departure }
```

(e) Replace:

```ts
    return ok({ doc: spec, action: 'delete' })
```

with:

```ts
    // D166. The unwind departs the spec through the same door the re-slice uses, so
    // everything that leaves canon with a spec — its design included — leaves here too.
    return ok({
      doc: spec, action: 'delete',
      departure: prepareDeparture(root, canon.paths, spec, {
        v: 1, t: 'status', artifact: String(spec.meta.id), from: String(spec.meta.status), to: 'removed', cause: 'abandon',
      }),
    })
```

(f) Replace:

```ts
  const parsed = splitDoc(prior.out)
  const toStatus = parsed.ok ? String(parsed.value.meta.status) : 'draft'
  return ok({ doc: spec, action: 'restore', content: prior.out, toStatus })
```

with:

```ts
  const parsed = splitDoc(prior.out)
  const toStatus = parsed.ok ? String(parsed.value.meta.status) : 'draft'
  // D166. The look goes back with the content it was drawn for: the design as it stood before
  // the commit being taken back, byte for byte — or none, if there was none then.
  const designR = designRel(canon.paths, String(spec.meta.id))
  const priorDesign = gitBlob(root, `${commit}^`, designR)
  const design = priorDesign !== undefined || existsSync(join(root, designR)) ? { rel: designR, prior: priorDesign } : undefined
  return ok({ doc: spec, action: 'restore', content: prior.out, toStatus, design })
```

(g) In `executeAbandon`, replace:

```ts
    if (item.revert) {
      const spec = item.revert.doc
      const id = String(spec.meta.id)
      const entry: StatusEntry = {
        v: 1, t: 'status', artifact: id, from: String(spec.meta.status),
        to: item.revert.action === 'restore' ? item.revert.toStatus : 'removed',
        cause: 'abandon',
      }
      specEntries.push({ stream: id, entry })
      files.add(spec.rel); files.add(journalRel(id))
      journalMulti.push({ stream: id, line: entryLine(entry as unknown as { t: 'status'; [k: string]: unknown }) })
    }
```

with:

```ts
    if (item.revert) {
      const spec = item.revert.doc
      const id = String(spec.meta.id)
      const entry: StatusEntry = item.revert.action === 'delete' ? item.revert.departure.entry : {
        v: 1, t: 'status', artifact: id, from: String(spec.meta.status), to: item.revert.toStatus, cause: 'abandon',
      }
      specEntries.push({ stream: id, entry })
      const touched = item.revert.action === 'delete'
        ? item.revert.departure.files
        : [spec.rel, journalRel(id), ...(item.revert.design ? [item.revert.design.rel] : [])]
      for (const f of touched) files.add(f)
      journalMulti.push({ stream: id, line: entryLine(entry as unknown as { t: 'status'; [k: string]: unknown }) })
    }
```

(h) Inside the transaction, replace:

```ts
        if (item.revert) {
          const abs = join(root, item.revert.doc.rel)
          if (item.revert.action === 'restore') writeFileSync(abs, item.revert.content)
          else unlinkSync(abs) // stateCommit's `git add` below correctly stages a tracked-but-missing file as a deletion
        }
```

with:

```ts
        if (item.revert) {
          // stateCommit's `git add` below stages a tracked-but-missing file as a deletion
          if (item.revert.action === 'delete') item.revert.departure.remove()
          else {
            writeFileSync(join(root, item.revert.doc.rel), item.revert.content)
            const d = item.revert.design
            if (d?.prior !== undefined) writeFileSync(join(root, d.rel), d.prior)
            else if (d !== undefined && existsSync(join(root, d.rel))) unlinkSync(join(root, d.rel))
          }
        }
```

- [ ] **Step 7: Run to verify they pass**

Run: `pnpm vitest run tests/reslice.test.ts tests/abandon.test.ts tests/check.test.ts`
Expected: PASS — the three D166 tests and every pre-existing re-slice, abandon and check test.

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm run typecheck` (expected exit 0).

```bash
git add src/departure.ts src/gitio.ts src/verbs/write.ts src/abandon.ts tests/reslice.test.ts tests/abandon.test.ts
git commit -F - <<'EOF'
fix(abandon): the design leaves, or goes back, with its spec (D166)

The re-slice and abandon's unwind each deleted a spec in their own way,
and only the re-slice remembered the spec's design: an unwound ui spec
left its look in canon, and an unwound amendment restored the spec but
left the amended look. prepareDeparture (departure.ts) is now the one
answer to what leaves canon with a spec, for both verbs; the restore
branch puts the design back as it stood before the commit being taken
back, byte for byte (gitBlob -- the git wrapper strips a trailing
newline, and a design is hashed as bytes). The re-slice's behavior is
unchanged, and a new test pins it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: The re-slice refuses while a plan still stands on the spec, and re-slices specs only

**Files:**
- Modify:
  - `src/scan.ts` (after `planFinished`)
  - `src/refusal.ts` (`Violation`, `humanCall`, the trailer)
  - `src/verbs/write.ts` (scan and refusal imports; the `else` branch of the re-slice)
  - `plugin/skills/witness-decompose/SKILL.md:47`
- Test: `tests/reslice.test.ts`, `tests/skills.test.ts`

**Interfaces:**
- Consumes: `planFinished` (Task 2).
- Produces:
  - `plansOn(canon: Canon, specId: string, opts?: { exclude?: Set<string>; pin?: string }): CanonDoc[]` in `src/scan.ts`. Tasks 5 and 7 use it.
  - `Violation.human?: true` and `humanCall(x: Violation): Violation` in `src/refusal.ts`.
  - Refusal rules `dangling-parent` (human-owned; in one refusal with `dangling-depends`) and `not-a-spec`.

- [ ] **Step 1: Write the failing tests**

`tests/reslice.test.ts` — replace the helpers import (as Task 3 left it):

```ts
import { approve, seededRepo, writeDesign, writePlan, writeSpec } from './helpers.js'
```

with:

```ts
import { approve, fakeScenario, gateEnv, ghState, seededRepo, shippableRepo, writeDesign, writePlan, writeSpec } from './helpers.js'
```

Append at the end of the file:

```ts
// D166 / issue #34. A plan's `parent` is the edge into the spec that row 62 never guarded. A
// plan still moving holds the re-slice; a finished one keeps its parent in the departed stream
// (check's half of D166) and holds nothing.
describe('re-slice over plans (D166)', () => {
  it('refuses dangling-parent while a plan of the superseded spec is still moving — a human\'s decision', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })   // live, shipped before this effort
    await writePlan(repo, 'auth-refresh-plan-1')                       // draft: still moving
    const r = await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('dangling-parent')
    expect(r.stdout + r.stderr).toContain('auth-refresh-plan-1')
    expect(r.stdout + r.stderr).toContain('a human\'s decision')
    expect(r.stdout + r.stderr).not.toContain('self-repair')
    expect(r.stdout + r.stderr).not.toContain('witness abandon')
    const canon = loadCanon(repo.root)
    expect(findById(canon, 'auth-refresh')).toBeDefined()               // nothing deleted
    expect(findById(canon, 'setup-card')).toBeUndefined()               // nothing written
    const refused = readStream(repo.root, repo.effort).filter((e) => e.t === 'write-refused').at(-1)
    expect(refused).toMatchObject({ artifact: 'setup-card', rules: [{ field: 'supersedes', rule: 'dangling-parent' }] })
    // abandoning the plan finishes it, and a finished plan holds nothing
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeUndefined()
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('names both dangling edges in one refusal', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }], depends: ['auth-refresh'] })
    await writePlan(repo, 'auth-refresh-plan-1')
    const r = await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('dangling-depends')
    expect(r.stdout + r.stderr).toContain('dangling-parent')
  })

  it('a plan merged but not yet stamped holds the re-slice until one check stamps it done', async () => {
    const { repo, planId, specId } = await shippableRepo()
    repo.setMeta(planId, { pr: 1 })                        // ship stamped the PR (direct seed, as stamp.test.ts does)
    const scenario = fakeScenario()
    ghState(scenario, 1, 'MERGED')
    const held = await writeSpec(repo, 'setup-card', { supersedes: specId, ...SETUP_CARD })
    expect(held.code).toBe(2)
    expect(held.stdout + held.stderr).toContain('dangling-parent')
    // check runs the lazy merge stamp (gateEnv clears CI and puts the fake gh first on PATH)
    await repo.cli(['check'], { env: gateEnv(scenario) })
    expect(findById(loadCanon(repo.root), planId)!.meta.status).toBe('done')
    expect((await writeSpec(repo, 'setup-card', { supersedes: specId, ...SETUP_CARD })).code).toBe(0)
    const res = await repo.cli(['check'], { env: gateEnv(scenario) })
    expect(res.stdout).not.toContain('unknown-parent')
    expect(res.code).toBe(0)
  })

  it('re-slices specs only — principles are amended in place', async () => {
    const repo = await seededRepo()
    const r = await writeSpec(repo, 'setup-card', { supersedes: 'principles', ...SETUP_CARD })
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('not-a-spec')
    expect(findById(loadCanon(repo.root), 'principles')).toBeDefined()
  })
})
```

`tests/skills.test.ts` — inside `describe('witness-decompose', …)`, after the `'does not claim the chore path always runs'` test, add (this file uses semicolons):

```ts
  it('hands a dangling-parent re-slice to the human (D166)', () => {
    expect(body()).toContain('dangling-parent');
    expect(body()).toContain('never abandon it yourself');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/reslice.test.ts tests/skills.test.ts -t "D166|dangling"`
Expected: the four re-slice tests and the skills pin FAIL.
- The re-slice is accepted (exit 0).
- The second test's refusal names only `dangling-depends`.
- `principles` is deleted.
- The skill lacks the sentence.

- [ ] **Step 3: `plansOn` (`src/scan.ts`)**

Directly after `planFinished` (Task 2):

```ts
export function planFinished(doc: CanonDoc): boolean {
  const s = String(doc.meta.status)
  return s === 'done' || s === 'abandoned'
}
```

add:

```ts

// D166. The plans that stand on a spec: its children that have not been withdrawn, outside
// the set of plans the asking operation is itself retiring. A `done` plan stands — it shipped
// this spec — and so does one still moving; only `abandoned` has stepped off. `pin` narrows to
// the children derived from one version of the spec, which is what an unwind would take away.
export function plansOn(canon: Canon, specId: string, opts: { exclude?: Set<string>; pin?: string } = {}): CanonDoc[] {
  return canon.docs.filter((d) =>
    d.meta.type === 'plan' && d.meta.parent === specId &&
    String(d.meta.status) !== 'abandoned' &&
    !(opts.exclude?.has(String(d.meta.id)) ?? false) &&
    (opts.pin === undefined || d.meta['derives-from'] === opts.pin))
}
```

- [ ] **Step 4: A row that is a human's decision says so (`src/refusal.ts`)**

(a) Replace:

```ts
  // D147. A runnable next command, rendered as `run:` only when it passes the same
  // no-placeholder test the decision block uses (`recommend.ts`) — a `run:` that needs
  // editing before it runs is the promise broken, which is D129's whole point.
  remedy?: string
}
```

with:

```ts
  // D147. A runnable next command, rendered as `run:` only when it passes the same
  // no-placeholder test the decision block uses (`recommend.ts`) — a `run:` that needs
  // editing before it runs is the promise broken, which is D129's whole point.
  remedy?: string
  // D166. The row names a decision that belongs to a human: re-running cannot clear it, so the
  // self-repair trailer would be false there — row 108's principle, for a refusal.
  human?: true
}
```

(b) Replace:

```ts
export function v(field: string, rule: string, got: string, want: string, remedy?: string): Violation {
  return remedy === undefined ? { field, rule, got, want } : { field, rule, got, want, remedy }
}
```

with:

```ts
export function v(field: string, rule: string, got: string, want: string, remedy?: string): Violation {
  return remedy === undefined ? { field, rule, got, want } : { field, rule, got, want, remedy }
}

export const humanCall = (x: Violation): Violation => ({ ...x, human: true })
```

(c) Replace:

```ts
    'help: fix each row and re-run — rows are structured for self-repair',
```

with:

```ts
    violations.some((x) => x.human)
      ? 'help: a row here is a human\'s decision — stop and surface the list; re-running cannot clear it'
      : 'help: fix each row and re-run — rows are structured for self-repair',
```

- [ ] **Step 5: The guards (`src/verbs/write.ts`)**

(a) Replace `import { renderRefusal, v, type Violation } from '../refusal.js'` with:

```ts
import { humanCall, renderRefusal, v, type Violation } from '../refusal.js'
```

(b) Replace `import { findById, findCycle, loadCanon, type Canon, type CanonDoc } from '../scan.js'` with:

```ts
import { findById, findCycle, loadCanon, planFinished, plansOn, type Canon, type CanonDoc } from '../scan.js'
```

(c) Replace:

```ts
      } else {
        const dependents = canon.docs
```

with:

```ts
      } else {
        // D166. Re-slicing re-cuts specs (row 5). Deleting a plan here stranded a live flow, and
        // deleting the principles removed every chore's only parent, with nothing to bring
        // either back.
        if (target.meta.type !== 'spec') {
          return refuseWrite([v('supersedes', 'not-a-spec', `${supersedes} is a ${String(target.meta.type)}`,
            'a spec — a plan is withdrawn with witness abandon and principles are amended in place')])
        }
        const dependents = canon.docs
```

(d) Replace:

```ts
        if (dependents.length > 0) {
          return refuseWrite([v('supersedes', 'dangling-depends', dependents.join(' '),
            'dependents rewritten first — the re-slice rewrites them before deleting')])
        }
```

with:

```ts
        // D166. A plan's `parent` is the other edge into the spec this deletes, and row 62
        // guarded only `depends`: every gate reads the parent, so a plan still moving was left
        // unable to move and impossible to clear (issue #34). A finished plan holds nothing — the
        // successor carries the content forward, and `check` resolves the plan's parent in the
        // departed stream. Whether a moving plan ships first or is withdrawn is a human's call,
        // so the row says so and names no command an agent could run for them.
        const moving = plansOn(canon, supersedes).filter((p) => !planFinished(p)).map((p) => String(p.meta.id))
        // Both edges in ONE refusal: every refusal counts against the first-try rate the
        // dashboard trends, and learning of the second edge only after repairing the first
        // would cost a refusal for nothing.
        const dangling = [
          ...(dependents.length > 0 ? [v('supersedes', 'dangling-depends', dependents.join(' '),
            'dependents rewritten first — the re-slice rewrites them before deleting')] : []),
          ...(moving.length > 0 ? [humanCall(v('supersedes', 'dangling-parent', moving.join(' '),
            'those plans finished or withdrawn first — the re-slice deletes their parent and which way each goes is a human\'s call'))] : []),
        ]
        if (dangling.length > 0) return refuseWrite(dangling)
```

- [ ] **Step 6: The decompose skill**

`plugin/skills/witness-decompose/SKILL.md:47` currently reads:

```markdown
- Boundary changes (split, merge, extraction out of a live spec) → the new spec's manifest carries `supersedes: <old-id>`; rewrite every dependent's `depends` in the same effort — the CLI refuses dangling edges.
```

Replace it with:

```markdown
- Boundary changes (split, merge, extraction out of a live spec) → the new spec's manifest carries `supersedes: <old-id>`; rewrite every dependent's `depends` in the same effort — the CLI refuses dangling edges. It also refuses `dangling-parent` while a plan of the old spec is still in motion: whether that plan ships first or is abandoned is the human's call, so stop and surface it — never abandon it yourself.
```

- [ ] **Step 7: Run to verify they pass**

Run: `pnpm vitest run tests/reslice.test.ts tests/skills.test.ts tests/check.test.ts tests/refusal.test.ts tests/decide.test.ts`
Expected: PASS. Task 2's first check test re-slices over a `done` plan and must still pass. The refusal renderer's existing tests (no human row) must render as before.

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm run typecheck` (expected exit 0).

```bash
git add src/scan.ts src/refusal.ts src/verbs/write.ts plugin/skills/witness-decompose/SKILL.md tests/reslice.test.ts tests/skills.test.ts
git commit -F - <<'EOF'
fix(write): a re-slice refuses while a plan still stands on the spec (D166)

The re-slice guarded the depends edge into the spec it deletes and not
the parent edge, so it deleted the parent of a draft, approved or
in-progress plan, which then could neither move nor be cleared. It now
refuses dangling-parent while such a plan exists, in one refusal with
dangling-depends. The row is a human's decision (humanCall): the
renderer says to stop instead of "fix each row and re-run", and the
want names no command an agent could run for them -- row 108's
principle. A re-slice target must be a spec (not-a-spec); deleting a
plan or the principles here was irreversible. plansOn (scan.ts) is the
one answer to which plans stand on a spec.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Abandon keeps content another plan stands on — and its final act never strands one

**Files:**
- Modify:
  - `src/abandon.ts`: imports; `SpecKeep` and `keptLine` after `SpecRevert` (as Task 3 left it); the `specRevertFor` signature and standing check; `AbandonItem`; `planItems`
  - `src/verbs/abandon.ts:10, 30-33, 42, 63, 68-69`
- Test: `tests/abandon.test.ts`

**Interfaces:**
- Consumes: `plansOn` (Task 4); the `SpecRevert` union (Task 3); `recapEffort` and imports (Task 3's test block).
- Produces, in `src/abandon.ts`:
  - `export interface SpecKeep { doc: CanonDoc; action: 'keep'; standing: string[]; shipped: boolean }`
  - `export const keptLine: (k: SpecKeep) => string`, rendering `<id> — not unwound · still standing on it: <ids>`
  - `AbandonItem.kept?: SpecKeep`
  - `specRevertFor(…): Result<SpecRevert | SpecKeep | undefined>`
- Verb output: `kept:` on both paths, and the refusal `still-standing` on `abandon <effort>`.

- [ ] **Step 1: Write the failing tests**

Append at the end of `tests/abandon.test.ts`:

```ts
// D166. Abandoning a plan takes back the spec content it was paired with (row 29) — but a
// sibling derived from the same version either shipped it or is still building it. The
// content stays while any other plan stands on it. An effort's own abandon is its last act,
// so it keeps only what nothing will ever need to take back.
describe('abandon keeps content another plan stands on (D166)', () => {
  it('abandoning the second plan of a shipped spec keeps the spec', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')                  // created by this effort
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    await writePlan(repo, 'auth-refresh-plan-2')           // same pin: the spec was never amended
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')
    const r = await repo.cli(['abandon', 'auth-refresh-plan-2'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('kept: auth-refresh — not unwound · still standing on it: auth-refresh-plan-1')
    const canon = loadCanon(repo.root)
    expect(findById(canon, 'auth-refresh')!.meta.status).toBe('live')   // canon still describes what shipped
    expect(findById(canon, 'auth-refresh-plan-2')!.meta.status).toBe('abandoned')
    expect(readStream(repo.root, 'auth-refresh').some((e) =>
      e.t === 'status' && (e as unknown as StatusEntry).to === 'removed')).toBe(false)
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('keeps it for a sibling still moving, and the last plan off takes it back', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    await writePlan(repo, 'auth-refresh-plan-2')
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    expect((await repo.cli(['abandon', 'auth-refresh-plan-2'])).code).toBe(0)
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeDefined()
    expect((await repo.cli(['check'])).code).toBe(0)
    const last = await repo.cli(['abandon', 'auth-refresh-plan-1'])
    expect(last.code).toBe(0)
    expect(last.stdout).toContain('reverted: auth-refresh (delete)')
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeUndefined()
    expect((await repo.cli(['check'])).code).toBe(0)       // both plans finished: their parent lives in the journal
  })

  it('a kept spec dangles no depends edge, so dependents do not refuse the abandon', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }], depends: ['auth-refresh'] })
    await writePlan(repo, 'auth-refresh-plan-1')
    await writePlan(repo, 'auth-refresh-plan-2')
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')
    const r = await repo.cli(['abandon', 'auth-refresh-plan-2'])
    expect(r.code).toBe(0)
    expect(r.stdout + r.stderr).not.toContain('waiting-dependents')
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeDefined()
  })

  it('abandon <effort> refuses while another effort\'s plan still builds on its spec, then takes it back', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')                  // created by auth-hardening
    approve(repo, 'auth-refresh')
    await recapEffort(repo, 'auth-followup')
    expect((await writePlan(repo, 'auth-refresh-plan-1', {}, PLAN_BODY, 'auth-followup')).code).toBe(0)
    const held = await repo.cli(['abandon', 'auth-hardening'])
    expect(held.code).toBe(2)
    expect(held.stdout + held.stderr).toContain('still-standing')
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeDefined()
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)   // its effort never wrote the spec: nothing unwinds
    expect((await repo.cli(['abandon', 'auth-hardening'])).code).toBe(0)
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeUndefined()      // nothing stands now: the unwind runs
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('abandon <effort> keeps for good a spec another effort\'s plan shipped', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await recapEffort(repo, 'auth-followup')
    expect((await writePlan(repo, 'auth-refresh-plan-1', {}, PLAN_BODY, 'auth-followup')).code).toBe(0)
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('kept: auth-refresh — not unwound · still standing on it: auth-refresh-plan-1')
    expect(findById(loadCanon(repo.root), 'auth-refresh')!.meta.status).toBe('live')
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('the restore keeps an amendment a sibling already shipped', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })   // live v1, shipped before this effort
    await writeSpec(repo, 'auth-refresh', { summary: 'amended by this effort' })   // v2
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    await writePlan(repo, 'auth-refresh-plan-2')           // both derived from v2
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')                        // v2 shipped by plan-1
    const r = await repo.cli(['abandon', 'auth-refresh-plan-2'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('kept: auth-refresh — not unwound · still standing on it: auth-refresh-plan-1')
    expect(String(findById(loadCanon(repo.root), 'auth-refresh')!.meta.summary)).toBe('amended by this effort')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/abandon.test.ts -t "keeps content"`
Expected: all six FAIL.
- Tests 1, 2 and 5: the spec is deleted, with no `kept:` line.
- Test 3: exit 2 with `waiting-dependents`.
- Test 4: the first effort abandon succeeds instead of refusing.
- Test 6: the summary is restored to v1.

- [ ] **Step 3: The keep (`src/abandon.ts`)**

(a) Replace `import { findById, type Canon, type CanonDoc } from './scan.js'` with:

```ts
import { findById, plansOn, type Canon, type CanonDoc } from './scan.js'
```

(b) Directly after the `SpecRevert` type (as Task 3 left it):

```ts
export type SpecRevert =
  | { doc: CanonDoc; action: 'restore'; content: string; toStatus: string; design?: { rel: string; prior: Buffer | undefined } }
  | { doc: CanonDoc; action: 'delete'; departure: Departure }
```

add:

```ts

// D166. The unwind that does not happen. Abandoning a plan takes back the spec content it was
// paired with — the whole spec when its effort created it (row 29), else the amendment. But a
// sibling derived from the same version either shipped it (taking it back makes canon forget
// built behavior) or is still building it (taking it back strands that plan — issue #34's
// shape). So the content stays while anything stands on it, and the caller says why.
// `shipped` is what makes a keep permanent; without it, the writing effort's next abandon is
// what takes the content back. A separate result rather than a third SpecRevert arm, so
// executeAbandon can never take a keep for a delete.
export interface SpecKeep { doc: CanonDoc; action: 'keep'; standing: string[]; shipped: boolean }

export const keptLine = (k: SpecKeep): string =>
  `${String(k.doc.meta.id)} — not unwound · still standing on it: ${k.standing.join(' ')}`
```

(c) Replace `): Result<SpecRevert | undefined> {` with:

```ts
): Result<SpecRevert | SpecKeep | undefined> {
```

(d) Replace:

```ts
      'abandon newest-first: a later amendment touched this spec')])
  }
  const commit = pinCommit(root, spec.rel, pin)
```

with:

```ts
      'abandon newest-first: a later amendment touched this spec')])
  }
  // D166. After "newest-first" (row 84 stands) and ahead of every precondition of the unwind
  // itself — a resolvable pin, no waiting dependents — because a kept spec unwinds nothing and
  // dangles nothing. Same pin in both branches: the siblings a delete would orphan were all
  // derived from the content it removes, and a restore moves toward older pins.
  const standing = plansOn(canon, String(spec.meta.id), { exclude: abandonSet, pin })
  if (standing.length > 0) {
    return ok({
      doc: spec, action: 'keep', standing: standing.map((p) => String(p.meta.id)),
      shipped: standing.some((p) => String(p.meta.status) === 'done'),
    })
  }
  const commit = pinCommit(root, spec.rel, pin)
```

(e) Replace:

```ts
export interface AbandonItem {
  planStamp?: PreparedStamp
  planId?: string
  revert?: SpecRevert
}
```

with:

```ts
export interface AbandonItem {
  planStamp?: PreparedStamp
  planId?: string
  revert?: SpecRevert
  kept?: SpecKeep
}
```

(f) In `planItems`, replace:

```ts
    if (parent) {
      const revertR = specRevertFor(root, canon, parent, String(plan.meta['derives-from']), abandonSet)
      if (!revertR.ok) return revertR
      item.revert = revertR.value
    }
```

with:

```ts
    if (parent) {
      const revertR = specRevertFor(root, canon, parent, String(plan.meta['derives-from']), abandonSet)
      if (!revertR.ok) return revertR
      const outcome = revertR.value
      if (outcome?.action === 'keep') item.kept = outcome
      else item.revert = outcome
    }
```

- [ ] **Step 4: Route and print the keep, and refuse a keep the effort's last act could not discharge (`src/verbs/abandon.ts`)**

(a) Line 10 — replace:

```ts
import { executeAbandon, planItems, specRevertFor, type AbandonItem } from '../abandon.js'
```

with:

```ts
import { executeAbandon, keptLine, planItems, specRevertFor, type AbandonItem, type SpecKeep } from '../abandon.js'
```

(b) Plan path: after the existing `reverted:` block (lines 30-32) and before `return EXIT.OK` (line 33), add:

```ts
    if (itemR.value.kept) ctx.out(kv('kept', keptLine(itemR.value.kept)))
```

(c) Effort path: after `const problems: Violation[] = []` (line 42), add:

```ts
    const kept: SpecKeep[] = []
```

Replace line 63:

```ts
      if (revertR.value) items.push({ revert: revertR.value })
```

with:

```ts
      const outcome = revertR.value
      if (outcome?.action === 'keep') {
        // D166. This abandon is the effort's last act, so a keep here must be one nothing has
        // to take back later: a shipped plan makes it so — canon describes built behavior. A
        // plan of another effort still building on the spec would leave it owned by no one and
        // removable by no verb, so that case refuses until the plan finishes or goes.
        if (!outcome.shipped) {
          problems.push(v('spec', 'still-standing', `${id}: ${outcome.standing.join(' ')}`,
            'those finished or withdrawn first — this abandon is the last act that could take the spec back'))
          continue
        }
        kept.push(outcome)
      } else if (outcome) items.push({ revert: outcome })
```

After the effort path's `ctx.out(kv('abandoned', …))` line (line 68) and before its `return EXIT.OK` (line 69), add:

```ts
    for (const k of kept) ctx.out(kv('kept', keptLine(k)))
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm vitest run tests/abandon.test.ts tests/check.test.ts tests/reslice.test.ts`
Expected: PASS — the six keep tests and every pre-existing abandon test. A lone plan still unwinds, and its dependents and stacked-amendment refusals still fire.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm run typecheck` (expected exit 0).

```bash
git add src/abandon.ts src/verbs/abandon.ts tests/abandon.test.ts
git commit -F - <<'EOF'
fix(abandon): the unwind keeps content another plan stands on (D166)

Abandoning a plan takes back the spec content it was paired with, and
neither branch asked whether another plan stood on it: abandoning the
second plan of a never-amended spec deleted it after the first had
shipped it, abandoning a sibling of a shipped amendment restored over
it, and abandon <effort> deleted specs another effort was building.

specRevertFor now keeps the content while any plan outside the abandon
set, not abandoned, was derived from it -- delete and restore alike --
after newest-first and before every precondition of the unwind. Both
paths print kept:. An effort's abandon is its last act, so there a keep
is allowed only when a standing plan shipped the content; otherwise it
refuses still-standing until that plan finishes or goes, instead of
leaving a spec no verb could remove.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: A re-sliced spec's open obligations follow its successor

**Files:**
- Modify:
  - `src/deferral.ts:2` and the end of the file
  - `src/stamp.ts:5, 92-95`
  - `src/verbs/write.ts` (the `departure` import, the `reslice` declaration, the re-slice construction, the files and transaction, all as Tasks 3 and 4 left them)
- Test: `tests/deferral.test.ts`

**Interfaces:**
- Consumes: Task 1 (several lines on one stream recover), Task 3 (`Departure`).
- Produces: `export function deferralMoves(entries: Entry[], from: string, to: string, which?: (d: DeferralEntry) => boolean): Array<{ stream: string; entry: { t: EntryType; [k: string]: unknown } }>`. Task 7 uses `which`.

- [ ] **Step 1: Write the failing test**

Append at the end of `tests/deferral.test.ts`:

```ts
// D166. D122 moved a debt to the parent spec "which outlives it" — and a re-slice is the one
// event that ends the spec instead. The debt follows the content to the successor.
describe('an obligation follows its spec to the successor (D166)', () => {
  it('re-books onto the successor when its spec is re-sliced', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    const id = (readStream(repo.root, 'auth-refresh-plan-1')
      .find((e) => e.t === 'deferral') as unknown as DeferralEntry).id
    repo.setMeta('auth-refresh-plan-1', { status: 'in-progress', pr: 9 })
    const scenario = fakeScenario()
    ghState(scenario, 9, 'MERGED')
    await repo.cli(['status'], { env: gateEnv(scenario) })            // merge: plan done, debt → auth-refresh
    expect((await writeSpec(repo, 'setup-card', {
      supersedes: 'auth-refresh', criteria: [{ id: 'ac-setup', test: '@spec:setup-card' }],
    })).code).toBe(0)
    const old = readStream(repo.root, 'auth-refresh')
    expect(old.some((e) => e.t === 'deferral-moved' && e.id === id && e.to === 'setup-card')).toBe(true)
    expect(openDeferrals(old)).toHaveLength(0)
    const moved = readStream(repo.root, 'setup-card').find((e) => e.t === 'deferral' && e.id === id)
    expect(moved).toMatchObject({ artifact: 'setup-card', moved_from: 'auth-refresh' })
    const s = await repo.cli(['status'])
    expect(s.stdout).toContain(id)
    expect(s.stdout).toContain('moved from auth-refresh')
    expect((await repo.cli(['check'])).stdout).not.toContain('stranded-deferral')
  })
})
```

Run: `pnpm vitest run tests/deferral.test.ts -t successor`
Expected: FAIL — no `deferral-moved` entry on the superseded stream.

- [ ] **Step 2: One rule for a debt changing homes (`src/deferral.ts`)**

Replace `import type { Entry } from './journal.js'` with:

```ts
import type { Entry, EntryType } from './journal.js'
```

Append at the end of the file:

```ts

// D122 + D166. A debt changes homes when the artifact holding it stops being the one the next
// effort will meet: a plan's merge hands its open obligations to the parent spec (stamp.ts), a
// re-slice hands the superseded spec's to its successor (write.ts), and taking a re-slice back
// hands them home again (departure.ts, `which` picking the ones that came from there). One
// rule for all three: the id is preserved, because age is measured across the move, and the
// old stream records where each debt went.
export function deferralMoves(
  entries: Entry[], from: string, to: string, which: (d: DeferralEntry) => boolean = () => true,
): Array<{ stream: string; entry: { t: EntryType; [k: string]: unknown } }> {
  return openDeferrals(entries).filter(which).flatMap((d) => [
    { stream: from, entry: { v: 1 as const, t: 'deferral-moved' as const, id: d.id, to } },
    { stream: to, entry: { ...d, artifact: to, moved_from: from } },
  ])
}
```

- [ ] **Step 3: The merge stamp uses it (`src/stamp.ts`, no behavior change)**

Replace `import { openDeferrals } from './deferral.js'` with:

```ts
import { deferralMoves } from './deferral.js'
```

Replace lines 92-95:

```ts
    const moves = parentId === undefined ? [] : openDeferrals(readStream(root, planId)).flatMap((d) => [
      { stream: planId, entry: { v: 1 as const, t: 'deferral-moved' as const, id: d.id, to: parentId } },
      { stream: parentId, entry: { ...d, artifact: parentId, moved_from: planId } },
    ])
```

with:

```ts
    const moves = parentId === undefined ? [] : deferralMoves(readStream(root, planId), planId, parentId)
```

- [ ] **Step 4: The re-slice moves the debts (`src/verbs/write.ts`)**

(a) Replace `import { canonExit, prepareDeparture, type Departure } from '../departure.js'` with:

```ts
import { deferralMoves } from '../deferral.js'
import { canonExit, prepareDeparture, type Departure } from '../departure.js'
```

(b) Replace `    let reslice: Departure | undefined` with:

```ts
    let reslice: Departure | undefined
    let moves: ReturnType<typeof deferralMoves> = []
```

(c) Replace (as Task 3 left it):

```ts
        reslice = prepareDeparture(root, cfg.value.paths, target, {
          v: 1, t: 'status', artifact: supersedes, from: String(target.meta.status),
          to: 'superseded', cause: 'supersede', by: id!,
        })
```

with:

```ts
        reslice = prepareDeparture(root, cfg.value.paths, target, {
          v: 1, t: 'status', artifact: supersedes, from: String(target.meta.status),
          to: 'superseded', cause: 'supersede', by: id!,
        })
        // D166. The superseded spec's open obligations follow its content to the successor —
        // D122's rule, whose premise ("the parent spec, which outlives it") the re-slice ends.
        // A split's later slices find the stream already settled, so its debts go to the first.
        moves = deferralMoves(readStream(root, supersedes), supersedes, id!)
```

(d) Replace (as Task 3 left it):

```ts
    const files = [rel, stream, ...(reslice?.files ?? [])]
    const res = withTxn(root, {
      op: `write(${id})`, files, journal: { stream: effort, line },
      ...(reslice ? { journalMulti: [{ stream: reslice.entry.artifact, line: entryLine(reslice.entry as unknown as { t: 'status'; [k: string]: unknown }) }] } : {}),
    }, () => {
      writeDoc(join(root, rel), { meta: built.meta, body })
      crashPoint(ctx.env, 'artifact-write')
      if (reslice) {
        reslice.remove()
        appendEntry(root, reslice.entry.artifact, reslice.entry as unknown as { t: 'status'; [k: string]: unknown })
        crashPoint(ctx.env, 'reslice-commit')
      }
```

with:

```ts
    const files = [rel, stream, ...(reslice?.files ?? []), ...(moves.length > 0 ? [journalRel(id!)] : [])]
    const res = withTxn(root, {
      op: `write(${id})`, files, journal: { stream: effort, line },
      ...(reslice ? { journalMulti: [
        { stream: reslice.entry.artifact, line: entryLine(reslice.entry as unknown as { t: 'status'; [k: string]: unknown }) },
        ...moves.map((m) => ({ stream: m.stream, line: entryLine(m.entry) })),
      ] } : {}),
    }, () => {
      writeDoc(join(root, rel), { meta: built.meta, body })
      crashPoint(ctx.env, 'artifact-write')
      if (reslice) {
        reslice.remove()
        appendEntry(root, reslice.entry.artifact, reslice.entry as unknown as { t: 'status'; [k: string]: unknown })
        for (const m of moves) appendEntry(root, m.stream, m.entry)
        crashPoint(ctx.env, 'reslice-commit')
      }
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run tests/deferral.test.ts tests/stamp.test.ts tests/reslice.test.ts tests/txn.test.ts`
Expected: PASS — the new test, plus the existing re-book and preserve-the-id tests through `deferralMoves`.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm run typecheck` (expected exit 0).

```bash
git add src/deferral.ts src/stamp.ts src/verbs/write.ts tests/deferral.test.ts
git commit -F - <<'EOF'
fix(write): a re-sliced spec's open obligations follow its successor (D166)

D122 moves a merged plan's open deferrals to the parent spec, "which
outlives it". A re-slice is the one event that ends the spec instead,
and the debts stayed open on its departed stream, which status never
read: they dropped out of the ledger silently. The re-slice now moves
them to the successor in the same state commit, through the one rule
the merge stamp also uses (deferralMoves): the id is preserved and the
old stream records where each went.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: The way back — taking back a re-slice brings its predecessor back

**Files:**
- Modify:
  - `src/departure.ts` (imports; `Return`, `prepareReturns`)
  - `src/abandon.ts` (imports; `SpecRevert`; `specRevertFor` after the pin; the delete and restore results; `executeAbandon`)
- Test: `tests/reslice.test.ts`

**Interfaces:**
- Consumes:
  - `gitBlob` and `SpecRevert` (Task 3);
  - `plansOn` and `SpecKeep` (Tasks 4, 5);
  - `deferralMoves(…, which)` (Task 6);
  - `landedJournal` recovery (Task 1): a return writes several lines to two streams.
- Produces, in `src/departure.ts`:
  - `export interface Return { entry: StatusEntry; files: string[]; restore: () => void; moves: Array<{ stream: string; entry: { t: EntryType; [k: string]: unknown } }> }`
  - `export function prepareReturns(root: string, paths: CanonPaths, commit: string, successor: string): Return[]`
- `SpecRevert`'s two arms gain `returns: Return[]`.

- [ ] **Step 1: Write the failing tests**

`tests/reslice.test.ts` — replace line 4:

```ts
import { readStream, streamExists } from '../src/journal.js'
```

with:

```ts
import { openDeferrals } from '../src/deferral.js'
import { appendEntry, readStream, streamExists } from '../src/journal.js'
```

Append at the end of the file:

```ts
// D166. Row 29 unwinds a write by selectively reverting its state commit, and a re-slice's
// commit also deleted the predecessor. Taking that write back brings the predecessor back —
// whole, or not at all while another slice of the same re-slice still stands.
describe('the way back (D166)', () => {
  it('abandoning the effort that re-sliced a shipped spec brings the spec back, debts and all', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })   // live
    repo.effort = 'bootstrap'
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'done')                     // shipped
    repo.effort = 'auth-hardening'
    appendEntry(repo.root, 'auth-refresh', {
      t: 'deferral', id: 'd-0000cafe', artifact: 'auth-refresh', gate: 'ship', round: 1,
      anchor: 'auth-refresh > ## Behavior', kind: 'artifact-debt', caused_by_run: 'r-1',
    })
    repo.git('add', '.witness/journal/auth-refresh.jsonl')
    repo.git('commit', '-q', '-m', 'an open obligation on the shipped spec', '-m', 'Witness-State: 1')
    const before = repo.read('specs/auth-refresh.md')
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
    expect((await repo.cli(['abandon', 'auth-hardening'])).code).toBe(0)
    const canon = loadCanon(repo.root)
    expect(findById(canon, 'setup-card')).toBeUndefined()
    expect(findById(canon, 'auth-refresh')!.meta.status).toBe('live')          // shipped content is described again
    expect(repo.read('specs/auth-refresh.md')).toBe(before)                    // byte for byte
    expect(openDeferrals(readStream(repo.root, 'auth-refresh')).map((d) => d.id)).toEqual(['d-0000cafe'])
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('abandoning the only plan of the only successor brings the spec back too', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
    approve(repo, 'setup-card')
    expect((await writePlan(repo, 'setup-card-plan-1', {
      parent: 'setup-card', steps: [{ id: 's1', title: 'card', criteria: ['ac-setup'] }],
    })).code).toBe(0)
    expect((await repo.cli(['abandon', 'setup-card-plan-1'])).code).toBe(0)
    const canon = loadCanon(repo.root)
    expect(findById(canon, 'setup-card')).toBeUndefined()
    expect(findById(canon, 'auth-refresh')!.meta.status).toBe('live')
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('taking back a split brings the spec back once, with every slice gone', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
    expect((await writeSpec(repo, 'setup-email', {
      supersedes: 'auth-refresh', criteria: [{ id: 'ac-email', test: '@spec:setup-email' }],
    })).code).toBe(0)
    expect((await repo.cli(['abandon', 'auth-hardening'])).code).toBe(0)
    const canon = loadCanon(repo.root)
    expect(findById(canon, 'setup-card')).toBeUndefined()
    expect(findById(canon, 'setup-email')).toBeUndefined()
    expect(findById(canon, 'auth-refresh')!.meta.status).toBe('live')
    expect(readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'status' && e.from === 'superseded')).toHaveLength(1)
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('one slice of a split is kept while another still stands — the split goes back whole', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
    expect((await writeSpec(repo, 'setup-email', {
      supersedes: 'auth-refresh', criteria: [{ id: 'ac-email', test: '@spec:setup-email' }],
    })).code).toBe(0)
    approve(repo, 'setup-card')
    expect((await writePlan(repo, 'setup-card-plan-1', {
      parent: 'setup-card', steps: [{ id: 's1', title: 'card', criteria: ['ac-setup'] }],
    })).code).toBe(0)
    const r = await repo.cli(['abandon', 'setup-card-plan-1'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('kept: setup-card — not unwound · still standing on it: setup-email')
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeUndefined()      // half a split is not taken back
    expect((await repo.cli(['abandon', 'auth-hardening'])).code).toBe(0)        // the effort takes it back whole
    expect(findById(loadCanon(repo.root), 'auth-refresh')!.meta.status).toBe('live')
  })
})
```

Run: `pnpm vitest run tests/reslice.test.ts -t "way back"`
Expected: all four FAIL.
- Tests 1–3: `auth-refresh` stays departed, so `findById(…)!` is undefined.
- Test 4: the slice is deleted, with no `kept:` line.

- [ ] **Step 2: The way back (`src/departure.ts`)**

Replace the import block (as Task 3 left it):

```ts
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonPaths } from './config.js'
import { designRel } from './design.js'
import { journalRel, readStream, type Entry, type StatusEntry } from './journal.js'
import { findById, type Canon, type CanonDoc } from './scan.js'
```

with:

```ts
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonPaths } from './config.js'
import { deferralMoves } from './deferral.js'
import { designRel } from './design.js'
import { splitDoc } from './fm.js'
import { gitBlob, tryGit } from './gitio.js'
import { journalRel, readStream, type Entry, type EntryType, type StatusEntry } from './journal.js'
import { findById, type Canon, type CanonDoc } from './scan.js'
```

Append at the end of the file:

```ts

export interface Return {
  entry: StatusEntry      // superseded → the status it left with, cause abandon: the departure ends
  files: string[]         // its spec file, its design when it had one, its stream
  restore: () => void     // writes the departed bytes back
  moves: Array<{ stream: string; entry: { t: EntryType; [k: string]: unknown } }>   // its debts, home again
}

// The way back. Row 29 unwinds a write by selectively reverting its state commit, and a
// re-slice's commit did two things: it wrote the successor and departed its predecessor.
// Taking that write back therefore brings the predecessor back — its file and design as they
// stood before the commit, byte for byte, a status entry that ends the departure, and the
// obligations that had followed it to the successor. Without this, abandoning the effort that
// re-sliced a shipped spec left canon describing none of what had shipped, under an id no
// verb could use again.
export function prepareReturns(root: string, paths: CanonPaths, commit: string, successor: string): Return[] {
  const shown = tryGit(root, 'show', '--no-renames', '--name-status', '--format=', commit)
  if (!shown.ok) return []
  const deleted = shown.out.split('\n').filter((l) => l.startsWith('D\t')).map((l) => l.slice(2))
  return deleted.flatMap((rel): Return[] => {
    if (!rel.startsWith(`${paths.specs}/`) || !rel.endsWith('.md')) return []
    const blob = gitBlob(root, `${commit}^`, rel)
    if (blob === undefined) return []
    const parsed = splitDoc(blob.toString('utf8'))
    if (!parsed.ok) return []
    const id = String(parsed.value.meta.id)
    const exit = canonExit(readStream(root, id))
    if (exit?.to !== 'superseded' || exit.by !== successor) return []
    const design = designRel(paths, id)
    const designBlob = deleted.includes(design) ? gitBlob(root, `${commit}^`, design) : undefined
    return [{
      entry: { v: 1, t: 'status', artifact: id, from: 'superseded', to: exit.from, cause: 'abandon' },
      files: [rel, ...(designBlob === undefined ? [] : [design]), journalRel(id)],
      restore: () => {
        writeFileSync(join(root, rel), blob)
        if (designBlob !== undefined) writeFileSync(join(root, design), designBlob)
      },
      moves: deferralMoves(readStream(root, successor), successor, id, (d) => d.moved_from === id),
    }]
  })
}
```

- [ ] **Step 3: The unwind takes the way back (`src/abandon.ts`)**

(a) Replace `import { prepareDeparture, type Departure } from './departure.js'` with:

```ts
import { prepareDeparture, prepareReturns, type Departure, type Return } from './departure.js'
```

(b) Replace `import { appendEntry, entryLine, journalRel, type StatusEntry } from './journal.js'` with:

```ts
import { appendEntry, entryLine, journalRel, type EntryType, type StatusEntry } from './journal.js'
```

(c) Replace (as Task 3 left it):

```ts
export type SpecRevert =
  | { doc: CanonDoc; action: 'restore'; content: string; toStatus: string; design?: { rel: string; prior: Buffer | undefined } }
  | { doc: CanonDoc; action: 'delete'; departure: Departure }
```

with:

```ts
export type SpecRevert =
  | { doc: CanonDoc; action: 'restore'; content: string; toStatus: string; design?: { rel: string; prior: Buffer | undefined }; returns: Return[] }
  | { doc: CanonDoc; action: 'delete'; departure: Departure; returns: Return[] }
```

(d) Replace:

```ts
  const prior = tryGit(root, 'show', `${commit}^:${spec.rel}`)
```

with:

```ts
  // D166. The way back: the write being taken back may have departed a predecessor (a
  // re-slice), which then returns with it. A re-slice can cut one spec into several slices, and
  // taking back one while another still stands would leave the predecessor half-described, so
  // that write is kept until its siblings go too — together, through the effort that made them.
  const returns = prepareReturns(root, canon.paths, commit, String(spec.meta.id))
  const slices = returns.flatMap((r) => canon.docs
    .filter((d) => d.meta.type === 'spec' && d.meta.supersedes === r.entry.artifact && String(d.meta.id) !== String(spec.meta.id))
    .filter((d) => !abandonSet.has(String(d.meta.id)))
    .map((d) => String(d.meta.id)))
  if (slices.length > 0) return ok({ doc: spec, action: 'keep', standing: slices, shipped: false })
  const prior = tryGit(root, 'show', `${commit}^:${spec.rel}`)
```

(e) Replace `      doc: spec, action: 'delete',` with:

```ts
      doc: spec, action: 'delete', returns,
```

(f) Replace `  return ok({ doc: spec, action: 'restore', content: prior.out, toStatus, design })` with:

```ts
  return ok({ doc: spec, action: 'restore', content: prior.out, toStatus, design, returns })
```

(g) In `executeAbandon`, replace:

```ts
  const specEntries: Array<{ stream: string; entry: StatusEntry }> = []
```

with:

```ts
  const specEntries: Array<{ stream: string; entry: StatusEntry }> = []
  const returnEntries: Array<{ stream: string; entry: { t: EntryType; [k: string]: unknown } }> = []
```

(h) Replace (as Task 3 left it):

```ts
      journalMulti.push({ stream: id, line: entryLine(entry as unknown as { t: 'status'; [k: string]: unknown }) })
    }
```

with:

```ts
      journalMulti.push({ stream: id, line: entryLine(entry as unknown as { t: 'status'; [k: string]: unknown }) })
      // D166. A spec this write had departed comes back in the same state commit.
      for (const r of item.revert.returns) {
        const lines = [{ stream: r.entry.artifact, entry: r.entry as unknown as { t: EntryType; [k: string]: unknown } }, ...r.moves]
        for (const f of r.files) files.add(f)
        for (const l of lines) {
          files.add(journalRel(l.stream))
          journalMulti.push({ stream: l.stream, line: entryLine(l.entry) })
        }
        returnEntries.push(...lines)
      }
    }
```

(i) Inside the transaction, replace:

```ts
            else if (d !== undefined && existsSync(join(root, d.rel))) unlinkSync(join(root, d.rel))
          }
```

with:

```ts
            else if (d !== undefined && existsSync(join(root, d.rel))) unlinkSync(join(root, d.rel))
          }
          for (const r of item.revert.returns) r.restore()
```

and replace:

```ts
      for (const se of specEntries) appendEntry(root, se.stream, se.entry as unknown as { t: 'status'; [k: string]: unknown })
```

with:

```ts
      for (const se of specEntries) appendEntry(root, se.stream, se.entry as unknown as { t: 'status'; [k: string]: unknown })
      for (const re of returnEntries) appendEntry(root, re.stream, re.entry)
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run tests/reslice.test.ts tests/abandon.test.ts tests/check.test.ts tests/deferral.test.ts tests/txn.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm run typecheck` (expected exit 0).

```bash
git add src/departure.ts src/abandon.ts tests/reslice.test.ts
git commit -F - <<'EOF'
fix(abandon): taking back a re-slice brings its predecessor back (D166)

The unwind reverted a re-slice successor's own file and nothing else,
though the re-slice's state commit had also deleted the predecessor.
Abandoning the effort that re-sliced a shipped spec therefore left
canon describing none of what had shipped, and the predecessor's id
could not be used again. prepareReturns (departure.ts) reads the
commit being taken back: a spec it departed in favour of this successor
returns -- its file and design as they stood before that commit, byte
for byte, a status entry that ends the departure, and the obligations
that had followed it. A split goes back whole: one slice is kept while
another still stands, and the effort that made them takes them back
together.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 8: An id names one artifact — and a create never lands on another's file

**Files:**
- Modify:
  - `src/departure.ts` (imports; `idRetired`)
  - `src/verbs/write.ts` (the fs and departure imports; a guard after `refuseWrite`; a guard after `rel`)
  - `src/verbs/adopt.ts:12` (import) and after the duplicate-id check
  - `plugin/skills/witness-decompose/SKILL.md:90`
- Test: `tests/reslice.test.ts`, `tests/skills.test.ts`

**Interfaces:**
- Consumes: `canonExit` (Task 2).
- Produces:
  - `export function idRetired(root: string, id: string, type: string): Violation | undefined` in `src/departure.ts`;
  - refusal rules `id-taken` (from `write` creates and from `adopt`) and `path-taken` (from `write` creates).

- [ ] **Step 1: Write the failing tests**

Append at the end of `tests/reslice.test.ts`:

```ts
// D166. An id names one artifact for the life of the repo, because its stream IS that
// artifact's history; and a create never lands on a file another doc holds.
describe('identity (D166)', () => {
  it('a superseded id is never written again', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-tokens', TOKENS_CRITERIA)
    approve(repo, 'auth-tokens')
    await writeSpec(repo, 'token-rotation', { supersedes: 'auth-tokens', ...ROTATION_CRITERIA })
    const again = await writeSpec(repo, 'auth-tokens', TOKENS_CRITERIA)
    expect(again.code).toBe(2)
    expect(again.stdout + again.stderr).toContain('id-taken')
    expect(again.stdout + again.stderr).toContain('superseded by token-rotation')
    expect(findById(loadCanon(repo.root), 'auth-tokens')).toBeUndefined()
  })

  it('adopt cannot bring a superseded id back either', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-tokens', TOKENS_CRITERIA)
    approve(repo, 'auth-tokens')
    await writeSpec(repo, 'token-rotation', { supersedes: 'auth-tokens', ...ROTATION_CRITERIA })
    repo.write('specs/auth-tokens.md', repo.git('show', 'HEAD~1:specs/auth-tokens.md') + '\n')
    repo.git('add', 'specs/auth-tokens.md')
    repo.git('commit', '-q', '-m', 'hand re-create')
    const r = await repo.cli(['adopt', 'specs/auth-tokens.md'])
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('id-taken')
  })

  it('a spec its own abandon unwound may be written again as a spec', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)   // unwound: `removed`
    expect((await writeSpec(repo, 'auth-refresh')).code).toBe(0)
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeDefined()
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('an effort\'s slug is not a free artifact id, and the refusal says whose it is', async () => {
    const repo = await seededRepo()
    const r = await writeSpec(repo, repo.effort, { criteria: [{ id: 'ac-x', test: `@spec:${repo.effort}` }] })
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('id-taken')
    expect(r.stdout + r.stderr).toContain('is an effort\'s slug')
  })

  it('witness\'s own floor stream is not a free artifact id', async () => {
    const repo = await seededRepo()
    const r = await writeSpec(repo, 'floor', { criteria: [{ id: 'ac-f', test: '@spec:floor' }] })
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('id-taken')
  })

  it('a stray stream does not hold its id — next and write cannot disagree', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    appendEntry(repo.root, 'auth-refresh-plan-1', { t: 'status', artifact: 'auth-refresh-plan-1', from: 'draft', to: 'approved', cause: 'gate-approve' })
    repo.git('rm', '-q', 'plans/auth-refresh-plan-1.md')
    repo.git('add', '-A')
    repo.git('commit', '-q', '-m', 'hand delete', '-m', 'Witness-State: 1')
    expect((await writePlan(repo, 'auth-refresh-plan-1')).code).toBe(0)
  })

  it('a create never lands on another doc\'s file — rename leaves the old path to the renamed doc', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    expect((await repo.cli(['rename', 'auth-refresh', 'token-refresh'])).code).toBe(0)
    const r = await writeSpec(repo, 'auth-refresh', { summary: 'a different spec' })
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('path-taken')
    expect(r.stdout + r.stderr).toContain('holds token-refresh')
    expect(findById(loadCanon(repo.root), 'token-refresh')).toBeDefined()
  })
})
```

`tests/skills.test.ts`: inside `describe('witness-decompose', …)`, after the D166 test Task 4 added, add:

```ts
  it('names the ids and paths a new spec cannot take (D166)', () => {
    expect(body()).toContain('id-taken');
    expect(body()).toContain('path-taken');
  });
```

Run: `pnpm vitest run tests/reslice.test.ts tests/skills.test.ts -t "identity|cannot take"`
Expected:
- **FAIL:** superseded (accepted), adopt (accepted), effort slug (accepted), floor (accepted), path-taken (overwrites `token-refresh`), and the skills pin.
- **PASS:** the unwound-spec and stray-stream tests, which are the boundaries the rule must keep.

- [ ] **Step 2: `idRetired` (`src/departure.ts`)**

Replace the import block (as Task 7 left it):

```ts
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonPaths } from './config.js'
import { deferralMoves } from './deferral.js'
import { designRel } from './design.js'
import { splitDoc } from './fm.js'
import { gitBlob, tryGit } from './gitio.js'
import { journalRel, readStream, type Entry, type EntryType, type StatusEntry } from './journal.js'
import { findById, type Canon, type CanonDoc } from './scan.js'
```

with:

```ts
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonPaths } from './config.js'
import { deferralMoves } from './deferral.js'
import { designRel } from './design.js'
import { FLOOR_STREAM } from './floor.js'
import { splitDoc } from './fm.js'
import { gitBlob, tryGit } from './gitio.js'
import { journalRel, readStream, type Entry, type EntryType, type StatusEntry } from './journal.js'
import { v, type Violation } from './refusal.js'
import { findById, type Canon, type CanonDoc } from './scan.js'
```

Append at the end of the file:

```ts

// Whether a NEW artifact may take this id. An id names one artifact for the life of the repo,
// because its stream IS that artifact's history. Three streams already belong to something
// else: a superseded spec's (a successor owns its content, and its finished plans resolve their
// parent there), an effort's, and witness's own floor pins. The one re-use is the same artifact
// again: a spec its own abandon unwound may be written again as a spec. A stream that records
// none of these — a stray, or a doc canon cannot parse — does not hold its id; the findings
// that already name it (`orphan-journal`, the parse error) are its remedy.
export function idRetired(root: string, id: string, type: string): Violation | undefined {
  if (id === FLOOR_STREAM) return v('id', 'id-taken', id, `a new id — ${id} is witness's own floor stream`)
  const entries = readStream(root, id)
  if (entries[0]?.t === 'recap') return v('id', 'id-taken', id, `a new id — ${id} is an effort's slug`)
  const exit = canonExit(entries)
  if (exit?.to === 'superseded') {
    return v('id', 'id-taken', id, `a new id — ${id} was superseded by ${exit.by ?? 'a successor'} and its stream is that spec's lineage`)
  }
  if (exit?.to === 'removed' && type !== 'spec') return v('id', 'id-taken', id, `a new id — ${id} was a spec its abandon unwound`)
  return undefined
}
```

- [ ] **Step 3: `write` and `adopt` ask it; a create never overwrites (`src/verbs/write.ts`, `src/verbs/adopt.ts`)**

`src/verbs/write.ts`:

(a) Replace `import { readFileSync } from 'node:fs'` with:

```ts
import { existsSync, readFileSync } from 'node:fs'
```

(b) Replace `import { canonExit, prepareDeparture, type Departure } from '../departure.js'` with:

```ts
import { canonExit, idRetired, prepareDeparture, type Departure } from '../departure.js'
```

(c) Directly after the `refuseWrite` definition:

```ts
    const refuseWrite = (viol: Violation[]): number => {
      journalRefusal(ctx, root, effort, id!, viol)
      renderRefusal(viol).forEach(ctx.err)
      return EXIT.REFUSED
    }
```

add:

```ts
    // D166. A create may not take an id that already names something (`idRetired` — the rule
    // `rename` applies to its target, with the one re-use of a spec its abandon unwound).
    if (existing === undefined) {
      const taken = idRetired(root, id!, String(manifest.type))
      if (taken) return refuseWrite([taken])
    }
```

(d) Directly after:

```ts
    const rel = existing ? existing.rel : `${manifest.type === 'plan' ? cfg.value.paths.plans : cfg.value.paths.specs}/${id}.md`
```

add:

```ts
    // D166. Nor land on another doc's file: `rename` moves the id and the journal but leaves the
    // path, so `specs/<old>.md` can hold the renamed doc, and a create under the old id overwrote it.
    if (existing === undefined && existsSync(join(root, rel))) {
      const holder = canon.docs.find((d) => d.rel === rel)
      return refuseWrite([v('id', 'path-taken', rel, holder
        ? `a new id — ${rel} holds ${String(holder.meta.id)}`
        : `a new id — ${rel} holds a doc canon cannot read (fix or revert it first)`)])
    }
```

`src/verbs/adopt.ts`:

(a) Replace `import { findById, findCycle, loadCanon } from '../scan.js'` with:

```ts
import { idRetired } from '../departure.js'
import { findById, findCycle, loadCanon } from '../scan.js'
```

(b) Replace:

```ts
  if (canon.docs.filter((d) => String(d.meta.id) === id).length > 1) {
    violations.push(v('id', 'duplicate-id', id, 'one doc per id'))
  }
```

with:

```ts
  if (canon.docs.filter((d) => String(d.meta.id) === id).length > 1) {
    violations.push(v('id', 'duplicate-id', id, 'one doc per id'))
  }
  // D166. Adopt runs the checks write runs: a hand-made doc may not take a retired id either.
  const taken = idRetired(root, id, String(meta.type))
  if (taken) violations.push(taken)
```

- [ ] **Step 4: The decompose skill (`plugin/skills/witness-decompose/SKILL.md:90`)**

Replace:

```markdown
- `id`: `[a-z0-9-]+`; new ids land at `specs/<id>.md` (or the repo's configured specs dir).
```

with:

```markdown
- `id`: `[a-z0-9-]+`; new ids land at `specs/<id>.md` (or the repo's configured specs dir). An id that already names something is refused `id-taken` — a superseded spec, an effort's slug, witness's `floor` — and so is a path another doc holds (`path-taken`): choose a new id.
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm vitest run tests/reslice.test.ts tests/skills.test.ts tests/abandon.test.ts tests/check.test.ts tests/write-plan.test.ts tests/adopt.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm run typecheck` (expected exit 0).

```bash
git add src/departure.ts src/verbs/write.ts src/verbs/adopt.ts plugin/skills/witness-decompose/SKILL.md tests/reslice.test.ts tests/skills.test.ts
git commit -F - <<'EOF'
fix(write): an id names one artifact, and a create never overwrites (D166)

A create -- by write or by adopt -- could land on any id whose stream
already existed. Writing a superseded id again re-bound the old spec's
finished plans and its diff base to a different spec; an effort's slug
or witness's floor stream mixed two histories in one file. idRetired
(departure.ts) is the one rule, which write and adopt both ask: those
three are taken, a spec its own abandon unwound may be written again as
a spec, and a stray stream holds no id (so next and write cannot
disagree about a plan id). Separately, a create may not land on a file
another doc holds: rename leaves the old path to the renamed doc, and a
create under the old id overwrote it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 9: The decision record

**Files:** `DESIGN.md` (exact-string edits; the lines are long)

**Interfaces:** none (documentation). State what Tasks 1–8 built, citing their files. Fold in any "Corrected while executing" change.

- [ ] **Step 1: Legend sentence.** At the end of the Decision-log intro paragraph (`DESIGN.md:308`), after `…so \`release.mjs\` exited 0 having cut nothing.`, append:

```markdown
 Row 166 (⊜) added 2026-10-19 — post-incident amendment, no grill: issue #34 found `check` red for good after a re-slice deleted the parent of a plan still in flight; the probes behind it found a spec's departure from canon implemented twice and half each time with no way back, and two adversarial passes against the plan found sixteen more defects in the same act before it was built.
```

- [ ] **Step 2: Row 166.** Insert a new line directly after row 165 (the line starting `| 165 ⊜ |`, `DESIGN.md:477`):

```markdown
| 166 ⊜ | A spec leaves canon without stranding what points at it | Fixes issue #34; amends 29, 62, 69 and 122. A spec leaves canon through exactly two verbs — the re-slice (`superseded`, naming the successor) and abandon's unwind of a spec its own effort created (`removed`) — and `src/departure.ts` is the one home for that act: how a departure is read (`canonExit`: the stream's latest status entry, when it is a departure), what leaves with the spec for both verbs (`prepareDeparture`: its file and its design), how it is taken back (`prepareReturns`), and which ids it retires (`idRetired`). **Into the departing spec:** `depends` still refuses. A plan's `parent`: the re-slice refuses `dangling-parent` while a plan still moves — in one refusal with `dangling-depends`, marked a human's decision so the reader is told to stop rather than self-repair (row 108's principle) — and a target must be a spec (`not-a-spec`); the unwind keeps content another plan stands on (`plansOn`, same pin, delete and restore alike), after "newest-first" and before every other precondition, saying so (`kept:`), and an effort's own abandon — the last act that could take its content back — refuses `still-standing` unless a standing plan shipped the content, which makes the keep permanent. **Out with it:** its design, deleted with a deleted spec and restored byte for byte with a restored one (`gitBlob`); its open obligations, to the successor (`deferralMoves`, the one rule the merge stamp shares). **Back:** taking back the write that re-sliced a spec brings the predecessor back — file, design, a status entry ending the departure, and the obligations that had followed it — unless another slice of the same re-slice still stands. **Identity:** a new artifact, by `write` or `adopt`, may not take a superseded spec's id, an effort's slug or witness's `floor` stream (`id-taken`), nor land on a path another doc holds (`path-taken`); a spec its own abandon unwound may be written again as a spec, and a stray stream holds no id. **Reading:** `check` resolves a finished plan's parent in the departed stream (a `done` plan under `removed` stays an error: that unwind deleted shipped behavior, pre-166); a plan still moving under one is `unknown-parent` naming the way out; a departed stream is lineage, not `orphan-journal` — nor is witness's own `floor` stream — unless it holds open obligations (`stranded-deferral`, naming `dismiss --cause superseded`), which `status` lists too; `write` accepts naming a spec that left canon either way, and `log --lineage` reads the same departure. The departure stays the stream's last status entry; obligation bookkeeping may still append after it. **Recovery:** `landedJournal` is the one derivation of what a crash left — `completeTxn` appends only each stream's missing tail and `recover` ranks by the same count | Probed in throwaway repos before this row was written; then two adversarial passes against the plan's patched tree — one against the recorded design, one attacking behavior — found sixteen more defects in the same act and one pre-existing data loss, every one reproduced or confirmed by reading before it was fixed here; then confirmed read-only on the reporting repo (`check`: `1 errors` → `0 errors`, every other read verb byte-identical on both known consumers). The issue reported one facet — a re-slice over an in-flight plan — and the act turned out implemented twice, half each time, with no way back: a re-slice over a draft, approved, in-progress or **done** plan, and the plainest abandon, left `check` at exit 1 for good; abandoning a sibling deleted or restored content another plan had shipped; a keep across efforts left a spec no verb could remove; the unwind left a ui spec's look in canon after the spec, or the amendment it was drawn for, was gone; a re-slice dropped the spec's open obligations off `status`; a superseded id could be written again, or adopted, re-binding finished plans and the diff base; and abandoning the effort that re-sliced a shipped spec left canon describing nothing of what had shipped, under an id no verb could reuse. Rows 29 and 62 both reasoned about the `depends` edge into a deleted spec and nothing else that points at one — and row 29's own definition, a selective revert of the state commit, already implied the way back, since a re-slice's commit deleted the predecessor too. The re-slice refuses only plans still moving, because a merge is what stamps a spec live and refusing over any plan would forbid the extraction re-slice the decompose rules prescribe for mature canon; the unwind keeps rather than refuses because a `done` sibling can never move; an effort's abandon refuses instead of keeping where no later act could take the content back. Found underneath: `recover` ranked a fully landed multi-line transaction as partial and recommended rolling it back; `rename` leaves the old path holding the renamed doc, so a create under the old id overwrote it. Residuals: a finished plan's pin under a departed parent is not re-verified — nothing reads it, and the departure never journaled the path; a split's later slices receive no debts, the first successor took them |
```

- [ ] **Step 3: Prose, Living canon (`DESIGN.md:89`).** After `dangling \`depends\` edges refuse the commit — dependents are rewritten in the re-slice.` insert:

```markdown
 A plan still moving under the superseded spec refuses it too (`dangling-parent`), a finished plan keeps its parent in the departed stream, the spec's open obligations move to the successor, the superseded id is never written again, and taking back the write that re-sliced brings the predecessor back (166).
```

- [ ] **Step 4: Prose, Abandonment (`DESIGN.md:92`).** Replace `spec/plan paths only, journal paths never` with `spec, plan and design paths only, journal paths never`. Then, after `a deleted dep would block its dependents forever.`, insert:

```markdown
 Content another plan still stands on is kept rather than unwound, and the abandon says so (`kept:`); an effort's abandon refuses instead while only another effort's moving plans stand on its content, since nothing after it could take that content back (166).
```

- [ ] **Step 5: Prose, status enum and journal (`DESIGN.md:123`, `DESIGN.md:175`).** Replace `(\`superseded\` is journal-terminal — the re-slice deletes the file)` with:

```markdown
(`superseded` is journal-terminal — the re-slice deletes the file; `removed` is the same for a spec its own effort's abandon unwound, 166)
```

and replace `Re-slicing freezes the old spec's journal;` with:

```markdown
Re-slicing freezes the old spec's journal — its departure stays the last status entry, though obligation bookkeeping may still append, and taking the re-slice back ends the departure (166);
```

- [ ] **Step 6: Open / deferred.** Insert these five bullets directly under the `## Open / deferred` heading, above the existing first bullet:

```markdown
- **`next` does not read `check`'s graph findings.** Rule A routes to `witness check` on parse and schema errors only; `unknown-parent`, `unknown-dep`, `cycle` and `pin-unresolvable` fall through to rule B's "nothing is owed" note — which is how issue #34's driving loop ended every session on `witness check`. Row 166 removes that instance; the class stays, and so does its sharpest case: a plan stranded before 166 (still moving, parent already departed) is routed by `next` into gates that refuse it, while `check` names the way out.
- **Designs a pre-166 unwind left behind are not detected.** Row 166 makes the unwind take a ui spec's design with it from now on; one already orphaned stays, and `check` does not look. Neither known consumer has one, and a finding would have no sanctioned remedy while no verb can remove a canon file with a trailer — the same gap that keeps a parked draft from being audit-clean.
- **`rename` does not rewrite other streams' references.** Found by row 166's behavior pass, pre-existing: renaming a re-slice successor moves its own stream but not its predecessor's `by:` or the `deferral-moved to:` entries that name it, so `log --lineage` loses the predecessor and the way back cannot find it. Row 166's `path-taken` closes the worse half (a create overwriting the renamed doc); rewriting cross-stream references is `rename`'s own row to write.
- **`log --lineage` follows only a split's first successor.** Pre-existing: a predecessor's departure names one `by:`, so a later slice of the same re-slice shows no predecessor. Display only — the departure, its debts and its way back key on the first successor, and a split goes back whole.
- **A plan at an older pin under a `done` newer-pin sibling cannot be abandoned directly.** Pre-existing: `stacked-amendment` refuses `abandon <plan>` and `already-done` refuses `abandon <effort>`; re-authoring the plan first, then abandoning it, works.
```

- [ ] **Step 7: Proofread and commit**

Run `grep -c '^| 166 ⊜ |' DESIGN.md`; expected `1`. Run `grep -n 'Row 166 (⊜)' DESIGN.md`; expected one hit, on line 308.

```bash
git add DESIGN.md
git commit -F - <<'EOF'
docs(design): row 166 -- a spec leaves canon without stranding what points at it

Fixes issue #34; amends rows 29, 62, 69 and 122. Records the departure
as one act with a way back (departure.ts), every reference into a
departing spec it settles, how check and status read a departure, the
recovery and rename defects found underneath, the probes and the two
adversarial passes behind it, and five residuals under Open / deferred.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 10: Verify, ship, close

**Files:** none (verification, GitHub, release).

- [ ] **Step 1: Full verification at the branch tip**

```bash
pnpm test > "$TMPDIR/witness-d166-test.log" 2>&1; grep -E 'Test Files|Tests ' "$TMPDIR/witness-d166-test.log"; grep -c AssertionError "$TMPDIR/witness-d166-test.log"
pnpm run typecheck
pnpm run build
npx biome check .
```

Expected: `Tests` reports 0 failed and `AssertionError` count is `0` (E7 records the dry-run's exact count). The other three commands exit 0. The `pnpm test` exit code and the few `[vitest-worker]: Timeout calling "onTaskUpdate"` lines are noise.

- [ ] **Step 2: Re-run the issue on the reporting repo, and diff the read verbs (read-only)**

```bash
cd ~/x/personal/fewhats.com
CI=1 WITNESS_REGISTRY=off node ~/x/personal/witness/dist/bin.js check; echo "exit=$?"
git status --short
```

Expected:
- `checks: 41 docs · … · 0 errors`, `exit=0`, with no `unknown-parent` row and no `orphan-journal` row;
- `git status --short` shows only the two pre-existing untracked files.

Then run `status`, `next`, `index` and `log --all` with the same environment, under both `main`'s build and this branch's, on fewhats.com and on `~/x/personal/know-your-customer-mvp`. Expect byte-identical output.

- [ ] **Step 3: Push and open the PR — human says go first**

```bash
git push -u origin d166-spec-departure
cat > "$TMPDIR/d166-pr.md" <<'EOF'
## Root cause

A spec leaves canon through two verbs — the re-slice (`superseded`) and abandon's unwind of a spec its own effort created (`removed`) — and each implemented that act partially and differently, guarding only the `depends` edge into the spec, with no way to take a departure back; `check` resolved every plan's parent against live canon only. So a re-slice over any plan (including a `done` one — i.e. any shipped spec) left `check` at exit 1 for good, and so did the plainest abandon. Probing the same act, then two adversarial passes against this fix, found more: abandoning a sibling deleted or restored content another plan had shipped; a keep across efforts left a spec no verb could remove; the unwind left a ui spec's design behind; a re-slice dropped the spec's open obligations off `status`; a superseded id could be written again or adopted; abandoning the effort that re-sliced a shipped spec lost it for good; and crash recovery duplicated, and mis-ranked, transactions that write several lines to one stream.

## Fix (row D166)

- `src/departure.ts` is the one home of the act: `canonExit` (read), `prepareDeparture` (what leaves with a spec), `prepareReturns` (the way back), `idRetired` (identity).
- re-slice: refuses `dangling-parent` (a human's decision, no self-repair trailer) and `not-a-spec`; moves open debts to the successor.
- abandon: keeps content another plan stands on (`kept:`); an effort's final abandon refuses `still-standing` unless the keep is permanent; the design leaves or goes back with its spec; taking back a re-slice brings the predecessor back.
- identity: `id-taken` (write and adopt) and `path-taken`; a stray stream holds no id.
- check/status: a departure is lineage; `stranded-deferral` while debts remain; `floor` is never an orphan.
- recovery: one `landedJournal` for `completeTxn` and `recover`.

## Evidence

Every facet probed before code; two adversarial passes (design, behavior) reproduced sixteen more defects, all fixed; each task red then green; all code dry-run verbatim before review. Read-only against the reporting repo with this branch's build: `0 errors`; every other read verb byte-identical on both known consumers.

Fixes #34.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
npx -y gh-axi pr create --title "fix: a spec leaves canon without stranding what points at it (D166)" --body-file "$TMPDIR/d166-pr.md"
```

Wait for CI (`ci.yml`) to go green.

- [ ] **Step 4: After merge — release 0.14.7 (human pushes the tag)**

```bash
git checkout main && git pull --ff-only
pnpm release patch
git push origin main && git push origin v0.14.7
```

- [ ] **Step 5: Upgrade the reporting consumer, skills first**

```bash
cd ~/x/personal/fewhats.com
npx skills@latest add -g -y https://registry.npmjs.org/@popovych.co/witness/-/witness-0.14.7.tgz
npx -y @popovych.co/witness@0.14.7 init --agent pi
npx -y @popovych.co/witness@0.14.7 check
```

Expected: 0 errors. Issue #34 closes when the PR merges.

---

## Verification

- [ ] `pnpm test` summary: 0 failed, 0 `AssertionError`; typecheck, build and biome clean
- [ ] Recovery never duplicates or mis-ranks a multi-line stream (Task 1)
- [ ] The issue's shape and its siblings read clean, and every stray still errors (Task 2)
- [ ] The design leaves, or goes back, with its spec (Task 3)
- [ ] The re-slice refuses a moving plan as a human's decision, and refuses non-specs (Task 4)
- [ ] Abandon keeps what other plans stand on, and its final act never strands a spec (Task 5)
- [ ] A re-sliced spec's debts reach its successor (Task 6)
- [ ] Taking back a re-slice brings its predecessor back; a split goes back whole (Task 7)
- [ ] An id names one artifact; a create never overwrites (Task 8)
- [ ] Reporting repo `0 errors`; read verbs byte-identical on both consumers (Task 10, Step 2)
- [ ] Issue #34 closed by the merged PR
