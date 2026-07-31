# witness

[![npm](https://img.shields.io/npm/v/@popovych.co/witness.svg)](https://www.npmjs.com/package/@popovych.co/witness)
[![ci](https://github.com/popovych-co/witness/actions/workflows/ci.yml/badge.svg)](https://github.com/popovych-co/witness/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@popovych.co/witness.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@popovych.co/witness.svg)](https://nodejs.org)

**Spec-driven development for AI coding agents, where nothing advances without evidence.**

witness takes a change from brainstorm to merged PR through a **six-stage pipeline**
with **five evidence-gated transitions**, driven from **Claude Code or Pi**. Specs are
**state** (what must be true), plans are **motion** (what we're changing); the CLI is the
sole writer of both, and every transition leaves evidence in an append-only journal.

The name is the thesis: an agent claiming "done" is not evidence. A red→green test
transition the CLI watched happen is. witness is the thing that watched.

## Why

Agents are confident narrators of work they did not do. witness removes the narration
from the critical path:

- **Evidence, then human.** No stage advances on an agent's say-so. Deterministic checks
  run first; reviewer verdicts are spawned and captured by the CLI, never relayed through
  the agent's own transcript.
- **Specs are state, plans are motion.** Specs describe what must be true and outlive the
  change; plans describe one change and die with it. Never mixed, never reversed.
- **The CLI is the sole writer.** Agents propose through a validating write path; a guard
  hook blocks direct edits to canon. Malformed state is unrepresentable, not merely
  discouraged.
- **Red→green is witnessed, not claimed.** Every added test must be observed failing, then
  passing, with both shas journaled. A test that never failed is refused as `vacuous`.
- **Append-only journal.** Every check, verdict and human decision lands in
  `.witness/journal/*.jsonl` — git-diffable, resumable, never compacted.
- **Resumable by construction.** Kill any stage mid-run and re-run it; position is derived
  from frontmatter plus world state, never from session memory.

Status: all four slices landed — state core, deterministic evidence, gates &
motion, plugin + calibration. Reviewer calibration is the remaining pre-1.0
work (`docs/graduation.md`).

## Prerequisite

`witness gate` spawns the **Claude Code CLI** headlessly for every reviewer, on every
harness (DESIGN.md row 87, decision 12). Install and authenticate `claude` on any
machine that runs gates, whatever drives the pipeline. `witness check` probes for it.

## Quickstart

```bash
npx @popovych.co/witness init --agent claude-code   # scaffold + install the engine, guard and dashboard
npx @popovych.co/witness recap --file recap.json    # birth an effort from a confirmed scope recap
npx @popovych.co/witness write auth-refresh --effort auth-hardening --meta m.json --body b.md
npx @popovych.co/witness                            # dashboard: where you are, the one next action
```

Installed globally (`npm i -g @popovych.co/witness`) the binary is `witness`.

## Install per harness

witness is two halves: **six skills**, distributed through the
[skills](https://github.com/vercel-labs/skills) ecosystem installer, and the
**engine + guard + dashboard**, which no skills installer can place — `witness init
--agent <name>` writes those and commits them.

**Claude Code** — one step, the native path:

```bash
/plugin marketplace add popovych-co/witness    # skills, engine, guard and dashboard together
```

**Pi** (and any other agent the installer supports):

```bash
npx skills@latest add https://registry.npmjs.org/@popovych.co/witness/-/witness-<version>.tgz
#   choose your agent, then choose GLOBAL scope — see below
npx @popovych.co/witness init --agent pi
```

**Install skills at global scope, not project scope.** Pi resolves project skills at
`<cwd>/.pi/skills` with no upward walk, and the implement stage runs with its cwd inside
`.witness/worktrees/<plan-id>` — a directory the installer never touched. A
project-scope install therefore loses every skill in the stage that does the most work.
Global (`~/.pi/agent/skills`) is cwd-independent. `witness check` warns when the
resolved harness cannot see all six skills.

A tarball URL is version-pinned, so `skills update` cannot resolve forward: re-run `add`
with the new version URL to upgrade.

### Support tiers

| Tier | Agents | What they get |
| --- | --- | --- |
| **Supported** | Claude Code, Pi | skills, `/witness` engine, canon guard, session dashboard |
| **Skills only** | the other agents the installer supports | the six skills; no engine, no guard, no dashboard — the `Witness-State` trailer audit remains the guarantee (DESIGN.md row 31) |

Verified against **pi 0.83.0** and **skills 1.5.21**. Re-verify on any major bump of
either.

## Configuration keys

| Key | Meaning |
|---|---|
| `harness: claude-code \| pi` | fallback used only when detection cannot answer. Order: `WITNESS_HARNESS` → `PI_CODING_AGENT` → `CLAUDECODE` → `harness:` → `claude-code` |

There is no `provider:` key. Harnesses whose `--model` flag is `provider/id` (Pi) are
rendered with the provider witness knows they need. That is not a preference: `witness
gate` spawns the Claude CLI for every reviewer on every harness, and `gates.<stage>.model`
drives **both** those reviewers and the implement session's own model — so the pin must be
an Anthropic id, and a Pi implement session on a non-Anthropic model is not expressible.

## Verbs

| verb | does |
| --- | --- |
| `init [--agent claude-code\|pi\|auto]` | scaffold config, principles, journal — one trailer commit; `--agent` also installs that harness's engine, guard and dashboard (idempotent) |
| `recap [--amend] --file <json>` | validate + persist a scope recap; births the effort journal |
| `write <id> --effort <e> --meta <json> --body <md>` | validated manifest → spec/plan on disk + journal entry |
| `diff <spec-id>` | delta since the last realized state (plan pin → empty) |
| `check` | schema, graph, invariants, needs, trailer audit, probes |
| `index` | id · summary · status · depends across the canon |
| `satisfy <id> --need <text\|n>` | flip a manual need via the write path |
| `log <id>` | render a journal stream |
| `gate <decompose\|plan\|implement\|ship\|design> <id>` | run the reviewer gate; journals the round, stamps on pass |
| `decide <gate> <id> --approve\|--revise [--pin <policy>]` | record the human decision on a stopped gate; `--pin` adds a standing content policy |
| `design <spec-id> --file <html>\|--open\|--reconfirm` | register/show a `ui` spec's approved look |
| `start <plan-id>` | create/re-attach the plan's worktree (`.witness/worktrees/<id>`) |
| `next` | the one next action across every effort |
| `ship <plan-id>` | lanes → ship gate → PR → CI watch |
| `test-evidence` / `verify-red` | journal red/green criteria evidence from a worktree |
| `adopt <path>` | absolve a finished hand-edit into the journal |
| `abandon <plan-id \| effort-slug>` | wind a plan/effort down; reverts only specs that effort itself wrote |
| `dispatch-report <plan-id> --steps-assigned <n> --steps-completed <n>` | journal a session slice's telemetry |
| `rename <old> <new>` | id rename across canon, refs, journal |
| `clean` | reap stale worktrees |
| `sync` | pull --rebase + push state commits |
| `calibrate <model>` | run the reviewer calibration battery |
| `recover [--complete\|--rollback]` | resolve a crashed write transaction |
| *(no verb)* | dashboard |

## Exit codes

`0` ok · `1` findings · `2` refused (structured `{field, rule, got, want}` rows) · `3` blocked (lock/txn/untrusted cmd in non-TTY) · `9` test-only injected crash

## State model

- **Frontmatter is position** — the CLI derives "where are we" by scanning it; nothing else stores pipeline state.
- **The journal is history** — `.witness/journal/<id>.jsonl`, append-only, committed, never compacted.
- **Every state commit carries `Witness-State: 1`** — `witness check` audits that spec/plan diffs appear only in trailer-bearing commits.
- **Canon roots are configurable** — `paths: { specs: docs/specs, plans: docs/plans }` in `witness.config.yaml` (defaults: `specs/`, `plans/`); scan, commit scoping, the guard hook, and criteria excludes all follow it. `git mv` existing docs when changing it.
- Local, never committed: `.witness/{lock,txn.json,allow.json,calibration.local.yaml}`.

## Development

```bash
pnpm install
pnpm test           # vitest, in-process CLI against throwaway git repos
pnpm run typecheck
pnpm run build
```

## Run economics (operator notes)

Non-load-bearing knobs for the machine that hosts long implement runs — the design
depends on none of them (DESIGN.md row 79):

- **Keep the host awake.** A suspend longer than an hour mid-run expires the prompt
  cache; on wake the full agent context is re-written at cache-write price. On macOS:
  `caffeinate -dims` for the session, or plug in and disable sleep.
- **`CLAUDE_CODE_AUTO_COMPACT_WINDOW`** (set at CLI launch) lowers the harness's
  auto-compaction threshold as belt-and-suspenders under the dispatch budget. It is
  documented for main sessions only — whether subagents honor it is unverified.
- The designed mechanisms are the dispatch budget (`implement.stepsPerDispatch`),
  the loop-width protocol, and `dispatch-report` telemetry — see DESIGN.md rows 79–81.
