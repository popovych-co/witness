---
name: witness-decompose
description: Slice a witness effort's confirmed recap into vertical spec slices, or route a fix to the one spec it amends — manifests handed to witness write, then the decompose gate. Chores never reach this stage. Normally invoked by /witness with the effort slug.
---

# witness-decompose — recap → sliced specs → gate

## Ground rules (every witness skill)

Resolve the CLI once per session:

```bash
WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.26.2}"
```

- **Render the CLI's decision output verbatim and in full — every line, unmodified.** Never print a command set you remember; never recompose, reformat, summarise or reorder what the CLI emitted. Which decisions are live, how they rank, and what each costs are the CLI's answers, and they change with the round, the bound, the repair grant and the content sha — a remembered set is wrong in more states than it is right.
- **The human decides; you may type it.** Run a `witness decide` verb when the human **names an option** — its number or its verb — or gives a bare affirmation ("y", "ok", "go") while a **CLI-rendered decision block carrying a recommended option** is on screen: the affirmation **selects the recommended option**, and you append `--via affirmation` to the printed command. Otherwise the string is run **byte-for-byte**: never recomposed, never reformatted, never with a placeholder you resolved yourself. The moment you compose a `--note` or resolve an id, you are authoring their decision. **A nod never takes** `--approve --override`, `--stop`, a trust grant, or `witness abandon` — those require naming, and the CLI refuses them with `nod-cannot`. A block with **no** recommendation also requires naming. **Questions you authored yourself** (the grill, the design session's questions) are conversation, not a block: an affirmation there accepts your stated recommendation, with no selection entry, no journal claim and no flag; a number there (1, 2, 3) picks that answer — never a `witness decide` option. A selection does not survive session death: killed and re-run, render the block again and ask again.
- **Never edit `specs/**`, `plans/**`, or `designs/**`** (the canon dirs — `paths:` in witness.config.yaml may relocate them) — not with an edit tool, not with a write tool, not with Bash redirection. The CLI is the sole writer of state; you author in scratch files under `$(mktemp -d)` and hand them to the CLI. (The canon guard blocks you; the trailer audit catches what it can't.)
- **Read canon with `witness read <id>`, never by path.** Canon lives at the primary root; inside a worktree the files are **absent by design**, so a path read finds nothing and a stale copy cannot be mistaken for the contract. Fat artifacts: `witness read <spec-id> --design --outline`, then `--lines <a>-<b>`.
- **Read a file before your first edit of it in this session.** Relay boundaries, `verify-red`'s stash cycle, and worktree re-attach all change files under you — an edit against a remembered copy is how "modified since read" and partial applies happen. The CLI now prints `stale-reads:` when it churns the tree; treat that list as unread.
- **Never invoke gate reviewers or relay verdicts.** `witness gate` runs reviewers itself and journals what they said; your summary of a verdict is not evidence.
- **Refusal repair loop:** a `witness` verb exiting 2 prints structured violations (`field · rule · got · want`). Fix your input and retry — **3 total attempts** per artifact, then stop, show the human the violation list verbatim, and end your turn.
- **A refused or hook-blocked command is a stop, not a step to drop.** Re-issue it on its own; if it still refuses, tell the human what was blocked and why. Never proceed by deleting the refused half of a compound command — a dropped step is silent, and silence is how a skipped check becomes a shipped defect.
- **Re-entrancy:** derive position from CLI output (`$WITNESS next`, the dashboard, `log`, `index`) — never from conversation memory. Killed and re-run, you must converge.
- **A `witness: context …` line is addressed to you.** Once per session, when this session's context has filled to the configured limit, it follows a command's result. Finish the act you are in (here: the specs, through their writes and the gate) — a session that has done none yet does the one it was routed to — then hand back to /witness, whose `next` hands over to a fresh session.

## Inputs (rebuild them, never remember them)

```bash
$WITNESS read <effort> --decisions   # the latest recap: class, goals g*, decisions d*, constraints c*, non-goals n*
$WITNESS index            # live canon: id · summary · status · depends, grouped by dir
$WITNESS decide decompose <effort> --show   # ONLY when re-entered after a revise
```

The class comes from the recap. Never ask for it again.

## Route by class

- **feature** — slice (next section). Expect the gate to stop for scope approval afterwards: that is the standing stop working, not a failure.
- **fix** — find **THE one spec** to amend: match the broken behavior against `witness index` summaries; when summaries tie, grep the specs dir read-only **at the primary root** (searching across canon is not an artifact read, and there is no verb for it — the read rule governs reading an artifact you have already identified). Amend exactly one spec. If the fix genuinely needs a brand-new spec, write it — the gate's tripwire stops for a human, which is the designed check on your routing (on a young canon this fires often; say so rather than fighting it).
- **chore** — **write NO specs** (a chore writing spec content is refused at write time, by definition of the class). There is nothing here for you: `next` routes a chore straight to the plan stage, because the decompose gate refuses `nothing-to-gate` without written specs and `write` refuses spec content from a chore — the stage is unsatisfiable in both directions. The parent for the coming plan is chosen when that plan is authored. Hand back immediately if you were invoked for one.

## Slicing rules (feature)

- Thin **vertical** slices: each spec independently shippable, observable end-to-end. Never layers ("the schema", "the client").
- Each spec answers exactly one question; no two overlap; **one fact, one home**. A fact needed by two slices gets extracted into its own spec, and both `depends` on it.
- Amending a living spec is the same write with the existing id — its status resets to `draft` (re-approval owed). If the CLI warns the spec has an in-flight child plan, surface that warning at the gate stop.
- Boundary changes (split, merge, extraction out of a live spec) → the new spec's manifest carries `supersedes: <old-id>`; rewrite every dependent's `depends` in the same effort — the CLI refuses dangling edges. It also refuses `dangling-parent` while a plan of the old spec is still in motion: whether that plan ships first or is abandoned is the human's call, so stop and surface it — never abandon it yourself.
- Cross-cutting changes → sequenced per-slice amendments ordered via `depends`, expand-contract style (accept both → switch → drop old), each step independently shippable.
- Self-check totality before gating: every goal covered by ≥ 1 spec, every spec covers ≥ 1 goal, every decision carried by ≥ 1 spec. A decision no slice can carry was filed wrong — it is a constraint or a non-goal; say so at the gate stop, where `--revise --upstream` re-opens the recap.

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
  "covers": ["g1"],
  "carries": ["d1"]
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
$WITNESS write auth-refresh --effort <effort> --meta "$DIR/meta.json" --body "$DIR/body.md"
```

Get these right the first time — the dashboard trends your first-try valid rate:

- `summary` ≤ 120 chars: what the slice **is** (Motivation carries the why).
- `criteria`: ≥ 1 entry, unique ids, each exactly one of `test` (value must be `@spec:<this-spec-id>`) or `cmd`. A criterion that cannot fail is not a criterion.
- `covers`: the recap goal ids this spec honestly advances — the critic judges the mapping's quality.
- `carries`: the recap decision ids this spec realizes. Every decision is carried by ≥ 1 spec (the gate's `decision-coverage`). A behavior decision is stated in that spec's `## Behavior`; an approach decision is not contradicted. The journal holds it, never frontmatter. Omit it when the recap has no decisions.
- Body: exactly the `## Motivation` and `## Behavior` headings; behavior-only — internal interfaces never appear in a spec.
- `id`: `[a-z0-9-]+`; new ids land at `specs/<id>.md` (or the repo's configured specs dir). An id that already names something is refused `id-taken` — a superseded spec, an effort's slug, witness's `floor` — and so is a path another doc holds (`path-taken`): choose a new id.
- `needs`: external prerequisites only, machine-checkable (`env:` / `cmd:` / `manual:` + `satisfied`). A manual need the slice can still be built and shipped without carries an `id` and names the `cmd:` criteria it holds — `{ "id": "ses-prod", "manual": "SES production access", "satisfied": false, "holds": ["ac-baseline"] }` — and while it is unmet those criteria report `held` instead of failing. A need the slice cannot even start without belongs on its plan, where it blocks `witness start`.
- `ui`: set `ui: true` in the manifest **iff** the slice changes browser-rendered or interactive behavior (a screen, a form, client-side interaction). A browser-behavior slice **without** the flag, or a flag on a non-UI slice, is a slicing-critic finding. A `ui` spec earns a **design stage** before its plan — the look is approved before code (Decision 69).

## Gate

```bash
$WITNESS gate decompose --effort <effort>    # append --manual when the run asked for it
```

- **Auto-pass** (green path) → done; hand back to /witness.
- **Stop** (standing stop, blocking findings, fix-created-spec tripwire) → render the gate output verbatim and in full, including its ranked options and `run:` line, and END YOUR TURN. You never decide.
- **Re-entered after `--revise`** → `decide --show` reconstructs the verdict + human note; findings anchor to spec headings. Fix via new `witness write` calls (same ids amend in place), self-check totality, re-gate. The 3-round bound is the CLI's — surface it, never fight it. `--show` also emits `state:` and `exits:` — a `reopened` or `settled` state means the verdict above it is history, so act on the `exits:` line, not on remembered findings.
- **Re-entered after the stop screen's re-interview option** (`--revise --upstream <effort>` naming this effort: the scope itself; `decide decompose <effort> --show` carries the human's note) → never re-slice against the recap the human rejected. Use the `witness-brainstorm` skill to amend it, starting from `$WITNESS draft amend-<effort>`; once its first answer is saved `next` resumes the amendment, and the re-armed gate judges the new slicing after it lands.
- Findings implicate the **scope itself** (goals wrong, not slicing wrong)? Tell the human that `--revise --upstream` on the stop screen sends it back to re-interview: the `witness-brainstorm` skill amends the recap, starting from `$WITNESS draft amend-<effort>`, and `next` resumes the amendment once its first answer is saved.
- **Under `autonomy: on`** (printed by `gate`; not on a `--manual` run): the CLI settles this stop itself — the scope stop and a created spec go to its arbiter, findings to its policy — and prints `decided:`. If a `relay:` line printed under it, this session has reached its context limit: print that line verbatim and END YOUR TURN — a fresh session takes the revise. Otherwise, on `→ revise`, re-author from the revise-context it printed and re-gate; on `→ approve` or `→ stop`, hand back to /witness. Never run `witness decide`. End your turn only at a `kept-stop:` line, a `relay:` line, or a refusal you cannot repair.
