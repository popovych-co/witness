---
name: witness-ship
description: Ship a witness plan — drive the CLI's deterministic ship phases (lanes → gate → PR → CI watch), resolve the conflicts a moved base leaves, and stop for the human where judgment is owed. Normally invoked by /witness with the plan id.
---

# witness-ship — lanes → gate → PR → CI watch

<!-- Derived (MIT): step sequence re-owned from kunchenguid/no-mistakes
(validate, push, PR, CI — then a human). Rewritten for witness: the CLI runs
every deterministic step; this skill orchestrates and resolves what only a
model can. See NOTICE.md. -->

## Ground rules (every witness skill)

Resolve the CLI once per session:

```bash
WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.31.1}"
```

- **Render the CLI's decision output verbatim and in full — every line, unmodified.** Never print a command set you remember; never recompose, reformat, summarise or reorder what the CLI emitted. Which decisions are live, how they rank, and what each costs are the CLI's answers, and they change with the round, the bound, the repair grant and the content sha — a remembered set is wrong in more states than it is right.
- **The human decides; you may type it.** Run a `witness decide` verb when the human **names an option** — its number or its verb — or gives a bare affirmation ("y", "ok", "go") while a **CLI-rendered decision block carrying a recommended option** is on screen: the affirmation **selects the recommended option**, and you append `--via affirmation` to its printed command when it is a `witness decide` option — a recommended command of another verb (the recovery fork's `witness recover --complete`) runs as printed. Otherwise the string is run **byte-for-byte**: never recomposed, never reformatted, never with a placeholder you resolved yourself. The moment you compose a `--note` or resolve an id, you are authoring their decision. **A nod never takes** `--approve --override`, `--stop`, a trust grant, or `witness abandon` — those require naming, and the CLI refuses them with `nod-cannot`. A block with **no** recommendation also requires naming. **Questions you authored yourself** (the grill, the design session's questions) are conversation, not a block: an affirmation there accepts your stated recommendation, with no selection entry, no journal claim and no flag; a number there (1, 2, 3) picks that answer — never a `witness decide` option. A selection does not survive session death: killed and re-run, render the block again and ask again.
- **Never edit `specs/**`, `plans/**`, or `designs/**`** (the canon dirs — `paths:` in witness.config.yaml may relocate them) — not with an edit tool, not with a write tool, not with Bash redirection. The CLI is the sole writer of state; you author in scratch files under `$(mktemp -d)` and hand them to the CLI. (The canon guard blocks you; the trailer audit catches what it can't.)
- **Read canon with `witness read <id>`, never by path.** Canon lives at the primary root; inside a worktree the files are **absent by design**, so a path read finds nothing and a stale copy cannot be mistaken for the contract. Fat artifacts: `witness read <spec-id> --design --outline`, then `--lines <a>-<b>`.
- **Read a file before your first edit of it in this session.** Relay boundaries, `verify-red`'s set-aside cycle, and worktree re-attach all change files under you — an edit against a remembered copy is how "modified since read" and partial applies happen. The CLI now prints `stale-reads:` when it churns the tree; treat that list as unread.
- **Never invoke gate reviewers or relay verdicts.** `witness gate` runs reviewers itself and journals what they said; your summary of a verdict is not evidence.
- **Refusal repair loop:** a `witness` verb exiting 2 prints structured violations (`field · rule · got · want`). Fix your input and retry — **3 total attempts** per artifact, then stop, show the human the violation list verbatim, and end your turn.
- **A refused or hook-blocked command is a stop, not a step to drop.** Re-issue it on its own; if it still refuses, tell the human what was blocked and why. Never proceed by deleting the refused half of a compound command — a dropped step is silent, and silence is how a skipped check becomes a shipped defect.
- **Re-entrancy:** derive position from CLI output (`$WITNESS next`, the dashboard, `log`, `index`) — never from conversation memory. Killed and re-run, you must converge.
- **A `witness: context …` line is addressed to you.** Once per session, when this session's context has filled to the configured limit, it follows a command's result. Finish the act you are in (here: a fix, through the `witness ship` run that carries it). The hand-over is the CLI's: it happens only when the CLI prints a `relay:` line with no `run:`. When none prints, keep working.

## Drive the phase machine

You are the ship session — spawned fresh at the primary root via the `run:` handoff `next` printed (a fresh session is the execution model; CI investigation and conflict resolution happen in this session, in the worktree, yourself).

`witness ship <plan-id>` is the whole phase machine — gate, PR, CI watch:

```bash
$WITNESS ship <plan-id>    # append --manual when the run asked for it
```

The CLI derives the phase from world state (`pr:` field, journal, PR head) — killed anywhere, re-running converges. **A run that ends with a `relay:` line** has reached this session's context limit, whatever its outcome: render what it printed above that line, print the `relay:` line verbatim, and END YOUR TURN — the next ship pass runs in a fresh session. That holds in the CI loop too: after a relay, never fix and re-run ship here. Otherwise, your job per outcome:

- **Gate ran and stopped** (it *always stops* — the ship gate is a standing stop): render the checks (markers · lint · tests · drift lane), the reviewer findings, and its ranked options verbatim and in full, then END YOUR TURN. A conflict marker on a line the plan adds or a red lint part withholds the review: the round prints `checks-only:` — no lens ran and no round was spent — and the fix is what the check names. A lint red the author cannot fix — red on the base too, or one only the human accepts — is the human's to book (`witness decide ship <plan> --book lint`), never a session's; the block offers it, and the human types it. A switch-off the plan adds (an `eslint-disable` or `@ts-ignore` comment, an `it.skip(` or `.only(`, a `#[allow(` …) reads `switch-offs` red: render it with the rest and END YOUR TURN; the revise removes it, or `witness decide ship <plan> --book switch-offs` books it when it is right as it stands — the human's or, under `autonomy: on`, the arbiter's, never a session's. A `decided: ship … → book` line hands back to /witness, whose `next` routes the re-gate. The two-lane drift check ran inside: deterministic lane fail-closed, drift-reviewer advisory.
- **After the human approves** → run `$WITNESS ship <plan-id>` again: it commits the worktree (the first code commit — implement leaves everything uncommitted), pushes the branch, opens the PR (`pr:` stamped), rebases if main moved, and watches CI. When main moved before the PR opened, ship carries the plan's work across and re-gates by itself: a move changed the tree the battery judged, so a second battery runs on the moved tree and stops like the first.
- **`textual-conflict`** (exit 1) → main moved under the plan and the two collide; the conflict is yours (next section). Rows naming each file, then a row naming a backup under `refs/witness/kept/`, are a **clash**: the plan's uncommitted work went back onto the moved base with conflicts, and they stay in the files. One row whose steps name `git rebase` is a **replay conflict**: the plan's commits collide with main, the CLI aborted its rebase, and the uncommitted work is back as it was.
- **`clash-unresolved`** (exit 2) → a clash is still in the plan's files — unmerged entries, or git's stash-apply label lines in a file a backup lists — and every gate, evidence run, `witness turn` and ship on the plan refuses until it is resolved: resolve it by **A clash** below. A row that leads with `witness ship <plan-id>` instead means a move was interrupted and the work may not be in the tree: run that line, which finishes the move, and resolve no file by hand before it has run.
- **CI red** → investigate in the worktree; fix under TDD discipline (a behavior fix gets a red first — reuse the implement protocol); commit, then re-run `$WITNESS ship <plan-id>`: it carries the fix to the PR under its own lease and re-watches.
- **CI green** → tell the human the PR is ready to merge. **Never merge it yourself** — merging is the human's act on GitHub; the lazy stamp flips `plan → done`, `spec → live` on the next scan (`$WITNESS next` after merging shows it).
- **Under `autonomy: on`** (printed by `gate`): the arbiter settles the ship gate's stop, and `witness ship` carries on in the same run — PR, CI watch, and on green it merges the PR itself and prints `merged:`. Never run `witness decide`, and never merge yourself or run a `gh pr merge` line. A `decided: ship … → revise (decided first)` line is a revise like any other: another decider settled the stop first; fix from the revise-context it printed. A `busy:` line means another witness run is acting on this plan now: render it and END YOUR TURN — never retry it, and run no other verb on the plan. An `awaits-drive:` line means the round is red only for a lint result drive owes on the base: drive lints the base, then runs the gate again — render it and END YOUR TURN. An `autonomy: left for a human — only the human books lint …` line is the human's: under `autonomy: on` they run `--book` at their own terminal — render it and END YOUR TURN. A `steps-open` refusal, or `merge: held — <step> is not built yet`, means the plan gained a step: ship nothing, and hand back to /witness, which routes the step. `merge: held — the ship approval lapsed` means re-run `witness ship`, which re-gates. `ci: red` with failing checks is yours: fix it and re-run `witness ship`. A merge or fix stop — `merge: held` for no CI checks, no passing check, a PR aimed at another branch, a closed PR or a refused login, and a `merge-refused`, `push-diverged` or `pr-branch-gone` refusal — is the human's: render it and END YOUR TURN; running `witness ship` again returns the same stop. A hold that clears by itself — `ci: pending`, a check set or a base that could not be read, a fetch or push the remote did not answer, a git lock another process held (`index-locked`) — is drive's to check again: END YOUR TURN. So is a `kept-stop:` line the human's: render it and END YOUR TURN.

## Conflict resolution

In the worktree (`.witness/worktrees/<plan-id>`). Witness never resolves a conflict and never drops your work: resolve each file preserving BOTH intents — the plan's behavior and what landed on main; a resolution that drops either is a silent revert. Run each row's own commands, never a remembered flag: which side `--theirs` and `--ours` keep follows the operation, and the row says which.

### A clash

The refusal names each file on a row of its own, with its kind and its remedy, then the backup of the plan's work as it stood before the move (`refs/witness/kept/<plan-id>/<n>`, deleted when the plan merges).

1. Apply each file's remedy as its row says:
   - **content** — resolve the conflict markers keeping both intents, then the row's `git add -- <file>`; a file with one marker left is still content: finish resolving it;
   - **binary, or both changed with no markers** — offered only while the file still holds a version git left: the row's `git checkout --theirs -- <file>` keeps the plan's version (in a stash apply, *theirs* is the plan's side) and `git checkout --ours -- <file>` keeps main's; then `git add -- <file>`;
   - **no markers left** — the file holds neither side's version and no conflict marker, so it reads as resolved: if it is your resolution, the row's `git add -- <file>` records it, and `git checkout -m -- <file>` puts the markers back. Never check out a side over it: that throws your resolution away;
   - **binary, neither side's version** — a binary file you rewrote: if it is your resolution, the row's `git add -- <file>` records it; the row's checkouts would replace it with a side;
   - **modify/delete** — the row says which side `git rm -- <file>` keeps and which side `git add -- <file>` keeps.
2. Test through `$WITNESS turn -- <test command>`; the resolution must be green before it travels.
3. Re-run `$WITNESS ship <plan-id>`, which re-gates: no battery has judged the moved tree.

A `clash-unresolved` row for label lines in a file that is not a clash — a doc or a fixture whose own text starts with a label — names the human's way out: tell the human, and never move the backup yourself.

### A replay conflict

1. Commit the uncommitted work first (in the PR phase ship's code commit already exists, and fix commits of your own are normal).
2. Rebase onto the REMOTE tip, which re-hits the conflict the CLI reported (default branch: main; rebasing the LOCAL ref recreates the stale base the CLI just refused, D142):

   ```bash
   git fetch origin <ship-branch>
   git rebase origin/<ship-branch>
   # resolve each conflicted file preserving both intents, then
   git add -- <file>
   git rebase --continue
   ```
3. Test through `$WITNESS turn -- <test command>`; the resolution must be green before it travels.
4. Re-run `$WITNESS ship <plan-id>`: it pushes under witness's own lease, so there is no hand push.

Any test you run yourself — reproducing a failed lane, checking a resolution — goes through `$WITNESS turn -- <test command>`, so it takes turns with the other worktrees' runs.

Conflicts touching `specs/` or `plans/` cannot happen (PR branches carry code only); if you see one, stop — something upstream is wrong, hand it to the human.

## Revise at the ship gate

`decide ship <plan-id> --revise` re-enters here with the verdict (`decide --show`). Drift-lane findings usually mean code and spec disagree — if the *code* is wrong, fix it in the worktree (TDD, evidence); if the **spec** is wrong, tell the human `--revise --upstream` routes to decompose — never edit the spec yourself. When you judge there is nothing to change, hand the revise back with `$WITNESS gate ship <plan-id> --unchanged`, and never `decide` — a plain re-gate hands nothing back. A passing lane against amended parent content re-pins `derives-from` automatically (CLI-witnessed); you never touch pins. `--show` also emits `state:` and `exits:` — a `reopened` state means the verdict above it is history, so act on the `exits:` line, not on remembered findings. A `settled` state's `exits:` line is the human's retraction, never run by a session: follow `help: witness next`. A `retracted` state (the human took the approval back) asks for a re-review, not an edit: re-run `$WITNESS ship <plan-id>`, which re-judges the same tree itself (the ship gate's `--fresh`, after its rebase).
