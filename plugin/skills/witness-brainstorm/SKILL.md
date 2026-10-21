---
name: witness-brainstorm
description: Stateless scope interview for a witness effort — one question at a time, each with a firm recommendation, ending in a confirmed scope recap persisted via witness recap; under autonomy it drafts the recap from the queued ask with no interview. Use when starting a new effort or re-scoping one; normally invoked by /witness.
---

# witness-brainstorm — scope interview → confirmed recap

<!-- Derived (MIT): interview style from mattpocock/skills grill-me (one
question at a time, always with a recommendation); intent-before-design
exploration from obra/superpowers brainstorming. Rewritten stateless for
witness: ends in a confirmed scope recap, writes no document. See NOTICE.md. -->

## Ground rules (every witness skill)

Resolve the CLI once per session:

```bash
WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.17.0}"
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

## What you produce

No canon, only evidence: a **confirmed scope recap** persisted by `witness recap` as the birth entry of the effort journal. This skill writes no spec, no plan, no brief — decompose consumes the recap after you, including after session death.

## Under `autonomy: on`

When the CLI prints `autonomy: on` and this run is not `--manual`, there is no interview and no confirmation: nobody is there to answer. You answer one ask.

1. **Read the ask from the CLI.** `$WITNESS next` prints it as `ask: <id> — <text>` under `stage: brainstorm`, and it is the whole brief. No `ask:` line means nobody asked for anything: report `no ask — nothing to build` and end.
2. **Draft the recap from the ask and the repo.** Read `$WITNESS index` (existing canon, so a `fix` can name the spec whose promise it restores) and the repo's product docs. Pick the class by the interview's rules. When the ask could add or change a screen, the class is `feature`.
3. **Write every assumption down.** Everything the ask does not say and your recap assumes becomes a constraint (`c1 …`, "Assumed: …") or a non-goal (`n1 …`). Leave no assumption in your head: the recap is all the next stage and the check can see.
4. **Persist with the ask:** `$WITNESS recap --file "$DIR/recap.json" --ask <id>`. The CLI checks the recap against the ask before the effort is born. Exit 1 means the check sent it back: its `reason:` and `note:` lines say what to change, so re-draft and run it again. When it prints that the ask is parked, end: the CLI reports it.
5. **Never pass `--manual` yourself.** It tells the CLI a human confirmed the recap. A refusal the CLI calls a human's decision (`ask-required`, `ask-parked`, `class-change`) is a stop.

## Interview protocol

**One question per turn.** Every question carries the same five fields the CLI's decision block uses, so a human meets one shape everywhere in this pipeline: a concrete **recommendation**, a one-line **why**, the strongest **alternative**, **when** that alternative is the right call, and the **tradeoff** it carries against the recommendation. Add a short note to either option only when running with it has a caveat the option itself does not state. Lock each answer before the next; walk in dependency order. The five fields are **the floor, not the count** — keep interviewing while material scope uncertainty remains; a recap that would surprise its reviewer is under-asked:

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

- When `next` printed an `ask:` line, add `--ask <id>`: the recap records the ask it answers, and `next` stops offering it.
- Effort slug: kebab-case `[a-z0-9-]+`, minted from the scope title. A `slug-reuse` refusal means that history exists — mint a different slug; histories never merge, and `--amend` is never the dodge.
- **Amending scope** — mid-effort scope change, or the decompose gate's stop screen handed off to re-interview: run the interview shortened to what changed, confirm, then `$WITNESS recap --amend <effort> --file "$DIR/recap.json"`. An amendment re-arms the decompose gate's feature-class stop: scope changed, scope gets re-approved.
- The refusal repair loop applies (3 attempts, then stop with the violation list).

## Stateless by design

Session died mid-interview? Start over — nothing was persisted; that is the accepted cost. If the dashboard's efforts table already shows the effort (the recap landed), do not re-interview — hand back to /witness.
