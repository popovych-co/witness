# Issues #86, #87, #80 (rows 243–245) Implementation Plan — the rebuild

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the base moves, witness carries the plan's uncommitted work itself, and a clash stays in the files instead of reaching a gate (#86). Every act a screen offers is one `decide` accepts, and a revise the author hands back unchanged is decided again (#87). A session, reviewer or arbiter ends when its turn ends (#80). All three ship as witness 0.30.0; #76 closes without witness work (decision 13).

**Architecture:**
- **#86:** a witness-owned carry (`src/carry.ts`) replaces `git rebase --autostash` inside `rebaseIfMoved`. Every ship run starts with step 0, which finishes an interrupted move. One guard predicate (`src/clash.ts`) is read by every gate, evidence run, turn and ship.
- **#87:** one pure derivation, `liveActs` in `src/rounds.ts`, feeds every screen, hint and refusal, the arbiter's menu, and `decide`'s own acceptance. `witness gate … --unchanged` journals a new `revise-returned` entry, and one owed predicate reads it everywhere.
- **#80:** `WorkerStream` reports when the turn ends. One end watch (`src/session-end.ts`) gives drive sessions and reviewer attempts a 60 s grace, then stops them and records the harness's own ending status.
- **#76:** closed without witness work (decision 13). The user runs witness inside a VM themselves; Slice 5 is dropped.

**Tech Stack:**
- TypeScript (ESM, Node ≥ 20) and vitest.
- git and gh CLIs. Step 0's comparison needs git ≥ 2.40.
- No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-19-remaining-issues-design.md`, revision 9. Revision 6 was approved 2026-11-19 (commit 13b621f); the user's decision 12 then rewrote its #76 part (revision 7), pass 7 and the build's own rulings amended it (revision 8), and decision 13 dropped #76 (revision 9). Each task names the design section it builds; read that section with the task. Rows 243–245 in `DESIGN.md` are already written.

**Rebuild:** this plan builds from main (0.29.0, b92a461) on branch `remaining-issues-2`, in the worktree `/Users/home/x/personal/witness/.claude/worktrees/remaining-issues-2`. A first build on branch `remaining-issues` (229648f..3ae38f9) stays as a reference, untouched. Its ledger (`/Users/home/x/personal/witness/.claude/worktrees/remaining-issues/.superpowers/sdd/2026-11-19-remaining-issues/progress.md`) says why each choice in the "Settled by the first build" lists below was made, and the design's §4.1.5, §4.2.9 and §4.3 carry the same choices. Do not copy its code.

## Global Constraints

- **Release.** 0.30.0, as one release at the end (decision 8). The user runs `pnpm release minor`; never run it yourself. The new journal kind `revise-returned` raises the state floor (c3).
- **No new committed setting** and no `witness migrate` (n1). The grace (`END_GRACE_MS = 60_000`) and the never-started window (`SESSION_QUIET_MS`, 5 min) are constants.
- **Conflicts and operations.** Witness never resolves a conflict (n2). It never aborts, or applies into, an operation a session started.
- **The shared stash list.**
  - Nothing witness does lands on git's shared stash list. Source uses only `git stash create` and `git stash apply <sha>`, which never touch `refs/stash`.
  - Source never runs `git stash push|pop|drop|store`.
  - Tests may build stash entries only inside their own throwaway repos (`git stash store`).
- **Reading git.** Parse git's output only when git ran under `LC_ALL=C` (`tryGitC`, or the carry's own runner). Witness's own rebase runs with `GIT_REFLOG_ACTION=witness-carry`.
- **Rendering.** Every command a row offers goes through the act renderers (`cliAct`, `runRow`, `shellLine`; row 239). File names print as quoted foreign words. Git's text prints through `logSafe`.
- **The new journal kind** gets its `ENTRY_PROGRESS` row (`src/progress.ts:10`): `'revise-returned': 'act'` (row 206).
- **Machine-local files** live under `.witness/live/` or in `LOCAL_STATE_FILES` (`src/gitio.ts:124`). Write them without following a link.
- **Control and bidi characters.** They appear in source only as `\u` escapes. Scan every written file with the perl one-liner from memory `raw-escapes-in-written-docs` after writing, and tell implementer subagents the same.
- **Text pins.** Skill, command and README text for a behavior lands in the same task as the behavior, because `tests/command.test.ts` and `tests/skills.test.ts` pin that text.
- **Test-only env seams** follow `WITNESS_DRIVE_AGENT_BIN`'s precedent (`src/drive.ts:221-223`): a comment names the seam test-only, and it is never documented for users.
- **Running tests.**
  - Run one file as `caffeinate -i npx vitest run tests/<file>`.
  - Record the full suite's baseline at b92a461 in the build ledger before Task 1.
  - `npx tsc --noEmit` stays clean.
- **The repo's own worktree.**
  - Never `git stash` in the repo.
  - Never `git add -A` there: the worktree's `node_modules` is an untracked symlink.
  - To watch a test fail against pre-fix code, reverse-apply the fix hunk (memory `no-stash-red-checks`).
- **Probe material.** The design passes' probes live outside the repo, in `/Users/home/x/personal/witness/.superpowers/sdd/2026-11-19-issues-86-87/scratch/` and in `/Users/home/x/personal/witness/.claude/worktrees/remaining-probes/tests/zz-*.test.ts`. Copy their setup, and invert their final assertions to the fixed behavior.
- **Slice close** (the user's condition of approval):
  1. Run the full suite (`caffeinate -i npx vitest run`), `npx tsc --noEmit`, and the perl scan of every file the slice touched.
  2. Spawn a fresh opus agent with the slice's `git diff <slice-start>..HEAD` and the design sections it builds, never the implementer's summary. Ask it for an adversarial review against the real code.
  3. Re-run each finding before fixing it, fix what holds, and log the review in the ledger.
- **Subagents.** Implementer and reviewer subagents run on opus, never fable.
- **Order.** Tasks 1–17, then Task 20. Task 18 was built first (609ec06..ed92f1a); decision 13 dropped it with Task 19, and the commit that brought revision 9 removes its files.
- **The first build's knowledge.** Each task's "Settled by the first build" list is part of that task: interface choices and review fixes from the first build, tagged with its ledger entries. The tests it names go into the task's Step 1 beside the others.
- **Build ledger:** `/Users/home/x/personal/witness/.superpowers/sdd/2026-11-20-remaining-issues-2/progress.md`.

## Review Focus

- **git in another language** (`LANG=de_DE.UTF-8`, `LANGUAGE=de`). The carry must still tell a clash ("CONFLICT") apart from "conflicts in index" and from a refused apply. Test added to Task 3.
- **File names that git and shells treat specially** (`-x.md`, `[x].md`, `:x.md`, `a b.md`, a name with a newline). The clash rows, the remedies they print and signal (b)'s read must name exactly that file and no other. Test added to Task 2.
- **A CRLF checkout** (`core.autocrlf=true`, the Windows default). Right after a crash, step 0 must read "the work already back", not `carry-pending` forever. Test added to Task 4.
- **A pi end signal split across two reads, with CRLF line ends** (a Windows pipe). The grace must still start. Test added to Task 15.
- **A revise left open across the upgrade** (its run journaled under 0.29.x's key). `gate --unchanged` must run a fresh round and say that nothing was handed back. Test added to Task 12.

---

## Slice 1 — #86: the carry, the guard, the leases (row 243)

### Task 1: The carry's git primitives and the guard predicate (design §4.1.1 steps 2, 4, 7; §4.1.2)

**Files:**
- Create: `src/carry.ts`, `src/clash.ts`
- Test: `tests/carry-primitives.test.ts`, `tests/clash-guard.test.ts`

**Interfaces:**
- Produces (`src/carry.ts`):
  - `CARRY_ACTION = 'witness-carry'`.
  - `carryGit(wt: string, ...args: string[]): { code: number | null; stdout: string; stderr: string }`. Runs `spawnSync('git', …)` from `src/spawn.ts` with env `{ ...process.env, LC_ALL: 'C', GIT_REFLOG_ACTION: CARRY_ACTION }` and keeps both streams. The carry needs both: `CONFLICT` goes to stdout, "conflicts in index" to stderr.
  - `carryRef(planId: string): string` returns `refs/witness/carry/<planId>`.
  - `keptPrefix(planId: string): string` returns `refs/witness/kept/<planId>/`.
  - `type OpInProgress = 'rebase-merge' | 'rebase-apply' | 'MERGE_HEAD' | 'CHERRY_PICK_HEAD' | 'REVERT_HEAD'`.
  - `operationInProgress(wt: string): OpInProgress | undefined`. Checks each name through `git rev-parse --git-path <name>`, then `existsSync`.
  - `interface UnmergedPath { path: string; stages: Partial<Record<1 | 2 | 3, string>> }`, where the stages hold blob shas.
  - `unmergedPaths(wt: string): UnmergedPath[]`, read from `git ls-files -u -z`.
  - `interface KeptRef { ref: string; sha: string; files: string[] }`.
  - `keptRefs(wt: string, planId: string): KeptRef[]`, in numeric order.
  - `keepCarry(wt: string, planId: string, carry: string, files: string[]): Result<string>`, which returns the new ref's name.
- Produces (`src/clash.ts`):
  - `type ClashSignal = { kind: 'unmerged'; files: UnmergedPath[] } | { kind: 'labels'; files: string[] } | { kind: 'carry'; ref: string }`.
  - `clashLeft(wt: string, planId: string, shipBranch: string): ClashSignal | undefined`.
  - `clashViolations(planId: string, s: ClashSignal, wt: string): Violation[]`, with rule `clash-unresolved`. A `labels` refusal also says, as prose, that a doc or fixture line which merely starts with a label is released by moving that kept ref out of `refs/witness/kept/` (§4.1.2 "The escape"), so the backup itself is kept.
  - `fileRemedies(wt: string, files: UnmergedPath[], op: 'stash' | 'rebase' | 'merge'): string[]`: §4.1.3's per-file rows, each `"<kind> — <remedy>"`. Task 3 reuses them for the clash refusal.

**Decided here (the design leaves the kept ref's format open):**
- `keepCarry` writes a stash-shaped commit with the carry's own tree and parents: `git commit-tree <carry>^{tree} -p <carry>^1 -p <carry>^2`.
- Its message is `witness kept <planId>\n\nfiles: <JSON array of names>`.
- It then runs `git update-ref <prefix><n> <sha> ''`. This is create-only, with `<n>` = the highest existing number + 1.
- Only then does it delete the carry ref.
- `git stash apply --index <kept>` and `git stash show -p <kept>` work on it unchanged.
- File names come from `ls-files -u -z`, unquoted, and are stored as JSON.

**Settled by the first build:**
- `clashViolations` takes the worktree as a third parameter: a file's remedy needs its kind (content or binary).
- `clashLeft`'s order is the carry (c), then unmerged entries (a), then label lines (b) (§4.1.5).
- With no merge-base (no remote or local ship branch), signal (b) reads the listed file itself for label lines, failing closed.
- `fileRemedies` takes the operation (`stash | rebase | merge`; the guard reads it from `operationInProgress`) and reads any operation's conflict markers as content (S1-5). File rows carry no runnable `remedy`, since `git add` before resolving would be wrong to offer as `run:`.
- Every remedy goes through one `remedyLine`. A name git reads as pathspec magic or a glob (`:x.md`, `[x].md`, `*`, `?`, a backslash) gets `git --literal-pathspecs …`. A name a terminal cannot show, or one Windows refuses, is shown with a note and never offered (S1-4, S1-7).
- `keepCarry` deletes the carry ref with its expected old value; any failed step refuses `carry-pending`, naming the carry ref.
- `untrackedInTheWay(wt, paths)` lives in `carry.ts`, shared by Task 3's rebase and every apply. It compares without case under `core.ignorecase` (S1-2).
- Tests to add:
  - the remedies for `:x.md` and `[x].md`, run as printed, stage exactly that file;
  - a name with a newline is shown with a note and offered as no runnable line;
  - a rebase's clash and a merge's clash name their sides for that operation.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/carry-primitives.test.ts — a tmp repo with a linked worktree `wt` on branch witness/p1
it('names every operation in progress through git-path, worktree-aware (P19)', () => {
  // start a conflicting `git merge` inside wt
  expect(operationInProgress(wt)).toBe('MERGE_HEAD')
  carryGit(wt, 'merge', '--abort')
  expect(operationInProgress(wt)).toBeUndefined()
})
it('a kept ref is stash-shaped, numbered, never overwritten, and lists its files as written', () => {
  const carry = carryGit(wt, 'stash', 'create').stdout.trim()
  carryGit(wt, 'update-ref', carryRef('p1'), carry)
  const k1 = keepCarry(wt, 'p1', carry, ['-x [y].md', 'a\nb.md'])
  expect(k1.ok && k1.value).toBe('refs/witness/kept/p1/1')
  expect(carryGit(wt, 'rev-parse', '--verify', '--quiet', carryRef('p1')).code).not.toBe(0)
  expect(keptRefs(wt, 'p1')[0]!.files).toEqual(['-x [y].md', 'a\nb.md'])
  expect(carryGit(wt, 'stash', 'show', '-p', 'refs/witness/kept/p1/1').code).toBe(0)
  expect(carryGit(wt, 'stash', 'list').stdout).toBe('')            // the shared list untouched
  carryGit(wt, 'update-ref', carryRef('p1'), carry)
  expect(keepCarry(wt, 'p1', carry, ['f']).ok && 'refs/witness/kept/p1/2').toBeTruthy()
})
it('unmergedPaths reads NUL-separated names unquoted, with each stage blob (P51)', () => {
  // clash a file named 'é [x].md' via a conflicting `git stash apply`
  expect(unmergedPaths(wt).map((u) => u.path)).toEqual(['é [x].md'])
  expect(Object.keys(unmergedPaths(wt)[0]!.stages).sort()).toEqual(['1', '2', '3'])
})
```

