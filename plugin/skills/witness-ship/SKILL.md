---
name: witness-ship
description: Ship a witness plan — drive the CLI's deterministic ship phases (lanes → gate → PR → CI watch), resolve semantic rebase conflicts, and stop for the human where judgment is owed. Normally invoked by /witness with the plan id.
---

# witness-ship — lanes → gate → PR → CI watch

<!-- Derived (MIT): step sequence re-owned from kunchenguid/no-mistakes
(validate, push, PR, CI — then a human). Rewritten for witness: the CLI runs
every deterministic step; this skill orchestrates and resolves what only a
model can. See NOTICE.md. -->

## Ground rules (every witness skill)

Resolve the CLI once per session:

```bash
WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.5.1}"
```

- **Never edit `specs/**` or `plans/**`** (the canon dirs — `paths:` in witness.config.yaml may relocate them) — not with an edit tool, not with a write tool, not with Bash redirection. The CLI is the sole writer of state; you author in scratch files under `$(mktemp -d)` and hand them to the CLI. (The canon guard blocks you; the trailer audit catches what it can't.)
- **Never invoke gate reviewers or relay verdicts.** `witness gate` runs reviewers itself and journals what they said; your summary of a verdict is not evidence.
- **Refusal repair loop:** a `witness` verb exiting 2 prints structured violations (`field · rule · got · want`). Fix your input and retry — **3 total attempts** per artifact, then stop, show the human the violation list verbatim, and end your turn.
- **A refused or hook-blocked command is a stop, not a step to drop.** Re-issue it on its own; if it still refuses, tell the human what was blocked and why. Never proceed by deleting the refused half of a compound command — a dropped step is silent, and silence is how a skipped check becomes a shipped defect.
- **Re-entrancy:** derive position from CLI output (`$WITNESS next`, the dashboard, `log`, `index`) — never from conversation memory. Killed and re-run, you must converge.

## Drive the phase machine

You are the ship session — spawned fresh at the primary root via the `run:` handoff `next` printed (a fresh session is the execution model; CI investigation and conflict resolution happen in this session, in the worktree, yourself).

`witness ship <plan-id>` is the whole phase machine — gate, PR, CI watch:

```bash
$WITNESS ship <plan-id>
```

The CLI derives the phase from world state (`pr:` field, journal, PR head) — killed anywhere, re-running converges. Your job per outcome:

- **Gate ran and stopped** (it *always stops* — the ship gate is a standing stop): render the checks (tests · lint · drift lane) and the reviewer findings verbatim, print `witness decide ship <plan-id> --approve | --revise --note "…" | --stop`, END YOUR TURN. The two-lane drift check ran inside: deterministic lane fail-closed, drift-reviewer advisory.
- **After the human approves** → run `$WITNESS ship <plan-id>` again: it commits the worktree (the sole code commit — implement leaves everything uncommitted), pushes the branch, opens the PR (`pr:` stamped), rebases if main moved, and watches CI.
- **`semantic-conflict`** → the CLI aborted its mechanical rebase; the conflict is yours (next section), then re-run ship.
- **CI red** → investigate in the worktree; fix under TDD discipline (a behavior fix gets a red first — reuse the implement protocol); commit, `git push --force-with-lease` if you rebased, plain push otherwise; re-run `$WITNESS ship <plan-id>` to re-watch.
- **CI green** → tell the human the PR is ready to merge. **Never merge it yourself** — merging is the human's act on GitHub; the lazy stamp flips `plan → done`, `spec → live` on the next scan (`$WITNESS next` after merging shows it).

## Semantic conflict resolution

In the worktree (`.witness/worktrees/<plan-id>`):

```bash
git rebase <ship-branch>          # re-hit the conflict the CLI reported (default branch: main)
# resolve each conflicted file preserving BOTH intents — the branch's behavior
# and what landed on main; a resolution that drops either is a silent revert
git add -A && git rebase --continue
<run the repo's tests locally — the resolution must be green before it travels>
git push --force-with-lease
$WITNESS ship <plan-id>          # resume the watch
```

Conflicts touching `specs/` or `plans/` cannot happen (PR branches carry code only); if you see one, stop — something upstream is wrong, hand it to the human.

## Revise at the ship gate

`decide ship <plan-id> --revise` re-enters here with the verdict (`decide --show`). Drift-lane findings usually mean code and spec disagree — if the *code* is wrong, fix it in the worktree (TDD, evidence); if the **spec** is wrong, tell the human `--revise --upstream` routes to decompose — never edit the spec yourself. A passing lane against amended parent content re-pins `derives-from` automatically (CLI-witnessed); you never touch pins. `--show` also emits `state:` and `exits:` — a `reopened` or `settled` state means the verdict above it is history, so act on the `exits:` line, not on remembered findings.
