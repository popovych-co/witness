# A clash never reaches a gate, every offered act is accepted, and a finished turn ends its session

Date: 2026-11-19 · Status: draft, revision 9. Folded in: the grill (decisions 1–10, one question at a time); a verification pass, whose Windows research against Microsoft's docs reversed decision 3; pass 1 (three opus reviewers on the decision notes); pass 2 (three on revision 1 of this doc); passes 3–5 (two each, on what revisions 2–4 changed); pass 6 (two, on the VM part alone); and the user's decision 12, after the plan, which runs all of witness inside the VM and parks revision 6's runner; pass 7 (two, on revision 7); the build's own rulings and review fixes (§4.1.5, §4.2.9, §4.3); and the user's decision 13, during the rebuild, which closes #76 without witness work and drops everything written or built for it (revision 8, commit ad32f77, keeps it). I re-ran every load-bearing finding or read-confirmed it at the cited line (§3) · Fixes issues #86, #87, #80 (#76 closes without witness work, decision 13) · Release 0.30.0, one release · DESIGN.md rows 243–245 · Evidence: probes P1–P60 and the research W-R (§6)

## 1. Why

There are four open issues; #88–#90 shipped in 0.29.0 (PR #91). #86 and #87 were filed on 2026-11-18 from the same Windows autonomy run that produced #88–#90 (witness 0.28.3, harness `pi`, Windows 11, git 2.56.0.windows.1, `autonomy: on`). #80 and #76 are older; #76 closes without witness work (decision 13).

- **#86.** `rebaseIfMoved` rebases the uncommitted implement tree with `git rebase --autostash` and treats a non-zero exit as the conflict. When re-applying the autostash conflicts, git exits **0**. It leaves the files `UU` with markers and keeps a `stash@{0}: autostash`. Ship then gated the broken tree, twice in one repo: once spending a ship budget's last round, once letting implement rounds re-review markers until the arbiter parked the gate.
- **#87.** After an arbiter's `stop` at the bound and a human's `--revise --repair`, `decide --show` listed four acts and every one refused `nothing-pending`. Meanwhile `ship` answered "revise owed" and `gate ship` answered "revise changed nothing". Only a cosmetic edit moved the flow.
- **#80.** Drive ends a session when its process exits. A pi worker whose turn had ended stayed alive because a third-party extension leaked a ref'd timer (pi-lens's vscode-jsonrpc reader). It held its target and slot until `drive.sessionTimeoutMs`: 1 h 20 min and 35 min in the issue. pi's print mode never calls `process.exit()`, and the json stream already says the turn is over.
- **#76.** wot-mod-manager's client suite opens the real desktop app on the user's desktop for every test run. It closes without witness work (decision 13): with all of witness running inside a Windows VM on the user's PC, the app opens on the VM's screen.

Each cause below was checked against the code at main (b92a461, 0.29.0) or by a probe (§6):

