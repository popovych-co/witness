---
name: witness-brainstorm
description: The grill for a witness effort — walks the whole decision tree one plain-words question per turn, each with up to three ranked answers, explores the repo before asking, saves a local draft after every settled answer, and ends in a critique pass, a playback and a confirmed recap persisted via witness recap. Normally invoked by /witness.
---

# witness-brainstorm — the grill → confirmed recap

<!-- Derived (MIT): the grill from mattpocock/skills grill-me (the whole
decision tree, one question at a time with a recommended answer, the codebase
explored instead of asking); intent-before-design exploration from
obra/superpowers brainstorming. Rewritten for witness: ends in a confirmed
recap, keeps a local draft, writes no document. See NOTICE.md. -->

## Ground rules (every witness skill)

Resolve the CLI once per session:

```bash
WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.26.1}"
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
- **A `witness: context …` line is addressed to you.** Once per session, when this session's context has filled to the configured limit, it follows a command's result. Finish the act you are in (here: the answer you are on, through its `witness draft` save) — a session that has done none yet does the one it was routed to — then hand back to /witness, whose `next` hands over to a fresh session.

## What you produce

No canon, only evidence: a **confirmed scope recap** persisted by `witness recap` as the birth entry of the effort journal. This skill writes no spec, no plan, no brief — decompose consumes the recap after you, including after session death. On the way it keeps a **local draft** through `witness draft`: never committed, never journaled, deleted when the recap lands.

## Start

```bash
DIR=$(mktemp -d)
```

- **An amendment queues no ask.** When `next` printed a `target:` with `stage: brainstorm`, or you were sent to amend (a decompose scope stop, a design session's behavior answer), skip the ask: the key is `amend-<effort>`, and the amendment bullet below is where you start.
- **The ask.** Every new effort's grill starts by queuing an ask. Use the `ask:` line from `$WITNESS next` when it is there. When it is not, open with "what do you want to build?", run `$WITNESS ask "<their words>"` on the answer, then run `$WITNESS next` again — its `ask:` line names the id.
- **The key.** Your draft's key is `ask-<id>`, or `amend-<effort>` for an amendment.
- **Resuming.** A `draft:` line means resume: read the draft back with the command it names, continue after the last settled answer, and tell the human in one line where you resume. `next` names a drafted amendment the same way, with `target:` its effort.
- **An amendment** (a decompose stop sent back to re-interview, or a design session's behavior answer) starts from `$WITNESS draft amend-<effort>`, which prints the latest recap as the seed. Edit that seed, and never retype a text you are not changing: a decision's text is part of its plans' pin. Walk the branches the change touches. Once its first answer is saved, `next` resumes it ahead of the effort's other work.

## The question

- **One question per turn**, in plain words — no witness jargon the human has to decode.
- **Up to three ranked answers, in the CLI's field words** (a human meets one shape everywhere in this pipeline). Answer 1 is the pick, with its **why**. Answers 2 and 3 each carry **when** (better if…) and **tradeoff** (the cost against the pick). Give fewer when fewer real answers exist — never padded.
- **How the human replies:** `y` or `1` takes the pick, `2` or `3` takes those, or they answer in their own words. Lock each answer before the next.

## Explore before asking, check before showing

- Anything the repo can answer — code, `witness index`, `witness read <id>`, `witness read <id> --decisions`, product docs, journals — you answer yourself, and say what you found with `file:line`. Only intent, priorities, taste and facts outside the repo reach the human.
- Every factual claim in a question is verified by a file read or a probe before the human sees it.

## The walk

- **The floor.** The recap's fields are **the floor, not the count**: keep asking while any open branch would change what gets built. A recap that would surprise its reviewer is under-asked.
- **The order, by dependency:** the problem and who has it → scope edges → behavior, including edge cases and failures → data and approach → rollout and compatibility. Skip branches the repo already answers.
- **Class** — `feature | fix | chore` — is inferred: `fix` restores promised behavior; `chore` is motion with no state change (deps, tooling); everything else is `feature`. It shows in the playback, and you ask only when it is unclear.
- **No short forms.** A fix's or a chore's tree is small, so its grill ends fast; it is still walked whole.
- **Out of bounds:** the look (that is the design session) and the order of steps (that is the plan).

## Where each answer goes

- **Goals** are outcomes someone can observe, numbered `g1, g2, …` — "Guests can pay by card", never "Integrate Stripe".
- **Non-goals** are deliberate noes, `n1, …`. Push for at least one; scope without a "no" is unbounded.
- **Constraints** are standing limits on the whole effort (compliance, performance budgets, compatibility), `c1, …`. Empty is fine.
- **Decisions** are settled answers that shape at least one spec, in behavior or approach, `d1, …`. An answer that shapes no single spec is a constraint or a non-goal.
- **Slices** are non-binding thin vertical slices you expect decompose to cut — plain strings.

## Save as you go

After each settled answer, write the growing draft — the recap fields settled so far, plus `open`, the branches still open — and save it:

```bash
cat > "$DIR/draft.json" <<'EOF'
{
  "class": "feature",
  "goals": [{ "id": "g1", "text": "Guests can pay by card at checkout" }],
  "decisions": [{ "id": "d1", "text": "A declined card keeps the cart and says why" }],
  "open": ["which card brands", "refunds"]
}
EOF
$WITNESS draft <key> --file "$DIR/draft.json"
```

The CLI checks the draft's shape, never its completeness. A `draft-moved` refusal means another session saved answers since: read the draft back and continue from it.

## The end

1. Once no open branch would change what gets built, run **one critique pass** over the whole set from the human's seat — what goes stale, what they meet on upgrade, which outside readers break — and probe every finding.
2. Then the **playback** table: class · goals · non-goals · constraints · decisions · slices.
3. Then an explicit yes. Adjust and re-render until confirmed: the recap is decompose's input contract, and a fuzzy recap poisons every stage after it.

## Persist

```bash
cat > "$DIR/recap.json" <<'EOF'
{
  "effort": "auth-hardening",
  "class": "feature",
  "goals": [{ "id": "g1", "text": "Refresh tokens rotate before expiry" }],
  "non_goals": [{ "id": "n1", "text": "No SSO provider changes" }],
  "constraints": [],
  "decisions": [{ "id": "d1", "text": "Rotation happens server-side, invisible to the client" }],
  "slices": ["token rotation"]
}
EOF
$WITNESS recap --file "$DIR/recap.json" --ask <id>
```

- `--ask <id>` names the ask the recap answers, and `next` stops offering it.
- **An amendment** runs `$WITNESS recap --amend --file "$DIR/recap.json"`, the recap naming its effort. It re-arms the decompose gate's feature-class stop: scope changed, scope gets re-approved.
- **A confirmed recap deletes the draft.** Nothing is left to resume.
- Effort slug: kebab-case `[a-z0-9-]+`, minted from the scope title. A `slug-reuse` refusal means that history exists — mint a different slug; histories never merge, and `--amend` is never the dodge.
- The refusal repair loop applies (3 attempts, then stop with the violation list).
