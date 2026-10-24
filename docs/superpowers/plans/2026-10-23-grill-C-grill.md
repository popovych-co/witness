# Grill Part C: the grill, drafts and the design session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Brainstorm becomes a grill. It walks the whole tree, asks plain-word questions with up to three ranked answers, explores before asking and checks before showing, then ends in a critique pass, a playback and a yes. Every settled answer goes to a local draft that a dead, rate-limited or relayed session resumes from. The design session shows up to three rendered, screenshot-checked directions before it asks which, and a design answer that changes behavior lands in the recap as a decision.

**Architecture:** Three seams.
- **One draft store behind one verb.** Drafts live in `src/drafts.ts` as `.witness/drafts/<key>.json`, never committed and never journaled. `witness draft <key> [--file <json>]` saves and reads them, keyed by what the conversation is about: `ask-<id>`, `amend-<effort>` or `design-<spec-id>`.
- **The CLI's existing readers learn drafts.**
  - `next` routes a drafted ask first, then a drafted amendment, and names a conversation's draft wherever it routes into one.
  - `recap`, `ask --withdraw`, `decide design --approve` and `design --reconfirm` end a draft.
  - `sessionActed` counts a save as an act (row 191).
- **The conversations themselves are skill prose.**
  - The brainstorm skill is rewritten as the grill.
  - The design skill gains the directions page, `design --preview`, the check, converge, author and register.
  - A behavior answer turns into a recap amendment.
  - One CLI line is fixed: decide's scope help, which prints a command that refuses today.

**Tech Stack:** TypeScript (ESM), vitest, pnpm, git; the witness CLI and its plugin skills.

