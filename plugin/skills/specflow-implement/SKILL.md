---
name: specflow-implement
description: Implement a specflow plan — CLI-managed worktree, fresh subagent, red/green TDD with CLI-witnessed evidence per step, then the implement gate. Normally invoked by /specflow with the plan id.
---

# specflow-implement — plan → tagged tests + code → gate

<!-- Derived (MIT): red/green/refactor discipline merged from obra/superpowers
test-driven-development and mattpocock/skills tdd (near-duplicates; union
taken). Rewritten for specflow: evidence is CLI-witnessed at red and green,
tests carry the parent spec's tag in their NAME. See NOTICE.md. -->

## Ground rules (every specflow skill)

Resolve the CLI once per session:

```bash
SPECFLOW="${SPECFLOW_BIN:-npx -y @whatmatters/specflow@0.1.6}"
```

- **Never edit `specs/**` or `plans/**`** (the canon dirs — `paths:` in specflow.config.yaml may relocate them) — not with Edit, not with Write, not with Bash redirection. The CLI is the sole writer of state; you author in scratch files under `$(mktemp -d)` and hand them to the CLI. (A PreToolUse hook blocks you; the trailer audit catches what it can't.)
- **Never invoke gate reviewers or relay verdicts.** `specflow gate` runs reviewers itself and journals what they said; your summary of a verdict is not evidence.
- **Refusal repair loop:** a `specflow` verb exiting 2 prints structured violations (`field · rule · got · want`). Fix your input and retry — **3 total attempts** per artifact, then stop, show the human the violation list verbatim, and end your turn.
- **Re-entrancy:** derive position from CLI output (`$SPECFLOW next`, the dashboard, `log`, `index`) — never from conversation memory. Killed and re-run, you must converge.

## Start (idempotent)

`specflow start <plan-id>` creates or re-attaches the worktree:

```bash
$SPECFLOW start <plan-id>
```

Prints the worktree path (`.specflow/worktrees/<plan-id>`, branch `specflow/<plan-id>`) and `agent-model:` — the config's implement-stage model pin (`gates.implement.model`, falling back to `gates.model`). Re-entry is safe: `in-progress` re-attaches or recreates. Refusals go to the human, with the remedy the CLI names: `blocked-deps` (a dependency isn't live/done yet), `needs-unmet` (show `specflow satisfy …` for manual needs), `not-approved`.

## Dispatch a fresh subagent

One plan = one fresh subagent working **inside the worktree** — clean context, real isolation. **Dispatch it on the model `start` printed as `agent-model:`** — map the exact id to your dispatch surface's nearest knob (e.g. `claude-sonnet-5` → `sonnet`); `session-default` means inherit the session model, never substitute your own judgment for the pin. Dispatch it with this prompt, filling the placeholders from the plan doc:

> Work in `<worktree-path>` (cd there first; every file you touch lives under it).
> You are implementing plan `<plan-id>` for spec `<parent-id>`. Its step sections follow: <paste the plan's `## Step:` sections>.
>
> Protocol per step, in order — red/green/refactor with witnessed evidence:
> 1. Write the failing test FIRST. The test's NAME carries the tag `@spec:<parent-id>` (in the title string — never a comment; e.g. `it("rotates token before expiry @spec:auth-refresh")`).
> 2. Run `${SPECFLOW_BIN:-npx -y @whatmatters/specflow@0.1.6} test-evidence <plan-id> --phase red` from the worktree. It must record a genuine red. If it reports the test passes before implementation (`vacuous`), STOP — never proceed to green on a vacuous red. First suspect the runner: a filter that never reaches the tagged tests (e.g. a dropped trailing `--` in the root test script) makes every phase lie. Fix the runner or the test until red genuinely fails, then re-record — a later genuine red supersedes the vacuous one (the gate judges the latest cycle). A `filter-matched-nothing` refusal is the same stop signal with the diagnosis built in. If neither applies, the behavior already exists — report instead of implementing.
> 3. Write the minimal code to make it pass. No speculative generality.
> 4. Run `… test-evidence <plan-id> --phase green` — it must record green.
> 5. Refactor freely while green; leave everything uncommitted — the worktree stays dirty by design.
>
> UI work TDDs at the browser, end-to-end: when a step changes what the browser renders or how the user interacts with it (markup, styles, routes, client-side behavior), the failing test in step 1 is a **Puppeteer** test driving the real UI **through the whole slice** — headless, tagged in its NAME like any test, living in the repo's regular suite so the criteria runner reaches it (Puppeteer is a library, not a runner — a test the runner can't reach has unwitnessable evidence). Everything the repo owns runs real: the test owns the slice's lifecycle — build, boot the backend and its store, serve the frontend; never assume a running dev server (evidence runs in a clean worktree). Fake only what the repo does not own (third-party services). Stubbing the slice's own backend — request interception, mocked fetch, canned API fixtures — turns the test UI-only, and the implement gate's pr-test lens flags it like any substitution. Unit/component tests may accompany a browser test, never replace it.
>
> Never touch `specs/` or `plans/` (state lives on main; the CLI routes it). Never `git commit`, never push, never open PRs — ship is a later stage and owns the sole code commit (evidence and gates read the working tree directly, so nothing needs committing here). Scaffolding steps skip evidence (nothing tagged changes). When every step is done, report the worktree diff summary.

If code landed before its red was witnessed (you or the subagent slipped), reconstruct instead of faking: `$SPECFLOW verify-red <plan-id>` (stashes non-test changes, expects red, restores, expects green — safe in the isolated worktree).

## Gate

```bash
$SPECFLOW gate implement <plan-id>    # append --manual when the run asked for it
```

Its deterministic checks are the exit bar: a diff exists, every diff-added/modified tagged test has its red→green pair (no vacuous reds), and the parent's whole deterministic lane runs green locally — so ship confirms rather than discovers. The reviewer battery is class-scaled by the CLI.

- **Auto-pass** (green path — no standing stop here) → hand back to /specflow.
- **Stop** (blocking findings or `--manual`) → render verbatim, print `specflow decide implement <plan-id> --approve | --revise --note "…" | --stop`, END YOUR TURN.
- **Re-entered after `--revise`** → `decide --show` for the verdict + note (code findings anchor to `path#symbol`); dispatch the subagent again with the findings appended to its prompt; it fixes in the worktree under the same TDD protocol (new behavior = new red first); re-gate. Rounds are counted by the CLI; at the bound it forces the human.
- Findings implicate the **plan** (code faithful, plan wrong)? Tell the human `--revise --upstream <plan-id>` reopens the plan stage.
