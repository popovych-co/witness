---
description: Run the witness pipeline — ask the CLI what's next, do it, loop; stop where a human is owed a decision
argument-hint: "[--manual] [what to build]"
---

# /witness — the engine

The CLI decides, you act. If `$ARGUMENTS` contains `--manual`, append `--manual` to **every** `witness gate` and `witness ship` command you run this session — caution is a per-run mood, never config.

Any other words in `$ARGUMENTS` are the human's ask: run `$WITNESS ask "<those words>"` once, before the first `next`. The CLI queues it and `next` routes it to brainstorm, so the ask outlives this session.

Resolve the CLI once:

```bash
WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.19.3}"
```

If the repo has no `witness.config.yaml`, run `$WITNESS init` first (one bootstrap commit), then proceed. If init or any verb refuses on a dirty tree, the human commits or cleans it — **never `git commit` yourself, anywhere, at any stage**: the CLI makes its own state commits, and the ship phase makes the sole code commit.

## Loop

Every turn is `witness next`, read, act on the first matching row, repeat:

1. Run `$WITNESS next`.
2. Read its TOON lines: `next:` (a command line), and optional `stage:`, `target:`, `note:`, `home:` (the directory this action's session belongs in), `run:` (the paste-ready handoff command), `relay:` (how a session continues in a fresh context in the same `home:`). **`run:` and `relay:` are printed only when `home:` is a different session from yours** — the CLI compares it against your cwd, resolving symlinks, so you never make that comparison yourself. `run:` and `relay:` are rendered by the CLI for the harness you are running on — never rewrite them, never substitute a command you remember.
3. Act on the **first** matching row, then go to 1:

| Signal | Action |
|---|---|
| `launch:` is printed and this session is not `--manual`-armed | Autonomy is on and no `witness drive` runs for this repo. If `next:` names `witness decide`, that stop is the human's: run it with `--show` first and render everything it emits verbatim. Then run the `launch:` command via Bash as you run a `next:` line. It starts drive in the background and prints a `watch:` line. Print that `watch:` line for the human and **END YOUR TURN**: drive starts every session from here and reports when nothing else can move. |
| `watch:` is printed and no `launch:` | A `witness drive` already runs this repo. If `next:` names `witness decide`, run it with `--show` and render everything it emits verbatim first — that stop is the human's. Print the `watch:` line for the human and **END YOUR TURN**. |
| `drive: done` is printed | `witness drive` started this session for one target and that target needs nothing more from it. **END YOUR TURN**. |
| A `choose:` block is printed (`note:` says `N ready — ranked below`) | Several specs are ready and the CLI has ranked them. Render the whole block verbatim and in full — the recommendation, its why, each alternative's when and tradeoff, and the `judge-first:` line — then ask the human which to plan. Then use the `witness-plan` skill with the id they name. Never collapse the block to a bare list of ids: the ranking and its costs are the part they are deciding with. |
| `next:` names `witness decide` | A gate is stopped and the decision is the human's. Run `$WITNESS decide <gate> <target> --show`, render everything it emits verbatim and in full — the checks, the findings, and its ranked options — and **END YOUR TURN**. Never substitute a command set you remember: it is wrong at the round bound, in the reopened and stale states, and wherever a repair grant is unspent. Never run `--approve`, `--revise` or `--stop` on your own judgment. |
| a `run:` line is printed | This stage belongs to a different session; the CLI already compared `home:` against your cwd. Print the `run:` line verbatim for the human (if this session is `--manual`-armed, change the argument to `'/witness --manual'`), say that work continues in the fresh session, and **END YOUR TURN**. Never use a stage skill or run the `next:` command from the wrong `home:` — a fresh session is the execution model, and it is the only one. A `home:` line with **no** `run:` under it means you are already there: read on and act. |
| `stage: brainstorm` | Use the `witness-brainstorm` skill. |
| `stage: decompose` | Use the `witness-decompose` skill with `target` (the effort slug). |
| `stage: design` | Use the `witness-design` skill with `target` (the spec id). |
| `stage: plan` | Use the `witness-plan` skill with `target` (the spec id). |
| `stage: implement` | Use the `witness-implement` skill with `target` (the plan id). |
| `stage: ship`, or `next:` names `witness ship` | Use the `witness-ship` skill with `target` (the plan id). |
| any other `next:` line (`witness gate …`, `witness start …`, `witness check`, `witness recover …`, `witness check --drift`) | Run it verbatim via Bash (plus `--manual` on `gate` and `ship` when armed). Exit 0 or 1 → loop. Exit 2 or 3 → render the refusal; if it names a mechanical remedy you can do without judgment (e.g. `witness recover --complete`), do it and loop, else stop for the human. |

## Under `autonomy: on`

`next`, `start`, `gate` and `decide --show` print `autonomy: on` and the `kept-stops:` set when the repo has opted in. Unless this session is `--manual`-armed, that changes exactly these rules:

- **Decisions are the CLI's.** It settles each stop itself — through its policy, or the arbiter it launches — and prints who decided (`decided: … · policy` or `· arbiter`). Never run `witness decide`. Outside the brainstorm interview and the design session, which stay conversations, never end your turn to ask and never put options of your own to the human: when a stage owes a call of yours, make it, state it in one line, and continue.
- **A `witness decide` line from `next` belongs to a human.** The CLI left that stop for a person, and the `kept-stop:` line or the refusal above it says why. Run `$WITNESS decide <gate> <target> --show`, render it verbatim, name the human's act, and END YOUR TURN.
- **The merge is the CLI's.** `witness ship` merges its own PR on green CI and prints `merged:`. You still never merge.

`run:` handoffs, relays, refusals you cannot mechanically repair and no progress end your turn exactly as above.

## Stop conditions (end your turn)

- After a `decide` line surfaced and you rendered it, the turn ends. If the human then names an option, run that option's printed string byte-for-byte and resume the loop — naming the option is their judgment, typing it is not yours to substitute. A bare affirmation ("y", "ok", "go") against a block that carries a **recommended** option selects that option: run its printed string with `--via affirmation` appended. It never takes `--approve --override`, `--stop`, a trust grant or `witness abandon` — those still require naming (D143).
- A `decide` line surfaced — the standing stops (ship always; feature scope; fix-created-spec) and every blocking finding land here by design.
- The same `next:` line came back twice with nothing changed in between → report `no progress: <line>`, what you tried, and hand off.
- An exit 2/3 you cannot mechanically satisfy — `needs-unmet` (show the human the witness satisfy command the refusal names), `slug-reuse`, lock contention, calibration floor stops under `--manual`.
- A skill ended its turn for a gate stop — that stop is yours too; do not restart the loop until the human decides.

**Never merge a PR** — merging is the human's act on GitHub; the lazy stamp finishes the lifecycle on the next scan. **Never edit `specs/` or `plans/`** (or wherever the repo's `paths:` config relocates them) — that is what the skills' write path is for. Run `$WITNESS status` — the orientation screen (flows, blocked docs, reconcile rows, pending gates) — when you need position rather than the next action; bare `$WITNESS` prints the same screen. If it reports the reviewer model is uncalibrated, surface that; under `--manual` treat it as a stop.
