---
name: specflow-design
description: Produce a ui spec's living approved look — an interactive design session ending in a self-contained designs/<spec-id>.html handed to specflow design, then the design gate. Normally invoked by /specflow with the spec id.
---

# specflow-design — spec → approved look → gate

<!-- Adapted: process from benoticed docs/ui/redesign-method.md (context phase →
2-3 distinct directions → converge → change-ladder), generalized to two modes and
re-owned for specflow; greenfield direction informed by Anthropic frontend-design
(Apache-2.0, LICENSES/frontend-design-Apache-2.0.txt, changes stated in NOTICE.md).
No text copied verbatim; the design-critic lens is new material. -->

## Ground rules (every specflow skill)

Resolve the CLI once per session:

```bash
SPECFLOW="${SPECFLOW_BIN:-npx -y @whatmatters/specflow@0.2.1}"
```

- **Never edit `specs/**`, `plans/**`, or `designs/**`** — the CLI is the sole writer of state. Author HTML in `$(mktemp -d)` and hand it to `specflow design`. (A PreToolUse hook blocks direct edits; the trailer audit catches end-runs.)
- **Never invoke gate reviewers or relay verdicts.** `specflow gate design` runs the design-critic itself and journals what it said.
- **Refusal repair loop:** `specflow design` exiting 2 prints structured violations (`field · rule · got · want`). Fix and retry — **3 total attempts**, then stop and show the human the list verbatim.
- **A refused or hook-blocked command is a stop, not a step to drop.** Re-issue it on its own; if it still refuses, tell the human what was blocked and why. Never proceed by deleting the refused half of a compound command — a dropped step is silent, and silence is how a skipped check becomes a shipped defect.
- **Re-entrancy:** derive position from `$SPECFLOW next` / the dashboard / `log`, never from conversation memory.

## When you run

The `/specflow` loop invokes you for a `ui`-flagged spec in a **feature** effort whose design is pending (missing or stale). fix/chore specs never reach you. Two modes:

- **New screen** — no `designs/<spec-id>.html` yet. Design from the spec.
- **Amend a living look** — the file exists but the spec was amended. Read the current look first; propose the *smallest* change that re-serves the (changed) behavior. If there is genuinely no visual delta, tell the human to run `specflow design <spec-id> --reconfirm` (re-stamps, no session).

## Inputs (rebuild them, never remember them)

```bash
cat specs/<spec-id>.md                 # the parent spec — Behavior is your coverage contract
$SPECFLOW index                        # sibling specs, for pattern consistency
cat designs/<spec-id>.html 2>/dev/null # the current look, in amend mode
# the repo's design canon, if configured — read docs.design from specflow.config.yaml:
#   docs: { design: [docs/ui/design-language.md, ...] }  → read each; it is the blocking authority
```

## The session (interactive — this stage is human judgment)

1. **Context.** Name the screen's one job and primary user (from the spec's Motivation + Behavior). If a design canon is configured, read it — it governs hierarchy, framing, action placement, and component vocabulary. Report what you found before proposing.
2. **Diverge.** Produce **2–3 genuinely distinct** structural directions that serve the job (different hierarchies/groupings), each consistent with the canon. One idea is never enough — divergence is what surfaces a better structure than the obvious one.
3. **Converge.** With the human, pick or synthesize the winner. Every behavior the spec promises must be visible and operable in it (the design-critic checks this as blocking coverage).
4. **Author the artifact.** One **self-contained** HTML file — inline all CSS/JS, embed assets as `data:` URIs, no external `src`/`href`. Give every section a stable, unique `id` (`id="essentials"`, `id="save-bar"`, …): these are the design-critic's anchors and must total **≥ 2**. Data-shape anchoring: when a section renders spec data, name the id after the data it shows, not its pixels.

```bash
DIR=$(mktemp -d)
cat > "$DIR/look.html" <<'EOF'
<!doctype html>
<html><head><meta charset="utf-8"><style>/* inline tokens + layout */</style></head>
<body>
  <header id="eyebrow">Bookings</header>
  <main id="essentials"><!-- the 5 things that matter, dominant --></main>
  <details id="advanced"><!-- tuning fields, subordinate --></details>
  <footer id="save-bar"><!-- primary action, always reachable --></footer>
</body></html>
EOF
$SPECFLOW design <spec-id> --file "$DIR/look.html"
```

```bash
$SPECFLOW design <spec-id> --open   # opens the artifact for the human — required before the gate
```

- **Register, then show.** `specflow gate design` refuses `design-unseen` until the human has been shown the artifact's current bytes, so `--open` is part of the flow, not a nicety. Re-authoring re-arms it: new bytes, new showing. `specflow next` names this step by itself — follow it.
- The opener failing (`opener-failed`) prints a `file://` path. Give the human that path verbatim and stop; do not work around it by pointing `SPECFLOW_OPENER` at something that does not show anything.

## Gate

```bash
$SPECFLOW gate design <spec-id>    # append --manual when the run asked for it
```

- The design gate **always stops** — the look is human judgment, same footing as ship. It refuses to run at all until `specflow design <spec-id> --open` has shown the human the current artifact. Render the gate output verbatim and print the exits: `specflow decide design <spec-id> --approve | --revise --note "…" | --stop`. **END YOUR TURN.** You never decide. The findings are *about* the design — they are never a substitute for the human being shown it.
- **Re-entered after `--revise`** → `specflow decide design <spec-id> --show` reconstructs the verdict + note (findings anchor to `design#<id>` or `<spec-id> > ## Heading`). Re-author the HTML, re-run `specflow design`, re-gate. The 3-round bound is the CLI's — surface it, never fight it. `--show` also emits `state:` and `exits:` — a `reopened` or `settled` state means the verdict above it is history, so act on the `exits:` line, not on remembered findings.
- Findings implicate the **slicing** (the spec is wrong, not the look)? Tell the human `specflow decide design <spec-id> --revise --upstream <effort>` reopens decompose (scope-level changes chain to `recap --amend`).
- On approve the CLI stamps `design: {sha, spec}` on the spec; the plan stage then requires that pin. You are done — hand back to `/specflow`.