- **#86.**
  - P1 reproduces the exit 0 on Apple git 2.50.1. `rebaseIfMoved` (`src/ship.ts:262-310`) states the opposite in its own comment (:291-295).
  - No verb refuses a tree with unmerged entries.
  - The ship skill's conflict steps (`plugin/skills/witness-ship/SKILL.md:46-66`) have three problems:
    - they name a refusal the CLI never prints (`semantic-conflict`; the CLI's rule is `textual-conflict`);
    - they cannot run on the uncommitted gate-phase tree, nor on a PR-phase tree that holds an uncommitted fix (P26);
    - they end, like the CI-red bullet (:47), in a hand `--force-with-lease` that leases on the tracking ref. Row 242 retired that hazard for witness's own pushes.
- **#87: two rules, one for the screens and one for the door.** `decide` accepts an act only if `anchorOf` (`src/verbs/decide.ts:380-408`) finds a run for it. The screens build their acts elsewhere: `exitActs` and `reopenActs` (`src/rounds.ts:337-415`), `recommend` (`src/recommend.ts`), gate's parked hint (`src/gate.ts:301-307`), and the refusal wants. In #87's journal D94's revised anchor fails because a stop sits between the run and the revise, and row 241's un-park reading does not cover a repair revise (`decide.ts:332`). So all four offered acts refuse (P3). The class is wider than the issue:
  - after any plain revise, the **recommended** `--revise` refuses (P3);
  - after an approve plus a reopen, the offered approve and stop refuse (P24);
  - a gate settled by a **passing** run offers four acts that all refuse (P23);
  - the retraction `gate --fresh` names refuses after an approve (P8) and after a pass (P23);
  - an approve after a revise on unchanged ship content never ships. `shipPhase` reads the first decision after the run (`src/ship.ts:50-56`), and `appendKind`'s `revisedAfter` reads any revise rather than the last disposition (`src/rounds.ts:461-463`, `:503`) (P9).
- **#80.**
  - P4 shows pi's stream ending `agent_end` → `agent_settled`.
  - P5 reproduces the hang with a scratch extension holding a `setInterval`: `agent_settled` at 656 ms, the process alive at 20 s.
  - pi 1.4.0, the reporter's version, writes `agent_settled` the same way (P18).
  - `spawnSession` settles only on `exit`/`close` (`src/drive.ts:205-410`).
  - The reviewer and arbiter invokers wait for exit under a timeout (`src/reviewer.ts:200-358`). So a finished reviewer that lingers reads as `reviewer-timeout` after its retries, and one stopped after its turn ended exits by signal and reads as `reviewer-invocation` (P46).

**Decided by the user**, one question at a time:
1. **A clash on the moved base (#86).** It stays in the files for the session or the human to resolve. Witness keeps its backup of the work in a witness-only ref, never on git's shared stash list. Every gate, test run and ship refuses while a clash is unresolved.
2. **A revise the author hands back unchanged (#87).** It goes back to the **arbiter** (autonomy on), not "stuck · retry". The user picked this over my recommendation (that the human decides), accepting that the arbiter may overrule a revise the human chose.
3. **Tests real and off the screen (#76).** The first pick was a second Windows account kept signed in in the background. The verification pass showed that such a session has no live input desktop (W-R), so the user revised it to **a machine with a live screen** where witness sends the test runs. *(Dropped by 13.)*
4. **The test machine unavailable (#76).** Drive pauses, notifies and resumes by itself. It never falls back to the user's desktop. *(Superseded by 12; dropped by 13.)*
5. **Getting the code there (#76).** Copy only what changed since the last run (git snapshots over the runner's own connection). The machine keeps its own installed packages and build output. The user rejected a shared network folder. *(Superseded by 12; dropped by 13.)*
6. **Who hands a revise back (#87, after pass 1).** Only an explicit act (`witness gate … --unchanged`). Drive never hands one back for a session.
7. **One design doc and one plan** for all four issues *(three after 13)*.
8. **One release** at the end, knowing #86, #87 and #80 then wait for #76. *(After 13 nothing waits: 0.30.0 carries #86, #87 and #80.)*
9. **Revising again (#87, after pass 2).** A human may send a handed-back revise back once more with a note saying what to change, and the session gets the note. The arbiter never can.
10. **Never a separate machine (#76, after pass 2).** The test machine is **a Windows VM on the user's own PC** ("we never want to use a separate machine"). *(Dropped by 13.)*
11. **Approval (after pass 6).** The user approved revision 6, with the VM code to wait for a Windows check run on their PC. *(Its VM part is dropped by 13.)*
12. **All of witness in the VM (#76, after the plan).** The user's goal is to play games on the PC while witness works, without the tests ever pulling them out of a game. So all of witness for that repo runs inside the VM, and revision 6's runner is parked in `docs/superpowers/specs/2026-11-19-vm-runner-parked.md` (§4.4). *(Dropped by 13, with the parked doc.)*
13. **#76 closes without witness work (during the rebuild).** Running witness inside the VM solves #76 by itself, so every piece of work for it goes: the route and the setup guide (§4.4), row 246, the Windows check (`scripts/vm-check/`, the rebuild's Task 18, 609ec06..ed92f1a), the README's VM guide (Task 19), the VM's W-checks and the parked runner's doc. Setting up the VM is the user's, outside witness, and #76 is closed by hand.

The user confirmed the #86/#87 recap before the verification pass. Before the first write-up they asked for verification ("verify yourself first", then "another verify pass first"), and they asked for a short pass on revisions 2 and 3 before approving. Calls marked *(my call)* are the designer's; §11 lists the ones to check while reading.

## 2. Goals, non-goals, anti-goals

**Goals**
- g1. A moved base never puts a clash in front of a gate (#86). Witness carries the plan's uncommitted work across the move itself and leaves a clash in the files, and nothing witness does is left on git's shared stash list.
- g2. Every act a screen, hint or refusal offers is one `decide` accepts (#87). A state where every offered act refuses is unreachable.
- g3. A revise the author hands back unchanged is decided again: by the arbiter under autonomy, by the human otherwise (#87).
- g4. A session, a reviewer and the arbiter end when their turn ends, not when their process exits (#80).

**Non-goals**
- n1. No new committed setting and no `witness migrate`. The grace is a constant (row 202's precedent).
- n2. Witness never resolves a conflict (row 77: "the CLI never freehands a merge").
- n4. Tests a session runs outside `witness turn` still run where the session runs them (row 218; D133's guard fails open). This is named as a residual (§7).

**Anti-goals**
- A gate, an evidence run or a ship on a tree with an unresolved clash or an unfinished move.
- A ship of a tree the ship gate has not judged since a move.
- Witness aborting, or applying into, an operation a session started.
- A witness entry left on git's shared stash list.
- A screen, a hint or a refusal that offers an act `decide` refuses, to a human or to the arbiter.
- The arbiter hearing the author's narration (anti-goal 1, `src/arbiter.ts:136-138`).

**Constraints**
- c1. Witness only. Upgrading a consumer is the user's call, made separately.
- c2. Windows behaviour is measured by the human before a row says MEASURED (W9 and W10, §7).
- c3. 0.30.0 adds a journal entry kind (`revise-returned`). Once a 0.30.0 CLI journals anything, the state floor (the highest `w` stamp in the journal, `src/floor.ts`, row 116) refuses every older CLI at dispatch. An older drive already running keeps 0.29 behaviour until it restarts (`src/cli.ts:187-199`).
- c4. Built against main at b92a461. Rows 240–242 are merged, and their settle token, busy locks, held records and timers are what this design lands on.
- c5. Step 0's tree comparison needs git ≥ 2.40 (`merge-tree --write-tree` with `--merge-base`; P40). An older git skips the comparison: a clean tracked tree is re-applied, and anything else refuses `carry-pending`, naming the old git.

## 3. Evidence

- **The issues' texts**, quoted in §1.
- **Probes P1–P48** (§6). Scratch repos, scripts and vitest probe files are in `.superpowers/sdd/2026-11-19-issues-86-87/scratch/` (git-ignored), with the decision ledger beside them.
  - P1–P6 are mine. I re-ran every other probe except P20 (pass 1-B's own vitest file). The differences were a same-second commit id and a German-locale section my shell skipped.
  - Read-confirmed by me at the cited lines:
    - the code claims behind P20;
    - the local-file exemption (`src/gitio.ts:124-147`);
    - the policy's arm order (`src/autonomy.ts:95-115`);
    - the key's version term (`src/rounds.ts:154-158`);
    - the readers that swallow a runner refusal (`src/criteria.ts:56-65`, `src/drift.ts:104-108`);
    - row 71's capture path (`src/evidence.ts:135-142`);
    - drive's limited-lane, idle-clock and pause lines (`src/drive.ts:937-943`, `:1272`, `:1291-1292`);
    - libuv's Windows `UV_FS_O_NOFOLLOW 0` (`uv/win.h:700`);
    - git's release note for `merge-tree --merge-base` (2.40.0).
  - The local-file exemption, the readers that swallow a runner refusal, row 71's capture path, drive's limited-lane, idle-clock and pause lines, and libuv's flag served revision 6's runner, dropped with #76 (decision 13).
- **W-R, Windows research** by an opus agent from Microsoft Learn, Raymond Chen's blog, and the git, pnpm, Tauri and VirtualBox sources. I re-fetched the two load-bearing quotes verbatim. It served #76, which closes without witness work (decision 13), and stays as the record.
- **pi 1.4.0's own code**, unpacked offline from the npm cache by passes 1-B and 3-H (P18). pi 0.85.1 is installed here.

## 4. The design

### 4.1 Row 243 — a clash stays in the files, never in front of a gate (#86)

#### 4.1.1 The carry (R1) *(the user's decision 1; the steps are my call, hardened by passes 1–4)*

The carry replaces `--autostash` in `rebaseIfMoved`. Git runs under `LC_ALL=C` wherever witness reads its words. Witness runs its own rebase with `GIT_REFLOG_ACTION=witness-carry`, so its rebase can be told from a session's.

0. **Finish an unfinished move.** This runs at the start of every `witness ship` run, inside its busy marker, before row 241's open-step refusal, before `shipPhase` routes, and before the "revise owed" and standing-record exits (P32, P41). A carry ref `refs/witness/carry/<plan>` present means a move was interrupted.
   1. **The worktree gone** (an abandoned plan) refuses `carry-pending`, showing the ref and keeping it.
   2. **Operations in progress.**
      - A rebase is aborted only when it is witness's own: HEAD's latest `(start)` reflog entry carries `witness-carry`, every HEAD reflog entry after it carries `witness-carry` too, and its `orig-head` is `<carry>^1`. A session that continued witness's rebase (`git rebase --continue`) has written its own entries, so its resolved commits are never dropped (P53).
      - Any other operation in progress (step 2's list) refuses `operation-in-progress` before anything is compared, applied or moved. A session's own rebase is never aborted, nor applied into (P40). Where no HEAD reflog exists (`core.logAllRefUpdates=false`), witness's own crashed rebase reads as a session's, which fails safe; the want then adds: if witness started it, run `git rebase --abort`, then re-run `witness ship`.
   3. **HEAD not the plan's branch** (detached, or another branch; `git symbolic-ref HEAD` is not `refs/heads/witness/<plan>`) refuses `carry-pending`, naming `git switch witness/<plan>`, before anything is compared, applied or moved.
   4. **Unmerged entries** with no operation in progress are step 7's clash only when they are the carry's own: every unmerged path's stages 1 and 3 are `<carry>^1`'s and `<carry>`'s blobs, absent where the carry has none. Then the carry moves to a kept ref and ship refuses `textual-conflict`. Unmerged entries of the session's own making (its own `git stash pop`, say) refuse `carry-pending`, naming the files (P43, P52).
   5. **The work already back.** The tree is compared with the carry replayed onto HEAD:
      - the worktree side is `git merge-tree --write-tree --merge-base=<carry>^1 HEAD <carry>` against the tracked tree a fresh `git stash create` records (no untracked files);
      - the index side is `… HEAD <carry>^2`;
      - a merge-tree that reports conflicts is never equal (P35, P43).

      If both sides are equal, the work is already back: the ref is dropped and ship proceeds.
   6. **A clean tracked tree.** The carry is re-applied as in step 7, with its three outcomes.
   7. **Anything else** refuses `carry-pending`, which never resets. It prints:
      - `git stash show -p <ref>` beside `git diff <ref>^1 <ref>^2`, which shows the staged-only versions;
      - the restore steps: on a clean tracked tree, `git stash apply --index <ref>`, or a plain apply when git answers "conflicts in index";
      - when the tree already holds the work, moving the ref to a kept ref rather than deleting it (prose).
1. **The guard** (§4.1.2).
2. **Any operation in progress refuses** `operation-in-progress`, naming its own `--continue`/`--abort`. The operations are `rebase-merge`, `rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD` and `REVERT_HEAD`, found under `git rev-parse --git-path` (P19).
3. **The lease** of row 242 is settled before anything moves, so a PR branch someone else pushed to refuses with the worktree untouched.
   - Whether a PR branch exists is read from `leaseFor`'s own explicit fetch (`+refs/heads/<b>:refs/remotes/origin/<b>`), in every caller (`rebaseIfMoved`, `createPr`, `pushApproved`). It is never read from `@{upstream}` or a tracking ref, which a single-branch or shallow clone never has (P37, P42).
   - No remote branch is a first push only while the plan has no PR (`meta.pr` unset), and only `createPr` makes it; `rebaseIfMoved` and `pushApproved` never push a branch the remote lacks. With a PR, no remote branch is row 242's "the PR branch is gone", whether or not a push was recorded (a PR opened by 0.28 or earlier has no record).
4. **Carry.** `git stash create`.
   - A non-zero exit refuses before anything moves: an intent-to-add entry refuses `carry-refused`, naming `git add`/`git reset` for it (P14). A held index lock is transient, and its want names the lock's path: remove it if no git process is running.
   - Empty output means "nothing to carry" only when `git status --porcelain --untracked-files=no` is empty too. Otherwise it refuses `carry-refused`.
   - The commit is written to the carry ref, never stored on `refs/stash`, the list every worktree shares (P2).
5. **Clean.** `git reset --hard`, then verify the tracked tree is clean.
   - `git checkout -- .` would leave staged work behind (P13), and with a user's `rebase.autoStash=true` that work brings #86 straight back (P15).
   - A tree still dirty after the reset (a file held open on Windows) refuses `carry-pending`, keeping the ref.
6. **Rebase.** `git rebase --no-autostash <remote>/<branch>`.
   - On a non-zero exit witness reads the unmerged paths, `git rebase --abort`s, verifies HEAD is the original, and puts the carry back with step 7's apply.
   - The carry ref is deleted only after a clean put-back. A failed abort or put-back keeps it and refuses `carry-pending`.
   - After a clean put-back, a replay conflict refuses as `textual-conflict`, naming the files (§4.1.3's replay steps). Anything else refuses as `rebase-refused`, in git's own words (`logSafe`). An untracked file the moved base adds never gets that far: in a witness worktree's sparse checkout `git rebase` silently replaces it with main's bytes and exits 0, so the carry refuses `rebase-refused`, naming the files, before anything moves (§4.1.5).
7. **Re-apply.** `git stash apply --index <carry>`. Only on git's "conflicts in index" does it fall back to a plain `apply`, and that copy is kept like a clash backup: a staged-only version survives only in the carry (P25). The outcomes:
   - **Clean.** The carry ref is deleted.
   - **Clash.** The tree had no unmerged entries before the apply, the apply printed `CONFLICT`, and it has unmerged entries after. The carry moves to `refs/witness/kept/<plan>/<n>` (numbered, never overwritten), and its message lists the clashing files. Ship refuses `textual-conflict` (exit 1, row 77) with §4.1.3's clash steps.
   - **Refused.** Exit non-zero, no unmerged entries, and not "conflicts in index" (P19). The carry ref is kept, and ship refuses `carry-pending`, naming it.
   - **A held lock**, met in step 0 or at steps 5–7 (the reset, the rebase, the abort, the put-back, the apply), keeps the carry ref and exits 3 (`transient`), never `carry-pending`. Step 0 finishes the move on the next run.
8. **Push.** After a clean re-apply the lease push of row 242 runs. `pushApproved` now leases through `leaseFor` too, so a remote tip that is witness's own last push (`refs/witness/pushed/<plan>`) is overwritten under that lease. A push withheld by a clash, a refused apply or a crash, or a rebase a session did by hand, is then carried by the next ship run instead of reading as `push-diverged` (P21).
9. **Re-gating.** With no PR yet, an approved ship gate routes to `pr` only while that gate is settled for the current tree. `shipPhase` reads it with the reviewed sha, whose base term a move changes and a state-only advance does not. So after a carry, a clash or a refused apply, the next ship re-gates instead of committing a tree no battery judged since the move (P32; amends row 77).
10. **Kept refs** (`refs/witness/kept/<plan>/<n>`) are dropped when the plan merges. On an abandon they stay (D168: the CLI never discards work), and `check` reminds the human (§4.1.4).

#### 4.1.2 The guard (R2) *(my call, from decision 1; widened by passes 1–4)*

- **One predicate, `clashLeft(wt)`**, answers yes on any of three signals:
  - (a) git's unmerged index entries (`git ls-files -u`);
  - (b) lines that start with git's own stash-apply labels (`<<<<<<< Updated upstream`, `>>>>>>> Stashed changes`, `||||||| Stash base`; these are untranslated) in the files the plan's kept refs list;
  - (c) a carry ref present: a move is unfinished and the work is not in the tree.
- **How signal (b) is read.** One `git --literal-pathspecs diff --text --no-textconv --no-ext-diff --no-color --src-prefix=a/ --dst-prefix=b/ --no-relative <merge-base> -- <file>` runs per listed file, from the worktree root. The merge-base is HEAD's with the remote ship branch, so staged, unstaged and committed markers all show.
  - Without those flags, a `-diff` attribute, a textconv driver, forced colour, `diff.noprefix` or `diff.relative` would hide the labels or misname the file (P36, P44). Without `--literal-pathspecs`, a name like `:foo.md` reads as pathspec magic and `[x].md` also matches `x.md` (P51).
  - The kept ref lists names read NUL-separated (`git ls-files -u -z`) and stored unquoted; a C-quoted name matches nothing (P51).
  - A label line is seven or more `<`, `>` or `|` followed by its label, since a `conflict-marker-size` attribute changes the marker length (P51).
  - Plain `=======` lines never count. A Markdown heading underlined with seven `=` would otherwise block a plan for its whole life (P22).
- **Who reads it:**
  - every gate on the plan's worktree, checked in `runGate` before `judge` like `steps-open`;
  - `test-evidence`, verify-red included;
  - `ship`, after step 0 and again before its commit and `pushApproved`'s `git add -A`;
  - `witness turn` in a plan's worktree (at the primary root no plan's kept refs apply).
- **The refusal** `clash-unresolved` exits 2 (REFUSED) everywhere. In the gate, test-evidence and `witness turn`, exit 1 already means a verdict or a test's own failure.
  - For (a) and (b) it names each file on a row of its own, with its remedy (§4.1.3).
  - For (c) it leads with `witness ship <plan>`, which finishes the move (step 0), and offers no per-file resolution.
- **The escape.** If a doc or fixture line in a once-clashed file starts with a label, the human can move that kept ref out of `refs/witness/kept/` (given as prose), so the backup itself is kept (§7).

#### 4.1.3 What the session and the human see (R3) *(my call; row 239's act lines)*

- **A clash** (step 7). Each file is named on a row of its own, with its kind read from the `ls-files -u` stages and its remedy:
  - **content:** resolve the markers keeping both intents, then `git add <file>`;
  - **binary, or both changed with no markers:** `git checkout --theirs -- <file>` keeps the plan's version (in a stash apply, *theirs* is the plan's side) and `--ours` keeps main's; then `git add <file>` (P25);
  - **modify/delete:** the row says which side `git rm <file>` keeps and which side `git add <file>` keeps, from the stages.
  - Then the session tests through `$WITNESS turn` and re-runs ship, which re-gates (step 9).
- **A replay conflict** (step 6). The steps:
  1. Commit the uncommitted work first. In the PR phase, ship's code commit already exists, and a session's fix commits are normal.
  2. `git rebase <remote>/<branch>`, resolve, `git add`, `git rebase --continue`.
  3. Test through `$WITNESS turn`.
  4. Re-run `witness ship`. Ship pushes under witness's own lease (step 8), so there is no hand push.
- **The refusals, their exits, and what ship records** (row 242's `refusalOutcome`):

| Rule | Exit | Ship records |
| --- | --- | --- |
| `textual-conflict` (clash or replay) | 1 (row 77) | nothing: the session's work (88-90 §4.3.1) |
| `clash-unresolved` | 2 | nothing |
| `operation-in-progress` | 2 | nothing |
| `carry-refused` (intent-to-add, an uncapturable state) | 2 | nothing |
| `carry-pending` (an unfinished move, a refused apply, a failed put-back or reset, the worktree gone) | 2 | nothing |
| `rebase-refused` (not a conflict) | 2 | nothing |
| a held lock, the index's or the carry ref's, rule `index-locked` (any step; after step 4 the carry ref is kept) | 3 | `transient` |

- **Rendering.** Commands go through the act renderer, with file names as quoted foreign words (row 239's B17). Wants carry the steps, so a consumer whose installed skill predates 0.30.0 still gets correct steps from the CLI.
- **The ship skill** names `textual-conflict` and `clash-unresolved`, never `semantic-conflict`. It gains both step sets. Its CI-red bullet becomes "commit, then re-run `witness ship`" (`pushApproved` now leases), so no hand `--force-with-lease` remains. The pins in `tests/skills.test.ts:215-217` move with it. The router command (`plugin/commands/witness.md`) gains lines for the new refusals.

#### 4.1.4 Leftovers from older versions (R4) *(my call)*

- **Leftover autostash entries.** `witness check` warns for each shared stash entry whose subject matches `^On witness/(.+): autostash$` (`git stash list --format='%H %s'`), naming it by commit sha.
  - The level is `warn`, so `check`'s exit is unchanged (row 139).
  - The text says the entry may hold the only clean copy of a plan's work. It gives the drop as prose for the human, never as a runnable row (D168): find its `stash@{N}` with `git stash list --format='%gd %H'`, since `git stash drop <sha>` refuses.
  - The human's own `On main: autostash` entries are skipped.
- **Kept refs of plans that are abandoned, done or no longer a plan, and carry refs of any plan not in progress,** get the same kind of warning, with the ref named.
- **Worktrees already holding `UU` files** from 0.28.x or 0.29.0 are refused by the guard at their next gate, evidence run or ship, with the remedy.

#### 4.1.5 Settled while building (rulings and review fixes)

The build of Tasks 1–7 and its slice review settled these. Tags name entries in the first build's ledger (`.superpowers/sdd/2026-11-19-remaining-issues/progress.md` in the `remaining-issues` worktree; that branch is kept as a reference).
- **The guard's order** is the carry (c), then unmerged entries (a), then label lines (b). With a carry ref standing, `witness ship` is the one remedy that turns every state into a clash with its own steps (Task 1).
- **With no merge-base** (no remote or local ship branch), signal (b) reads the listed file itself for label lines, failing closed (Task 1).
- **Remedy lines for odd names.** A name git reads as pathspec magic or a glob (`:x.md`, `[x].md`, `*`, `?`, a backslash) gets `git --literal-pathspecs …`. A name a terminal cannot show, or one Windows refuses, is shown with a note and never offered as a runnable line (Task 2, S1-4, S1-7).
- **Sides follow the operation.** `fileRemedies` reads it (stash apply, rebase or merge) from the operation in progress, and reads any operation's conflict markers as content (S1-5).
- **An untracked file in the way is refused before anything is written:** at the rebase (step 6's sparse-checkout overwrite) and wherever step 0 or step 7 applies the carry, without regard to case under `core.ignorecase` (Task 3, S1-1, S1-2).
- **A held lock** is read from git's words and from the lock file itself, at capture, reset, rebase and apply, since Apple's git words it differently. A lock on the carry ref is `index-locked` too (S1-3).
- **Dropping the carry ref is checked.** A failed drop after a clean apply is a held lock (exit 3) or `carry-pending`, never a leftover that loops `clash-unresolved` (S1-6).
- **The "conflicts in index" fallback's kept ref** lists the carry's staged files (`git diff <carry>^1 <carry>^2`), so the guard reads them, finds no labels, and the move proceeds (Task 3).
- **The kept ref** is a stash-shaped commit with the carry's tree and parents, whose message lists the files as JSON, made create-only and numbered (the plan, Task 1).
- **The PR branch** is named from the plan (`witness/<plan>`), never from HEAD. `pr-branch-gone` is a human's call, recorded `fix` (Tasks 5, 6).

### 4.2 Row 244 — every offered act is accepted, and a handed-back revise is decided again (#87)

#### 4.2.1 One derivation (R5) *(my call; the class D94, D119, D121, D131 and R11 each patched one state of)*

- **`liveActs`** (in `src/rounds.ts`, beside `exitActs`; `next.ts` cannot import `gate.ts`) is a pure function of:
  - the gate's journal;
  - the content's sha;
  - the upstream;
  - lifted holds;
  - whether the design was seen;
  - row 241's owed-work facts (an open step, a plan reopen, an evidence row);
  - the state of the reopen the gate's own upstream revise made (booked on the effort stream for the plan and design gates, `decide.ts:590-643`), and for decompose whether a recap landed after the revise.

  It gives the decide and gate acts that are legal now.
- **Membership** is by verb plus `--override`, `--repair` and `--upstream` for `decide`, and by verb plus `--fresh` and `--unchanged` for `gate`. Notes, `--pin`, `--via` and `--trust-cmds` do not count.
- **What stays in `decide`:**
  - the policy-only cap-park anchor (row 183);
  - the actor rules: `nod-cannot`, `autonomy-cannot`, `unpark-human`, and §4.2.7's `revise-human`;
  - `note-required` (a bare revise in the revised or handed-back state).

  `repair-spent` is journal state and lives in `liveActs`.
- **Who reads it:**
  - `exitActs`, `reopenActs` and `recommend`'s options;
  - gate's parked hint;
  - every refusal `want`, `help:` and `run:` row that names a decide or gate act, such as `nothing-pending` (`decide.ts:424-428`) and `settled-approve` (`gate.ts:440-446`);
  - `decide-view`'s states;
  - `needsYou`'s rows;
  - the arbiter's `menuFor`;
  - `decide`'s own acceptance.
- **A state-walk test** builds a journal for each state. The states:
  - pending; revised; revised after a stop; revised after a malformed round; revised after a malformed round on moved content; revised with a malformed round after the revise; repair-revised;
  - reopened after an approve; parked; parked at the bound, then reopened;
  - settled by an approve; settled by a pass; at the bound; stale;
  - handed back; handed back with the content moved since; handed back, then decided; handed back, then `--fresh`; handed back, then revised again;
  - retracted.

  It runs every act any screen offers as a human, and the state's arbiter menu as `selected: 'arbiter'`. Each act must land, or refuse with a rule the screen itself states. A `run:` of `witness gate` "after you change the work" counts as conditional.

#### 4.2.2 What each state offers (R6) *(my call, from pass 2's F1 and passes 3–4; the user's decision 9)*

In the revised and handed-back states the anchor is the run the revise disposed of, malformed runs skipped (P45).

| State | Offered on the human's screens | Recommended (`run:`) | The session's line |
| --- | --- | --- | --- |
| pending, below the bound | today's set (approve, revise, send upstream, stop) | today's rule | — |
| **revised**: latest disposition a revise of any kind (plain, repair, un-park, upstream, or a reopen by `caused_by`), content unchanged, no hand-back | approve despite the finding; park; send upstream (a parent exists, the latest revise was not upstream, and the anchor's upstream ladder is not spent); re-review (`gate --fresh`, below the bound); revise again with a note (§4.2.7) | `witness gate <gate> <target>`, "after you change the work" | change the work and re-run the gate, or hand it back with `--unchanged` |
| **handed back**, content unchanged | the same set | send upstream when the blocking finding's anchor is in the parent, else park ("neither the author nor a reviewer found a fix") | — (the arbiter or the human decides) |
| **handed back, content or a hold moved since** | re-gate, park, send upstream, revise again with a note; no approve. Its options carry the run's primary anchor, so an upstream taken here spends D123's ladder (P47) | the re-gate | change nothing more; the re-gate judges what moved |
| revised or handed back **at the bound** | the endgame set: approve `--override`, send upstream, repair while unspent, stop, abandon; no `--fresh` | the endgame's rule | — |
| **settled** by an approve or by a pass | the retraction alone: `decide --revise --note "<why>"`, after which `gate --fresh` re-judges | — | — |
| **settled**, content moved since the approve or pass | the re-gate: the approval lapsed (D75) | the re-gate | — |
| **retracted**: the latest revise un-settled an approve or a pass (no `caused_by`) | re-review (`gate --fresh`, below the bound), approve, park, revise again with a note; no hand-back | `gate --fresh` | re-review with `gate --fresh` (it spends a round), or change the work and re-run the gate; a session may run that `--fresh` |
| parked | row 241's reopen acts | row 241's | — |

- **Approve, below the bound,** works as in the pending state: plain `--approve` stays accepted, and the screens show only its accounted spelling, `--approve --override`, while a blocking finding stands (D122; recommend.ts:167-177).
- **Under autonomy** a hand-back is settled by the arbiter at once (§4.2.6). The human's screens show it only while it is still owed (busy, left), or with autonomy off.
- **No second plain revise** is offered anywhere. A revise again needs a note (§4.2.7).
- **A malformed round after the revise** (or after a hand-back) keeps the state's offers and leads with its free re-run, `malformed-rerun`'s act, for the human and the session alike. The re-run repairs the round (`appendKind`'s `repair`) instead of answering changed-nothing (P50).

#### 4.2.3 The revised state's rules, and the old bugs (R7) *(my call; amends row 94's half 1 and row 77)*

- **Revised** means the gate's latest disposition after the run it disposes of is a revise of any kind, whatever came before it: an arbiter's stop, a park, earlier revises. A reopen by another gate's `--revise --upstream` (`caused_by`) counts as a revise (P24).
- **The revised-state rules,** `revise-returned` included, match before `malformed-rerun` when a revise follows the malformed run. Otherwise a hand-back after a malformed round is masked by a re-run that answers changed-nothing (P45).
- **One pairing everywhere.** Changed-nothing, `authoringOwed` and every staleness read pair a revise with the run it disposed of (malformed runs skipped), never with a malformed run after it.
  - A malformed round after the revise, on the content the revise asked about, is repaired by a re-gate (`appendKind`'s `repair`, P50). One on other content leaves the pairing with the disposed run, so unchanged content answers changed-nothing and can be handed back (review fix S3-3). A malformed last round with no revise after it is always repaired (S2-4).
  - So `--unchanged` hands back only when the current key is the disposed run's key. Content edited between a stopped run and a malformed one has no verdict, so the gate re-runs it instead of calling it unchanged (P50).
  - P45's case, malformed on the same content, keeps its hand-back because the keys match.
- **The ship bug.** `shipPhase` and `appendKind` read the gate's **last** disposition. Changed-nothing needs that disposition to be a revise, so an approve after a revise on unchanged content goes on to ship (P9). `repairsOnRegate` (row 209) shares `revisedAfter` and reads it the same way. With no PR, `shipPhase` also checks that the approval holds for the current tree (§4.1.1 step 9).
- **The retraction.** `decide --revise --note "<why>"` after an approve **or a pass** anchors on the last run and un-settles the gate. `gateSettled` reads the last disposition after a pass too (`src/verbs/next.ts:59`). The `settled-approve` want names both steps: the retraction, then `gate --fresh` (P8, P23).

#### 4.2.4 Handing a revise back (R8) *(the user's decisions 2 and 6; the act's shape is my call, from verification V1 and passes 1–4)*

- **What `--unchanged` does.** `witness gate <gate> <target> --unchanged` runs the gate exactly as `witness gate` does, `resolve` and lanes included, in the caller's process.
  - Where that gate would answer changed-nothing (content, setup and checks unchanged), it journals `revise-returned` `{gate, run_id, sha}` instead, plus `manual: true` under `--manual`. The `run_id` is the run the revise disposed of.
  - Where the checks flipped or the key moved, it proceeds as the plain gate would (a cached or fresh round) and prints that nothing was handed back (P11).
  - A witness version bump between the revise and the hand-back moves the key, so a fresh round runs instead (`src/rounds.ts:154-158`).
- **What it refuses** (exit 2):
  - no revise standing (`nothing-to-hand-back`);
  - the gate's own latest revise is upstream and its work is still owed there. That holds while the reopen it made is open, and for decompose (whose upstream is the recap) until a recap lands after the revise (P48);
  - a retraction (`retraction-owed`, naming `gate --fresh`). That is the gate's latest revise when it has no `caused_by` and was journaled while the gate was settled (its run passed, or the disposition before it is an approve). A retraction asks for a re-review, not an edit, so the arbiter must not re-approve the old verdict through a hand-back. A reopen asks for an edit, and may be handed back;
  - a hand-back already standing;
  - a decision that landed since its own read: `--unchanged` takes row 240's settled token at its refusal read and checks it again under the lock, refusing `settled-since` (review fix S3-1);
  - at the bound, where the endgame decides.
- **Exits.** Under autonomy the gate's tail then settles it under the settle lock every settle takes (row 240), and the exit is that settle's. A hand-back journaled `manual: true` goes to the human in every settle that reads it. With autonomy off the gate exits 1 with the decision row.
- **A plain re-run is unchanged:** it stays changed-nothing and journals nothing (row 94 kept). A session that re-runs `gate` just to look never hands anything back (V1).
- **Only explicit hand-backs** (decision 6). Drive never hands a revise back for a session: it cannot tell "nothing to change" from "never got to it" without reading the session's words, which rows 240/242 retired. A session that ends without handing back ends stuck, as today.
- **Anyone may hand back.** Nothing tells a session from a human in a chat, and a human who hands back with autonomy off gets their own decision row.
- **The skills.** Every stage skill and the router gain one line: when you judge there is nothing to change, hand the revise back with `$WITNESS gate <gate> <target> --unchanged`, and never `decide`.

#### 4.2.5 One owed predicate (R9) *(my call, from passes 1–4; amends rows 94's half 2 and 173)*

- **The third owed kind is a standing hand-back.** The gate's latest disposition after the run it disposes of is a revise, and a `revise-returned` for that run follows it. Any later run that is not malformed, or any later disposition, ends it (P33). A malformed run judged nothing, so it leaves the hand-back standing and its free re-run follows.
- **Staleness is judged where the decision is made,** so the predicate needs no current sha. `recommend`'s `stale-below-bound` guard admits a standing hand-back and offers §4.2.2's moved row, with the re-gate first. Ship's awaiting-decision block passes content staleness too (`src/ship.ts:685`). The entry's `sha` records what was handed back (P34).
- **Every reader reads this one predicate** (P10 showed `owedDecisions` blind to it today):
  - `owedRun`;
  - `owedFrom` and `pendingDecisionsAll`, which feed `settleOwed` (`src/settle.ts:344`), `needsYou` (`src/needs-you.ts:128`) and `next`'s tier 2;
  - `flowBlocked`;
  - `authoringOwed`, false while a hand-back stands. Its hand-back check comes before its reopen check (`src/verbs/next.ts:107-117`), so `next` stops routing the edit;
  - `shipPhase`;
  - `check`'s `gate-awaiting-decision`;
  - `witness status`'s gates table (`src/verbs/dashboard.ts:369-386`);
  - `decide-view`, which gains a `handed-back` state.

#### 4.2.6 Who decides a handed-back revise (R10) *(the user's decision 2; the routing is my call, from passes 1–4; amends rows 121, 171, 172)*

- **The rule.** `recommend` gains the rule `revise-returned`, after `stale-below-bound` in row 121's first-match table. It also comes before `malformed-rerun` when a revise follows the malformed run (§4.2.3). It carries `anchor: <primary>`, so D123's ladder applies: no upstream once `ladderSpent(primary)`.
- **The policy.** `policyFor` sends it to the arbiter only after the arms that belong elsewhere (`src/autonomy.ts:95-115`):
  - the trust grant (the human's, row 205);
  - the stale or malformed re-run;
  - the fallen-back re-run;
  - the design look (a hand-back at a clean design gate is the human's design-look stop);
  - the granted-trust re-run.

  It sits outside `TAKEN` (`autonomy.ts:65`).
- **The arbiter's menu:**
  - approve despite the finding: `--approve --override` while a blocking finding stands, plain approve otherwise;
  - send upstream, where §4.2.2 allows it;
  - park.

  It never revises: `menuFor` drops every plain revise for this rule, the noted one included, and keeps `--revise --upstream` (P38). Hand-backs spend no rounds, so the bound would never stop a revise→hand-back loop. `menuFor` filters as today otherwise: no approve on failed checks or at a design gate.
- **The arbiter's evidence** (`decisionEvidence`) gains the hand-back as a journal fact: "the author handed this revise back with the content unchanged". Its history today lists the gate's decisions (`src/arbiter.ts:169-186`). The fact is no narration (anti-goal 1).
- **With autonomy off,** the human's decision row (`needsYou`) carries §4.2.2's set.
- **Accepted consequence** (decision 2): the arbiter may overrule a revise or a repair grant the human made. This touches rows 109 and 241. Row 241's "a settler that parked a gate must not be the one to un-park it" still holds for the un-park itself.

#### 4.2.7 Revising again with a note (R11) *(the user's decision 9; its reach before a hand-back is my call, §11)*

- **Where it applies.** In the revised state, handed back or not, a human may run `decide <gate> <target> --revise --note "<what to change>"`.
- **What it requires.**
  - A note. A plain `--revise` (no `--upstream`, no `--repair`) without `--note` refuses `note-required` in the revised, handed-back, retracted and settled states, so a retraction always carries its reason (D99).
  - A human. It is refused for policy and arbiter selections and inside a session drive started (`revise-human`, on the pattern of rows 205, 207 and 225). The same rule covers the retraction of an approve or a pass, as row 241 made the un-park a human's act.
- **What it does.** It journals a new revise, whose note reaches the session through `printReviseContext`, and it ends a standing hand-back.

#### 4.2.8 `--fresh` stays the human's re-review (R12) *(my call, from pass 1-A; row 99 named)*

- **Row 99's job is kept:** `gate --fresh` re-judges unchanged content, spending a round and running the battery. P7 shows it already gets out of #87's journal, by spending the paid repair round.
- **It is not the way to ask the arbiter.** Under autonomy the policy would revise a re-judged blocking verdict again (`TAKEN`), so a re-review reaches the arbiter only at the bound. The hand-back asks it now, spends no round, and runs no new judgment.
- **Where it shows up:** the screens offer `--fresh` where it is live, as §4.2.2 shows. The skills use `--unchanged`.

#### 4.2.9 Settled while building (rulings and review fixes)

- **Corner states the table leaves open** (Task 8):
  - only malformed rounds: `pending`, acts [`gate`], led by the free re-run;
  - `abandon-effort` as the last disposition: `none`, no acts;
  - retracted on moved content: [`gate`, `--stop`, `--revise --note`]; the approve is a stale verdict, and `--fresh` becomes the plain re-gate;
  - revised with a lifted hold reads like moved content: [`gate`];
  - the malformed lead applies in pending, revised, handed back (both) and retracted, never at the bound, settled or parked;
  - parked with a malformed round after it reads parked everywhere (S2-2).
- **A withheld approve still anchors** where a blocker names why: moved content refuses `stale-verdict`, a lifted hold `hold-lifted`, the bound without `--override` `override-required`. In the settled, parked and none states it is `nothing-pending` (Task 9).
- **The upstream slot** `--revise --upstream <effort>` (the bound-recurrence rule's, with no parent) stays accepted, kept in `LiveActs.slots` (Task 10).
- **Staleness and lifted holds are read against the last run that judged something,** by decide-view, gate's choices and `gateParked` too; `actFacts` computes `holdLifted` itself (S2-1, S2-2).
- **`settled-approve` fires only for the content the approve judged;** on moved content `--fresh` runs (S2-3).
- **A stop after a pass reads parked,** since `gateSettled` reads the last disposition after a pass too (Task 11).
- **`--unchanged`'s refusals come from liveActs' state:** at the bound `hand-back-at-bound`; handed back `hand-back-standing`; retracted `retraction-owed`; revised with upstream work owed `upstream-owed`; otherwise `nothing-to-hand-back`. A hand-back is journaled only where changed-nothing names the disposed run; anything else runs as the plain gate and says why nothing was handed back (Task 12).
- **One owed predicate, `decisionOwed`** (the pending run, else the run a standing hand-back names), replaces `pendingDecision` in every reader. Status's gates row reads `handed back`, and ship reads awaiting-decision for a standing hand-back, with or without a PR (Task 13).
- **The moved hand-back's row carries rule `stale-below-bound`,** so the policy's stale arm takes the free re-gate before the arbiter's `revise-returned` arm. A manual hand-back reaches the human through the settle and the gate's tail (Task 14).
- **The changed-nothing screen reads liveActs,** so its session line drops the hand-back hint while upstream work is owed, and recommend's revised re-gate row never names `--unchanged` (S3-2).

### 4.3 Row 245 — a session ends when its turn ends (#80)

*(my calls; the end signals are probed (P4, P5, P17, P18, P27, P28, P31, P46); the grace's rules come from passes 1–4)*

- **The end signal** is read from the stream witness already parses:
  - **pi:** `agent_settled`, which fires after any retry, compaction or queued continuation (pi's own docs; P18 for 1.4.0). A pi that never writes `agent_settled` keeps today's wait for its exit.
  - **claude stream-json:** a top-level `result` (no `parent_tool_use_id`) while no backgrounded call is open (`src/worker-stream.ts`, issue 64's P12/P17).
  - **claude json mode** (reviewers): a complete result envelope.
  - **Drive sessions only:** a pi session that shows no run-starting record (the grace's list below) within `SESSION_QUIET_MS` (5 min) of its start has ended as a run that never started (code 1).
    - The 5 minutes are awake time on the session's clock (row 210), which runs from spawn, so a pi that leaks before it writes its header is caught too.
    - This covers a missing key or an expired login while a startup handle leaks (P31). An extension may still write its own records first (P49).
    - The window is long because extensions' `session_start` and `before_agent_start` handlers run before `agent_start` (P27); witness's own add-on blocks there for up to 60 s.
- **The grace:** 60 s, a constant (row 202's precedent; the issue asked for `drive.exitGraceMs`).
  - **What cancels it:** only a JSON record that starts a run:
    - pi: `agent_start`, `turn_start`, `message_start` for a user, assistant or tool-result message (a custom message an extension posts starts no run, and one that triggers a turn brings its own `agent_start`; review fix S4-3), `tool_execution_start`, `compaction_start`, `auto_retry_start`;
    - claude: `system:init`, `assistant`, `user`, or a `system:task_started` or `task_updated` marking a call `is_backgrounded`.
  - **What never cancels it:** non-JSON stdout, stderr, and non-run events (`queue_update`, `entry_appended`, `session_info_changed`). A leaky extension that logs would otherwise hold the session forever (P17).
  - **Re-arming:** at the next settle, and for claude at the next top-level `result` with no backgrounded call open.
- **The timeout keeps running.** The end signal never stops a session's or a reviewer's timeout.
  - A deadline that falls inside a grace ends the session clean (turn ended), never as a timeout.
  - A cancelled grace leaves the timeout where it was.
  - In pi 0.85.1 a follow-up sent from an `agent_settled` handler restarts a turn that pi itself then cuts off (P28). That session still meets its timeout, as today.
- **The tail.** Lines that arrive while a grace runs are shown but never enter the tail row 182 reads (`src/drive.ts:277-281`). The record that cancels the grace resumes it, so a resumed turn's usage-limit line still reaches the tail. A record's lines stay out only when a grace ran before it and still runs after it, so the record that starts a grace (a claude error result) keeps its lines too (review fix S4-1).
- **The stop** is the one the timeout uses: the process group, or the Windows job host's tree (rows 201, 218).
- **The status.** An attempt stopped after its end signal is classified with the status the harness gives that ending: 0, or for claude 1 after an error result. It is never classified by the stop's own status (`null`/SIGTERM, or exit 1 from a Windows job kill) (P46). The same holds for a reviewer's and the arbiter's attempt, whose classifier (`src/reviewer.ts:216-223`) would otherwise read the stop as `reviewer-invocation`.
- **How it is recorded:** `exited`, with that code and the stream's error flag. The log line amends row 214's `ended` line, keeping its `(error)` and awake time:
  - `ended HH:MM:SS · turn ended · the process did not exit — stopped after 60s[ (error)] · <awake>`;
  - with "stopped at the deadline" in place of "stopped after 60s" when the deadline fell inside the grace;
  - `ended HH:MM:SS · never started · stopped after 5m · <awake>` for a run that never started.
- **Reviewers and the arbiter.** The async invoker watches the stream for the end signal, then gives the same 60 s grace and stop.
  - A reviewer that never starts stays on today's timeout and retry path: its end watch has no never-started window, and its grace runs on `opts.ticker` (Task 17).
  - A reviewer stopped after its turn still fails closed when its input pipe broke early (EPIPE), as an exit 0 does (review fix S4-2).
  - Drift moves from the sync invoker to the async one with a no-wait option, keeping row 182's "the sync lane never waits".
  - The sync invoker retires; `tests/reviewer.test.ts` and `tests/spawn.test.ts:285-356` move with it.
- **Settled while building** (rulings and review fixes):
  - claude's `started()` turns true at `system:init`; the json envelope's `is_error` is the reviewer's failure flag (Task 15).
  - The end watch never throws: a stream that cannot answer reads as not ended and started, so the timeout alone holds (Task 16).
  - The recorded code after a stop at the end signal is 1 for a run that never started, 1 when the harness is not pi and the stream failed (a claude error result), and 0 otherwise; pi's JSON mode exits 0 on an error answer (Task 16).
  - Drift's `noWait` refusal says to wait for the reset, inside drive too (Task 17).
- **Residuals** (§7):
  - a claude session whose backgrounded call stays open waits as today;
  - a `SessionEnd` hook or pi `session_shutdown` work longer than 60 s is cut;
  - 0.85.1's cut-off follow-up waits for the timeout.

### 4.4 #76 — closed without witness work (decision 13)

No witness code, no guide and no check. The user runs all of witness inside a Windows VM on their PC, so the app the tests open shows on the VM's screen, never on theirs; the VM's setup is theirs. Revision 8 (commit ad32f77) holds the route, the setup guide and the parked runner.

### 4.5 Docs, prompts and skills

- **The ship skill:** both conflict step sets, the CI-red bullet without a hand force-push (§4.1.3), and the hand-back line.
- **The implement, decompose, plan and design skills, and the router command:** the hand-back line and lines for the new refusals. `tests/command.test.ts` pins the router's text.
- **DESIGN.md:** rows 243–245 and the Open / deferred edits (§5).

### 4.6 Rollout *(the user's call, made separately)*

- Consumers move to 0.30.0 when the user says so.
- A revise left open across the upgrade meets a fresh round on its next gate, not a hand-back, because the key's witness version moved (§4.2.4).

## 5. DESIGN.md rows

**New rows** 243–245 (rows 228–236 are reserved by the UI design, and 238 by the paused display rule).

| Row | By | Change |
| --- | --- | --- |
| 77 | 243, 244 | the carry replaces `--autostash`; the refusals and their exits (§4.1.3); ship reads the last disposition; with no PR an approve routes to `pr` only while settled for the current tree |
| 94 | 244 | half 1: the revised state covers any revise, whatever came before, and gains send-upstream; half 2: `authoringOwed` is false while a hand-back stands; changed-nothing still appends nothing, and `--unchanged` is a separate act |
| 99 | 244 | named: `--fresh` stays the re-review, offered where live |
| 112 | 244 | `--unchanged` re-runs the checks like any gate, so a flip is a new judgment, never a hand-back |
| 119, 131 | 244 | their exits sets move into `liveActs` |
| 121, 171 | 244 | the `revise-returned` rule (after `stale-below-bound`, before `malformed-rerun` after a revise, with its anchor) and its arm |
| 126, 209 | 244 | `revisedAfter` reads the last disposition, for `repairsOnRegate` too |
| 172 | 244 | the arbiter's evidence gains the hand-back; its menu drops plain revises for this rule |
| 173 | 244 | a third owed kind, the standing hand-back |
| 182 | 245 | the code and the status after a stop, and the tail during a grace; drift's no-wait on the async invoker |
| 206 | 244 | `revise-returned` counts as progress |
| 214 | 245 | the `ended` line's new endings |
| 241 | 244 | the revised anchor no longer reads only from the un-park |
| 242 | 243 | the lease is settled before the carry, read from its own explicit fetch in every caller; `pushApproved` leases; the new refusals' outcomes |

**Touched:**
- 109 (an accepted consequence of decision 2);
- 116 (the floor);
- 139 (a `warn` finding);
- 201 (the stop);
- 202 and 218 (by row 245, the session stop);
- 239 (act lines);
- 240 (the settle lock on a hand-back).

**Open / deferred** gains five entries:
- a claude session with a backgrounded call still open waits as today (245);
- shutdown work longer than 60 s after a turn ends is cut (245);
- pi 0.85.1 cuts off a follow-up sent from an `agent_settled` handler, so that session waits for its timeout (245);
- markers `git add`ed in a file that never clashed are judged by the battery; a label-shaped line in a once-clashed file needs its kept ref moved by hand; a clashed file renamed afterwards escapes the label check (243);
- `witness turn` passes a Windows exit code on whole, so 256 reads as success to Git Bash's `$?` (218).

## 6. Probes

Paths are under `.superpowers/sdd/2026-11-19-issues-86-87/scratch/`. `grill/` holds P1–P6 and my re-runs. `pass1-{A,B,C}/`, `pass2-{D,E}/`, `pass3-{G,H}/` and `pass4-{I,J}/` hold the reviewers' originals, and `my-rerun-*.out` my re-runs. P6, P12, P20, P29, P30, P39, P46's libuv half and P54–P60 served revision 6's runner, dropped with #76 (decision 13); they stay here as the record.

| Probe | What ran | Result |
| --- | --- | --- |
| P1 | `git rebase --autostash` over a conflicting dirty tree (Apple git 2.50.1) | exit 0, `UU f.txt`, `stash@{0}: autostash` kept (`grill/p86a`) |
| P2 | `stash create` → ref → clean → rebase → `stash apply <carry>` | apply exit 1, `UU` with markers, non-clashing file applied, untracked untouched, stash list 0 throughout (`grill/p86c`) |
| P3 | #87's journal through `--show` and every listed act; a plain revise, then `--show` | all 4 offered acts refuse `nothing-pending`, and `gate` answers changed-nothing; after a plain revise the **recommended** `--revise` refuses |
| P4 | pi 0.85.1 `--mode json`, unknown model | `… agent_end · agent_settled`, exit 0 22 ms later (`grill/p80/probe.mjs`) |
| P5 | P4 with an extension holding `setInterval` | `agent_settled` at 656 ms, alive at 20 s |
| P6 | temp-index snapshot, `git bundle`, fetch, checkout | tracked, staged and untracked captured, ignored left out, index and stash untouched; a bundle needs a ref; increments need a forced refspec; deletions propagate (`grill/p76b`) |
| P7 | #87's journal, then `gate --fresh` | round 4 of 4 runs, then `decide --stop` lands |
| P8 | approve, then `gate --fresh`, then the retraction it names | `settled-approve` → `decide --revise --note` → `nothing-pending` |
| P9 | ship gate: revise, approve on unchanged content, `witness ship` ×2 | changed-nothing both times, `shipPhase: gate`, no PR |
| P10 | a handed-back revise on today's code | the re-gate re-runs `ship.test`; the policy takes `--revise` → refused, and without it `--revise --upstream`; `owedDecisions` empty; `ship` says "revise owed" |
| P11 | a check that flips between runs | changed-nothing becomes a journaled cached round and a second policy revise |
| P12 | a 3 s synchronous `execCommand` beside a 200 ms timer | 0 ticks |
| P13 | staged change, `checkout -- .`, `rebase` | the staged change survives; "Your index contains uncommitted changes", exit 1 (`grill/p86d`) |
| P14 | intent-to-add entry, `stash create` | exit 1, "Cannot save the current worktree state" (`grill/p86e/b1`) |
| P15 | P13's staged change with `rebase.autoStash=true` | exit 0, `UU`, one entry on the shared stash list — #86 again (`grill/p86e/b3`) |
| P16 | markers `git add`ed | no unmerged entries; `git diff --check <base>` reports "leftover conflict marker" ×3, exit 2 (`grill/p86e/b5`) |
| P17 | a leaky extension that logs after the turn | non-JSON stdout and stderr every 3 s after `agent_settled`, alive at 20 s (`grill/p80/chatty.ts`) |
| P18 | pi 1.4.0 from the npm cache | writes `agent_settled` after handlers and continuations; print mode returns without `process.exit` (passes 1-B and 3-H, code read) |
| P19 | a rebase in progress; a ship killed mid-replay; binary and modify/delete clashes; a refused apply | ship's rebase exits 128, and its abort would destroy a manual rebase; unmerged entries the carry trips on; no markers for binary/`UD`; exit 1 with no unmerged entries |
| P20 | the VM's sync and the host's run | ignored reports and screenshots survive `checkout -f` + `clean -fd`; the host deletes reports first; `WITNESS_SCREENS_DIR` is an absolute host path; an unknown local key refuses in older CLIs (pass 1-B) |
| P21 | a clash on a PR-phase move, then the session resolves | the PR branch stays at the pre-rebase commit; the next ship returns `clean` with no push; `pushApproved`'s unleased push is rejected (`push-diverged`); a push leased on witness's recorded push succeeds |
| P22 | the guard's second signal | `diff --check` against HEAD misses committed markers; a Markdown setext underline of seven `=` reports "leftover conflict marker" after a correct resolution |
| P23 | a gate settled by a passing run | `--show` offers 4 acts and all refuse; `gate --fresh` refuses `settled-approve` naming the retraction, which refuses; an emulated retraction leaves `gateSettled` true |
| P24 | approve, then a reopen; parked at the bound, then a reopen | the offered `--approve` and `--stop` refuse; at the bound `gate --fresh` exits 3 |
| P25 | `git checkout --theirs` on a binary clash; an `--index` apply over a staged-only change | `ls-files -u` lists it until `git add`; the `--index` apply refuses "conflicts in index" with no unmerged entries, and the staged-only version survives only in the carry |
| P26 | the replay-conflict steps on a PR-phase tree with an uncommitted fix | `git rebase` refuses "You have unstaged changes" |
| P27 | pi with an 8 s `session_start` or `before_agent_start` handler | header at ~230 ms, `agent_start` at ~8.2 s |
| P28 | pi 0.85.1 with a follow-up sent from `agent_settled` and a leak | `agent_settled · agent_start`, then alive at 20 s |
| P29 | `withRunnerTurn` around an async body | the turn file is gone before the body's await finishes |
| P30 | bundle edges | a VM missing a prerequisite fails the fetch; a PC that lost the VM's tip fails the bundle; one snapshot ref per plan carried another run's commit |
| P31 | pi with no login and a leaky extension | only the session header, alive at 20 s |
| P32 | `shipPhase` for an approved ship gate with no PR | `pr` whether the tree equals the approved one or moved; the reviewed sha moves on a carry-only rebase and a resolved clash, and stays put on state-only advances (passes 3-G, 4-I) |
| P33 | the owed predicate's first wording | "a `revise-returned` later than the latest revise" never ends after an approve, a park or a later run |
| P34 | `recommend` on a handed-back run whose content moved | `stale=true → undefined` (no block, the settle returns `none`); `stale=false → blocking-here` |
| P35 | step 0's tree comparison | equal right after a crash before the reset or after a put-back; unequal after a clean apply onto the moved base; equal against `merge-tree --write-tree` replaying the carry onto HEAD |
| P36 | the label signal | plain `git diff <merge-base>` shows unstaged, staged and committed label lines; diff3/zdiff3 write the base label (`Stash base`); labels untranslated while `CONFLICT` translates; a `-diff` attribute, textconv or `color.ui=always` hides them |
| P37 | `leaseFor` in a single-branch clone | `refs/remotes/origin/<b>` never exists, so it refuses `head-unreadable` |
| P38 | `menuFor` on the handed-back set | the arbiter is offered `--revise --note "<why>"` |
| P39 | the client's outcome; bundle edges | a SIGKILLed client reads as a failed run, a relayed 256 reads as green on POSIX, a crash reads as failed; two snapshots of an unchanged tree in one second share a sha and git refuses the empty bundle; a VM keeping only detached checkouts lists no tips |
| P40 | step 0 against a session's rebase | a session rebase from the same HEAD matches `orig-head == <carry>^1` and would be aborted; one paused at a clean point from another HEAD takes the carry onto its detached HEAD, and its `--abort` then wipes the work; witness's own rebase shows `witness-carry (start)` in HEAD's reflog; git's `merge-tree --merge-base` arrived in 2.40 (pass 4-I) |
| P41 | where step 0 runs | placed after row 241's open-step refusal, a carry ref left while a step is open loops (pass 4-I, from the code) |
| P42 | the lease's callers in a single-branch clone | `@{upstream}` still fails after the explicit fetch; a first push's fetch reads as row 242's "the PR branch is gone" unless the first push is told apart (pass 4-I) |
| P43 | step 0 in a crashed clash and after a fallback apply | `git stash create` fails "needs merge" on the clash tree; after the plain-apply fallback the index side never matches; `git stash show -p` omits the staged-only version that `git diff <ref>^1 <ref>^2` shows (pass 4-I) |
| P44 | signal (b) under more configs | content lines show under external diff, colour, `bigFileThreshold`, attributes and textconv; `diff.noprefix`/`mnemonicPrefix` rewrite the `+++` header; `diff.relative` hides files outside the cwd; a renamed clashed file escapes the pathspec (pass 4-I) |
| P45 | a revise after a malformed round | `malformed-rerun` matches first; its re-run answers changed-nothing and journals nothing (pass 4-I) |
| P46 | a lingering pi stopped after `agent_settled`; libuv's Windows flags | `EXIT code=null sig=SIGTERM`; `UV_FS_O_NOFOLLOW` is 0 on Windows (`uv/win.h:700`) (pass 4-J; my re-run) |
| P47 | an upstream decided on the moved row | the decision journals no anchor, so `ladderSpent` never counts it (pass 4-I) |
| P48 | decompose's `--revise --upstream` | journals `{gate: 'recap'}` and writes no reopen entry; a recap is visible on the effort stream (pass 4-I and 5-K, from the code) |
| P49 | no login, an extension that names the session | header, "No API key", `session_info_changed`, `entry_appended`, no `agent_start`, alive at 15 s (pass 4-J; my re-run) |
| P50 | a malformed round after content moved, then a revise | the revise lands on the earlier stopped run; stale against it, not against the malformed run; the re-gate says changed nothing about content no verdict judged; after a revise, a malformed re-gate's recommended re-run repairs (pass 5-K; my re-run) |
| P51 | signal (b)'s pathspecs and markers | `:foo.md` reads as pathspec magic (0 label lines) and `[x].md` also matches `x.md`; `--literal-pathspecs` fixes both; a C-quoted `ls-files -u` name matches nothing; a `conflict-marker-size` attribute writes longer markers (pass 5-K; my re-run) |
| P52 | a session's own `git stash pop` after witness crashed mid-move | `UU` with no operation in progress, and stage 3 differs from the carry's blob, so the clash is the session's (pass 5-K; my re-run) |
| P53 | a session continues witness's crashed rebase | `rebase (continue)` entries follow witness's `(start)`, and an abort would drop the session's resolved commits; a session's new rebase, `pull --rebase` or `-i` writes its own `(start)` (pass 5-K; my re-run) |
| P54 | `live.ts`'s `put` for `runner/<run>.json` | its temp file goes to `.witness/live/.runner/…`, which never exists; the write fails with ENOENT, swallowed, with or without `runner/` present (pass 5-L; my re-run) |
| P55 | §4.4.4 and §4.4.5 of revision 5 read together | a loss "counts … whatever the probe finds" beside "counts only run-class catches": the record could not tell a counted loss from an outage, so one reading loops on a UAC prompt and the other ends a target stuck for a lock (pass 6-N) |
| P56 | what a drive session runs, and what a silent session leaves | each session gets `WITNESS_BIN` as `node …/src/bin.js`, read at spawn; a session that journals nothing leaves the floor where it was, and `superseded` never prints (pass 6-N; my re-run) |
| P57 | three connect shapes on loopback | nothing listening: refused in 1 ms; accepted then closed: ends before the hello; accepted and silent: only the deadline ends it (pass 6-N; my re-run) |
| P58 | snapshot failures and edges | an unreadable untracked file makes `git add -A` fail and leaves the temp index, so `write-tree` records the base tree; a sparse plan worktree's hidden stray file makes it exit 1; a drift snapshot without init's ignore block carries `runner.lock`, `drive.log`, `allow.json`; a shallow PC repo's full bundle fails to fetch (pass 6-M; my re-run) |
| P59 | pnpm in a checkout another plan used | without a terminal, `pnpm install --frozen-lockfile` aborts a modules purge (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`); with `CI=true` it purges and installs (pass 6-M, live pnpm 10.22.0) |
| P60 | ignore rules that live only on the PC | the VM's `git clean -fd` deletes `node_modules` and `target` ignored only through `info/exclude` or a global excludes file (pass 6-M; my re-run) |

**W-R — Windows research** (it served #76, closed by decision 13; kept as the record), re-fetched by me where load-bearing:
- OpenInputDesktop: "If the calling process is running in a disconnected session, the function returns a handle to the desktop that becomes active when the user restores the connection."
- QUNS_NOT_PRESENT: "A screen saver is displayed, the machine is locked, or a nonactive Fast User Switching session is in progress."
- What goes with the input desktop:
  - bring-to-front (`SetForegroundWindow`; tao's `set_focus` falls back to synthetic input);
  - tray menus (`TrackPopupMenu` needs the owner foreground);
  - toast banners (queued while not present);
  - likely WebView2 rendering (Chromium pauses on lock).
- Full fidelity needs a live screen elsewhere: a VM whose console stays connected and unlocked.
- Hyper-V's enhanced session mode is a host setting: `Set-VMHost -EnableEnhancedSessionMode` "Indicates whether users can use enhanced mode when they connect to virtual machines on this server by using Virtual Machine Connection". It needs the guest's Remote Desktop *service* ("The virtual machine must have Remote Desktop Services enabled"), not its "allow remote connections" setting. VMConnect's "Type clipboard text" is the basic session's route from host to guest.
- Windows Firewall's stealth mode: "For ports on which no application listens, the stealth mode feature blocks the outgoing ICMP unreachable packet and TCP RST messages", so a stopped `runner serve` looks like a stopped VM. (The parked runner's.)
- A VirtualBox port forward with no host IP listens on every host interface, and host-only networking has no outside access. (The parked runner's.)
- An SSH session into Windows runs its programs in Session 0, which has no interactive desktop, because Windows' OpenSSH server runs as a service (Microsoft's Win32-OpenSSH issue #998, "Opening native graphical application from remote shell", is labelled "Resolution - By Design").
- VirtualBox beside memory integrity: "Third-party virtualization applications, such as VMware and VirtualBox, can't run alongside Hyper-V, Memory Integrity, or Credential Guard", and "they might fall back to a slower, emulated mode" (Microsoft Learn). Memory integrity is on by default on clean installs of Windows 11 (Microsoft's OEM guidance; pass 7, not re-fetched by me).
- VirtualBox's Guest Additions on a window resize: "The video resolution in the guest will be automatically adjusted, as if you had manually entered an arbitrary resolution in the guest's Display settings."
- Windows' restart sign-on: "On rebooting, the user will automatically be signed in via the Autologon mechanism and then additionally locked to protect the user's session."
- `SetForegroundWindow` succeeds, among other cases, when "The foreground lock time-out has expired", which an idle VM's desktop meets (pass 7, not re-fetched by me).

## 7. Edge cases and residuals

- **Tests outside `witness turn`** take no turn (row 218, D133), as today.
- **claude background calls.** A claude session whose backgrounded call stays open after its last result waits as today, up to `sessionTimeoutMs`. From the stream, a dev server and a long test look alike.
- **Shutdown work and follow-ups.** A `SessionEnd` hook or pi `session_shutdown` work longer than 60 s is cut. pi 0.85.1's cut-off follow-up (P28) waits for the timeout.
- **Markers outside a clash.**
  - Markers `git add`ed in a file that never clashed with witness's carry (a hand-made merge) are broken content for the battery.
  - A doc or fixture line starting with a stash-apply label in a once-clashed file holds the guard until its kept ref is moved out by hand.
  - A clashed file renamed afterwards escapes the label check.
- **`witness turn` passes a Windows exit code on whole**, so a command exiting 256 reads as success to Git Bash's `$?` (P39). The CLI's own evidence runs read it correctly; the fix is a one-line change if it bites.
- **Old git.** Step 0's comparison needs git ≥ 2.40. An older git skips it: a clean tracked tree is re-applied, and anything else refuses `carry-pending`, naming the old git.
- **The arbiter may overrule** a revise or a repair grant the human made (decision 2).
- **A session that ends without handing back** ends stuck, as today (decision 6).
- **Older witness still running.** An older drive keeps 0.29 behaviour until restarted (c3).

**Found in the first build's reviews and deferred** (minor; the first build's ledger):
- `--unchanged --fresh` runs a paid round with a false note; the pair should refuse (S3-4).
- The router's "revise changed nothing" row fires where `--unchanged` refuses (handed back, retracted, upstream owed), and the hand-back line has no `--manual` hint (S3-5).
- `decide --show` on a handed-back reopen says "reopened — the gate must run again" (S3-6).
- Status's "handed back" outcome covers plan, implement and ship, not design or decompose (S3-7).
- Drive's `journal:` line prints `revise-returned` as truncated raw JSON (log.ts's default).
- `next` and `status`'s parked rows call `reopenActs` without a content sha, so a gate parked at the bound on moved content still lists the approve there; and the endgame set offers `--stop` on a gate already parked at the bound, which lands as a second park (S2-5).
- An abort during a grace, with a session that ignores SIGTERM, is overwritten to `exited` (S4-4).
- The reviewer's line splitter hears once per chunk, never hears a final record with no newline, and re-splits the whole buffer per chunk; drive's `lineSink`, moved to `worker-stream.ts`, is the fix (S4-5–S4-7).
- The turn-end tests leave `sleep 600` orphans: a reviewer's stop reaches only its direct child on POSIX (pre-existing).
- The `LANG=de` carry test proves nothing with Apple's git, which has no German catalog; the behaviour was verified under Homebrew git (S1-8).
- Suspected, not reproduced: aborting witness's own crashed rebase while a session edits mid-resolution; `git am` reading as `rebase-apply` (the refusal names the wrong verb); a `rebase.backend=apply` reflog reading `witness-carry:` (fails safe); a duplicate kept ref after a crash between keep and drop; non-UTF-8 names on Linux.

**Windows measurements owed** (the human, before the row says MEASURED):
- W9. The carry on git 2.56.0.windows.1, including a file held open (Git for Windows retries an unlink for about 71 ms).
- W10. #80's stop after the grace, through the job host, and the status it leaves.

## 8. Testing

- **Regression tests are the probes inverted:**
  - carry, guard, push and phase tests: P1, P2, P13–P16, P19, P21, P22, P25, P26, P32, P35–P37, P40–P44;
  - carry and guard tests also take P51–P53;
  - decide, settle and ship tests: P3, P7–P11, P23, P24, P33, P34, P38, P45, P47, P48, P50;
  - drive and reviewer tests: P4, P5, P17, P27, P28, P31, P46, P49. They use the pi fake (`fixtures/fakebin/pi`) emitting `agent_settled`, slow starts, extension records before auth, and chatty or lingering tails.
- **The state-walk test** of §4.2.1, human and arbiter.
- **Tests that pin today's behaviour and must change:**
  - `tests/skills.test.ts:215-217` (`semantic-conflict`, the hand force-push);
  - `tests/command.test.ts` (the router's text);
  - `tests/reviewer.test.ts` and `tests/spawn.test.ts:285-356` (the sync invoker);
  - `tests/drive.test.ts:386` (the `ended` line);
  - `tests/exits-line.test.ts:294`;
  - `tests/decide-view.test.ts` (screen states);
  - `tests/needs-you.test.ts`;
  - `tests/autonomy.test.ts`;
  - `tests/rounds.test.ts:72-84`, plus a new revise-then-approve case.
- **Windows:** W9 and W10 are the human's.

## 9. Build order *(my call; one plan, one release, per decisions 7 and 8)*

1. **#86:**
   - the carry, with step 0 at every ship;
   - the guard;
   - the leases;
   - the re-gate rule;
   - the refusals table;
   - the skill and router steps;
   - `check`'s warnings.
2. **#87's one derivation:**
   - `liveActs`;
   - §4.2.2's table;
   - the revised state;
   - the old bugs (P8, P9, P23, P24, P45).
3. **#87's hand-back:**
   - `--unchanged` and `revise-returned`;
   - the standing-hand-back predicate and its stale row;
   - the policy arm;
   - the arbiter's menu and evidence;
   - revising again with a note.
4. **#80:**
   - end signals;
   - the grace, the timeout, the tail and the stop status;
   - reviewers and drift.
5. **Whole-branch verification;** release 0.30.0.

## 10. Left to the builder

- Rule names this doc does not state.

## 11. Calls for you to check while reading

1. **On a clash,** the session sees each clashing file with its fix, and every gate, test run and ship refuses until it is resolved. Then ship re-runs its gate before it opens a PR (§4.1.1–4.1.3).
2. **The backup copy of the work after a clash is kept until the plan merges.** The recap you confirmed said "dropped at the next move"; I changed it so a botched fix can always be undone. If you abandon the plan, the copy stays and `check` reminds you (§4.1.1, §4.1.4).
3. **On a handed-back revise, the arbiter can** approve despite the finding (recorded as an override), send it upstream, or park it. It never sends it back again (§4.2.6).
4. **You can send work back again with a note before the session hands it back,** not only after. That is my extension of your answer (§4.2.7).
5. **`gate --fresh` stays your way to have the reviewers look again** at unchanged work, and it spends a round. Sessions hand a revise back with `--unchanged`, which costs nothing. After you undo an approval, the session cannot hand it back: the reviewers must look again (§4.2.4, §4.2.8).
6. **After a session's turn ends, witness gives it 60 s to exit, then stops it.** This is fixed, not a setting (§4.3).