**Spec:** `docs/superpowers/specs/2026-10-23-grill-design.md`: §4.4, §4.6–4.8, the C rows of §5 (stage table row 1, effort prose, 52, 72, 125, 156, 191, 197, 199, 200), the C lines of §8, and §9–§11. Read §4.4 and §4.6 before Task 1. Part A shipped as 0.22.0 (PR #50) and Part B as 0.23.0 (PR #51); this plan is re-read against both at main @ `c9baed9`.

## Builder's calls (§10 left these open)

1. **A dedicated `witness draft <key>` verb, not `recap --draft`.** `recap`'s `--amend` is a boolean whose effort lives in the file (re-probed at `c9baed9`: `recap --amend e1` refuses `bad-arguments … Unexpected argument 'e1'`), so `recap --draft --amend` could not name the draft it reads back. A design draft has no recap at all. One verb with an explicit key serves all three kinds.
2. **Drafts stay out of git three ways, each for a different reader.**
   - **`dirtyStatePaths` exempts the prefix** (row 90's precedent). This covers the CLI's own predicate (`stateCommit`, `write`, `design`, `adopt`, `recover`, `check`), so a draft never blocks state and never reads as a hand edit. Re-probed at `c9baed9`: an untracked `.witness/drafts/ask-a1.json` today makes `check` report `hand-edit-in-progress` and `ask` refuse `unrelated-dirty`.
   - **`init`'s `.gitignore` block lists it** for new repos.
   - **Every save runs `ensureExcluded`** (`src/worktree.ts:51`). That writes `.witness/drafts/` into `.git/info/exclude`, the way `start` already does for `.witness/screens/`. An existing repo's `.gitignore` predates the line (fewhats, HYC; `init` writes its block only when scaffolding, `src/verbs/init.ts:113-117`), so without this `git status` would show the draft and a human's `git add -A` would commit it (c2).
3. **A save counts as an act by carrying the saver's session hash.** The verb stores `journalStamp(ctx.env)?.session` (`src/context.ts:70`, the stamp `main` opens for every journal line) in the file, and `sessionActed` reads drafts beside the journal. A read-back is not an act. Nothing is journaled (§4.6).
4. **`next`'s line is `draft: <n> items settled · resume with witness draft <key>`.**
   - §4.6's example said "decisions settled". After Part B, "decisions" names the d-ids, and a grill also settles goals, non-goals and constraints.
   - The count is the recap items in all four lists, and the class and slices aren't items, so the word is "items", not "answers" (spec review).
   - The line names the read-back command (row 129: a rendered command runs).
5. **A design draft ends when the look is stamped:** `decide design --approve`, or `design --reconfirm` when an amended spec needs no new look. It does not end when the look registers.
   - A behavior note given at the approval stop (§7) re-opens the look after registration, and the direction and answers must still be there ("nothing is redone", §4.8).
   - The registered artifact holds the page; the draft holds the conversation.
   - `--reconfirm` stamps the look exactly as an approve does (`src/verbs/design.ts:171`), and the amend-mode session that chose it is over, so its draft ends too.
6. **`WITNESS_OPENER` no longer exists.** Row 90's config single-home work removed it; grep finds it only in DESIGN.md. `--preview` opens through `opener:` in `.witness/config.local.yaml` via `openArtifact`, exactly as `--open` does.
7. **`recap --amend` takes no value.** The design doc's `--amend <effort>` means `witness recap --amend --file <recap.json>`, with the effort named in the file. Part B fixed DESIGN.md's copies; two copies of the wrong form still ship at `c9baed9` and are fixed here: `src/verbs/decide.ts:707` and `plugin/skills/witness-brainstorm/SKILL.md:71`.
8. **`next` routes a drafted amendment.** A live effort with a readable `amend-<effort>` draft routes `witness recap --amend --file <recap.json>`, with `stage: brainstorm` and `target: <effort>`.
   - It comes after a drafted ask and before any undrafted ask: finish what you started.
   - Without it, a session that relays or dies mid-amendment hands its successor to decompose or to the design rung. Neither resumes the amendment, and decompose re-slices against the old recap (spec review).
   - **No new classification.** The line starts with `witness recap` and carries `stage: brainstorm`, so Part A's `conversationStage` (`src/verbs/next.ts:998`) already reads it as a conversation: drive sets the effort aside, `driveHasWork` holds it as the human's, and an autonomous chat's `humanAction` returns it. The effort's decompose waits for the amendment.
   - **Residual (Open / deferred):** an amendment not yet started has no draft. After `decide decompose … --revise --upstream`, `next` still routes back to decompose authoring (`authoringOwed` reads `revise-upstream` as `revise`, `src/verbs/next.ts:105`), not to the grill. The decompose skill now tells the agent how to start one (Task 6); once its first answer is saved, `next` resumes it.
   - **An amendment starts from the latest recap:** `witness draft amend-<effort>` with nothing saved prints that recap as the seed draft, with the texts and slices exact. Part B's pins hash each decision's id and text (`canonicalDecisions`, `src/decisions.ts:77`), so retyping a text would move every plan that carries it.
9. **"Every grill starts by queuing an ask" is the skill's rule, not the CLI's.** A recap without `--ask` stays valid, so seed and test recaps keep working (§4.6: `witness ask` has no gate).
10. **An unknown draft field is refused.** The draft is a resumed session's only memory, and a field dropped without a word is a lost answer.
11. **A save never drops another session's settled answer.**
    - A save over a draft whose stored `session` is a different session's refuses `draft-moved` unless the incoming draft keeps every settled item the stored one holds: the ids in goals, non-goals, constraints and decisions for a grill, and the `answers` for a design draft.
    - Two chats routed into one drafted ask, or into one look, would otherwise overwrite each other's answers.
    - A relay's fresh session reads the draft back first, so its first save is a superset and passes. A session dropping its own answer is not affected.
    - Outside a harness session there is no session to compare, so the last save wins, as before.
12. **A conversation's draft is read once, at the print site.** `conversationDraft(root, action)` sits beside `conversationStage` and maps an action to its draft key: brainstorm with an `ask:` to `ask-<id>`, brainstorm with a target to `amend-<effort>`, and design with a target to `design-<spec-id>`. The routing block prints its `draft:` line.
    - Part A gave the design session four routes into it (`--file` twice, `--open` and the gate, plus `next`'s routed gate re-run). A relayed design session lands on whichever one is next. Wiring the line into one return would leave a successor at `--open` or at the gate with no direction and no answers.
    - The ask and the amendment routes go through the same function. `NextAction` gains no field, and the autonomous chat's `humanAction` prints through the same block (Part A).
13. **A draft key refuses what its recap would.** For `ask-` and `amend-` keys the verb calls `recap`'s own `askRefusal` and `effortRefusal(…, true)`, exported for it as `next.ts` exports `resolveFlow` for drive, and re-labels the field `key`. A second copy would be a second answer to "may this recap land".
    - An `amend-` key also needs a stream that holds a recap, because the seed prints it.
    - A `design-` key needs only a canon spec, since every look the design rung routes is already a ui feature spec.

## Global Constraints

- **Witness-only.** Never modify fewhats.com or any other consumer. Task 7's differential reads a throwaway `git clone --local`.
- **Base and branch:** main @ `c9baed9` (`chore(release): 0.23.0`, after PR #51's merge `35ecd83`), on branch `grill`. Release 0.24.0 is cut by the user (`pnpm release minor`), because the classifier blocks the agent from running it.
- **Judge the suite by AssertionError count, not by exit code.** A few `onTaskUpdate` worker timeouts make vitest exit 1 even when every test is green.
- **Settling under CI.** GitHub sets `CI=true`. A test that expects `next` to settle passes `{ env: fixtureEnv() }`.
- **Drafts are never committed and never journaled.** No `stateCommit` file list ever names a path under `.witness/drafts/`.
- **DESIGN rows.** Amend in place with `**Amended by 197:**`, `**Amended by 199:**`, `**Amended by 200:**` or `**Touched by 200:**`, as Parts A and B did. Rows 197, 199 and 200 are new; insert 197 directly above Part B's 198 (`DESIGN.md:552`), and 199 and 200 after it.
- **No new config key.**
- **Copy, verbatim** (`answer(s)` is `answer` for 1 and `answers` otherwise):
  - **Save:** `draft: <key> — saved · <summary>`.
  - **Read-back:** first `draft: <key> · <summary>`, then the draft as `JSON.stringify(draft, null, 2)`.
  - **Summaries:**
    - grill: `<n> item(s) settled`, where n counts goals, non_goals, constraints and decisions, plus ` · <k> open` when `open` is non-empty;
    - design: `direction <chosen|open> · <n> answer(s) settled · page <saved|none>`;
    - an amend key with nothing saved: `draft: amend-<effort> · seeded from the latest recap`, then the recap's `effort`, `class`, `goals`, `non_goals`, `constraints`, `decisions` (when present) and `slices` as JSON.
  - **`next`:** `draft: <summary> · resume with witness draft <key>`.
  - **Refusal rules:**
    - `bad-key`, with the want `ask-<id> | amend-<effort> | design-<spec-id>`;
    - recap's own rules, field `key` (Builder's call 13): `unknown-ask`, `ask-answered` and `ask-withdrawn` (the last two remove the stale draft first); `id-taken`, `unknown-effort` and `terminal`;
    - `unknown-effort` with the want `an effort with a recap to amend`, when the stream holds no recap;
    - `unknown-spec`, with the want `a specs/ doc id`;
    - `unknown-field`, with the want `one of <allowed fields, space-separated>`;
    - `effort-mismatch`, `no-draft`, `draft-unreadable` and `input-json`;
    - `draft-moved`, with the want `this draft holds answers another session saved — read it back (witness draft <key>) and continue from it`;
    - each list's shape rule from `idTextList`.
  - **`--preview` output:**
    - `previewed: <spec-id>`
    - `path: <absolute path>`
    - `opener: <cmd>`
    - `note: a preview registers nothing — witness design <spec-id> --file <html> registers the look`
  - **decide's help line:** `help: scope itself implicated → witness recap --amend --file <recap.json> (the recap names effort <target>)`.
  - **The ground rule each skill gains,** inside "Questions you authored yourself …", whose parenthetical becomes `(the grill, the design session's questions)`: `a number there (1, 2, 3) picks that answer — never a \`witness decide\` option`.
  - **The context wording:**
    - brainstorm: `(here: the answer you are on, through its \`witness draft\` save)`;
    - design: `(here: the answer you are on, through its \`witness draft\` save — or, once the full look is authored, the look through \`witness design\` and its gate)`.
- **Reviewers.** Spawn any reviewer with model opus.

## Consumed from Part A (0.22.0, read at `c9baed9`)

Each item was checked against the shipped code.
- **`nextAsk(root): AskStatus | undefined`** (`src/ask.ts:137`) is the oldest unanswered ask. Its one caller is tier 3's rung (`src/verbs/next.ts:805`). C makes it prefer a drafted ask (Task 2).
- **`AskStatus = { id; text; state: 'unanswered' | 'answered' | 'withdrawn'; effort? }`** (`src/ask.ts:18`). There is no `parked` state.
- **`conversationStage`** (`src/verbs/next.ts:998`) is consumed unchanged by Builder's call 8's line. An earlier draft of this plan said C consumed it nowhere; the amendment route makes that wrong.
- **`humanAction(root, ctx, canon, cfg, first, outside)`** (`:1034`) walks `computeNext`. One routing block (`:1189-1194`) prints both the ladder's action and the walk's, so the drafted routes and their `draft:` line reach the autonomous chat with no change to the walk.
- **`turnEnds`** (`:1226`): a routed conversation (`human !== undefined`) keeps row 191's hand-over guard. That is what lets a draft save hand a grill over in an autonomous chat (Task 3).
- **`Aside.key0` and take-back** (`src/drive.ts:276`, `takeBack` `:403-411`):
  - **An ask.** The target-less `progressKey` is the line, the effort count, the `asks` lines and the txn (`:298-303`). A draft save moves it only when it reorders the asks: a younger ask's first draft flips the line to that ask. Drive prints `drive: taken back — untargeted work · …`, meets the ask again as a conversation and sets `-` aside under the new key, spawning nothing. Saves on the routed ask move nothing.
  - **An amendment.** Its key is its effort's: the line and the effort stream's count. A save moves nothing. The `recap --amend` that lands it grows the stream, so drive takes the effort back and meets Part B's re-armed decompose.
  - **A look.** §4.8's spec rewrite appends a `write` naming the spec to the effort stream, which moves the look's key (`inEffort`). Drive takes the look back and meets it again as a conversation, and the report names it. "Drive's report and notification say so" (§4.8) needs no C code.
- **The skills as A leaves them.**
  - Brainstorm has no autonomy section (`tests/skills.test.ts:272-275` pins that).
  - Design keeps one ``## Under `autonomy: on` `` paragraph (`SKILL.md:40-42`), which C leaves word for word.
- **`witnessDesign(repo, specId)`** (`tests/helpers.ts:299`) registers-then-shows through the noop opener, and C's tests use it.
- A's five deferred minors are not C's.

## Consumed from Part B (0.23.0, read at `c9baed9`)

- **`RecapEntry.decisions?` and `RecapDecision`** (`src/decisions.ts:13`).
  - `recap` validates `decisions` with `idTextList(…, 'd', false)` (`src/verbs/recap.ts:64`).
  - `idTextList` still lives at `src/verbs/recap.ts:28-49`; C moves it into `src/idlists.ts` and reuses it for draft shapes.
- **The amendment path, B's Builder's call 8** (`amendedSinceSettled` `src/verbs/next.ts:293`, `decomposeOwed` `:321`, `reslicing` `:856-859`):
  - **It re-arms decompose** after an amendment of an unfinished effort, even when every spec is approved, until a settling round (`passed` or `approve`) follows. `decision-coverage` then fails until a spec carries the new decision, which is how §4.8's design-born decision reaches the spec.
  - **While that decompose is owed, the design rung and the plan queue skip the effort's specs** (`resliced`), so an autonomous chat is not sent back into the look on the pre-amendment spec. B's `tests/next-scope.test.ts` test 6 pins that routing for a drive child and for the chat.
  - **A finished effort's amendment re-arms nothing** (B's residual). An amendment grill on one lands in no spec.
- **`witness read <spec-id | effort> --decisions`.** The grill's explore step and the design session's behavior check read it.
- **The skills as B leaves them:** decompose names `carries` and reads `read <effort> --decisions`; plan reads `--decisions`.
- **B's eight deferred minors are not C's,** except the one B left to C: decide's unrunnable `recap --amend <effort>` help line (Task 5).

## Line numbers: main @ `c9baed9`

Re-read after A and B. If main has moved, grep the anchor.

| File | Touch point | Lines · anchor |
| --- | --- | --- |
| `src/ask.ts` | `withdrawAsk`, `nextAsk` | `:109-134`, `:136-139` · `export function nextAsk` |
| `src/verbs/recap.ts` | `idTextList` (moves out); `effortRefusal` and `askRefusal` (exported); the commit's `res.ok` and its output | `:28-49`; `:74-82`, `:85-91`; `:167-174` |
| `src/verbs/next.ts` | tier 3's ask rung; `conversationStage`; the routing block's `ask:` line | `:802-811` · `const ask = admits(undefined) ? nextAsk(`; `:998-1003`; `:1192` |
| `src/slice.ts` | `sessionActed` and its comment | `:24-31` |
| `src/gitio.ts` | `LOCAL_STATE_FILES`, `dirtyStatePaths` | `:95-126` |
| `src/worktree.ts` | `ensureExcluded` and its list | `:51-63`, the list `:60` |
| `src/verbs/init.ts` | `GITIGNORE_BLOCK` | `:20-30` |
| `src/cli.ts` | `VERBS`; `VERB_USAGE`, its `design` entry | `:23-68`; `:73-104`, `:82` |
| `src/verbs/design.ts` | options; usage; the `--open` branch; `reconfirm`'s success | `:21-24`; `:26`; `:42`; `:182-185` |
| `src/verbs/decide.ts` | the decision's transaction and lock; the help line | `:652-668`; `:707` |
| `tests/helpers.ts` | `SKILL_GROUND_RULES` | `:673-691` |
| `tests/skills.test.ts` | brainstorm describes; row 156's floor test (kept); row 125's describe | `:26-39`; `:53-58`; `:231-246` |
| `plugin/skills/witness-brainstorm/SKILL.md` | the whole file (76 lines) | — |
| `plugin/skills/witness-design/SKILL.md` | `## When you run`; the autonomy paragraph (kept); `## The session` | `:33-38`; `:40-42`; `:57-84` |
| `plugin/skills/witness-decompose/SKILL.md` | the scope-implicated line | `:106` |
| `plugin/commands/witness.md` | the `stage: brainstorm` row; the autonomy rule naming the interview | `:38`; `:50` |
| `README.md` | A's autonomy sentence; verb rows `recap` and `design`; the State model's local list | `:236-238`; `:277`, `:287`; `:315` |
| `DESIGN.md` | stage row 1; effort prose; the Skills line; brainstorm's provenance row; the rationale trail; rows 52, 72, 125, 156, 191, 198; Open / deferred | `:28`; `:76-79`; `:206`; `:265`; `:351`; `:406`, `:426`, `:485`, `:511`, `:546`, `:552`; `:556` |
| `NOTICE.md` | brainstorm's grill-me line | `:31` |

The ground-rule bullets held through A and B, given as the affirmation bullet / the context bullet:

| Skill | Lines |
| --- | --- |
| brainstorm | `:22` / `:30` |
| decompose | `:17` / `:25` |
| plan | `:22` / `:30` |
| implement | `:22` / `:83` |
| ship | `:22` / `:30` |
| design | `:23` / `:31` |

## Review Focus

1. **A pre-0.24 consumer** (a `.gitignore` without the drafts line and an empty `.git/info/exclude`, as fewhats and HYC have). The first save leaves `git status --porcelain` empty, and `check` reports no `hand-edit-in-progress`. → Task 1.
2. **A design session relayed after it registered the look.** Its successor is routed to `--open` or to the gate, and that `next` names the draft too, so the direction and answers come back. → Task 2, `next names a look's design draft at every step`.
3. **Two chats on one drafted ask or one look** (`next` routes both into it). The second chat's first save lacks the first chat's items, so it refuses `draft-moved` and no answer is overwritten. Separate asks keep separate drafts. → Task 1, `a save never drops another session's answers`; Task 2, `an ask with a draft routes first`.
4. **A session that only reads a draft back while at its limit.** It hands nothing over and gets the opening warning instead. → Task 3.
5. **A corrupt draft file** (truncated JSON). `next` still routes the ask, with no `draft:` line and no priority. `witness draft <key>` refuses `draft-unreadable` naming the path, and a save over it succeeds. → Tasks 1 and 2.

A draft whose ask another chat answered (the file restored after that chat's recap deleted it) is still pinned, by Task 1 case 5 and Task 2 case 2. It left this list for case 2, which Part A's four design routes made more likely.

---

### Task 0: Branch, plan commit and baseline

- [ ] **Step 1:** `git switch main && git pull && git switch -c grill`. Confirm `git log --oneline -2` shows `c9baed9 chore(release): 0.23.0` above `35ecd83 Merge pull request #51`. Confirm `npm view @popovych.co/witness@0.23.0 version` prints `0.23.0`, because Task 7's differential runs it. If the publish failed (npm's OIDC publish can 401 transiently), the user re-runs the release workflow's failed job.
- [ ] **Step 2:** If main has moved past `c9baed9`, re-find the lines in the table above by their anchors.
- [ ] **Step 3: Commit this plan,** as B's branch opened with its own (`048d62c`). `git add docs/superpowers/plans/2026-10-23-grill-C-grill.md && git commit -m "docs: Part C's plan — the grill, drafts and the design session (D197)"`
- [ ] **Step 4: Baseline.** `pnpm typecheck` exits 0, and `pnpm test` shows 0 AssertionError. Note the test count; at `c9baed9` it gave 2079 passed and 8 skipped across 170 files, exiting 1 on 4 `onTaskUpdate` worker timeouts.

### Task 1: The draft store and `witness draft` (row 199)

**Files:**
- Create:
  - `src/drafts.ts` and `src/verbs/draft.ts`.
  - `src/idlists.ts`: `idTextList`, moved from `src/verbs/recap.ts:28-49` with its body unchanged. It imports only `refusal.ts`.
  - Why the move: `drafts.ts` importing `verbs/recap.ts` would close `drafts → recap → ask → drafts`, because `recap.ts` imports `ask.ts` and `ask.ts` will import `drafts.ts`.
- Modify:
  - `src/verbs/recap.ts`:
    - import `idTextList` from `../idlists.js`;
    - export `effortRefusal` and `askRefusal` (`:74-91`). Their comment names `draft` as the second reader and says a second copy would be a second answer to "may this recap land".
  - `src/gitio.ts:95-126`: add `LOCAL_STATE_DIRS = ['.witness/drafts/']` beside `LOCAL_STATE_FILES`, and `dirtyStatePaths` drops paths with that prefix. The comment names row 199 and row 90's precedent.
  - `src/worktree.ts:58-62`: the exclude list at `:60` gains `.witness/drafts/`, and the comment says drafts are local and never committed.
  - `src/verbs/init.ts:20-30`: `GITIGNORE_BLOCK` gains `.witness/drafts/`.
  - `src/cli.ts`:
    - `VERBS` gains `draft: () => import('./verbs/draft.js')`;
    - `VERB_USAGE` gains `draft: 'witness draft <ask-<id>|amend-<effort>|design-<spec-id>> [--file <json>]'`, the same string the verb prints as `'usage: …'` in single quotes (`tests/verb-usage.test.ts` extracts it with `/'usage: (witness [^']+)'/`).
- Test: create `tests/draft.test.ts`.

**Interfaces — produces:**

```ts
// src/drafts.ts — imports node:fs, node:path, worktree.ts, dsl.ts, refusal.ts and idlists.ts. Probed at c9baed9:
// that closure (config, config-file, gitio, legacy-comments, migration, pin, settings, toon, …) reaches no
// ask.ts, scan.ts or verb, so ask.ts, next.ts, slice.ts and the verbs may import this module.
export const DRAFTS_DIR = '.witness/drafts'
export type DraftKey = { kind: 'ask'; id: string } | { kind: 'amend'; effort: string } | { kind: 'design'; spec: string }
export function parseKey(key: string): DraftKey | undefined            // ask-a<n> · amend-<ID_RE> · design-<ID_RE>
export function keyName(k: DraftKey): string                            // its inverse: the file stem and the printed key
export interface StoredDraft { v: 1; key: string; session?: string; draft: Record<string, unknown> }
export function readDraft(root: string, k: DraftKey): Result<StoredDraft | undefined>   // ok(undefined) = none saved
export function saveDraft(root: string, k: DraftKey, draft: Record<string, unknown>, session: string | undefined): void
export function dropDraft(root: string, k: DraftKey): void              // absent is fine
export function draftSessions(root: string): string[]                   // the session of every readable draft
export function validateDraft(k: DraftKey, raw: unknown): Violation[]
export function settledItems(k: DraftKey, draft: Record<string, unknown>): string[]   // grill: the four lists' ids · design: answers
export function draftSummary(k: DraftKey, draft: Record<string, unknown>): string
export function draftLine(root: string, k: DraftKey): string | undefined   // `<summary> · resume with witness draft <key>`; undefined when none or unreadable
// src/verbs/recap.ts — now exported (Builder's call 13)
export function effortRefusal(root: string, effort: string, amend: boolean): Violation | undefined
export function askRefusal(root: string, id: string): Violation | undefined
```

**Rules:**
- **`saveDraft`:**
  - run `ensureExcluded(root)` first;
  - write `<key>.json.tmp`, then `renameSync` it into place, so a crash never leaves half a draft;
  - store `session` only when one is passed.
- **`validateDraft`:**
  - a value that is not a JSON object gives `v('draft', 'shape', <typeof>, 'JSON object')`.
  - **Grill keys** (`ask`, `amend`) allow `effort`, `class`, `goals`, `non_goals`, `constraints`, `decisions`, `slices` and `open`:
    - `effort` uses `ID_RE` (`id-charset`);
    - `class` is an enum (`feature | fix | chore`);
    - the four id lists use `idTextList(raw, field, g|n|c|d, false)`;
    - `slices` and `open` are lists of non-empty strings (`shape`);
    - an `amend` draft whose `effort` differs from the key's gives `effort-mismatch`.
  - **Design keys** allow `direction` (a non-empty string), `answers` and `open` (lists of non-empty strings) and `page` (a string).
  - Any other top-level field gives `unknown-field`.
- **`witness draft <key>`** (verb):
  - It runs from `primaryRoot`. It needs no lock and no txn guard: drafts are not state.
  - Every refusal about the key (`bad-key`, the referent rules, `no-draft`, `draft-unreadable`) names field `key`; a shape rule names the draft's own field.
  - `parseKey` failing refuses `bad-key`.
  - **Then the referent check (Builder's call 13), field `key`:**
    - `ask`: `askRefusal(root, id)`. For `ask-answered` or `ask-withdrawn`, `dropDraft` first, then refuse.
    - `amend`: `effortRefusal(root, effort, true)`, then `unknown-effort` when `latestRecap(root, effort)` is undefined.
    - `design`: `findById(loadCanon(root), spec)?.meta.type === 'spec'`, else `unknown-spec`.
  - **With `--file`:**
    - parse the JSON, resolved against `ctx.cwd` as `recap` does (`input-json`), then validate;
    - **the guard (Builder's call 11):** when a readable stored draft names a `session`, the saver has one (`journalStamp(ctx.env)?.session`) and the two differ, every item of `settledItems(stored)` must be in `settledItems(incoming)`, or the save refuses `draft-moved`;
    - then save and print the save line.
  - **Without `--file`:** `readDraft`.
    - **None:** for an `amend` key, print the seed from the latest recap (Builder's call 8). For other keys, refuse `no-draft` (want `a saved draft — witness draft <key> --file <json>`).
    - **An unreadable draft** refuses `draft-unreadable` (got the path, want `a draft witness wrote — save over it with --file`).
    - **Otherwise** print the read-back.

- [ ] **Step 1: Write the failing tests** in `tests/draft.test.ts`. Use `seededRepo({ noRecap: true })` and `const save = (repo, key, d, env?) => { repo.write('d.json', JSON.stringify(d)); return repo.cli(['draft', key, '--file', 'd.json'], env ? { env } : {}) }`, then `rmSync` the temp file before any `git status` check.
  1. `saves and reads back a grill draft keyed by its ask`:
     - `ask 'add dark mode'`;
     - `save(…, 'ask-a1', { goals: [{ id: 'g1', text: 'Readers can switch to a dark theme' }], decisions: [{ id: 'd1', text: 'The theme follows the OS setting first' }], open: ['who sees it first'] })` exits 0, and its stdout is `draft: ask-a1 — saved · 2 items settled · 1 open`;
     - `draft ask-a1`: line 0 is `draft: ask-a1 · 2 items settled · 1 open`, and `JSON.parse` of the remaining lines equals the saved object.
  2. `a draft is never committed, never journaled, and dirties nothing`. After a save:
     - `git status --porcelain` is `''`, HEAD is unchanged, and the `asks` stream's length is unchanged;
     - `check`'s stdout contains neither `hand-edit-in-progress` nor `.witness/drafts`;
     - a following `ask 'two'` exits 0, so its `stateCommit` was not refused.
  3. `a repo whose .gitignore predates drafts stays clean` (Review Focus 1):
     - overwrite `.gitignore` with today's block minus the drafts line and commit it, then `rmSync('.git/info/exclude', { force: true })`;
     - save; `git status --porcelain` is `''`, and `.git/info/exclude` contains `.witness/drafts/`.
  4. `the shape is checked, not completeness`. Each case exits as stated:

     | Draft saved | Exit and rule |
     | --- | --- |
     | `{}` on `ask-a1` | 0, `0 items settled` |
     | `{ goals: [{ id: 'x1', text: 'a' }] }` | 2, `id-prefix` |
     | `{ colour: 'blue' }` | 2, `unknown-field` |
     | `{ effort: 'other' }` on `amend-auth-hardening` (after a recap births `auth-hardening`) | 2, `effort-mismatch` |
     | `{ direction: '' }` on `design-auth-refresh` (after `writeSpec`) | 2 |
  5. `the key names a live referent, as its recap would`:
     - `draft nope` gives `bad-key`, `draft ask-a9` gives `unknown-ask`, `draft amend-ghost` gives `unknown-effort`, `draft design-ghost` gives `unknown-spec`, and every one of these rows names field `key`;
     - save `ask-a1`, then `recap --file … --ask a1`, then restore the file from a copy; `draft ask-a1` gives `ask-answered`, and the file is gone.
  6. `a corrupt draft is named and can be saved over` (Review Focus 5):
     - write `.witness/drafts/ask-a1.json` as `{"v":1,`;
     - `draft ask-a1` exits 2 with `draft-unreadable` and the path;
     - a save then exits 0, and the read-back works.
  7. `a save never drops another session's answers` (Review Focus 3):
     - session `S1` (`measuredEnv('S1', 10_000, 1_000_000)`) saves `ask-a1` with `g1` and `d1`;
     - session `S2` saving `{ goals: [g1] }` exits 2 with `draft-moved`;
     - `S2` saving `{ goals: [g1], decisions: [d1, d2] }` exits 0;
     - after that, `S2` saving `{ goals: [g1], decisions: [d2] }` exits 0, because a session may drop its own answers;
     - a design draft holds the same way: after `writeSpec(repo, 'auth-refresh', { ui: true })`, `S1` saves `design-auth-refresh` with `answers: ['groups first', 'no icons']`, and `S2` saving `answers: ['groups first']` exits 2 with `draft-moved`.
  8. `the exemption alone keeps a visible draft from blocking state` (code review):
     - save, then strip `.witness/drafts/` from both `.gitignore` and `.git/info/exclude`, so `git status` shows the draft untracked;
     - `check`'s stdout has no `hand-edit-in-progress`, and `ask 'two'` exits 0;
     - only `dirtyStatePaths`' prefix exemption is left to keep them clean, so this pins it. On main the same file gives both failures (re-probed).
  9. `an amendment starts from the latest recap`:
     - after `recap --file writeRecap({ slices: ['rotation'] })` births `auth-hardening`, `draft amend-auth-hardening` exits 0;
     - line 0 is `draft: amend-auth-hardening · seeded from the latest recap`;
     - the JSON's `goals` and `slices` equal the recap's, character for character, and it has no `ask`, `w` or `ctx` key;
     - no file is written.
- [ ] **Step 2: Run and see FAIL.** `pnpm exec vitest run tests/draft.test.ts tests/verb-usage.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see PASS.** Also `tests/recap.test.ts tests/gitio.test.ts tests/init.test.ts tests/worktree.test.ts tests/check.test.ts`. `pnpm typecheck` exits 0.
- [ ] **Step 5: Commit.** `git commit -am "feat: witness draft — a conversation's local draft, never committed (D199)"` (with `git add` for the new files).

### Task 2: A draft ends with its conversation, resumes first, and is named at every route into it (row 199)

**Files:**
- Modify:
  - `src/ask.ts`:
    - `nextAsk` (`:136-139`) becomes `const open = askQueue(root).filter((a) => a.state === 'unanswered'); return open.find((a) => draftLine(root, { kind: 'ask', id: a.id }) !== undefined) ?? open[0]`, so a drafted ask comes first, the oldest drafted ask among several. Its comment says so.
    - `withdrawAsk` runs `dropDraft(root, { kind: 'ask', id })` after its commit succeeds.
  - `src/verbs/recap.ts`: after the commit succeeds (`:167`), and only then, `dropDraft` `ask-<id>` when `--ask` was given and `amend-<effort>` when `--amend` was.
  - `src/verbs/next.ts`:
    - **Tier 3 (`:802-811`)** splits the ask rung around the amendment rung (Builder's call 8). Only the order is decided here, so it is given whole:

      ```ts
      const ask = admits(undefined) ? nextAsk(root) : undefined
      const grill = (a: AskStatus): NextAction =>
        ({ line: `witness recap --file <recap.json> --ask ${a.id}`, stage: 'brainstorm', ask: { id: a.id, text: a.text } })
      if (ask !== undefined && draftLine(root, { kind: 'ask', id: ask.id }) !== undefined) return grill(ask)
      const amending = efforts.find((e) => admits(e.slug) && draftLine(root, { kind: 'amend', effort: e.slug }) !== undefined)
      if (amending !== undefined) return { line: 'witness recap --amend --file <recap.json>', stage: 'brainstorm', target: amending.slug }
      if (ask !== undefined) return grill(ask)
      ```

      The amendment checks only `admits(e.slug)`: the action has a target, so a walk scoped to the effort (drive's fill, `humanAction`) still finds it. Nothing changes for efforts without a saved amend draft. The tier comment gains row 199 and "finish what you started".
    - **`conversationDraft(root, action)`** goes beside `conversationStage` (Builder's call 12).
    - **The routing block** prints `kv('draft', d)` directly after the `ask:` statement (`:1192`), when `conversationDraft` returns one.
- Test: `tests/next-ask.test.ts`, `tests/recap.test.ts`, `tests/ask.test.ts`, `tests/design-verb.test.ts`

**Interfaces — produces:**

```ts
// src/verbs/next.ts. brainstorm + ask → ask-<id>; brainstorm + target → amend-<target>; design + target → design-<target>;
// anything else → undefined. The value is draftLine's.
export function conversationDraft(root: string, action: Pick<NextAction, 'stage' | 'target' | 'ask'>): string | undefined
```

- [ ] **Step 1: Write the failing tests.**
  1. `next-ask.test.ts` › `an ask with a draft routes first and says where to resume` (Review Focus 3):
     - `ask 'one'`, `ask 'two'`, then save `ask-a2` with one goal;
     - `nextLine` contains `--ask a2`, `ask: a2 — two` and `draft: 1 item settled · resume with witness draft ask-a2`;
     - save `ask-a1` too; `next` now routes `--ask a1`, the oldest drafted ask;
     - `draft ask-a2` still reads back its own goal.
  2. `a draft whose ask was answered elsewhere is ignored`:
     - use Task 1 case 5's setup: save `ask-a1`, copy the file aside, run `recap --file … --ask a1` (which now deletes it), and restore the copy;
     - `next` does not contain `--ask a1`.
  3. `a corrupt draft neither crashes next nor jumps the queue` (Review Focus 5): `ask 'one'`, `ask 'two'`, and a corrupt `ask-a2.json`. `next` exits 0, routes `--ask a1`, and prints no `draft:` line.
  4. `recap.test.ts` › `a confirmed recap ends its draft`:
     - save `ask-a1`, then `recap --file … --ask a1`; the file is gone;
     - save `amend-auth-hardening`, then `recap --amend --file …`; the file is gone;
     - a refused recap (`slug-reuse`) leaves its draft in place.
  5. `ask.test.ts` › `withdrawing an ask ends its draft`.
  6. `next-ask.test.ts` › `a drafted amendment is resumed before an undrafted ask`:
     - `seededRepo()`, then save `amend-auth-hardening` with one decision, then `ask 'later'`;
     - `next` contains `next: witness recap --amend --file <recap.json>`, `stage: brainstorm`, `target: auth-hardening` and `draft: 1 item settled · resume with witness draft amend-auth-hardening`, and does not contain `--ask a1`;
     - after `recap --amend --file …` succeeds, `next` routes `--ask a1`.
  7. `design-verb.test.ts` › `next names a look's design draft at every step` (Review Focus 2):
     - `writeSpec(repo, 'auth-refresh', { ui: true })`, `approve`;
     - save `design-auth-refresh` as `{ direction: 'grouped list', answers: ['groups first'], page: '<!doctype html><p>x</p>' }`;
     - `const D = 'draft: direction chosen · 1 answer settled · page saved · resume with witness draft design-auth-refresh'`;
     - `next` contains `next: witness design auth-refresh --file <html>` and `D`;
     - after `writeDesign(repo, 'auth-refresh')`, `next` contains `next: witness design auth-refresh --open` and `D`;
     - after `witnessDesign(repo, 'auth-refresh')`, `next` contains `next: witness gate design auth-refresh` and `D`.
- [ ] **Step 2: Run and see FAIL.** `pnpm exec vitest run tests/next-ask.test.ts tests/recap.test.ts tests/ask.test.ts tests/design-verb.test.ts`. Tests 2 and 3 already pass before this task's code, because today's `next` reads no draft at all. Keep them as pins for the new code, which must not break them.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see PASS.** Also `tests/next-scope.test.ts tests/next.test.ts tests/next-authoring.test.ts`, which pin `next`'s output unit and Part B's re-arm. `pnpm typecheck` exits 0.
- [ ] **Step 5: Commit.** `git commit -am "feat: a drafted conversation resumes first, is named at every route into it, and ends with its recap (D199)"`

### Task 3: A draft save is an act (row 191)

**Files:**
- Modify `src/slice.ts:24-31`: `sessionActed` returns true when a journal act carries the session, as today, or when `draftSessions(root).includes(hash)`. Update its comment: a settled answer saved is stage work, and a read-back is not.
- Test: `tests/context-relay.test.ts`, new describe `a draft save is an act (row 199)`. It reuses the file's `RELAY` (`:188`), `warnAt` (`:189`) and `relays` (`:227`).

- [ ] **Step 1: Write the failing tests.** `const G = (t: number) => measuredEnv('G1', t, 1_000_000)`.
  1. `a grill hands over at its next settled answer`:
     - `seededRepo({ noRecap: true })`;
     - `ask 'add dark mode'` with `G(10_000)`; asks are bookkeeping (no `ask` in `ACT_KINDS`);
     - save `ask-a1` with `G(150_000)`;
     - `next` with `G(210_000)` contains all of: `next: witness recap --file <recap.json> --ask a1`, `draft: 1 item settled · resume with witness draft ask-a1`, `context: 21% of 1M · limit 20%` and `RELAY`.
  2. `reading a draft back is not an act` (Review Focus 4): a second session `G2` runs `draft ask-a1` at 250k. `next` with `G2(250_000)` prints no `relay:` and contains `warnAt(25)`.
  3. `an autonomous chat hands the grill over too`: as case 1, after `autonomyOn(repo)`. The output contains `RELAY` and no `launch:`, because the ask is the only work and it is the human's.
  4. `an amendment hands over mid-grill, and its successor is routed back to it`:
     - `seededRepo()`; `G` saves `amend-auth-hardening` at 150k;
     - `next` at 210k contains `next: witness recap --amend --file <recap.json>` and `RELAY`;
     - a fresh session's `next` at 10k routes the same line with its `draft:`.
- [ ] **Step 2: Run and see FAIL.** `pnpm exec vitest run tests/context-relay.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see PASS.** Also `tests/slice.test.ts tests/drive.test.ts`. Drive journals no session and saves no draft, so its no-progress check is untouched.
- [ ] **Step 5: Commit.** `git commit -am "feat: a draft save counts as an act — a grill hands over at a settled answer (D199)"`

### Task 4: `witness design --preview`, and registering the look keeps its draft (row 200)

**Files:**
- Modify `src/verbs/design.ts`:
  - **The options (`:21-24`)** gain `preview: { type: 'string' }`.
  - **The usage (`:26`)** becomes `usage: witness design <spec-id> --file <html> | --reconfirm | --open | --preview <html>`. `src/cli.ts:82`'s `VERB_USAGE.design` gets the same string.
  - **Beside the `--open` branch (`:42`),** `if (values.preview !== undefined) return previewOnly(ctx, root, specId, values.preview)`. It sits after the spec lookup and before the ui and feature checks, as `--open` does.
  - **`previewOnly`:**
    - resolve the path against `ctx.cwd`; a missing file refuses `v('--preview', 'input-unreadable', <path>, 'a readable HTML file')`;
    - `loadLocalConfig`, then `openArtifact`;
    - `failed` refuses with `opener-failed` and the `file://` path, worded as `openOnly` words it (`:83-84`);
    - otherwise print the four preview lines;
    - take no lock, journal nothing, commit nothing.
  - **`persist` leaves the design draft alone.** It ends when the look is stamped (Task 5).
- Test: `tests/design-open.test.ts`, `tests/design-verb.test.ts`

- [ ] **Step 1: Write the failing tests.** Write the page to `join(mkdtempSync(join(tmpdir(), 'pv-')), 'p.html')`, outside the repo, so `git status` stays meaningful.
  1. `--preview opens a page through the opener and records nothing`:
     - `writeLocalConfig(repo.root, { opener: noopOpener() })`;
     - the preview exits 0, and stdout contains `previewed: auth-refresh` and `opener: `;
     - HEAD is unchanged, `readStream(repo.root, 'auth-refresh')` has the same length, `designs/auth-refresh.html` does not exist, and `git status --porcelain` is `''`.
  2. `a preview the opener cannot show names its file:// path`: with opener `'/nonexistent/open'`, it exits 2, and stderr contains `opener-failed` and `file://`.
  3. `--preview refuses an unreadable page and an unknown spec`: these give `input-unreadable` and `unknown-spec`.
  4. `registering the look keeps its design draft`: save `design-auth-refresh`, then `writeDesign(repo, 'auth-refresh')`. The draft file is still there (Builder's call 5).
- [ ] **Step 2: Run and see FAIL.** `pnpm exec vitest run tests/design-open.test.ts tests/design-verb.test.ts tests/verb-usage.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see PASS.** Also `tests/design-gate-sight.test.ts tests/design-unseen.test.ts tests/design-autonomy.test.ts`. `design-shown` stays reserved for registered bytes (row 72).
- [ ] **Step 5: Commit.** `git commit -am "feat: witness design --preview opens a page and records nothing (D200)"`

### Task 5: A decision born in design, the look's draft ends when the look is stamped, and decide's scope help runs (§4.8, row 52)

**Files:**
- Modify:
  - `src/verbs/decide.ts`:
    - `:707`: the help line becomes the Global Constraints string;
    - after the decision's transaction commits and the lock is released (`:652-668`), when `gate === 'design'` and `entry.decision === 'approve'`, run `dropDraft(root, { kind: 'design', spec: target })` (Builder's call 5). This follows D154's rule at `:670`: after the decision is durable, never before.
  - `src/verbs/design.ts`: `reconfirm` runs the same `dropDraft` after its commit succeeds (`:182`).
- Test: `tests/decide.test.ts`, `tests/design-verb.test.ts`; create `tests/design-amend.test.ts`.

- [ ] **Step 1: Write the failing tests.** Gate verdicts use `fakeScenario`, `putVerdict` and `gateEnv`, as `tests/next-authoring.test.ts:49-74` does.
  1. `decide.test.ts` › `decide's scope help line is a command that runs`:
     - `seededRepo()`, `writeSpec`, then a decompose gate run, which stops on the feature scope;
     - run `decide decompose auth-hardening --revise --note "scope"`;
     - stdout contains `help: scope itself implicated → witness recap --amend --file <recap.json> (the recap names effort auth-hardening)` and does not match `/recap --amend auth-hardening/`.
  2. `design-amend.test.ts` › `a design answer that changes behavior lands in the recap, re-opens decompose, and keeps the look's draft`:
     1. `seededRepo()`, `writeSpec(repo, 'auth-refresh', { ui: true })`, `approve`.
     2. Save `design-auth-refresh` as `{ direction: 'grouped list', answers: ['groups first'], page: '<!doctype html><p>x</p>' }`.
     3. Save `amend-auth-hardening` as `{ decisions: [{ id: 'd1', text: 'Groups collapse and reorder' }] }`. `nextLine` now contains `next: witness recap --amend --file <recap.json>` and `target: auth-hardening`, ahead of the look.
     4. `recap --amend --file writeRecap({ decisions: [{ id: 'd1', text: 'Groups collapse and reorder' }] })` exits 0. The amend draft is gone, and the design draft remains.
     5. `nextLine` contains `next: witness gate decompose --effort auth-hardening` (B's re-arm).
     6. Run the gate with a clean verdict (`{ coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [] }`). It exits 1, and `decision-coverage`'s detail is `uncarried decisions: d1`. Then `decide decompose auth-hardening --revise --note "carry d1"`.
     7. `writeSpec(repo, 'auth-refresh', { ui: true, carries: ['d1'] }, '## Motivation\nTokens leak.\n\n## Behavior\nRotate before expiry. Groups collapse and reorder.\n')`, then gate again, then `decide decompose auth-hardening --approve`.
     8. `nextLine` contains `next: witness design auth-refresh --file <html>` and `draft: direction chosen · 1 answer settled · page saved · resume with witness draft design-auth-refresh`.
  3. `design-amend.test.ts` › `approving the look ends its design draft`:
     - with the draft saved, `writeDesign`, then `witnessDesign`, then the design gate on a clean verdict (`tests/design-autonomy.test.ts:5`'s `CLEAN`: `design#save-bar` and `auth-refresh > ## Behavior`), which stops, then `decide design auth-refresh --approve`;
     - the draft file is gone.
  4. `design-amend.test.ts` › `under autonomy the chat is not sent back into the look while decompose re-slices it`:
     - case 2's setup through step 4, plus `autonomyOn(repo)`;
     - `nextLine(repo, { env: fixtureEnv() })` contains no `stage: design` and no `witness design auth-refresh`;
     - Part B's re-slice skip holds the look (B pins the routing, `tests/next-scope.test.ts` test 6), and the saved design draft must not bring it back. Case 2, without autonomy, covers the look returning once decompose is re-approved.
  5. `design-verb.test.ts` › `reconfirming a look ends its design draft`:
     - `writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })`, `approve`, `writeDesign`;
     - stamp a stale look by hand, as the file's A10 test stamps a current one: `repo.setMeta('booking-form', { design: { sha: 'a'.repeat(64), spec: 'b'.repeat(64) } })`;
     - save `design-booking-form`, then `design booking-form --reconfirm` exits 0, and the draft file is gone.
- [ ] **Step 2: Run and see FAIL.** `pnpm exec vitest run tests/decide.test.ts tests/design-amend.test.ts tests/design-verb.test.ts`. Expect cases 1, 3 and 5 to fail. Cases 2 and 4 may already pass on Tasks 1–4 plus Part B; if they do, keep them as the §4.8 regression pins and say so in the commit body.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see PASS.** Same command.
- [ ] **Step 5: Commit.** `git commit -am "fix(decide): the scope help names a recap amendment that runs; a look's draft ends when it is stamped (D200)"`

### Task 6: The grill and the design session — skills, engine, README, NOTICE and DESIGN rows

**Files:**
- **`plugin/skills/witness-brainstorm/SKILL.md`, rewritten as the grill** (§4.4–§4.6). Keep every shared ground rule. The sections, in order:
  - **Frontmatter `description`:** *The grill for a witness effort — walks the whole decision tree one plain-words question per turn, each with up to three ranked answers, explores the repo before asking, saves a local draft after every settled answer, and ends in a critique pass, a playback and a confirmed recap persisted via witness recap. Normally invoked by /witness.* The NOTICE comment says grill-me (the whole tree, the recommended answer, explore instead of asking), rewritten for witness: *ends in a confirmed recap, keeps a local draft, writes no document*.
  - **`## What you produce`:** no canon, only evidence; it still says `writes no`. A local draft is never committed.
  - **`## Start`:**
    - **The ask.** Every grill starts by queuing an ask. Use `ask:` from `$WITNESS next` when it is there. When it is not, open with "what do you want to build?", run `$WITNESS ask "<their words>"`, then run `$WITNESS next` again.
    - **The key.** The key is `ask-<id>`, or `amend-<effort>` for an amendment.
    - **Resuming.** A `draft:` line means resume: read the draft back with the command it names, continue after the last settled answer, and tell the human in one line where you resume. `next` names a drafted amendment the same way, with `target:` its effort.
    - **An amendment** (a decompose stop sent back to re-interview, or a design session's behavior answer) starts from `$WITNESS draft amend-<effort>`, which prints the latest recap as the seed. Edit that seed, and never retype a text you are not changing, because a decision's text is part of its plans' pin. Once its first answer is saved, `next` resumes it ahead of the effort's other work.
  - **`## The question`:**
    - **One question per turn**, in plain words.
    - **Up to three ranked answers, in the CLI's field words.** Answer 1 is the pick, with its `why`. Answers 2 and 3 each carry `when` (better if…) and `tradeoff` (the cost). Give fewer when fewer real answers exist — never padded.
    - **How the human replies:** `y` or `1` takes the pick, `2` or `3` takes those, or they answer in their own words.
  - **`## Explore before asking, check before showing`:**
    - Anything the repo can answer — code, `witness index`, `witness read <id>`, `witness read <id> --decisions`, product docs, journals — you answer yourself, with `file:line`.
    - Every factual claim in a question is verified by a file read or a probe before the human sees it.
  - **`## The walk`:**
    - **The floor.** The recap's fields are the floor, not the count.
    - **The order, by dependency:** the problem and who has it → scope edges → behavior, including edge cases and failures → data and approach → rollout and compatibility. Skip branches the repo answers.
    - **Class.** It is inferred by today's rules and asked only when unclear.
    - **No short forms.** A fix's or a chore's tree is small, so its grill ends fast.
    - **Out of bounds:** the look (the design session) and the order of steps (the plan).
  - **`## Where each answer goes`:** goals are outcomes (`g1…`), non-goals deliberate noes (`n1…`), constraints standing limits on the whole effort (`c1…`), and decisions settled answers that shape at least one spec, in behavior or approach (`d1…`). An answer that shapes no single spec is a constraint or a non-goal.
  - **`## Save as you go`:** after each settled answer, write the growing draft (the recap fields so far plus `open`, the branches still open) and run `$WITNESS draft <key> --file "$DIR/draft.json"`. A `draft-moved` refusal means another session saved answers since: read the draft back and continue from it.
  - **`## The end`:**
    1. One critique pass from the human's seat; probe every finding.
    2. Then the playback table: class · goals · non-goals · constraints · decisions · slices.
    3. Then an explicit yes.
  - **`## Persist`:**
    - **The commands.** It shows `recap --file "$DIR/recap.json" --ask <id>`, with `decisions` in the example JSON. An amendment runs `$WITNESS recap --amend --file "$DIR/recap.json"`, the recap naming its effort (this replaces `:71`'s `--amend <effort>`).
    - **What a confirmed recap does.** It deletes the draft.
    - **What stays.** The slug rules and the repair loop.
  - **Deleted:** `## Stateless by design`.
- **`plugin/skills/witness-design/SKILL.md`** (§4.7–§4.8):
  - **Frontmatter `description`:** *Produce a ui spec's living approved look — a design session that shows up to three rendered, checked directions, converges in the grill's question shape, saves a local draft, and ends in a self-contained designs/<spec-id>.html handed to witness design, then the design gate. Normally invoked by /witness with the spec id.*
  - **`## When you run`** adds resuming: run `$WITNESS draft design-<spec-id>` on a `draft:` line, whichever design step `next` routed (`--file`, `--open` or the gate).
    - A session that relays or dies mid-amendment needs nothing here: `next` hands the amendment to the grill first, and the look waits with its draft.
  - **`## The session` becomes the seven steps of §4.7:**
    1. Context, as today.
    2. Up to three ranked structural directions, side by side on one self-contained comparison page, using the spec's real content.
    3. Check before showing: screenshot the page with the machine's browser (for example headless Chrome `--headless --screenshot`), fix what is broken, and check again. With no browser, say "not checked" when opening it, and never claim a check that did not run.
    4. Open it with `$WITNESS design <spec-id> --preview "$DIR/directions.html"`.
    5. Converge in the grill's question shape, up to three ranked answers with the pick first, and save the draft.
    6. Author the full look with every state the spec promises, check it the same way, and save the page in the draft.
    7. Register, show and gate, with the commands unchanged.
  - **New `## A behavior answer`** (§4.8):
    - **Pause the look.** Check the change against `$WITNESS read <effort> --decisions`.
    - **Amend the recap** with a numbered decision the human confirms:
      - start from `$WITNESS draft amend-<effort>`, the seed, and save `amend-<effort>` drafts as you go;
      - settle a clash with a non-goal or a constraint in one grill-shaped question;
      - then run `$WITNESS recap --amend --file …`.
    - **Then:** the design draft keeps the direction, the answers and the page. Tell the human decompose re-opens (under autonomy drive updates the spec), and end the session; the look comes back pending on the amended spec.
    - **A note at the approval stop** (`design look`) follows the same path when it changes behavior. A note only about the look stays `witness decide design <spec-id> --revise --note "…"` (§7).
  - **Keep:** A's one autonomy paragraph (`:40-42`), word for word, and the phrase ``the kept stop `design look` ``.
  - **Delete:** `the strongest alternative with when it wins and what it costs`.
- **All six skills' affirmation ground rule** takes the Global Constraints parenthetical and number rule. Brainstorm and design also take the new context wording.
- **`plugin/skills/witness-decompose/SKILL.md:106`:** *Findings implicate the **scope itself** (goals wrong, not slicing wrong)? Tell the human that `--revise --upstream` on the stop screen sends it back to re-interview: the `witness-brainstorm` skill amends the recap, starting from `$WITNESS draft amend-<effort>`, and `next` resumes the amendment once its first answer is saved.* Today's line says `next` routes the re-interview, which it does not (Builder's call 8's residual).
- **`plugin/commands/witness.md`:**
  - `:38`: `stage: brainstorm` → *Use the `witness-brainstorm` skill — with `target` (the effort) when `next` printed one: that is an amendment.*
  - `:50`: *Outside the brainstorm interview and the design session* → *Outside the grill and the design session*.
- **`tests/helpers.ts:673-691`:** `SKILL_GROUND_RULES` gains ``'never a `witness decide` option'``.
- **`tests/skills.test.ts`:**
  - **The brainstorm describes (`:26-39`):**
    - keep `One question per turn`, `recap --file`, `recap --amend`, `writes no`, `g1` and `n1`;
    - replace `two questions` with `No short forms` and `not.toContain('two questions')`;
    - add `d1`, `witness draft`, `what do you want to build?`, `critique pass` and `playback`;
    - add `not.toContain('Stateless by design')` and `not.toMatch(/recap --amend <effort>/)`.
  - **Row 156's floor test (`:53-58`)** stays unchanged.
  - **Row 125's describe (`:231-246`):**
    - brainstorm contains `why`, `when`, `tradeoff`, `up to three` and `never padded`;
    - design contains `up to three ranked` and `--preview` and `not checked`, and not `the strongest alternative with when it wins and what it costs`.
  - **`witness-decompose`** gains `draft amend-<effort>`.
  - A's autonomy pins (`:270-302`) stay green unchanged: the rewrite adds no `Under \`autonomy: on\`` to brainstorm and keeps design's one.
- **`README.md`:**
  - **What brainstorm and design are** (§4.10). Part A's sentence (`:236-238`, "Brainstorm and design stay conversations with a human in every mode…") gains: *Brainstorm is a grill: one plain-words question per turn with up to three ranked answers, the repo explored first, and a local draft after every settled answer, so a dead session resumes. Design shows up to three rendered, checked directions on one page before it asks which.*
  - **A verb row after `recap` (`:277`):** `draft <key> [--file <json>]` → *a grill's or design session's local draft — saved after every settled answer, read back to resume; never committed or journaled*.
  - **The `design` row (`:287`)** gains `\|--preview <html>` (opens a page and records nothing).
  - **The State model's local list (`:315`)** gains `drafts/`.
- **`NOTICE.md:31`:** grill-me's derivation becomes *(← grill-me: the whole decision tree, one question at a time with a recommended answer, the codebase explored instead of asking)*.
- **`DESIGN.md`:**
  - **The stage table, row 1 (`:28`):** the grill (197): the whole tree, plain-word questions with up to three ranked answers, the repo explored first. It ends in a confirmed recap with numbered decisions (198), and a local draft after every settled answer (199) survives session death. Its gate column gains *critique pass → playback → yes*.
  - **The effort prose (`:76-79`):** *the grill keeps a local draft per conversation (`.witness/drafts/`, never committed, 199), so the recap no longer has to survive session death on its own*.
  - **The Skills line (`:206`):** brainstorm becomes *(the grill → a local draft per settled answer → confirmed recap → `witness recap`)*, and design's *2–3 distinct directions* becomes *up to three rendered, checked directions on one page*.
  - **Brainstorm's provenance row (`:265`):** *stateless* becomes *keeps a local draft*.
  - **Row 52 (`:406`):** `**Amended by 200:**` *a decision born in the design session lands here (§4.8), and Part B's re-arm carries it into a spec*.
  - **Row 72 (`:426`):** `**Touched by 200:**` *`--preview` opens a page through the same opener as `--open` (`opener:`, row 90) and journals nothing; `design-shown` stays reserved for registered bytes*.
  - **Row 125 (`:485`):** `**Amended by 197:**` *up to three ranked answers in the CLI's field words, pick first, never padded; the design converge question the same (200)*.
  - **Row 156 (`:511`):** `**Amended by 197:**` *the floor is the recap's fields; the walk is the whole tree*.
  - **Row 191 (`:546`):** `**Amended by 199:**` *the brainstorm and design boundary is a settled answer; a draft save counts as an act (`sessionActed` reads each draft's session). The "mid-interview" residual is settled: a relay mid-grill now loses nothing, because the successor resumes from the draft*.
  - **Rows 197, 199 and 200**, in the shape of rows 194–198 (`| 197 ⊜ | <title> | Amends …. <Choice> | <Why> |`), with titles from spec §5:
    - 197 amends 125 and 156; 199 amends 191; 200 amends 52 and 125 and touches 72;
    - their Choice is §4.4, §4.6 and §4.7–4.8 plus this plan's Builder's calls;
    - their Why is spec §1, P3 and P5.
  - **The rationale trail (`:351`):** after B's sentence, which ends the line, add *Rows 197, 199 and 200 (⊜) added <date> — the drive and brainstorm grill (Q4–Q8), Part C: the grill, its drafts, and a design session that shows before it asks (`docs/superpowers/specs/2026-10-23-grill-design.md` §4.4, §4.6–4.8; amended: 52, 125, 156, 191; touched: 72).*
  - **Open / deferred (`:556`):** add Builder's call 8's residual at the top, beside B's: *an amendment not yet started has no draft, so after `decide decompose … --revise --upstream` `next` routes back to decompose authoring, not to the grill; the skills start the amendment, and `next` resumes it from its first saved answer (row 199)*.

- [ ] **Step 1:** Edit `tests/helpers.ts` and `tests/skills.test.ts`. Run `pnpm exec vitest run tests/skills.test.ts` → FAIL.
- [ ] **Step 2:** Rewrite the brainstorm skill; edit the design skill, the four other skills' ground rule and the decompose line; then edit the engine, `README.md`, `NOTICE.md` and `DESIGN.md`.
- [ ] **Step 3:** `pnpm exec vitest run tests/skills.test.ts tests/command.test.ts tests/licenses.test.ts tests/verb-usage.test.ts tests/prompts.test.ts tests/harness-neutrality.test.ts` → PASS.
- [ ] **Step 4: Commit.** `git commit -am "docs: the grill, drafts and the design session — skills, engine, README, rows 52, 72, 125, 156, 191, 197, 199, 200 (D197)"`

### Task 7: Verify and hand over

- [ ] **Step 1: Full suite and typecheck.** `pnpm typecheck` exits 0. Run `pnpm test`, then `grep -c AssertionError` on its output, which must give 0. The passed count is Task 0's plus C's new cases.
- [ ] **Step 2: A scripted walk of the draft path in a scratch repo** (`$SCRATCH/walk`, with `node dist/bin.js` after `pnpm build`, and `measuredEnv`-style `CLAUDE_CODE_SESSION_ID` and `WITNESS_CONTEXT` set by hand). Walk:
  1. `init`, then `ask "add dark mode"`.
  2. Save three drafts at a rising fill; the third save is at 21%.
  3. `next` prints `draft: …` and the `relay:`.
  4. A fresh session id: `next` has no relay, and `draft ask-a1` reads the three answers back.
  5. `recap --ask a1` deletes the draft, and `git status --porcelain` stays empty throughout.

  Paste the transcript into the PR body.
- [ ] **Step 3: Read-only fewhats differential.** Run `pnpm build`, then `git clone --local ~/x/personal/fewhats.com "$SCRATCH/fw"`. In the clone, with `CI=true`, compare `next`, `status`, `index` and `check` between `npx -y @popovych.co/witness@0.23.0` and `node <repo>/dist/bin.js`.
  - **Expected: no difference.** No drafts exist, `GITIGNORE_BLOCK` only affects new repos, and fewhats has no drafted ask or amendment for the new rungs to route.
  - Any line that differs is a c2 defect: explain it and fix it before going on.
  - `git -C "$SCRATCH/fw" status --porcelain` prints nothing.
- [ ] **Step 4: Reviews.** Two opus reviewers, from different angles:
  - code against this plan: the draft store, the three git exclusions, `sessionActed`, the cycle-free import of `drafts.ts` from `ask.ts`, and the referent rules shared with `recap`;
  - the user's seat against spec §4.4 and §4.6–4.8 plus Review Focus 1–5, including the two skills read as an agent would follow them.

  Re-run every finding before acting on it, then do one fix pass, red to green.
- [ ] **Step 5 (HUMAN):** push and open the PR (the agent does this when asked). The user merges, then runs `pnpm release minor` → 0.24.0.
