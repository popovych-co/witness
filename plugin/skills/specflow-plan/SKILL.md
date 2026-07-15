---
name: specflow-plan
description: Derive an implementation plan from a specflow spec's delta — step manifest mapping criteria, write-validated ## Step body — then run the plan gate. Normally invoked by /specflow with the spec id.
---

# specflow-plan — spec delta → step plan → gate

<!-- Derived (MIT): plan discipline from obra/superpowers writing-plans
(exact files, bite-sized verifiable steps). Rewritten for specflow: the plan
derives from a CLI-computed delta and its steps are schema'd against the
parent's criteria. See NOTICE.md. -->

## Ground rules (every specflow skill)

Resolve the CLI once per session:

```bash
SPECFLOW="${SPECFLOW_BIN:-npx -y specflow@0.1.1}"
```

- **Never edit `specs/**` or `plans/**`** — not with Edit, not with Write, not with Bash redirection. The CLI is the sole writer of state; you author in scratch files under `$(mktemp -d)` and hand them to the CLI. (A PreToolUse hook blocks you; the trailer audit catches what it can't.)
- **Never invoke gate reviewers or relay verdicts.** `specflow gate` runs reviewers itself and journals what they said; your summary of a verdict is not evidence.
- **Refusal repair loop:** a `specflow` verb exiting 2 prints structured violations (`field · rule · got · want`). Fix your input and retry — **3 total attempts** per artifact, then stop, show the human the violation list verbatim, and end your turn.
- **Re-entrancy:** derive position from CLI output (`$SPECFLOW next`, the dashboard, `log`, `index`) — never from conversation memory. Killed and re-run, you must converge.

## Inputs (rebuild them, never remember them)

Everything below is rebuilt from `specflow diff` and current files — never from conversation memory.

```bash
$SPECFLOW diff <spec-id>        # the delta this plan must realize (base: previous plan's pin → last live → empty)
cat specs/<spec-id>.md          # the parent spec, current content (reading is fine — writing is not)
ls plans/ && cat plans/<spec-id>-plan-*.md   # prior plans for this spec, if any
$SPECFLOW decide plan <plan-id> --show       # ONLY when re-entered after a revise
```

**Effort slug** (write needs `--effort`): the dashboard's efforts table. One active effort → use it. Several → `$SPECFLOW log <slug>` per candidate; the effort whose `write` entries name the parent spec owns this plan. Still ambiguous → ask the human.

**Plan id**: `<spec-id>-plan-<n>` — n = 1 + the highest existing n in `plans/` for this spec (a spec accumulates plans over its life; expand-contract amends it twice in one effort).

## Author the plan

Every criterion in the delta must be realized by ≥ 1 step; every step maps to ≥ 1 criterion **or** is honestly `scaffolding: true` (rigging only — fixtures, wiring, config; never behavior a criterion owns). `derives-from` is **stamped by the CLI** from the parent's current content — never put it in the manifest; a supplied stale pin refuses.

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
$SPECFLOW write auth-refresh-plan-1 --effort <effort> --meta "$DIR/meta.json" --body "$DIR/body.md"
```

Body discipline (write-validated: exactly one `## Step: <id>` section per manifest step, none missing, none orphaned):

- Each step section is executable by a fresh subagent with zero context: exact paths, the test to write first, expected red, minimal code, expected green.
- Steps ordered so nothing presumes an artifact a later step creates.
- Chore-class plans take `parent: principles` when repo-wide; the parent must be `approved`/`live` or the write refuses.

## Gate

```bash
$SPECFLOW gate plan <plan-id>    # append --manual when the run asked for it
```

- **Auto-pass** → done; hand back to /specflow.
- **Stop** → render the gate output verbatim, print `specflow decide plan <plan-id> --approve | --revise --note "…" | --stop`, END YOUR TURN.
- **Re-entered after `--revise`** → `decide --show` gives the verdict + note (findings anchor to `<plan-id> > ## Step: <id>`); rewrite via `specflow write` with the same plan id; re-gate. A parent amended mid-flight fails `pin-fresh` — rewriting through `specflow write` re-stamps the pin to current content; your body must then realize the *new* delta (`$SPECFLOW diff` again).
- Findings implicate the **spec** (plan faithful, spec wrong)? Tell the human `--revise --upstream <spec-id>` reopens decompose for it.
