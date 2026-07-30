---
name: specflow-decompose
description: Slice a specflow effort's confirmed recap into vertical spec slices, or route a fix to the one spec it amends — manifests handed to specflow write, then the decompose gate. Chores never reach this stage. Normally invoked by /specflow with the effort slug.
---

# specflow-decompose — recap → sliced specs → gate

## Ground rules (every specflow skill)

Resolve the CLI once per session:

```bash
SPECFLOW="${SPECFLOW_BIN:-npx -y @whatmatters/specflow@0.2.2}"
```

- **Never edit `specs/**` or `plans/**`** (the canon dirs — `paths:` in specflow.config.yaml may relocate them) — not with an edit tool, not with a write tool, not with Bash redirection. The CLI is the sole writer of state; you author in scratch files under `$(mktemp -d)` and hand them to the CLI. (The canon guard blocks you; the trailer audit catches what it can't.)
- **Never invoke gate reviewers or relay verdicts.** `specflow gate` runs reviewers itself and journals what they said; your summary of a verdict is not evidence.
- **Refusal repair loop:** a `specflow` verb exiting 2 prints structured violations (`field · rule · got · want`). Fix your input and retry — **3 total attempts** per artifact, then stop, show the human the violation list verbatim, and end your turn.
- **A refused or hook-blocked command is a stop, not a step to drop.** Re-issue it on its own; if it still refuses, tell the human what was blocked and why. Never proceed by deleting the refused half of a compound command — a dropped step is silent, and silence is how a skipped check becomes a shipped defect.
- **Re-entrancy:** derive position from CLI output (`$SPECFLOW next`, the dashboard, `log`, `index`) — never from conversation memory. Killed and re-run, you must converge.

## Inputs (rebuild them, never remember them)

```bash
$SPECFLOW log <effort>     # the latest recap entry is your contract: class, goals g*, non-goals n*, constraints c*
$SPECFLOW index            # live canon: id · summary · status · depends, grouped by dir
$SPECFLOW decide decompose <effort> --show   # ONLY when re-entered after a revise
```

The class comes from the recap. Never ask for it again.

## Route by class

- **feature** — slice (next section). Expect the gate to stop for scope approval afterwards: that is the standing stop working, not a failure.
- **fix** — find **THE one spec** to amend: match the broken behavior against `specflow index` summaries; when summaries tie, grep `specs/` read-only. Amend exactly one spec. If the fix genuinely needs a brand-new spec, write it — the gate's tripwire stops for a human, which is the designed check on your routing (on a young canon this fires often; say so rather than fighting it).
- **chore** — **write NO specs** (a chore writing spec content is refused at write time, by definition of the class). There is nothing here for you: `next` routes a chore straight to the plan stage, because the decompose gate refuses `nothing-to-gate` without written specs and `write` refuses spec content from a chore — the stage is unsatisfiable in both directions. The parent for the coming plan is chosen when that plan is authored. Hand back immediately if you were invoked for one.

## Slicing rules (feature)

- Thin **vertical** slices: each spec independently shippable, observable end-to-end. Never layers ("the schema", "the client").
- Each spec answers exactly one question; no two overlap; **one fact, one home**. A fact needed by two slices gets extracted into its own spec, and both `depends` on it.
- Amending a living spec is the same write with the existing id — its status resets to `draft` (re-approval owed). If the CLI warns the spec has an in-flight child plan, surface that warning at the gate stop.
- Boundary changes (split, merge, extraction out of a live spec) → the new spec's manifest carries `supersedes: <old-id>`; rewrite every dependent's `depends` in the same effort — the CLI refuses dangling edges.
- Cross-cutting changes → sequenced per-slice amendments ordered via `depends`, expand-contract style (accept both → switch → drop old), each step independently shippable.
- Self-check totality before gating: every goal covered by ≥ 1 spec, every spec covers ≥ 1 goal.

## Author each spec

Manifest + body in scratch, then the write:

```bash
DIR=$(mktemp -d)
cat > "$DIR/meta.json" <<'EOF'
{
  "type": "spec",
  "summary": "Refresh tokens rotate before expiry",
  "depends": ["auth-login"],
  "needs": [],
  "criteria": [
    { "id": "ac-rotate", "test": "@spec:auth-refresh" },
    { "id": "ac-smoke", "cmd": "npm run smoke:auth" }
  ],
  "covers": ["g1"]
}
EOF
cat > "$DIR/body.md" <<'EOF'
## Motivation

Why this slice exists — the recap goal in context, one short paragraph.

## Behavior

What must observably be true, public surface only. State every `cmd:`
criterion's expected behavior and thresholds HERE — a fact that lives only
inside a script has a hidden home and drifts invisibly.
EOF
$SPECFLOW write auth-refresh --effort <effort> --meta "$DIR/meta.json" --body "$DIR/body.md"
```

Get these right the first time — the dashboard trends your first-try valid rate:

- `summary` ≤ 120 chars: what the slice **is** (Motivation carries the why).
- `criteria`: ≥ 1 entry, unique ids, each exactly one of `test` (value must be `@spec:<this-spec-id>`) or `cmd`. A criterion that cannot fail is not a criterion.
- `covers`: the recap goal ids this spec honestly advances — the critic judges the mapping's quality.
- Body: exactly the `## Motivation` and `## Behavior` headings; behavior-only — internal interfaces never appear in a spec.
- `id`: `[a-z0-9-]+`; new ids land at `specs/<id>.md` (or the repo's configured specs dir).
- `needs`: external prerequisites only, machine-checkable (`env:` / `cmd:` / `manual:` + `satisfied`).
- `ui`: set `ui: true` in the manifest **iff** the slice changes browser-rendered or interactive behavior (a screen, a form, client-side interaction). A browser-behavior slice **without** the flag, or a flag on a non-UI slice, is a slicing-critic finding. A `ui` spec earns a **design stage** before its plan — the look is approved before code (Decision 69).

## Gate

```bash
$SPECFLOW gate decompose --effort <effort>    # append --manual when the run asked for it
```

- **Auto-pass** (green path) → done; hand back to /specflow.
- **Stop** (standing stop, blocking findings, fix-created-spec tripwire) → render the gate output verbatim, print the human's exits — `specflow decide decompose <effort> --approve | --revise --note "…" | --stop` — and END YOUR TURN. You never decide.
- **Re-entered after `--revise`** → `decide --show` reconstructs the verdict + human note; findings anchor to spec headings. Fix via new `specflow write` calls (same ids amend in place), self-check totality, re-gate. The 3-round bound is the CLI's — surface it, never fight it. `--show` also emits `state:` and `exits:` — a `reopened` or `settled` state means the verdict above it is history, so act on the `exits:` line, not on remembered findings.
- Findings implicate the **scope itself** (goals wrong, not slicing wrong)? Tell the human that `--revise --upstream` on the stop screen routes back to re-interview via `specflow recap --amend`.
