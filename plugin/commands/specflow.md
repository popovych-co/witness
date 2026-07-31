---
description: Run the specflow pipeline — ask the CLI what's next, do it, loop; stop where a human is owed a decision
argument-hint: "[--manual]"
---

# /specflow — the engine

The CLI decides, you act. If `$ARGUMENTS` contains `--manual`, append `--manual` to **every** `specflow gate` command you run this session — caution is a per-run mood, never config.

Resolve the CLI once:

```bash
SPECFLOW="${SPECFLOW_BIN:-npx -y @whatmatters/specflow@0.4.0}"
```

If the repo has no `specflow.config.yaml`, run `$SPECFLOW init` first (one bootstrap commit), then proceed. If init or any verb refuses on a dirty tree, the human commits or cleans it — **never `git commit` yourself, anywhere, at any stage**: the CLI makes its own state commits, and the ship phase makes the sole code commit.

## Loop

Every turn is `specflow next`, read, act on the first matching row, repeat:

1. Run `$SPECFLOW next`.
2. Read its TOON lines: `next:` (a command line), and optional `stage:`, `target:`, `note:`, `home:` (the directory this action's session belongs in), `run:` (the paste-ready handoff command), `relay:` (how a session continues in a fresh context in the same `home:`). `run:` and `relay:` are rendered by the CLI for the harness you are running on — never rewrite them, never substitute a command you remember.
3. Act on the **first** matching row, then go to 1:

| Signal | Action |
|---|---|
| `note:` contains `multiple ready — choose` | Show the listed spec ids, ask the human which to plan. Then use the `specflow-plan` skill with the chosen id. |
| `next:` names `specflow decide` | A gate is stopped and the decision is the human's. Run `$SPECFLOW decide <gate> <target> --show`, render the checks and findings verbatim, render the `exits:` line the CLI emitted verbatim — never a remembered set, which is wrong at the round bound and in the reopened and stale states — and **END YOUR TURN**. Never run `--approve`, `--revise`, or `--stop` on your own judgment. |
| `home:` present and ≠ your cwd | This stage belongs to a different session. Print the `run:` line verbatim for the human (if this session is `--manual`-armed, change the argument to `'/specflow --manual'`), say that work continues in the fresh session, and **END YOUR TURN**. Never use a stage skill or run the `next:` command from the wrong `home:` — a fresh session is the execution model, and it is the only one. |
| `stage: brainstorm` | Use the `specflow-brainstorm` skill. |
| `stage: decompose` | Use the `specflow-decompose` skill with `target` (the effort slug). |
| `stage: design` | Use the `specflow-design` skill with `target` (the spec id). |
| `stage: plan` | Use the `specflow-plan` skill with `target` (the spec id). |
| `stage: implement` | Use the `specflow-implement` skill with `target` (the plan id). |
| `stage: ship`, or `next:` names `specflow ship` | Use the `specflow-ship` skill with `target` (the plan id). |
| any other `next:` line (`specflow gate …`, `specflow start …`, `specflow check`, `specflow recover …`, `specflow check --drift`) | Run it verbatim via Bash (plus `--manual` on `gate` when armed). Exit 0 or 1 → loop. Exit 2 or 3 → render the refusal; if it names a mechanical remedy you can do without judgment (e.g. `specflow recover --complete`), do it and loop, else stop for the human. |

## Stop conditions (end your turn)

- A `decide` line surfaced — the standing stops (ship always; feature scope; fix-created-spec) and every blocking finding land here by design.
- The same `next:` line came back twice with nothing changed in between → report `no progress: <line>`, what you tried, and hand off.
- An exit 2/3 you cannot mechanically satisfy — `needs-unmet` (show the human `specflow satisfy <id> --need <text>`), `slug-reuse`, lock contention, calibration floor stops under `--manual`.
- A skill ended its turn for a gate stop — that stop is yours too; do not restart the loop until the human decides.

**Never merge a PR** — merging is the human's act on GitHub; the lazy stamp finishes the lifecycle on the next scan. **Never edit `specs/` or `plans/`** (or wherever the repo's `paths:` config relocates them) — that is what the skills' write path is for. If the dashboard warns the reviewer model is uncalibrated, surface the warning; under `--manual` treat it as a stop.
