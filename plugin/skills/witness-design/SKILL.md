---
name: witness-design
description: Produce a ui spec's living approved look — a design session that shows up to three rendered, checked directions, converges in the grill's question shape, saves a local draft, and ends in a self-contained designs/<spec-id>.html handed to witness design, then the design gate. Normally invoked by /witness with the spec id.
---

# witness-design — spec → approved look → gate

<!-- Adapted: process from benoticed docs/ui/redesign-method.md (context phase →
2-3 distinct directions → converge → change-ladder), generalized to two modes and
re-owned for witness; greenfield direction informed by Anthropic frontend-design
(Apache-2.0, LICENSES/frontend-design-Apache-2.0.txt, changes stated in NOTICE.md).
No text copied verbatim; the design-critic lens is new material. -->

## Ground rules (every witness skill)

Resolve the CLI once per session:

```bash
WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.26.0}"
```

- **Render the CLI's decision output verbatim and in full — every line, unmodified.** Never print a command set you remember; never recompose, reformat, summarise or reorder what the CLI emitted. Which decisions are live, how they rank, and what each costs are the CLI's answers, and they change with the round, the bound, the repair grant and the content sha — a remembered set is wrong in more states than it is right.
- **The human decides; you may type it.** Run a `witness decide` verb when the human **names an option** — its number or its verb — or gives a bare affirmation ("y", "ok", "go") while a **CLI-rendered decision block carrying a recommended option** is on screen: the affirmation **selects the recommended option**, and you append `--via affirmation` to the printed command. Otherwise the string is run **byte-for-byte**: never recomposed, never reformatted, never with a placeholder you resolved yourself. The moment you compose a `--note` or resolve an id, you are authoring their decision. **A nod never takes** `--approve --override`, `--stop`, a trust grant, or `witness abandon` — those require naming, and the CLI refuses them with `nod-cannot`. A block with **no** recommendation also requires naming. **Questions you authored yourself** (the grill, the design session's questions) are conversation, not a block: an affirmation there accepts your stated recommendation, with no selection entry, no journal claim and no flag; a number there (1, 2, 3) picks that answer — never a `witness decide` option. A selection does not survive session death: killed and re-run, render the block again and ask again.
- **Never edit `specs/**`, `plans/**`, or `designs/**`.** The CLI is the sole writer of state. Author HTML in `$(mktemp -d)` and hand it to `witness design`. (The canon guard blocks direct edits; the trailer audit catches end-runs.)
- **Read canon with `witness read <id>`, never by path.** Canon lives at the primary root; inside a worktree the files are **absent by design**, so a path read finds nothing and a stale copy cannot be mistaken for the contract. Fat artifacts: `witness read <spec-id> --design --outline`, then `--lines <a>-<b>`.
- **Read a file before your first edit of it in this session.** Relay boundaries, `verify-red`'s stash cycle, and worktree re-attach all change files under you — an edit against a remembered copy is how "modified since read" and partial applies happen. The CLI now prints `stale-reads:` when it churns the tree; treat that list as unread.
- **Never invoke gate reviewers or relay verdicts.** `witness gate design` runs the design-critic itself and journals what it said.
- **Refusal repair loop:** `witness design` exiting 2 prints structured violations (`field · rule · got · want`). Fix and retry — **3 total attempts**, then stop and show the human the list verbatim.
- **A refused or hook-blocked command is a stop, not a step to drop.** Re-issue it on its own; if it still refuses, tell the human what was blocked and why. Never proceed by deleting the refused half of a compound command — a dropped step is silent, and silence is how a skipped check becomes a shipped defect.
- **Re-entrancy:** derive position from `$WITNESS next` / the dashboard / `log`, never from conversation memory.
- **A `witness: context …` line is addressed to you.** Once per session, when this session's context has filled to the configured limit, it follows a command's result. Finish the act you are in (here: the answer you are on, through its `witness draft` save — or, once the full look is authored, the look through `witness design` and its gate) — a session that has done none yet does the one it was routed to — then hand back to /witness, whose `next` hands over to a fresh session.

## When you run

The `/witness` loop invokes you for a `ui`-flagged spec in a **feature** effort whose design is pending (missing or stale). fix/chore specs never reach you. Two modes:

- **New screen** — `$WITNESS read <spec-id> --design` refuses `no-design`: there is no living look yet. Design from the spec.
- **Amend a living look** — the file exists but the spec was amended. Read the current look first; propose the *smallest* change that re-serves the (changed) behavior. If there is genuinely no visual delta, tell the human to run `witness design <spec-id> --reconfirm` (re-stamps, no session).

**Resuming.** A `draft:` line from `next` means this look has a draft: run `$WITNESS draft design-<spec-id>`, whichever design step `next` routed (`--file`, `--open` or the gate), and continue from the chosen direction, the settled answers and the saved page. A session that relayed or died mid-amendment needs nothing here: `next` hands the amendment to the grill first, and the look waits with its draft.

## Under `autonomy: on`

When the CLI prints `autonomy: on` and this run is not `--manual`, the session is still a conversation with the human, and only the critic's rounds are settled for you. The CLI settles each round itself and prints `decided: … → revise` with a revise-context: re-author from it, register the new look with `$WITNESS design <spec-id> --file`, `--open` it and re-gate, showing the human each new look — unless a `relay:` line printed under the decision: this session has reached its context limit, so print that line verbatim and END YOUR TURN — a fresh session takes the revise. When the critic is clean the CLI stops at the kept stop `design look` and prints its `kept-stop:` line: render the gate output and END YOUR TURN; the human approves the screen or sends a note. A human's `--revise --note "…"` starts the next round, and that round is settled the same way.

## Inputs (rebuild them, never remember them)

```bash
$WITNESS read <spec-id>                # the parent spec — Behavior is your coverage contract
$WITNESS index                         # sibling specs, for pattern consistency
$WITNESS read <spec-id> --design       # the current look, in amend mode; its `no-design`
                                       # refusal IS the new-screen signal, so read it, don't hide it
# the repo's design canon, if configured — read docs.design from witness.config.yaml:
#   docs:
#     design: [docs/ui/design-language.md, …]  → read each; it is the blocking authority
#   design: [] means no canon is configured
```

## The session (interactive — this stage is human judgment)

```bash
DIR=$(mktemp -d)
```

1. **Context.** Name the screen's one job and primary user (from the spec's Motivation + Behavior). If a design canon is configured, read it — it governs hierarchy, framing, action placement, and component vocabulary. Report what you found before proposing.
2. **Directions, rendered.** Up to three ranked structural directions (different hierarchies or groupings, never three skins of one idea), side by side on one self-contained comparison page, `$DIR/directions.html`, using the spec's real content. Each stays consistent with the canon.
3. **Check before showing.** Screenshot the page with the machine's browser (for example headless Chrome: `--headless --screenshot`), look at the picture, fix what is broken, and check again. With no browser, say "not checked" when you open it — never claim a check that did not run.
4. **Open it as a preview.** `$WITNESS design <spec-id> --preview "$DIR/directions.html"` opens the page through the configured opener; it registers nothing and journals nothing.
5. **Converge** in the grill's question shape: up to three ranked answers, the pick first with its why, the others each with when it is better and its tradeoff — never padded. After each settled answer save the draft: the chosen `direction`, the settled `answers`, and `open`. A `draft-moved` refusal means another session saved answers since: read the draft back and continue from it.

