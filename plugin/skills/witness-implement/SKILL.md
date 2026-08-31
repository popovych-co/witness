---
name: witness-implement
description: Implement a witness plan — you are the implementer; CLI-managed worktree, session slices under the dispatch budget with a CLI-printed relay, red/green TDD with CLI-witnessed evidence per step, then the implement gate. Normally invoked by /witness with the plan id.
---

# witness-implement — plan → tagged tests + code → gate

<!-- Derived (MIT): red/green/refactor discipline merged from obra/superpowers
test-driven-development and mattpocock/skills tdd (near-duplicates; union
taken). Rewritten for witness: evidence is CLI-witnessed at red and green,
tests carry the parent spec's tag in their NAME. See NOTICE.md. -->

## Ground rules (every witness skill)

Resolve the CLI once per session:

```bash
WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.13.0}"
```

- **Render the CLI's decision output verbatim and in full — every line, unmodified.** Never print a command set you remember; never recompose, reformat, summarise or reorder what the CLI emitted. Which decisions are live, how they rank, and what each costs are the CLI's answers, and they change with the round, the bound, the repair grant and the content sha — a remembered set is wrong in more states than it is right.
- **The human decides; you may type it.** Run a `witness decide` verb when the human **names an option** — its number or its verb — or gives a bare affirmation ("y", "ok", "go") while a **CLI-rendered decision block carrying a recommended option** is on screen: the affirmation **selects the recommended option**, and you append `--via affirmation` to the printed command. Otherwise the string is run **byte-for-byte**: never recomposed, never reformatted, never with a placeholder you resolved yourself. The moment you compose a `--note` or resolve an id, you are authoring their decision. **A nod never takes** `--approve --override`, `--stop`, a trust grant, or `witness abandon` — those require naming, and the CLI refuses them with `nod-cannot`. A block with **no** recommendation also requires naming. **Questions you authored yourself** (the brainstorm interview, the design converge step) are conversation, not a block: an affirmation there accepts your stated recommendation, with no selection entry, no journal claim and no flag. A selection does not survive session death: killed and re-run, render the block again and ask again.
- **Never edit `specs/**`, `plans/**`, or `designs/**`** (the canon dirs — `paths:` in witness.config.yaml may relocate them) — not with an edit tool, not with a write tool, not with Bash redirection. The CLI is the sole writer of state; you author in scratch files under `$(mktemp -d)` and hand them to the CLI. (The canon guard blocks you; the trailer audit catches what it can't.)
- **Read canon with `witness read <id>`, never by path.** Canon lives at the primary root; inside a worktree the files are **absent by design**, so a path read finds nothing and a stale copy cannot be mistaken for the contract. Fat artifacts: `witness read <spec-id> --design --outline`, then `--lines <a>-<b>`.
- **Read a file before your first edit of it in this session.** Relay boundaries, `verify-red`'s stash cycle, and worktree re-attach all change files under you — an edit against a remembered copy is how "modified since read" and partial applies happen. The CLI now prints `stale-reads:` when it churns the tree; treat that list as unread.
- **Never invoke gate reviewers or relay verdicts.** `witness gate` runs reviewers itself and journals what they said; your summary of a verdict is not evidence.
- **Refusal repair loop:** a `witness` verb exiting 2 prints structured violations (`field · rule · got · want`). Fix your input and retry — **3 total attempts** per artifact, then stop, show the human the violation list verbatim, and end your turn.
- **A refused or hook-blocked command is a stop, not a step to drop.** Re-issue it on its own; if it still refuses, tell the human what was blocked and why. Never proceed by deleting the refused half of a compound command — a dropped step is silent, and silence is how a skipped check becomes a shipped defect.
- **Re-entrancy:** derive position from CLI output (`$WITNESS next`, the dashboard, `log`, `index`) — never from conversation memory. Killed and re-run, you must converge.

## Start (idempotent)

`witness start <plan-id>` creates or re-attaches the worktree:

```bash
$WITNESS start <plan-id>
```

Prints the worktree path (`.witness/worktrees/<plan-id>`, branch `witness/<plan-id>`) and `agent-model:`. The worktree carries **code only** — the canon dirs are excluded from it deliberately, so the plan you are implementing is not a file in there; `$WITNESS read <plan-id>` is how you read it, and what comes back is current rather than whatever was true when the worktree was cut. `agent-model:` is the config's implement-stage model pin (`gates.implement.model`, falling back to `gates.model`). Re-entry is safe: `in-progress` re-attaches or recreates. Refusals go to the human, with the remedy the CLI names: `blocked-deps` (a dependency isn't live/done yet), `needs-unmet` (show `witness satisfy …` for manual needs), `not-approved`.

