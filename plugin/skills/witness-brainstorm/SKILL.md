---
name: witness-brainstorm
description: Stateless scope interview for a witness effort — one question at a time, each with a firm recommendation, ending in a confirmed scope recap persisted via witness recap. Use when starting a new effort or re-scoping one; normally invoked by /witness.
---

# witness-brainstorm — scope interview → confirmed recap

<!-- Derived (MIT): interview style from mattpocock/skills grill-me (one
question at a time, always with a recommendation); intent-before-design
exploration from obra/superpowers brainstorming. Rewritten stateless for
witness: ends in a confirmed scope recap, writes no document. See NOTICE.md. -->

## Ground rules (every witness skill)

Resolve the CLI once per session:

```bash
WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.10.0}"
```

- **Never edit `specs/**` or `plans/**`** (the canon dirs — `paths:` in witness.config.yaml may relocate them) — not with an edit tool, not with a write tool, not with Bash redirection. The CLI is the sole writer of state; you author in scratch files under `$(mktemp -d)` and hand them to the CLI. (The canon guard blocks you; the trailer audit catches what it can't.)
- **Never invoke gate reviewers or relay verdicts.** `witness gate` runs reviewers itself and journals what they said; your summary of a verdict is not evidence.
- **Refusal repair loop:** a `witness` verb exiting 2 prints structured violations (`field · rule · got · want`). Fix your input and retry — **3 total attempts** per artifact, then stop, show the human the violation list verbatim, and end your turn.
- **A refused or hook-blocked command is a stop, not a step to drop.** Re-issue it on its own; if it still refuses, tell the human what was blocked and why. Never proceed by deleting the refused half of a compound command — a dropped step is silent, and silence is how a skipped check becomes a shipped defect.
- **Re-entrancy:** derive position from CLI output (`$WITNESS next`, the dashboard, `log`, `index`) — never from conversation memory. Killed and re-run, you must converge.

## What you produce

No canon, only evidence: a **confirmed scope recap** persisted by `witness recap` as the birth entry of the effort journal. This skill writes no spec, no plan, no brief — decompose consumes the recap after you, including after session death.

## Interview protocol

**One question per turn.** Every question carries a concrete recommendation, a one-line why, and the strongest rejected alternative. Lock each answer before the next; walk in dependency order:

1. **Class** — `feature | fix | chore`. Recommend from the opening ask: `fix` restores promised behavior; `chore` is motion with no state change (deps, tooling); everything else is `feature`.
2. **Problem & outcome goals** — what observably changes, for whom. Number them `g1, g2, …`. Each goal is an outcome someone can observe — "Guests can pay by card", never "Integrate Stripe".
3. **Non-goals** — what this effort deliberately will not do: `n1, n2, …`. Push for at least one; scope without a "no" is unbounded.
4. **Constraints** — standing limits (compliance, performance budgets, compatibility): `c1, …`. Empty is fine.
5. **Slice candidates** — non-binding thin vertical slices you would expect decompose to cut. Plain strings.

**Short forms.** `fix`: two questions — (1) what breaks, with the observable evidence; (2) the fix boundary — what must NOT change (its non-goals). `chore`: two questions — what maintenance, which area it touches.

## Confirmation

Render the recap as a table (class · goals · non-goals · constraints · slices) and get an explicit yes. Adjust and re-render until confirmed. The recap is decompose's input contract — a fuzzy recap poisons every stage after it.

## Persist

```bash
DIR=$(mktemp -d)
cat > "$DIR/recap.json" <<'EOF'
{
  "effort": "auth-hardening",
  "class": "feature",
  "goals": [{ "id": "g1", "text": "Refresh tokens rotate before expiry" }],
  "non_goals": [{ "id": "n1", "text": "No SSO provider changes" }],
  "constraints": [],
  "slices": ["token rotation"]
}
EOF
$WITNESS recap --file "$DIR/recap.json"
```

- Effort slug: kebab-case `[a-z0-9-]+`, minted from the scope title. A `slug-reuse` refusal means that history exists — mint a different slug; histories never merge, and `--amend` is never the dodge.
- **Amending scope** — mid-effort scope change, or the decompose gate's stop screen handed off to re-interview: run the interview shortened to what changed, confirm, then `$WITNESS recap --amend <effort> --file "$DIR/recap.json"`. An amendment re-arms the decompose gate's feature-class stop: scope changed, scope gets re-approved.
- The refusal repair loop applies (3 attempts, then stop with the violation list).

## Stateless by design

Session died mid-interview? Start over — nothing was persisted; that is the accepted cost. If the dashboard's efforts table already shows the effort (the recap landed), do not re-interview — hand back to /witness.