```bash
cat > "$DIR/draft.json" <<'EOF'
{ "direction": "grouped list", "answers": ["groups first", "no icons"], "open": ["empty state"] }
EOF
$WITNESS draft design-<spec-id> --file "$DIR/draft.json"
```

6. **Author the full look** with every state the spec promises — every promised behavior visible and operable (the design-critic checks this as blocking coverage). One **self-contained** HTML file: inline all CSS/JS, embed assets as `data:` URIs, no external `src`/`href`. Give every section a stable, unique `id` (`id="essentials"`, `id="save-bar"`, …): these are the design-critic's anchors and must total **≥ 2**. Data-shape anchoring: when a section renders spec data, name the id after the data it shows, not its pixels. Check it the same way as step 3, and save the page in the draft as `page`.
7. **Register, show, gate** — the commands below.

```bash
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
$WITNESS design <spec-id> --file "$DIR/look.html"
```

```bash
$WITNESS design <spec-id> --open   # opens the artifact for the human — required before the gate
```

- **Register, then show.** `witness gate design` refuses `design-unseen` until the human has been shown the artifact's current bytes, so `--open` is part of the flow, not a nicety. Re-authoring re-arms it: new bytes, new showing. `witness next` names this step by itself — follow it.
- The opener failing (`opener-failed`) prints a `file://` path. Give the human that path verbatim and stop; do not work around it by pointing `opener:` in `.witness/config.local.yaml` at something that does not show anything.

## Gate

```bash
$WITNESS gate design <spec-id>    # append --manual when the run asked for it
```

- The design gate **always stops** — the look is human judgment, same footing as ship. It refuses to run at all until `witness design <spec-id> --open` has shown the human the current artifact. Render the gate output verbatim and in full, including its ranked options and `run:` line. **END YOUR TURN.** You never decide. The findings are *about* the design — they are never a substitute for the human being shown it.
- **Re-entered after `--revise`** → `witness decide design <spec-id> --show` reconstructs the verdict + note (findings anchor to `design#<id>` or `<spec-id> > ## Heading`). Re-author the HTML, re-run `witness design`, re-gate. The 3-round bound is the CLI's — surface it, never fight it. `--show` also emits `state:` and `exits:` — a `reopened` or `settled` state means the verdict above it is history, so act on the `exits:` line, not on remembered findings.
- Findings implicate the **slicing** (the spec is wrong, not the look)? Tell the human `witness decide design <spec-id> --revise --upstream <effort>` reopens decompose (scope-level changes chain to `recap --amend`).
- On approve the CLI stamps `design: {sha, spec}` on the spec, and the look's draft ends; the plan stage then requires that pin. You are done — hand back to `/witness`.

## A behavior answer

An answer that adds or changes what the screen *does* — not only how it looks — belongs to the recap, not the look.

- **Pause the look.** Check the change against `$WITNESS read <effort> --decisions`.
- **Amend the recap** with a numbered decision the human confirms: start from `$WITNESS draft amend-<effort>` (the seed, the latest recap, every text exact), save `amend-<effort>` drafts as you go, settle a clash with a non-goal or a constraint in one grill-shaped question, then run `$WITNESS recap --amend --file "$DIR/recap.json"`.
- **Then** the design draft keeps the direction, the answers and the page. Tell the human decompose re-opens (under autonomy drive updates the spec), and end the session: the look comes back pending on the amended spec, and nothing is redone.
- **A note at the approval stop** (`design look`) that changes behavior settles the stop first, so no stale look can be approved and the draft survives: run `witness decide design <spec-id> --revise --upstream <effort> --note "<their words>"`, then amend as above. A note only about the look stays `witness decide design <spec-id> --revise --note "…"`.