## Work the plan in slices (session relay)

A fresh session is the execution model: **this session is the implementer**, working inside the worktree `start` printed. `start` also prints `dispatch-budget:` (the config's `implement.stepsPerDispatch`) and `dispatches:` (the run's shape). Work the plan as a **relay of session slices**: this session takes **at most the next `dispatch-budget` unfinished steps**, then relays. Derive which steps remain from the journal (`$WITNESS log <plan-id>` — steps with a green `test-evidence` are done), never from conversation memory.

Protocol per step, in order — red/green/refactor with witnessed evidence:

1. Write the failing test FIRST. The test's NAME carries the tag `@spec:<parent-id>` (in the title string — never a comment; e.g. `it("rotates token before expiry @spec:auth-refresh")`). Run the inner TDD loop against exactly the test under work — `-t` with the test's own name, never the spec tag. Rerunning a failing test is legal; rerunning the suite to watch one test is not. The tagged suite runs only inside the witnessed evidence cycle (the `test-evidence` phases below) at step close — "check nothing broke mid-step" duplicates a run the CLI already witnesses.
2. Run `$WITNESS test-evidence <plan-id> --phase red` from the worktree. It must record a genuine red. If it reports the test passes before implementation (`vacuous`), STOP — never proceed to green on a vacuous red. First suspect the runner: a filter that never reaches the tagged tests (e.g. a dropped trailing `--` in the root test script) makes every phase lie. Fix the runner or the test until red genuinely fails, then re-record — a later genuine red supersedes the vacuous one (the gate judges the latest cycle). A `filter-matched-nothing` refusal is the same stop signal with the diagnosis built in. If neither applies, the behavior already exists — report instead of implementing.
3. Write the minimal code to make it pass. No speculative generality.
4. Run `$WITNESS test-evidence <plan-id> --phase green` — it must record green.
5. Refactor freely while green; leave everything uncommitted — the worktree stays dirty by design.
6. Early exit: if you exceed **~15 inner-loop iterations** inside one step, or you have left the step's scope to fight infrastructure, the economy is to relay — finish the red→green you are in (never stop mid-red), report, and relay so a fresh context continues. Exceeding your slice is never the right economy.
7. Fat artifacts (the living design, long docs) are read **by section** — `$WITNESS read <spec-id> --design --outline` names every anchor with its line range, then `--lines <a>-<b>` fetches the one you need — never whole into your context; you would re-pay their tokens on every subsequent request.

**Tests you did not come to change.** When a step makes you edit a test file tagged for a spec other than your parent — a shared fixture, a helper, a suite-wide rename — you owe that spec **green now**, never a red→green pair: `red` means you observed the behavior missing before you built it, and you are not building that spec. The gate's `regression` check runs those specs' tagged tests and fails if any is red. Fix them in the worktree; never journal evidence under a tag this plan does not own, and never weaken the foreign test to pass.

UI work TDDs at the browser, end-to-end: when a step changes what the browser renders or how the user interacts with it (markup, styles, routes, client-side behavior), the failing test in step 1 is a **Puppeteer** test driving the real UI **through the whole slice** — headless, tagged in its NAME like any test, living in the repo's regular suite so the criteria runner reaches it (Puppeteer is a library, not a runner — a test the runner can't reach has unwitnessable evidence). Everything the repo owns runs real: the test owns the slice's lifecycle — build, boot the backend and its store, serve the frontend; never assume a running dev server (evidence runs in a clean worktree) — but inside your own inner loop, keep the app server alive across iterations where the harness allows; the per-run floor is boot + compile, not test time. Fake only what the repo does not own (third-party services). Stubbing the slice's own backend — request interception, mocked fetch, canned API fixtures — turns the test UI-only, and the implement gate's pr-test lens flags it like any substitution. Unit/component tests may accompany a browser test, never replace it.