```ts
// tests/clash-guard.test.ts — `clashed(placement)` builds a kept ref listing f.md and writes the
// stash-apply label lines into f.md unstaged, staged, or committed
it('signal (a): unmerged entries', () => expect(clashLeft(wt, 'p1', 'main')?.kind).toBe('unmerged'))
it.each(['unstaged', 'staged', 'committed'])('signal (b): %s label lines in a kept ref\'s file (P36)', (p) => {
  clashed(p)
  expect(clashLeft(wt, 'p1', 'main')).toEqual({ kind: 'labels', files: ['f.md'] })
})
it('signal (b): a plain ======= line or a setext underline never counts (P22)', () => {
  writeFileSync(join(wt, 'f.md'), 'Title\n=======\n')   // kept ref lists f.md
  expect(clashLeft(wt, 'p1', 'main')).toBeUndefined()
})
it('signal (b): labels with 9-char markers count (conflict-marker-size, P51)')
it.each([['diff', '-diff attribute'], ['textconv', 'textconv driver'], ['color.ui', 'always'],
  ['diff.noprefix', 'true'], ['diff.relative', 'true']])('signal (b) holds under %s (P36, P44)')
it('signal (b) names :foo.md and [x].md literally; x.md beside [x].md is not read (P51)')
it('signal (c): a carry ref present → kind carry; its violation leads with witness ship p1 and names no file', () => {
  const v = clashViolations('p1', { kind: 'carry', ref: carryRef('p1') }, wt)
  expect(v[0]!.rule).toBe('clash-unresolved')
  expect(v[0]!.want).toMatch(/witness ship p1/)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run `caffeinate -i npx vitest run tests/carry-primitives.test.ts tests/clash-guard.test.ts`. Expected: FAIL with "Failed to resolve import ../src/carry.js".

- [ ] **Step 3: Implement both modules**

- **Signal (b)** runs `tryGitC(wt, '--literal-pathspecs', 'diff', '--text', '--no-textconv', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--no-relative', <mergeBase>, '--', <file>)` once per listed file, from the worktree root.
  - `<mergeBase>` is `git merge-base HEAD refs/remotes/origin/<shipBranch>`, falling back to the local `<shipBranch>`.
  - A label line is an added line matching `/^\+(?:<{7,} Updated upstream|>{7,} Stashed changes|\|{7,} Stash base)\r?$/m`.
- **`fileRemedies`** picks a remedy by kind:
  - content (the file holds label lines): resolve the markers keeping both intents, then `git add -- <file>`;
  - binary, or both sides changed with no markers: `git checkout --theirs -- <file>` keeps the plan's version and `--ours` keeps main's, then `git add -- <file>`;
  - modify/delete, read from the missing stage (stage 3 is the plan's side in a stash apply): says which side `git rm -- <file>` keeps and which side `git add -- <file>` keeps.

  Every command goes through `shellLine`.

- [ ] **Step 4: Run them and watch them pass**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/carry.ts src/clash.ts tests/carry-primitives.test.ts tests/clash-guard.test.ts
git commit -m "feat: the carry's git primitives and the clash guard predicate (row 243)"
```

### Task 2: Every gate, evidence run, turn and ship refuses a clash (design §4.1.2 "Who reads it", "The refusal")

**Files:**
- Modify:
  - `src/clash.ts`: add `clashGuard`.
  - `src/gate.ts:298-325` (`runGate`): for the implement and ship gates, beside the `steps-open` refusal.
  - `src/verbs/evidence.ts`: test-evidence, verify-red included.
  - `src/verbs/turn.ts:20-46`: in a plan's worktree only.
  - `src/ship.ts` (`shipMarked`): at the top of the body, before `openStepRow` (:582). Task 4 puts step 0 before it. Also before the pr-phase commit (:700) and inside `pushApproved` (:442), before its `git add -A`.
- Test: `tests/clash-refusals.test.ts`

**Interfaces:**
- Consumes `clashLeft` and `clashViolations` (Task 1).
- Produces `clashGuard(root: string, cfg: Config, planId: string): Violation[] | undefined`, using `worktreePath(root, planId)` and `cfg.ship.branch`. All four callers use it.

**Settled by the first build:**
- The guard runs before `steps-open` in `runGate` (the implement and ship gates), before `checkStep` in test-evidence and verify-red, before the runner turn in `turn`, and first in `shipMarked`.
- `pushApproved(ctx, root, cfg, planId, summary)` takes the root and config, so it can ask the guard before its `git add -A`.
- Tests that make names NTFS refuses (`:`, `*`, `?`, a backslash, a newline) skip on win32.

- [ ] **Step 1: Write the failing tests**

```ts
// `clashedShippable()`: shippableRepo + a kept ref for f.txt + a conflicting `git stash apply` → UU f.txt
it('gate implement and gate ship refuse clash-unresolved, exit 2, before judging; nothing journaled', async () => {
  for (const gate of ['implement', 'ship']) {
    const r = await repo.cli(['gate', gate, planId], { env: gateEnv(scenario) })
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/clash-unresolved/)
  }
  expect(callCount(scenario)).toBe(0)
})
it('test-evidence and verify-red refuse with exit 2 and write no evidence entry')
it('witness turn in the plan worktree refuses with exit 2 and never runs the command; at the primary root it runs')
it('ship refuses before its commit and before pushApproved\'s add; f.txt stays UU', async () => {
  expect((await repo.cli(['ship', planId])).code).toBe(2)
  expect(g(wt, 'status', '--porcelain')).toMatch(/^UU f\.txt$/m)
})
it('a file named -x.md gets its own row, and its remedy runs `git add -- -x.md` (Review Focus)', async () => {
  // clash '-x.md', '[x].md', ':x.md', 'a b.md'
  const r = await repo.cli(['gate', 'implement', planId], { env })
  for (const n of ['-x.md', '[x].md', ':x.md', 'a b.md']) expect(r.stderr).toContain(shellLine(['git', 'add', '--', n]))
})
```

- [ ] **Step 2: Run them and watch them fail**

Run `caffeinate -i npx vitest run tests/clash-refusals.test.ts`. Expected: FAIL. The gate runs and exits 1.

- [ ] **Step 3: Wire `clashGuard` into the four callers**

Each caller renders the violations with `renderRefusal` and returns `EXIT.REFUSED`.

- [ ] **Step 4: Run them and watch them pass**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/clash.ts src/gate.ts src/verbs/evidence.ts src/verbs/turn.ts src/ship.ts tests/clash-refusals.test.ts
git commit -m "feat: every gate, evidence run, turn and ship refuses an unresolved clash (row 243)"
```

### Task 3: The carry replaces `--autostash` (design §4.1.1 steps 1–2 and 4–7; §4.1.3 clash and replay steps)

**Files:**
- Modify:
  - `src/carry.ts`: steps 4–7.
  - `src/ship.ts:262-310` (`rebaseIfMoved`), and its caller (:663).
  - `tests/ship-lease.test.ts`: callers move to the new signature.
- Test: `tests/ship-carry.test.ts`

**Interfaces:**
- Produces (`src/carry.ts`):
  - `captureCarry(wt: string, planId: string): Result<string | undefined>`. This is step 4; `undefined` means nothing to carry.
  - `cleanTree(wt: string, planId: string): Result<void>`. This is step 5: `git reset --hard`, then verify the tracked tree is clean.
  - `type Reapplied = { kind: 'clean' } | { kind: 'clash'; kept: string; files: UnmergedPath[] } | { kind: 'refused'; out: string } | { kind: 'locked'; lock: string }`.
  - `reapply(wt: string, planId: string, carry: string): Reapplied`. This is step 7.
- Rule names: `textual-conflict` (exit 1), `operation-in-progress`, `carry-refused`, `carry-pending` and `rebase-refused` (exit 2), and `index-locked` (exit 3, transient). The design does not name the held-lock rule, so `index-locked` is decided here.
- The signature changes once here, for Tasks 4 and 5 too: `rebaseIfMoved(wt: string, root: string, shipBranch: string, run: { planId: string; hasPr: boolean; env: Ctx['env'] }, remote = 'origin'): Result<'clean' | 'rebased'>`. `env` carries the crash points Task 4's tests use.

**Settled by the first build:**
- **An untracked file the moved base adds** (a non-ignored path the base holds, or a dir/file clash with one) refuses `rebase-refused`, naming the files, before anything moves. In a witness worktree's sparse checkout, `git rebase` silently replaces such a file with main's bytes and exits 0.
- **`reapply` refuses an untracked file** where the carry, or its index, writes one (S1-1).
- **The "conflicts in index" fallback's kept ref** lists the carry's staged files (`git diff <carry>^1 <carry>^2`).
- **After a failed rebase,** the abort's own exit is not read. Success is no operation in progress and HEAD back at the original.
- **`heldLock`** reads git's words, then the lock file itself, at capture, reset, rebase and apply; Apple's git words it differently. A lock on the carry ref is `index-locked` too, with that ref's `.lock` path as `got` (S1-3).
- **Dropping the carry ref after a clean apply is checked:** a failed drop is a held lock (exit 3) or `carry-pending` (S1-6).
- **The lock test** asserts `rebaseIfMoved`'s `index-locked` violation with the carry ref kept. Task 6 owns the exit and the record.
- **The `LANG=de` test** proves its point only with a git that has a German catalog (Homebrew's; Apple's has none). It skips, naming why, when `LANGUAGE=de git` prints no German (S1-8).
- **Tests to add:**
  - a sparse worktree's untracked file that the base adds is refused before anything moves, and its bytes are kept;
  - step 0 never writes the carry over an untracked file;
  - a case-only collision is refused under `core.ignorecase`;
  - a held carry-ref lock reads `index-locked`;
  - a failed carry-ref drop after a clean apply exits 3 or refuses `carry-pending`, and never loops `clash-unresolved`.

- [ ] **Step 1: Write the failing tests**

Copy the setup from `grill/p86a`, `p86c`, `p86d` and `p86e`, and invert the assertions.

```ts
// `movedClash()`: plan edits line 1 of f.txt uncommitted; main edits line 1 on origin
it('a clash re-applying the carry stays in the files: textual-conflict, UU kept, kept ref, no stash entry (P1, P2)', async () => {
  const r = await repo.cli(['ship', planId])
  expect(r.code).toBe(1)
  expect(r.stderr).toMatch(/textual-conflict/)
  expect(g(wt, 'status', '--porcelain')).toMatch(/^UU f\.txt$/m)
  expect(g(wt, 'stash', 'list')).toBe('')
  expect(keptRefs(wt, planId).map((k) => k.files)).toEqual([['f.txt']])
  expect(gateRuns(readStream(repo.root, planId), 'ship')).toHaveLength(0)
})
it('staged-only work survives the move (reset --hard, not checkout -- .) (P13)')
it('with rebase.autoStash=true nothing reaches the stash list (P15)')
it('an intent-to-add entry refuses carry-refused before anything moves, naming git add and git reset (P14)')
it('a clean move: applied --index, carry ref deleted, outcome rebased')
it('"conflicts in index" falls back to a plain apply, and that copy is kept like a clash backup (P25)')
it('a replay conflict aborts, puts the work back, and refuses textual-conflict with the replay steps naming the files (P26)')
it('an untracked file in the way refuses rebase-refused in git\'s words; the work is put back')
it('an operation in progress refuses operation-in-progress naming its --continue/--abort, and is never aborted (P19)')
it('a held index.lock exits 3 and keeps the carry ref; refusalOutcome is transient')
it('under LANG=de_DE.UTF-8 and LANGUAGE=de the clash still reads as a clash (Review Focus)', async () => {
  process.env.LANGUAGE = 'de'; process.env.LANG = 'de_DE.UTF-8'
  try { expect((await repo.cli(['ship', planId])).stderr).toMatch(/textual-conflict/) }
  finally { delete process.env.LANGUAGE; delete process.env.LANG }
})
```

- [ ] **Step 2: Run them and watch them fail**

Run `caffeinate -i npx vitest run tests/ship-carry.test.ts`. Expected: FAIL. Today's `--autostash` exits 0, so ship gates the markers.

- [ ] **Step 3: Implement steps 1–2 and 4–7 in `rebaseIfMoved`**

The order is the guard, then operations in progress, then the lease (unchanged until Task 5), then capture, clean, `git rebase --no-autostash <remote>/<branch>` through `carryGit`, and finally reapply.

- **On a non-zero rebase:**
  1. read the unmerged paths;
  2. `git rebase --abort`;
  3. verify HEAD is the original commit;
  4. put the work back with `reapply`.

  The carry ref is deleted only after a clean put-back.
- **Clash:** the tree had no unmerged entries before the apply, the apply printed `CONFLICT`, and it has unmerged entries after. The carry is moved with `keepCarry`, and the refusal is `textual-conflict` with `fileRemedies` rows plus "test through `$WITNESS turn`, then re-run `witness ship`, which re-gates".
- **Replay conflict:** §4.1.3's four replay steps, naming the files.

- [ ] **Step 4: Run them and watch them pass**

Run `caffeinate -i npx vitest run tests/ship-carry.test.ts tests/ship-lease.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/carry.ts src/ship.ts tests/ship-carry.test.ts tests/ship-lease.test.ts
git commit -m "fix: ship carries the plan's work itself; a clash stays in the files, never on the stash list (row 243, #86)"
```

### Task 4: Step 0 finishes an unfinished move at every ship run (design §4.1.1 step 0)

**Files:**
- Modify:
  - `src/carry.ts`: `witnessOwnRebase`, `gitAtLeast`, `blobAt`, `workAlreadyBack`.
  - `src/ship.ts`: `finishMove`, exported, called first in `shipMarked`, before Task 2's guard and before `openStepRow` (:582).
- Test: `tests/ship-finish-move.test.ts`

**Interfaces:**
- Produces:
  - `finishMove(root: string, wt: string, planId: string): Result<'none' | 'finished'>`, where `'none'` means no carry ref.
  - `witnessOwnRebase(wt: string, carry: string): boolean`. It is true when HEAD's latest `(start)` reflog entry and every later entry carry `witness-carry`, and `orig-head` is `<carry>^1`.
  - `gitAtLeast(versionLine: string, major: number, minor: number): boolean`.
- Consumes `reapply`, `keepCarry`, `unmergedPaths` and `operationInProgress`.

**Settled by the first build:**
- `finishMove` lives in `src/ship.ts`: it renders `clash.ts`'s rows, and `carry.ts` importing `clash.ts` would close an import cycle.
- With git < 2.40, the comparison is skipped: a clean tracked tree is re-applied, and anything else refuses `carry-pending`, naming the old git.
- Step 0's refusals exit through `carryExit` (`textual-conflict` 1, `index-locked` 3, everything else 2) and go through `recordRefusal`, so Task 6's rows apply to them too.

- [ ] **Step 1: Write the failing tests**

Copy the setup from `scratch/pass4-I` and `scratch/pass5-K` (P35, P40, P41, P43, P52, P53).

```ts
// `crashAt(point)`: runs `witness ship` as a child process with WITNESS_CRASH_AFTER=carry-<point>
// (crashPoint exits 9); points: after-capture, after-reset, mid-rebase
it('crash before the reset: the work is still in the tree → ref dropped, ship proceeds (P35)', async () => {
  crashAt('after-capture')
  expect((await repo.cli(['ship', planId])).stderr).not.toMatch(/carry-pending/)
  expect(tryG(wt, 'rev-parse', '--verify', carryRef(planId))).toBe(false)
})
it('crash after the reset: the tracked tree is clean → re-applied')
it('crash mid-rebase: witness\'s own rebase is aborted and the carry re-applied (P40, P53)')
it('a session continued witness\'s rebase → operation-in-progress; nothing aborted, its commits kept (P53)')
it('a session\'s own rebase from the same HEAD is never aborted (P40)')
it('HEAD detached or on another branch → carry-pending naming `git switch witness/<plan>`')
it('unmerged entries matching the carry\'s blobs → kept ref + textual-conflict; a session\'s own stash pop → carry-pending naming files (P43, P52)')
it('anything else → carry-pending printing `git stash show -p <ref>` beside `git diff <ref>^1 <ref>^2` and the restore steps; never resets')
it('the worktree gone → carry-pending showing the ref, which is kept')
it('runs before row 241\'s open-step refusal: a carry left while a step is open is finished (P41)')
it('core.autocrlf=true, CRLF files: crash before the reset reads as the work already back (Review Focus)')
it('gitAtLeast reads 2.39.5 as old and 2.56.0.windows.1 as new; an old git refuses carry-pending with the manual steps', () => {
  expect(gitAtLeast('git version 2.39.5', 2, 40)).toBe(false)
  expect(gitAtLeast('git version 2.56.0.windows.1', 2, 40)).toBe(true)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run `caffeinate -i npx vitest run tests/ship-finish-move.test.ts`. Expected: FAIL with "finishMove is not a function".

- [ ] **Step 3: Implement `finishMove` in step 0's sub-order 1–7**

- Add `crashPoint(run.env, 'carry-after-capture' | 'carry-after-reset' | 'carry-mid-rebase')` calls in `rebaseIfMoved`, on `src/txn.ts:39`'s existing crash-point seam.
- **The tree comparison:**
  - The worktree side is `git merge-tree --write-tree --merge-base=<carry>^1 HEAD <carry>`, compared with `<fresh>^{tree}`. `<fresh>` is a new `git stash create`, or `HEAD` when that prints nothing.
  - The index side is `… HEAD <carry>^2`, compared with `<fresh>^2^{tree}`.
  - A merge-tree exit of 1 (conflicts) is never equal.

- [ ] **Step 4: Run them and watch them pass**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/carry.ts src/ship.ts tests/ship-finish-move.test.ts
git commit -m "feat: step 0 finishes an interrupted move at every ship run (row 243)"
```

### Task 5: Leases from their own fetch; only createPr makes the first push; pushApproved leases (design §4.1.1 steps 3 and 8)

**Files:**
- Modify `src/ship.ts`:
  - `leaseFor` (:168-183);
  - `createPr` (:203-229);
  - the lease in `rebaseIfMoved`;
  - `pushApproved` (:442-466);
  - `refusalOutcome` (:106-121): add `pr-branch-gone`.
- Test: `tests/ship-lease.test.ts` (extend)

**Interfaces:**
- Produces `leaseFor(wt: string, branch: string, remote = 'origin'): Result<{ tip: string } | { absent: true }>`. It fetches `+refs/heads/<b>:refs/remotes/<remote>/<b>`, and git's "couldn't find remote ref" reads as `absent`.
- New rule `pr-branch-gone`. `refusalOutcome` maps it to `fix` with the reason "the PR branch is gone from the remote — recreate or reopen it, or abandon the plan".
- The three callers:
  - `createPr`: absent with `meta.pr` unset means a plain first push; otherwise it leases.
  - `rebaseIfMoved`: with `run.hasPr`, absent refuses `pr-branch-gone`. With no PR it never pushes.
  - `pushApproved`: leases through `leaseFor`, and absent refuses `pr-branch-gone`.

**Settled by the first build:**
- `leaseFor` and `pushApproved` are exported, since tests drive them directly.
- `rebaseIfMoved` names the PR branch by `branchName(planId)`, never by `symbolic-ref HEAD`.
- `pr-branch-gone` is `humanCall`, and records `fix`.

- [ ] **Step 1: Write the failing tests**

Copy the setup from `scratch/pass4-I` (P37, P42) and `scratch/pass2-E` (P21).

```ts
it('a single-branch clone: leaseFor reads the PR branch from its own fetch (P37)')
it('a first ship with no PR: rebaseIfMoved pushes nothing; createPr makes the first push (P42)', async () => {
  // no remote witness/<plan>; main moved; approve ship
  expect(remoteHas(branch)).toBe(false)               // after the gate phase
  await repo.cli(['ship', planId])                     // pr phase
  expect(remoteHas(branch)).toBe(true)
})
it('with a PR and no remote branch: rebaseIfMoved and pushApproved refuse pr-branch-gone, recorded fix')
it('a push held back by a clash is carried by the next ship under witness\'s lease, never push-diverged (P21)')
it('pushApproved overwrites witness\'s own last push and refuses a collaborator\'s commit with push-diverged')
```

- [ ] **Step 2: Run them and watch them fail**

Run `caffeinate -i npx vitest run tests/ship-lease.test.ts`. Expected: FAIL. `head-unreadable` appears in the single-branch clone.

- [ ] **Step 3: Implement the lease rules above**

- [ ] **Step 4: Run them and watch them pass**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ship.ts tests/ship-lease.test.ts
git commit -m "fix: every ship push leases from its own fetch; only createPr makes the first push (rows 242, 243)"
```

### Task 6: Re-gating after a move, and every new refusal's exit and record (design §4.1.1 step 9; §4.1.3 table)

**Files:**
- Modify `src/ship.ts`:
  - `shipPhase`'s no-PR branch (:48-61);
  - `refusalOutcome` (:106-121);
  - the rebase refusal's exit mapping (:660-668).
- Test: `tests/ship-carry-outcome.test.ts`

**Interfaces:**
- With no PR, `shipPhase` returns `'pr'` only while `gateSettled(entries, 'ship', treeSha)`, plus the existing base and hold terms. Task 11 then changes the decision it reads to the last disposition.
- The exits:
  - `textual-conflict` exits 1;
  - `index-locked` exits 3 and records `transient`;
  - every other new rule exits 2 and records nothing (`refusalOutcome` returns `undefined`).

**Settled by the first build:**
- `pr-branch-gone` keeps Task 5's `fix`. "Every other new rule" in this task means the carry's rules.

- [ ] **Step 1: Write the failing tests**

```ts
it.each(['carry-only rebase', 'resolved clash', 'refused apply'])('an approved ship gate with no PR re-gates after a %s (P32)', async () => {
  expect(shipPhase(plan, entries, reviewedShaAfterMove, false)).toBe('gate')
})
it('a state-only advance keeps the approval: shipPhase pr')
it.each([['textual-conflict', 1, undefined], ['clash-unresolved', 2, undefined], ['operation-in-progress', 2, undefined],
  ['carry-refused', 2, undefined], ['carry-pending', 2, undefined], ['rebase-refused', 2, undefined],
  ['index-locked', 3, 'transient']])('%s exits %i and records %s', async (rule, code, outcome) => {
  // force each refusal; read the plan stream's last ship-outcome
  expect(r.code).toBe(code)
  expect(lastShipOutcome(repo.root, planId)?.outcome).toBe(outcome)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run `caffeinate -i npx vitest run tests/ship-carry-outcome.test.ts`. Expected: FAIL. Today an approved gate routes to `pr` after a carry.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them and watch them pass**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ship.ts tests/ship-carry-outcome.test.ts
git commit -m "fix: ship re-gates a tree no battery judged since the move; the carry's refusals exit and record per the table (rows 77, 243)"
```

### Task 7: The ship skill, the router, and check's leftover warnings (design §4.1.3 "The ship skill"; §4.1.4)

**Files:**
- Modify:
  - `plugin/skills/witness-ship/SKILL.md:46-66`;
  - `plugin/commands/witness.md`;
  - `src/verbs/check.ts`: two `warn` findings;
  - `src/stamp.ts:133`: when the lazy stamp removes a merged plan's worktree, it also deletes that plan's kept refs (§4.1.1 step 10). An abandon keeps them (D168);
  - `tests/skills.test.ts:215-217`;
  - `tests/command.test.ts`.
- Test: `tests/check.test.ts` (extend)

**Interfaces:**
- New `warn` findings in check: `autostash-left` and `witness-ref-left`. Check's exit is unchanged (row 139).

**Copy fixed by the design:**
- **The skill**
  - It names `textual-conflict` and `clash-unresolved`, never `semantic-conflict`.
  - It carries the clash steps: the per-file remedies, then test through `$WITNESS turn`, then re-run ship, which re-gates.
  - It carries the replay steps:
    1. commit the uncommitted work first;
    2. `git rebase <remote>/<branch>`, resolve, `git add`, `git rebase --continue`;
    3. test through `$WITNESS turn`;
    4. re-run `witness ship`, which pushes under its own lease, so there is no hand push.
  - Its CI-red bullet becomes "commit, then re-run `witness ship`".
- **The router** gains a line each for `clash-unresolved`, `carry-pending`, `carry-refused`, `operation-in-progress` and `rebase-refused`.
- **Check** warns once per shared stash entry whose subject matches `^On witness/(.+): autostash$`.
  - The entry is named by its sha.
  - The drop is prose for the human, never a runnable row: find its `stash@{N}` with `git stash list --format='%gd %H'`.
  - The human's own `On main: autostash` entries are skipped.
  - It also warns for the kept refs of an abandoned plan, and for the carry ref of a plan not in progress.

**Settled by the first build:**
- `witness-ref-left` warns for the kept refs of plans that are abandoned, done or no longer a plan, and for the carry refs of any plan not in progress.
- A test's autostash entry is built as git's autostash builds it: the stash commit's subject is "On witness/<plan>: autostash" (the reflog message is just "autostash").
- Row 218's skill pin moves to the new step text ("Test through `$WITNESS turn -- <test command>`; the resolution must be green before it travels.").

- [ ] **Step 1: Write the failing tests**

```ts
// skills.test.ts — replaces :215-217
it('the ship skill names textual-conflict and clash-unresolved, never semantic-conflict, and no hand --force-with-lease', () => {
  const s = skill('witness-ship')
  expect(s).toMatch(/textual-conflict/); expect(s).toMatch(/clash-unresolved/)
  expect(s).not.toMatch(/semantic-conflict|--force-with-lease/)
})
// check.test.ts — the entries are built in the test's own tmp repo with `git stash store -m "On witness/p1: autostash" <sha>`
it('warns per witness autostash entry by sha with the drop as prose; skips On main: autostash; exit unchanged')
it('warns for an abandoned plan\'s kept ref and for a carry ref of a plan not in progress')
it('a merged plan\'s kept refs are deleted by the stamp; an abandoned plan\'s stay, and check warns')
```

- [ ] **Step 2: Run them and watch them fail**

Run `caffeinate -i npx vitest run tests/skills.test.ts tests/command.test.ts tests/check.test.ts`. Expected: FAIL.

- [ ] **Step 3: Write the text and the two findings**

- [ ] **Step 4: Run them and watch them pass**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/skills/witness-ship/SKILL.md plugin/commands/witness.md src/verbs/check.ts src/stamp.ts tests/skills.test.ts tests/command.test.ts tests/check.test.ts
git commit -m "docs: the ship skill's clash and replay steps; check warns of witness leftovers (row 243)"
```

- [ ] **Step 6: Slice close** (Global Constraints), for Slice 1.

---

## Slice 2 — #87: one derivation (row 244, part 1)

### Task 8: `liveActs`, every legal act from one pure derivation (design §4.2.1, §4.2.2, and §4.2.3's "one pairing")

**Files:**
- Modify:
  - `src/rounds.ts`: add `disposedRun`, `standingHandBack`, `liveActs`, `actKey`, `actLive`.
  - `src/journal.ts:20-38`: add `'revise-returned'` to `EntryType`, plus `ReviseReturnedEntry`.
  - `src/progress.ts:10`: `'revise-returned': 'act'`.
- Test: `tests/live-acts.test.ts`

**Interfaces (produced):**

```ts
export interface ReviseReturnedEntry { v: 1; t: 'revise-returned'; gate: string; artifact: string; run_id: string; sha: string; manual?: true }
export interface ActFacts {
  upstream: string | undefined   // the parent a send-upstream names; undefined = none
  stale: boolean                 // content moved since the anchor run
  holdLifted: boolean            // a hold lifted since the anchor run (row 179)
  owed: boolean                  // row 241's owed work: open step, plan reopen, evidence row, upstream work
  upstreamOwed: boolean          // the gate's own latest revise is upstream and its work is still owed there (P48)
}
export type GateStateKind = 'none' | 'pending' | 'revised' | 'handed-back' | 'handed-back-moved' | 'at-bound' | 'settled' | 'retracted' | 'parked'
export interface LiveActs { state: GateStateKind; anchor?: GateRunEntry; acts: Act[]; malformedRerun: boolean; session?: string }
export function disposedRun(entries: Entry[], gate: string): { run: GateRunEntry; at: number } | undefined
export function standingHandBack(entries: Entry[], gate: string): ReviseReturnedEntry | undefined
export function liveActs(gate: string, target: string, entries: Entry[], facts: ActFacts): LiveActs
export function actKey(act: Act | readonly string[]): string
export function actLive(live: LiveActs, key: string): boolean
```

**The rules:**
- **The pairing.** `disposedRun` is the latest run that is not malformed and comes before the gate's latest revise. Every staleness read and changed-nothing check pairs through it (§4.2.3).
- **The standing hand-back.** `standingHandBack` holds when the latest disposition after the disposed run is a revise, a `revise-returned` naming that run's `run_id` follows it, and no later run that is not malformed and no later disposition has come since (§4.2.5).
- **Membership keys:**
  - for `decide`: the verb plus `--override`, `--repair` and `--upstream`;
  - for `gate`: the verb plus `--fresh` and `--unchanged`;
  - `abandon`.

  Notes, `--pin`, `--via` and `--trust-cmds` never count. Below the bound, `decide --approve` and `decide --approve --override` are one act (D122).
- **State precedence:**
  1. `none`;
  2. `parked`;
  3. `at-bound`;
  4. `settled`;
  5. after a revise: `retracted`, else `handed-back` or `handed-back-moved`, else `revised`;
  6. `pending`.

  A malformed run after the revise keeps the state's acts, puts `gate <g> <t>` first, and sets `malformedRerun`.

**Settled by the first build:**
- The corner states of §4.2.9:
  - only malformed rounds;
  - `abandon-effort` as the last disposition;
  - retracted on moved content;
  - revised with a lifted hold;
  - where the malformed lead applies.
- The table test compares `a.argv.join(' ')`, since argv holds no `witness`.
- `ReviseReturnedEntry` lives in `src/journal.ts`, and `rounds.ts` imports its type.

- [ ] **Step 1: Write the failing test**

This table copies §4.2.2. `j.*` builds journals from compact helpers: `run(n, outcome, blocking?)`, `dec(decision, extra?)`, `back(runId)`. Upstream `e1` exists, and a blocking finding stands on the anchor.

```ts
const A = (...xs: string[]) => xs   // argv joined with ' '
const CASES: Array<[string, Entry[], Partial<ActFacts>, GateStateKind, string[]]> = [
  ['pending', j.pending, {}, 'pending',
    A('decide implement p1 --approve', 'decide implement p1 --revise', 'decide implement p1 --revise --upstream e1', 'decide implement p1 --stop')],
  ['pending, stale', j.pending, { stale: true }, 'pending',
    A('gate implement p1', 'decide implement p1 --revise', 'decide implement p1 --revise --upstream e1', 'decide implement p1 --stop')],
  ['revised (after a stop, after a malformed round, repair, un-park, reopen by caused_by)', j.revised, {}, 'revised',
    A('decide implement p1 --approve --override', 'decide implement p1 --stop', 'decide implement p1 --revise --upstream e1',
      'gate implement p1 --fresh', 'decide implement p1 --revise --note <why>')],
  ['revised, the author edited', j.revised, { stale: true }, 'revised', A('gate implement p1')],
  ['revised, the latest revise upstream', j.revisedUp, {}, 'revised',
    A('decide implement p1 --approve --override', 'decide implement p1 --stop', 'gate implement p1 --fresh', 'decide implement p1 --revise --note <why>')],
  ['handed back', j.back, {}, 'handed-back',
    A('decide implement p1 --approve --override', 'decide implement p1 --stop', 'decide implement p1 --revise --upstream e1',
      'gate implement p1 --fresh', 'decide implement p1 --revise --note <why>')],
  ['handed back, content moved', j.back, { stale: true }, 'handed-back-moved',
    A('gate implement p1', 'decide implement p1 --stop', 'decide implement p1 --revise --upstream e1', 'decide implement p1 --revise --note <why>')],
  ['handed back, a hold lifted', j.back, { holdLifted: true }, 'handed-back-moved',
    A('gate implement p1', 'decide implement p1 --stop', 'decide implement p1 --revise --upstream e1', 'decide implement p1 --revise --note <why>')],
  ['revised at the bound', j.revisedAtBound, {}, 'at-bound',
    A('decide implement p1 --approve --override', 'decide implement p1 --revise --upstream e1', 'decide implement p1 --revise --repair',
      'decide implement p1 --stop', 'abandon p1')],
  ['settled by an approve', j.approved, {}, 'settled', A('decide implement p1 --revise --note <why>')],
  ['settled by a pass', j.passed, {}, 'settled', A('decide implement p1 --revise --note <why>')],
  ['retracted', j.retracted, {}, 'retracted',
    A('gate implement p1 --fresh', 'decide implement p1 --approve --override', 'decide implement p1 --stop', 'decide implement p1 --revise --note <why>')],
  ['parked, nothing owed', j.parked, {}, 'parked', A('decide implement p1 --revise --note <why>', 'gate implement p1 --fresh')],
  ['parked, work owed', j.parked, { owed: true }, 'parked', A('decide implement p1 --revise --note <why>')],
]
it.each(CASES)('%s', (_n, entries, f, state, acts) => {
  const live = liveActs('implement', 'p1', entries, { upstream: 'e1', stale: false, holdLifted: false, owed: false, upstreamOwed: false, ...f })
  expect(live.state).toBe(state)
  expect(live.acts.map((a) => a.argv.slice(1).join(' '))).toEqual(acts)
})
it('a malformed round after the revise keeps the offers and leads with the free re-run', () => {
  const live = liveActs('implement', 'p1', j.revisedThenMalformed, facts)
  expect(live.malformedRerun).toBe(true)
  expect(live.acts[0]!.argv.slice(1).join(' ')).toBe('gate implement p1')
})
it('the pairing skips malformed runs: a revise after a malformed round disposes of the run before it (P45, P50)')
it('a hand-back ends at a later non-malformed run or any later disposition; a malformed run leaves it standing (P33)')
it('below the bound, plain --approve is live wherever --approve --override is offered (D122)')
it('no send-upstream once ladderSpent(primary)')
```

- [ ] **Step 2: Run it and watch it fail**

Run `caffeinate -i npx vitest run tests/live-acts.test.ts`. Expected: FAIL with "liveActs is not a function".

- [ ] **Step 3: Implement it in `src/rounds.ts` beside `exitActs`**

Move the body of `reopenActs` (the `parked` acts) and the endgame branch of `exitActs` (the `at-bound` acts) into private helpers that `liveActs` calls. Task 10 then turns `exitActs` and `reopenActs` into thin views over `liveActs`, so the two never call each other.

- [ ] **Step 4: Run it and watch it pass**

Run `caffeinate -i npx vitest run tests/live-acts.test.ts tests/progress.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rounds.ts src/journal.ts src/progress.ts tests/live-acts.test.ts
git commit -m "feat: liveActs — the legal acts of every gate state from one pure derivation (row 244)"
```

### Task 9: `decide` accepts exactly the live acts (design §4.2.1 "What stays in decide", §4.2.3's retraction, §4.2.7)

**Files:**
- Modify:
  - `src/verbs/decide.ts:358-440`: replace `anchorOf`'s revised, endgame and un-park rules with `liveActs`. The row 183 cap-park anchor and the actor rules stay.
  - `src/verbs/next.ts`: add `actFacts`.
- Test: `tests/decide-live.test.ts`

**Interfaces:**
- Consumes `liveActs`, `actKey`, `actLive` and `disposedRun` (Task 8).
- Produces `actFacts(root: string, cfg: Config | undefined, canon: Canon, gate: string, target: string, entries: Entry[], spec: { sha?: string; upstream?: string; holdLifted?: boolean }): ActFacts` in `src/verbs/next.ts`.
  - It computes `owed` through `parkOwed`, and `upstreamOwed` through the reopen the gate's own upstream revise made (`openReopen`), or for decompose through a recap after the revise.
  - The caller passes the values that come from `gateSpec`, since `next.ts` cannot import `gate.ts`.
- **Acceptance.** An act that is not live refuses with:
  - `stale-verdict` for an approve on moved content;
  - `repair-spent` and `repair-not-at-bound` for repairs, as today;
  - otherwise `nothing-pending`, whose want is `exitsLine(live.acts)`.

  The anchor is `live.anchor`.
- **New refusals:**
  - `note-required`: a plain `--revise` (no `--upstream`, no `--repair`) without `--note`, in the revised, handed-back and settled states.
  - `revise-human`: the revise again and the retraction, refused for `selected: 'policy' | 'arbiter'` and inside a drive child, on the pattern of rows 205, 207 and 225.

**Settled by the first build:**
- An approve the screens withhold still anchors where a blocker names why: moved content refuses `stale-verdict`, a lifted hold `hold-lifted`, and the bound without `--override` `override-required`. In the settled, parked and none states it is `nothing-pending`.
- `note-required` and `revise-human` also cover the retracted state.
- A second policy revise meets `revise-human` before the anchor rule; `tests/decide.test.ts`'s regex admits it.
- "After a plain revise the recommended act lands" belongs to Task 10, and "gate --fresh re-judges after the retraction" to Task 11.

- [ ] **Step 1: Write the failing tests**

```ts
// STATES: Task 8's journals, written into seededRepo streams; `offered(state)` = liveActs' acts for it
it.each(STATES)('%s: every offered act lands or refuses with a rule its screen states (human)', async (name) => {
  for (const act of offered(name)) {
    const r = await freshCopy(name).cli(act.argv.slice(1))
    expect(r.code === 0 || stated(name).includes(ruleOf(r.stderr))).toBe(true)
  }
})
it('#87\'s journal: every act --show lists lands (P3 inverted)')
it('after a plain revise the recommended act lands (P3)')
it('after an approve and a reopen, the offered approve and stop land (P24)')
it('a gate settled by a pass: the retraction lands, then gate --fresh re-judges (P8, P23)')
it.each(['revised', 'handed back', 'settled'])('a bare --revise in the %s state refuses note-required', ...)
it('revise again with a note refuses revise-human for policy, arbiter and a drive child')
it('a second repair in a window is not offered and refuses repair-spent')
```

- [ ] **Step 2: Run them and watch them fail**

Run `caffeinate -i npx vitest run tests/decide-live.test.ts`. Expected: FAIL with `nothing-pending` on offered acts.

- [ ] **Step 3: Implement the acceptance above**

- [ ] **Step 4: Run them and watch them pass**

Run `caffeinate -i npx vitest run tests/decide-live.test.ts tests/decide.test.ts tests/decide-show.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/decide.ts src/verbs/next.ts tests/decide-live.test.ts
git commit -m "fix: decide accepts exactly the acts liveActs offers (row 244, #87)"
```

### Task 10: Every screen reads `liveActs` (design §4.2.1 "Who reads it"; §4.2.2's session line)

**Files:**
- Modify:
  - `src/rounds.ts:337-415`: `exitActs` and `reopenActs` become views over `liveActs`.
  - `src/recommend.ts`: options are drawn only from `liveActs`.
  - `src/gate.ts:301-307`: the parked hint.
  - `src/gate.ts:440-446`: the `settled-approve` want names the retraction, then `gate --fresh`.
  - `src/gate.ts:488-494`: the changed-nothing screen prints `live.session` and the live acts.
  - `src/decide-view.ts:36-112`: a new `handed-back` state; every state's exits come from `liveActs`.
  - `src/needs-you.ts`: the decision rows.
  - `src/arbiter.ts:123-131`: `menuFor` reads `liveActs`.
- Test:
  - new: `tests/screens-live.test.ts`;
  - update: `tests/decide-view.test.ts`, `tests/needs-you.test.ts`, `tests/exits-line.test.ts:294`.

**Interfaces:**
- `LiveActs.session` holds the session's line:
  - in the revised state: "change the work and re-run the gate, or hand it back with `--unchanged`";
  - in the handed-back-moved state: "change nothing more; the re-gate judges what moved";
  - in the retracted state: "re-review with `gate --fresh` (it spends a round), or change the work and re-run the gate".

**Settled by the first build:**
- `menuFor` and `needsYou` render recommend's block, whose options come only from liveActs, so they need no edit of their own.
- The upstream slot `--revise --upstream <effort>` stays accepted: it is held in `LiveActs.slots`, `actLive` accepts it, and exits lines leave it out.
- On moved content:
  - a settled gate offers the re-gate;
  - the revised state renders no block;
  - a retracted state leads with the plain re-gate.
- decide-view and gate's choices read staleness and lifted holds through `actFacts`, against the last run that judged something, and `actFacts` computes `holdLifted` itself (S2-1).
- `gateParked` reads the last run that judged something (S2-2).
- `settled-approve` fires only for the content the approve judged (S2-3).
- `parkedActs` passes staleness to the endgame (S2-5).
- The implement-revised and settled goldens are re-recorded by hand with a row-244 note, never with `-u`.
- Tests to add:
  - a malformed re-review leaves a park standing;
  - on moved content a settled gate runs `--fresh`;
  - a gate parked at the bound on moved content offers no approve;
  - decide-view's staleness reads the last run that judged something.

- [ ] **Step 1: Write the failing test**

```ts
it.each(STATES)('%s: every act on every screen is live', (name) => {
  const live = liveActs('implement', 'p1', journal(name), facts(name))
  const shown = [...exitActsOf(name), ...recommendOptionsOf(name), ...decideViewExitsOf(name), ...needsYouActsOf(name),
    ...menuForOf(name), ...wantActsOf(name)]
  for (const a of shown) expect(actLive(live, actKey(a))).toBe(true)
})
it('gate --fresh on a settled gate names the retraction, then gate --fresh (P8)')
it('decide --show on a handed-back gate shows state handed-back')
```

- [ ] **Step 2: Run it and watch it fail**

Run `caffeinate -i npx vitest run tests/screens-live.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run it and watch it pass**

Run `caffeinate -i npx vitest run tests/screens-live.test.ts tests/decide-view.test.ts tests/needs-you.test.ts tests/exits-line.test.ts tests/recommend.test.ts tests/arbiter.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rounds.ts src/recommend.ts src/gate.ts src/decide-view.ts src/needs-you.ts src/arbiter.ts tests/screens-live.test.ts tests/decide-view.test.ts tests/needs-you.test.ts tests/exits-line.test.ts
git commit -m "fix: every screen, hint, refusal and the arbiter's menu offer only live acts (row 244)"
```

### Task 11: The old bugs: the last disposition, the retraction, a malformed round after a revise (design §4.2.3)

**Files:**
- Modify:
  - `src/ship.ts:48-61`: `shipPhase` reads the last disposition.
  - `src/rounds.ts:463-503`: `revisedAfter` reads the last disposition after the disposed run, and `repairsOnRegate` and `appendKind` pair through `disposedRun`.
  - `src/verbs/next.ts:51-78`: `gateSettled` reads the last disposition after a pass too.
  - `src/recommend.ts:196`: the revised-state rules match before `malformed-rerun` when a revise follows the malformed run.
- Test:
  - new: `tests/ship-phase-disposition.test.ts`;
  - update: `tests/rounds.test.ts:72-84`, adding a revise-then-approve case; `tests/recommend.test.ts`.

**Settled by the first build:**
- `appendKind` repairs every malformed last round, the legacy [malformed, revise] journal included (S2-4).
- `gateSettled` reads the last disposition after a pass, so a stop after a pass reads parked.

- [ ] **Step 1: Write the failing tests**

```ts
it('ship: a revise, then an approve on unchanged content → shipPhase pr, and witness ship opens the PR (P9)')
it('appendKind after a revise then an approve under the same key → resume, not changed-nothing')
it('a retraction after a pass un-settles the gate, and gate --fresh runs (P23)')
it('a revise after a malformed round: the revised-state rule matches first (P45)')
it('content edited between a stopped run and a malformed one: the re-gate runs, never changed-nothing (P50)')
```

- [ ] **Step 2: Run them and watch them fail**

Run `caffeinate -i npx vitest run tests/ship-phase-disposition.test.ts tests/rounds.test.ts tests/recommend.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them and watch them pass**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ship.ts src/rounds.ts src/verbs/next.ts src/recommend.ts tests/ship-phase-disposition.test.ts tests/rounds.test.ts tests/recommend.test.ts
git commit -m "fix: ship and the cache read a gate's last disposition; a retraction un-settles a pass (rows 77, 94, 126, 209, 244)"
```

- [ ] **Step 6: Slice close** (Global Constraints), for Slice 2.

---

## Slice 3 — #87: handing a revise back (row 244, part 2)

### Task 12: `witness gate <gate> <target> --unchanged` (design §4.2.4)

**Files:**
- Modify:
  - `src/verbs/gate.ts`: parse `--unchanged`.
  - `src/cli.ts:97`: the usage line becomes `witness gate <decompose|plan|implement|ship|design> <target> [--fresh] [--manual] [--unchanged]`.
  - `src/gate.ts`: `runGate` gains `flags.unchanged?: boolean`; the refusals run before `judge`; `judge`'s changed-nothing branch journals.
  - Every stage skill and `plugin/commands/witness.md`: the hand-back line.
  - `tests/skills.test.ts` and `tests/command.test.ts`.
- Test: `tests/gate-unchanged.test.ts`

**Interfaces:**
- **Refusals** (exit 2). Each is read from the journal before `judge`, so nothing is spent:
  - `nothing-to-hand-back`;
  - `upstream-owed` (`ActFacts.upstreamOwed`);
  - `retraction-owed`, naming `gate --fresh`;
  - `hand-back-standing`;
  - `hand-back-at-bound`.

  The design names only `nothing-to-hand-back` and `retraction-owed`; the other three names are decided here.
- **What it journals.** Where `appendKind` answers changed-nothing and the current key is the disposed run's key, it journals `{ v: 1, t: 'revise-returned', gate, artifact, run_id: disposedRun.run_id, sha: reviewedSha }`, plus `manual: true` under `--manual`.
- **A flip or a moved key** runs as the plain gate would and prints `note: nothing was handed back — <why>`.
- **The hand-back line** for every stage skill and the router: "when you judge there is nothing to change, hand the revise back with `$WITNESS gate <gate> <target> --unchanged`, and never `decide`".

**Settled by the first build:**
- The refusals map from liveActs' state, as §4.2.9 lists them.
- A hand-back is journaled only when `appendKind`'s changed-nothing names the disposed run. Anything else runs as the plain gate and prints `note: nothing was handed back — <why>`.
- The hand-back's screen prints `outcome: handed back — …` and, with autonomy off or a stop left to the human, the decision block. It exits 1.
- `--unchanged` takes row 240's settled token over the decisions after the disposed run at its refusal read, carries it into `judge`, and checks it again under the lock: the same disposed run, the same token, no run since, and no hand-back standing. A mismatch refuses `settled-since`, exit 2 (S3-1).
- The changed-nothing screen reads liveActs through `actFacts`, and recommend's revised re-gate row never names `--unchanged` (S3-2).
- `appendKind` pairs through the disposed run while no run that judged something follows the latest revise (S3-3).
- Tests to add:
  - a decision that lands between `--unchanged`'s read and its write refuses `settled-since`, and nothing is handed back;
  - the changed-nothing screen leaves out the hand-back hint while upstream work is owed;
  - a malformed round on other content leaves the pairing, so `--unchanged` hands back.

- [ ] **Step 1: Write the failing tests**

```ts
it('hands back: journals revise-returned for the disposed run; autonomy off exits 1 with the decision row', async () => {
  const r = await repo.cli(['gate', 'implement', planId, '--unchanged'], { env })
  expect(r.code).toBe(1)
  const e = readStream(repo.root, planId).filter((x) => x.t === 'revise-returned')
  expect(e).toEqual([expect.objectContaining({ gate: 'implement', run_id: stoppedRun, sha: reviewedSha })])
})
it('--manual journals manual: true')
it('a plain re-run stays changed-nothing and journals nothing (V1)')
it('a check that flipped runs a cached round and says nothing was handed back (P11)')
it.each([['no revise', 'nothing-to-hand-back'], ['own upstream revise still owed', 'upstream-owed'],
  ['a retraction', 'retraction-owed'], ['one standing', 'hand-back-standing'], ['at the bound', 'hand-back-at-bound']])(
  '%s refuses %s with exit 2 and journals nothing')
it('decompose\'s upstream revise refuses until a recap lands after it (P48)')
it('a revise left open across the upgrade (run key witness 0.29.0) runs a fresh round and says nothing was handed back (Review Focus)')
it('every stage skill and the router carry the hand-back line')
```

- [ ] **Step 2: Run them and watch them fail**

Run `caffeinate -i npx vitest run tests/gate-unchanged.test.ts`. Expected: FAIL. `--unchanged` is ignored.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them and watch them pass**

Run `caffeinate -i npx vitest run tests/gate-unchanged.test.ts tests/skills.test.ts tests/command.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/gate.ts src/cli.ts src/gate.ts plugin/skills plugin/commands/witness.md tests/gate-unchanged.test.ts tests/skills.test.ts tests/command.test.ts
git commit -m "feat: witness gate --unchanged hands a revise back (row 244, #87)"
```

### Task 13: One owed predicate: the standing hand-back (design §4.2.5)

**Files:**
- Modify:
  - `src/verbs/next.ts:92-117`: `owedRun`, and `authoringOwed`, whose hand-back check comes before its reopen check.
  - `src/verbs/next.ts:890-990`: `owedDecisions`, `owedFrom`, `pendingDecisionsAll` and `flowBlocked`.
  - `src/settle.ts:344` (`settleOwed`) and `src/needs-you.ts:128`.
  - `src/ship.ts:685`: the awaiting-decision block passes content staleness.
  - `src/verbs/check.ts`: `gate-awaiting-decision`.
  - `src/verbs/dashboard.ts:369-386`.
  - `src/recommend.ts:220`: `stale-below-bound` admits a standing hand-back and offers the moved row, re-gate first.
- Test: `tests/handback-owed.test.ts`

**Interfaces:**
- Every reader calls `standingHandBack` (Task 8). Nothing else decides whether a hand-back is owed.

**Settled by the first build:**
- One predicate, `decisionOwed`, lives in `rounds.ts`: the pending run, or else the run a standing hand-back names. It replaces `pendingDecision` in `owedRun`, `flowBlocked`, `pendingDecisionsAll`, check's `gate-awaiting-decision` and status's gates table. `settle.ts` and `needs-you.ts` read through those.
- Status's gates row says `handed back`.
- `shipPhase` returns awaiting-decision for a standing hand-back, with or without a PR.

- [ ] **Step 1: Write the failing tests**

```ts
it('a standing hand-back is owed to owedRun, owedDecisions, settleOwed, needsYou, next tier 2, flowBlocked, check and status (P10)')
it('authoringOwed is false while it stands; next stops routing the edit')
it('content moved since the hand-back: recommend offers the moved row with the re-gate first (P34)')
it('ship with a standing hand-back reads awaiting-decision, not "revise owed"')
```

- [ ] **Step 2: Run them and watch them fail**

Run `caffeinate -i npx vitest run tests/handback-owed.test.ts`. Expected: FAIL. `owedDecisions` is empty.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them and watch them pass**

Run `caffeinate -i npx vitest run tests/handback-owed.test.ts tests/next.test.ts tests/needs-you.test.ts tests/check.test.ts tests/dashboard.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/next.ts src/settle.ts src/needs-you.ts src/ship.ts src/verbs/check.ts src/verbs/dashboard.ts src/recommend.ts tests/handback-owed.test.ts
git commit -m "feat: a standing hand-back is owed to every reader (rows 94, 173, 244)"
```

### Task 14: The `revise-returned` rule, its policy arm, and the arbiter (design §4.2.6)

**Files:**
- Modify:
  - `src/recommend.ts`: the new rule comes after `stale-below-bound`, and before `malformed-rerun` when a revise follows the malformed run. It carries `anchor: <primary>`.
  - `src/autonomy.ts:95-115`: the new arm, outside `TAKEN` (:65).
  - `src/arbiter.ts:123-138`: the menu.
  - `src/arbiter.ts:169-186`: `decisionEvidence`.
- Test: extend `tests/recommend.test.ts`, `tests/autonomy.test.ts` and `tests/arbiter.test.ts`.

**Interfaces:**
- **The rule `revise-returned`.** It recommends send-upstream when the blocking finding's anchor is in the parent and D123's ladder is not spent; otherwise it recommends park.
- **The arm.** `policyFor` sends it to the arbiter, but only after the trust-grant, stale or malformed re-run, fallen-back re-run, design-look and granted-trust arms.
- **The menu.** `menuFor` drops every plain revise for this rule, the noted one included. It keeps `--revise --upstream`, and it still filters approve on failed checks or at a design gate.
- **The evidence.** `decisionEvidence` adds the fact "the author handed this revise back with the content unchanged". It is a journal fact, not narration (anti-goal 1).
- **`manual: true`.** Such a hand-back goes to the human in every settle that reads it.

**Settled by the first build:**
- The tests live in one file, `tests/handback-arbiter.test.ts`.
- The handed-back-moved row carries rule `stale-below-bound`.
- A manual hand-back reaches the human through settle's `judgeStop` (which returns none) and gate's `leftToTail`, both reading `standingHandBack(...).manual`.

- [ ] **Step 1: Write the failing tests**

```ts
it('recommend on a hand-back: rule revise-returned, anchor = primary; upstream when the anchor is in the parent, else park')
it('policyFor sends revise-returned to the arbiter after the trust, re-run and design-look arms')
it('the arbiter is never offered a plain revise or --revise --note for this rule (P38)')
it('an upstream taken from the moved row journals its anchor, so ladderSpent counts it (P47)')
it('decisionEvidence carries the hand-back fact and no author narration')
it('a manual hand-back goes to the human')
it('autonomy on: gate --unchanged settles at once under the settle lock; the exit is the settle\'s')
it.each(STATES)('%s: every act on the arbiter\'s menu lands as selected: arbiter (§4.2.1\'s state walk)')
```

- [ ] **Step 2: Run them and watch them fail**

Run `caffeinate -i npx vitest run tests/recommend.test.ts tests/autonomy.test.ts tests/arbiter.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them and watch them pass**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recommend.ts src/autonomy.ts src/arbiter.ts tests/recommend.test.ts tests/autonomy.test.ts tests/arbiter.test.ts
git commit -m "feat: a handed-back revise goes to the arbiter, who never revises it again (rows 121, 171, 172, 244)"
```

- [ ] **Step 6: Slice close** (Global Constraints), for Slice 3.

---

## Slice 4 — #80: a session ends when its turn ends (row 245)

### Task 15: The turn's end in the worker streams (design §4.3 "The end signal", "What cancels it")

**Files:**
- Modify `src/worker-stream.ts`:
  - the `WorkerStream` interface (:25-31);
  - `piStream` (:214-270);
  - `claudeStream` (:291-…);
  - a new `envelopeStream`.
- Test: `tests/worker-stream.test.ts`

**Interfaces:**
- `WorkerStream` gains:
  - `ended(): boolean`: an end signal stands. A run-starting record clears it.
  - `started(): boolean`: a run-starting record has been seen.
- `envelopeStream(): WorkerStream` is for claude json reviewers. `ended()` turns true once a record parses as an object with `type === 'result'`, and `started()` is always true.
- **The end signals:**
  - pi: `agent_settled`;
  - claude: a top-level `result` (no `parent_tool_use_id`) while no backgrounded call is open.
- **Run-starting records:**
  - pi: `agent_start`, `turn_start`, `message_start`, `tool_execution_start`, `compaction_start`, `auto_retry_start`;
  - claude: `system:init`, `assistant`, `user`, and a `system:task_started` or `task_updated` marking `is_backgrounded`.

  Non-JSON lines and `queue_update`, `entry_appended` and `session_info_changed` never clear `ended()`.

**Settled by the first build:**
- claude's `started()` turns true at `system:init`. A top-level result (no `parent_tool_use_id`, or a null one) ends the turn only when no backgrounded call is open. `envelopeStream` reports `failed` from the envelope's `is_error`.
- pi's `message_start` counts as a run start only for a user, assistant or toolResult message (S4-3).
- Test to add: an extension's custom message after `agent_settled` neither cancels the grace nor counts as a start.

- [ ] **Step 1: Write the failing tests**

```ts
it('pi: agent_end, agent_settled → ended(); a later turn_start clears it (P4, P18)', () => {
  const s = piStream(home)
  for (const r of ['{"type":"agent_start"}', '{"type":"agent_end","messages":[]}', '{"type":"agent_settled"}']) s.line(r)
  expect(s.ended()).toBe(true)
  s.line('{"type":"turn_start"}')
  expect(s.ended()).toBe(false)
})
it('pi: queue_update, entry_appended, session_info_changed and non-JSON lines never clear it (P17, P49)')
it('pi: started() stays false through the header and extension records, and turns true at agent_start (P27, P49)')
it('claude: a top-level result ends; one with parent_tool_use_id does not; an open backgrounded call holds the end until its task ends')
it('envelopeStream: ended once a type:result object parses')
it('an agent_settled record split across two chunks, with CRLF, ends the turn (Review Focus)', () => {
  const s = piStream(home); const sink = lineSink((r) => s.line(r))
  sink.push('{"type":"agent_start"}\r\n{"type":"agent_se'); sink.push('ttled"}\r\n')
  expect(s.ended()).toBe(true)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run `caffeinate -i npx vitest run tests/worker-stream.test.ts`. Expected: FAIL with "s.ended is not a function".

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them and watch them pass**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker-stream.ts tests/worker-stream.test.ts
git commit -m "feat: the worker streams say when a turn has ended (row 245)"
```

### Task 16: A drive session ends 60 s after its turn ends (design §4.3: the grace, the timeout, the tail, the stop, the status, the `ended` line, never started)

**Files:**
- Create: `src/session-end.ts`
- Modify: `src/drive.ts:205-410` (`spawnSession`); `SessionEnd` (:115) gains `ending?: EndCause`.
- Test:
  - new: `tests/drive-turn-end.test.ts`;
  - update: `tests/drive.test.ts:386`.

**Interfaces (produced):**

```ts
export const END_GRACE_MS = 60_000
export type EndCause = 'turn-ended' | 'never-started'
export interface EndWatch { heard(awakeMs: number): void; due(awakeMs: number): EndCause | undefined; graceRunning(): boolean }
export function endWatch(stream: WorkerStream, o: { neverStartedMs?: number }): EndWatch
export function endedHow(cause: EndCause, atDeadline: boolean, failed: boolean): string
```

**The exact copy from the design** (`endedHow`):
- `turn ended · the process did not exit — stopped after 60s`, with ` (error)` appended when `failed`;
- `turn ended · the process did not exit — stopped at the deadline`, with ` (error)` appended when `failed`;
- `never started · stopped after 5m`.

**How `spawnSession` uses it:**
- `const watch = endWatch(stream, { neverStartedMs: harness.name === 'pi' ? SESSION_QUIET_MS : undefined })`.
- In the stdout sink, `watch.heard(awakeNow())` runs right after `stream.line(record)` and before the lines are shown.
- `show` pushes nothing into the tail while `watch.graceRunning()`. The line is still printed.
- `tick(awake)` stops the session through `watch.due(awake)`.
- The clock's `expire` ends the session as turn-ended at the deadline while a grace runs, and as `timeout` otherwise.
- **The status after a stop** is `outcome: 'exited'`, with code 1 for `never-started`, 1 for a claude session whose stream failed, and 0 otherwise. It is never the stop's own status.

**Settled by the first build:**
- The turn-end tests use a scaled ticker, not drive.test's fastTicker: awake time is real time × 1000, or × 100 where a real sleep must stay inside a window.
- `endWatch` never throws. A stream that cannot answer reads as not ended and started, so the timeout alone holds.
- The recorded code follows §4.3's settled list.
- The tail admits per record: a record's lines stay out only when a grace ran before it and still runs after it (S4-1).
- Test to add: the record that starts a grace (a claude error result) keeps its usage-limit line in the tail.

- [ ] **Step 1: Write the failing tests**

Fake agents print NDJSON, then `sleep 600`. `stream: piStream(home)` and `fastTicker()` come from `tests/drive.test.ts`.

```ts
it('a pi worker that settles and lingers ends 60 s later: exited, code 0, turn-ended line (P5)', async () => {
  const end = await spawnSession(step, cfg, ctx, 1, { ticker: fastTicker(), stream: piStream(home) })
  expect(end).toMatchObject({ outcome: 'exited', code: 0, ending: 'turn-ended' })
  expect(lines.join('\n')).toMatch(/ended \d\d:\d\d:\d\d · turn ended · the process did not exit — stopped after 60s · /)
})
it('a chatty leaky tail never cancels the grace and never enters the tail (P17)')
it('a turn_start inside the grace cancels it; the next settle arms it again')
it('a deadline inside the grace ends clean: "stopped at the deadline", outcome exited, never timeout')
it('a pi with no run-starting record within 5 min awake: never started, code 1 (P31, P49)')
it('an 8 s before_agent_start handler is not "never started" (P27)')
it('the recorded code is never the stop\'s own status (P46)')
it('the stream\'s error flag keeps " (error)" on the turn-ended line')
it('a follow-up that pi cuts off after agent_settled still meets the timeout (P28)')
```

- [ ] **Step 2: Run them and watch them fail**

Run `caffeinate -i npx vitest run tests/drive-turn-end.test.ts`. Expected: FAIL. Each session runs to its timeout.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them and watch them pass**

Run `caffeinate -i npx vitest run tests/drive-turn-end.test.ts tests/drive.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-end.ts src/drive.ts tests/drive-turn-end.test.ts tests/drive.test.ts
git commit -m "fix: drive ends a session 60 s after its turn ends, not when its process exits (rows 182, 214, 245, #80)"
```

### Task 17: Reviewers and the arbiter end with their turn; drift goes async; the sync invoker retires (design §4.3 "Reviewers and the arbiter")

**Files:**
- Modify:
  - `src/reviewer.ts:120-358`:
    - `InvokeOpts` gains `noWait?: true`, and `ticker?: Ticker` as a test seam;
    - `spawnAttempt` runs an end watch, giving `END_GRACE_MS` and then the stop;
    - `Attempt` gains `stoppedAfterTurn: boolean`;
    - `classifyAttempt` reads the harness's ending status;
    - `invokeReviewer` (:228-251) is deleted.
  - `src/harness.ts`: each harness's `reviewer` names its stream (pi: `piStream`; claude json: `envelopeStream`).
  - `src/drift.ts:144`: `await invokeReviewerAsync(…, { noWait: true })`.
  - Move the sync cases in `tests/reviewer.test.ts` and in `tests/spawn.test.ts:285-356` to the async invoker.
- Test: `tests/reviewer-turn-end.test.ts`

**Interfaces:**
- `noWait` refuses a usage limit at once, as outside drive, which keeps row 182's "the sync lane never waits".
- The status after a stop:
  - pi: 0;
  - claude json: 1 when the envelope's `is_error`, else 0.

**Settled by the first build:**
- The reviewer's end watch has no never-started window, and its grace runs on `opts.ticker`.
- With `noWait`, the usage-limit refusal's want is the outside-drive one, inside drive too.
- The converted sync cases in `tests/spawn.test.ts` are win32-only.
- A reviewer stopped after its turn fails closed on EPIPE, as an exit 0 does (S4-2).
- Test to add: a reviewer whose stdin closed early, and which then settles and lingers, fails closed.

- [ ] **Step 1: Write the failing tests**

```ts
it('a pi reviewer that settles and lingers is stopped after the grace, and its verdict reads ok, not reviewer-timeout (P46)')
it('a claude reviewer whose envelope is complete but whose process lingers: stopped, envelope parsed')
it('a claude error envelope after a stop is the envelope\'s refusal, never reviewer-invocation from SIGTERM')
it('a reviewer that never starts stays on the timeout and retry path')
it('drift: a usage-limited reviewer refuses at once (noWait)')
it('drift and the battery share invokeReviewerAsync; reviewer.ts no longer exports invokeReviewer')
```

- [ ] **Step 2: Run them and watch them fail**

Run `caffeinate -i npx vitest run tests/reviewer-turn-end.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them and watch them pass**

Run `caffeinate -i npx vitest run tests/reviewer-turn-end.test.ts tests/reviewer.test.ts tests/spawn.test.ts tests/arbiter.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reviewer.ts src/harness.ts src/drift.ts tests/reviewer-turn-end.test.ts tests/reviewer.test.ts tests/spawn.test.ts
git commit -m "fix: reviewers and the arbiter end with their turn; drift runs on the async invoker (rows 182, 245)"
```

- [ ] **Step 6: Slice close** (Global Constraints), for Slice 4.

---

## Slice 5 — #76: dropped (decision 13)

#76 closes without witness work: the user runs witness inside a VM themselves. Task 18 (the Windows check) was built first, in 609ec06..ed92f1a; the commit that brought revision 9 removes `scripts/vm-check/`, and the zip in `~/Downloads` is the user's to delete. Task 19 (the README's VM guide) is not built.

---

## Finish

### Task 20: Whole-branch verification, the PR, and release prep

- [ ] **Step 1: Run the checks**

Run the full suite, `npx tsc --noEmit`, the perl scan over `git diff --name-only b92a461..HEAD`, and `grep -rn "remote snapshot\|runner\.local\|runner serve" src tests`. Expected:
- the baseline plus the new tests passed, with no `AssertionError`;
- tsc clean;
- no scan hits;
- no runner-only names: the runner was never built here.

- [ ] **Step 2: The whole-branch review**

Give a fresh opus agent the design doc and `git diff b92a461..HEAD`, and ask for an adversarial review of the whole branch against the real code. Re-run every finding before fixing it, fix what holds, and commit as `fix: the final review's <n> (rows 243–245)`.

- [ ] **Step 3: The Windows checks still owed**

Give the user W9 (the carry on Git for Windows, a file held open) and W10 (#80's stop through the job host); both can run in the user's Windows VM. The rows say MEASURED only after the user reports.

- [ ] **Step 4: The PR, with the user's go**

Draft the PR body in the ledger: one paragraph per issue, then the probes, the deferred items and the owed W-list, ending with `Closes #86, #87, #80` (#76 is already closed, decision 13). With the user's go, push the branch, open the PR, watch CI to green, and comment on each issue with what changed. Then stop. The user merges and runs `pnpm release minor` → 0.30.0.
