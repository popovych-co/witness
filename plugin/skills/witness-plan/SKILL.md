---
name: witness-plan
description: Derive an implementation plan from a witness spec's delta — step manifest mapping criteria, write-validated ## Step body — then run the plan gate. Normally invoked by /witness with the spec id.
---

# witness-plan — spec delta → step plan → gate

<!-- Derived (MIT): plan discipline from obra/superpowers writing-plans
(exact files, bite-sized verifiable steps). Rewritten for witness: the plan
derives from a CLI-computed delta and its steps are schema'd against the
parent's criteria. See NOTICE.md. -->

## Ground rules (every witness skill)

Resolve the CLI once per session:

```bash
WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.8.0}"
```

- **Never edit `specs/**` or `plans/**`** (the canon dirs — `paths:` in witness.config.yaml may relocate them) — not with an edit tool, not with a write tool, not with Bash redirection. The CLI is the sole writer of state; you author in scratch files under `$(mktemp -d)` and hand them to the CLI. (The canon guard blocks you; the trailer audit catches what it can't.)
- **Never invoke gate reviewers or relay verdicts.** `witness gate` runs reviewers itself and journals what they said; your summary of a verdict is not evidence.
- **Refusal repair loop:** a `witness` verb exiting 2 prints structured violations (`field · rule · got · want`). Fix your input and retry — **3 total attempts** per artifact, then stop, show the human the violation list verbatim, and end your turn.
- **A refused or hook-blocked command is a stop, not a step to drop.** Re-issue it on its own; if it still refuses, tell the human what was blocked and why. Never proceed by deleting the refused half of a compound command — a dropped step is silent, and silence is how a skipped check becomes a shipped defect.
- **Re-entrancy:** derive position from CLI output (`$WITNESS next`, the dashboard, `log`, `index`) — never from conversation memory. Killed and re-run, you must converge.

## Inputs (rebuild them, never remember them)

Everything below is rebuilt from `witness diff` and current files — never from conversation memory.

```bash
$WITNESS diff <spec-id>        # the delta this plan must realize (base: previous plan's pin → last live → empty)
cat specs/<spec-id>.md          # the parent spec, current content (reading is fine — writing is not)
ls plans/ && cat plans/<spec-id>-plan-*.md   # prior plans for this spec, if any
# (default layout shown — a repo's `paths:` config may relocate specs/ and plans/)
$WITNESS decide plan <plan-id> --show       # ONLY when re-entered after a revise
```

**Effort slug** (write needs `--effort`): **take it from the `$WITNESS next` line that routed you here** — next resolves it to a live effort that wrote this plan or its parent, so the slug in that command is the answer. Deriving your own instead risks booking the write onto an abandoned stream. If you arrived without that line: one active effort → use it; several → `$WITNESS log <slug>` per candidate, and the effort whose `write` entries name the parent spec owns this plan; still ambiguous → ask the human. If `next` asks for a `recap` instead of a write, no live effort can carry this plan — that recap is the owed work, not the plan.

**Plan id**: `<spec-id>-plan-<n>` — n = 1 + the highest existing n in `plans/` for this spec (a spec accumulates plans over its life; expand-contract amends it twice in one effort).

## Author the plan

Every criterion in the delta must be realized by ≥ 1 step; every step maps to ≥ 1 criterion **or** is honestly `scaffolding: true` (rigging only — fixtures, wiring, config; never behavior a criterion owns). `derives-from` is **stamped by the CLI** from the parent's current content — never put it in the manifest; a supplied stale pin refuses.

If the parent spec is `ui`-flagged, its **design must already be approved** (the design stage runs between decompose and plan). Read `designs/<spec-id>.html` — your steps derive from that approved look, not a fresh invention — and put its approved artifact sha in the manifest as `"design-from"` (the CLI refuses a plan whose pin is missing, stale, or present on a non-ui parent; get it from the spec's `design.sha` stamp via `$WITNESS log <spec-id>`). A UI step names the design section (`design#<id>`) it realizes alongside its `@spec:` browser test.

```bash
DIR=$(mktemp -d)
cat > "$DIR/meta.json" <<'EOF'
{
  "type": "plan",
  "parent": "auth-refresh",
  "depends": [],
  "needs": [],
  "steps": [
    { "id": "s1", "title": "rotate tokens on refresh", "criteria": ["ac-rotate"] },
    { "id": "s2", "title": "smoke wiring", "scaffolding": true }
  ]
}
EOF
cat > "$DIR/body.md" <<'EOF'
## Step: s1

Test-first, bite-sized, checkable: name the exact files to create/modify, the
failing test to write first (its name carries `@spec:auth-refresh`), the
minimal implementation, and the observable end state that proves ac-rotate.

## Step: s2

What rigging this sets up and why no criterion owns it.
EOF
$WITNESS write auth-refresh-plan-1 --effort <effort> --meta "$DIR/meta.json" --body "$DIR/body.md"
```

Body discipline (write-validated: exactly one `## Step: <id>` section per manifest step, none missing, none orphaned):

- Each step section is executable by a fresh session with zero context: exact paths, the test to write first, expected red, minimal code, expected green.
- A step realizing browser-visible behavior (markup, styles, routes, client-side interaction) names an **end-to-end Puppeteer** test as its test-to-write-first — the browser drives the slice's real backend and store, faking only third-party boundaries the repo doesn't own. Browser-level e2e TDD is the implement contract; the implement gate's pr-test lens treats a unit test standing in for the browser — or a browser test stubbing the slice's own backend — as a coverage gap.
- Steps ordered so nothing presumes an artifact a later step creates.
- **Chore-class plans choose their own parent here** — a chore never reaches the decompose stage, so no earlier stage picked one for you. Take the spec whose implementation area the chore touches; take `parent: principles` when the chore is repo-wide. Either way the parent must be `approved`/`live` or the write refuses. Report the choice so the gate stop shows what you routed to.

## Gate

```bash
$WITNESS gate plan <plan-id>    # append --manual when the run asked for it
```

- **Auto-pass** → done; hand back to /witness.
- **Stop** → render the gate output verbatim, print `witness decide plan <plan-id> --approve | --revise --note "…" | --stop`, END YOUR TURN.
- **Re-entered after `--revise`** → `decide --show` gives the verdict + note (findings anchor to `<plan-id> > ## Step: <id>`); rewrite via `witness write` with the same plan id; re-gate. A parent amended mid-flight fails `pin-fresh` — rewriting through `witness write` re-stamps the pin to current content; your body must then realize the *new* delta (`$WITNESS diff` again). `--show` also emits `state:` and `exits:` — a `reopened` or `settled` state means the verdict above it is history, so act on the `exits:` line, not on remembered findings.
- Findings implicate the **spec** (plan faithful, spec wrong)? Tell the human `--revise --upstream <spec-id>` reopens decompose for it.