**Capture the screens you build.** When `$WITNESS_SCREENS_DIR` is set (the CLI exports it during `test-evidence`), the browser test writes a named PNG per screen-level moment the step produces — `$WITNESS_SCREENS_DIR/<name>.png` via the driver's screenshot call. Name captures for the moments a reviewer must see, not every frame: `initial` (screen as it opens), `filled` (primary inputs populated), `error` (a validation/error state the slice can reach), `success` (the post-action confirmation). One capture per meaningful state; skip states the step doesn't touch. Guard the writes on the env var so the same test screenshots nothing during the gate's own drift lane. These captures are the design-reviewer's evidence — `test-evidence` witnesses a sha per PNG, and at the gate a **vision `design-reviewer`** (feature and fix batteries, only when the plan pins a `design-from` design) judges them against the repo's `docs.design` canon and the approved look (`$WITNESS read <spec-id> --design`). A UI plan that witnesses zero captures is refused `screens-matched-nothing` before any reviewer runs — a screen with no screenshot has unwitnessable design evidence, exactly as a browser test outside the runner has unwitnessable behavior evidence.

Never touch `specs/` or `plans/` (state lives on main; the CLI routes it) — they are not in your worktree at all, and `$WITNESS read <id>` is the route to their current content. Never `git commit`, never push, never open PRs — ship is a later stage and owns the sole code commit (evidence and gates read the working tree directly, so nothing needs committing here). Scaffolding steps skip evidence (nothing tagged changes). When every step is done, report the worktree diff summary.

**Relay at the slice boundary.** When your slice's steps are done (or you early-exited), report telemetry —

```bash
$WITNESS dispatch-report <plan-id> --steps-assigned <n> --steps-completed <n> \
  --tool-uses <n> --duration-ms <n>
```

(numbers are your own best-effort report; omit flags you don't have — `--tokens` is usually unknowable from inside the session. Labeled reported telemetry, never gate evidence). Then, if unfinished steps remain, print exactly this and **END YOUR TURN**:

> Slice done. Run the `relay:` line `dispatch-report` just printed — the next slice continues with fresh context (position re-derives from the journal).

`dispatch-report` prints a `relay:` line resolved for whatever harness you are running on — print it verbatim. If no `relay:` line came back, the CLI could not resolve the harness: say so, show the human `witness check`, and end your turn rather than guessing a command.

The fresh session re-enters through `/witness` and converges from CLI output — that re-entrancy is the relay mechanism, and it is why nothing may live only in conversation memory. When NO unfinished steps remain, skip the relay and go to the gate below.

If code landed before its red was witnessed (a slice slipped), reconstruct instead of faking: `$WITNESS verify-red <plan-id>` (stashes non-test changes, expects red, restores, expects green — safe in the isolated worktree).

## Gate

```bash
$WITNESS gate implement <plan-id>    # append --manual when the run asked for it
```

Its deterministic checks are the exit bar: a diff exists, every diff-added/modified tagged test has its red→green pair (no vacuous reds), and the parent's whole deterministic lane runs green locally — so ship confirms rather than discovers. The reviewer battery is class-scaled by the CLI.

- **Auto-pass** (green path — no standing stop here) → hand back to /witness.
- **Stop** (blocking findings or `--manual`) → render the gate output verbatim and in full, including its ranked options and `run:` line, and END YOUR TURN.
- **Re-entered after `--revise`** → `decide --show` for the verdict + note (code findings anchor to `path#symbol`); fix in the worktree yourself under the same TDD protocol (new behavior = new red first); re-gate. Rounds are counted by the CLI; at the bound it forces the human. `--show` also emits `state:` and `exits:` — a `reopened` or `settled` state means the verdict above it is history, so act on the `exits:` line, not on remembered findings.
- Findings implicate the **plan** (code faithful, plan wrong)? Tell the human `--revise --upstream <plan-id>` reopens the plan stage.
- A **design-reviewer** stop anchors to a capture filename (e.g. `initial.png`) — the finding is about the rendered screen, not the code. Fix the UI in the worktree, re-run the browser test so `test-evidence` witnesses the new capture, then re-gate; `$WITNESS read <spec-id> --design` is the approved direction to fix toward.
