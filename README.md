# specflow

A framework that takes a change from brainstorm to PR through a five-stage
pipeline with evidence-gated transitions, driven from **Claude Code or Pi**.
Specs are **state** (what must be true), plans are **motion** (what we're
changing); the CLI is the sole writer of both, and every transition leaves
evidence in an append-only journal.

Status: all four slices landed — state core, deterministic evidence, gates &
motion, plugin + calibration. Reviewer calibration is the remaining pre-1.0
work (`docs/graduation.md`).

## Prerequisite

`specflow gate` spawns the **Claude Code CLI** headlessly for every reviewer, on every
harness (DESIGN.md row 87, decision 12). Install and authenticate `claude` on any
machine that runs gates, whatever drives the pipeline. `specflow check` probes for it.

## Quickstart

```bash
npx @whatmatters/specflow init --agent claude-code   # scaffold + install the engine, guard and dashboard
npx @whatmatters/specflow recap --file recap.json    # birth an effort from a confirmed scope recap
npx @whatmatters/specflow write auth-refresh --effort auth-hardening --meta m.json --body b.md
npx @whatmatters/specflow                            # dashboard: where you are, the one next action
```

Installed globally (`npm i -g @whatmatters/specflow`) the binary is `specflow`.

## Install per harness

specflow is two halves: **six skills**, distributed through the
[skills](https://github.com/vercel-labs/skills) ecosystem installer, and the
**engine + guard + dashboard**, which no skills installer can place — `specflow init
--agent <name>` writes those and commits them.

**Claude Code** — one step, the native path:

```bash
/plugin marketplace add whatmatters/specflow    # skills, engine, guard and dashboard together
```

**Pi** (and any other agent the installer supports):

```bash
npx skills@latest add https://registry.npmjs.org/@whatmatters/specflow/-/specflow-<version>.tgz
#   choose your agent, then choose GLOBAL scope — see below
npx @whatmatters/specflow init --agent pi
```

**Install skills at global scope, not project scope.** Pi resolves project skills at
`<cwd>/.pi/skills` with no upward walk, and the implement stage runs with its cwd inside
`.specflow/worktrees/<plan-id>` — a directory the installer never touched. A
project-scope install therefore loses every skill in the stage that does the most work.
Global (`~/.pi/agent/skills`) is cwd-independent. `specflow check` warns when the
resolved harness cannot see all six skills.

A tarball URL is version-pinned, so `skills update` cannot resolve forward: re-run `add`
with the new version URL to upgrade.

### Support tiers

| Tier | Agents | What they get |
|---|---|---|
| **Supported** | Claude Code, Pi | skills, `/specflow` engine, canon guard, session dashboard |
| **Skills only** | the other agents the installer supports | the six skills; no engine, no guard, no dashboard — the `Specflow-State` trailer audit remains the guarantee (DESIGN.md row 31) |

Verified against **pi 0.83.0** and **skills 1.5.21**. Re-verify on any major bump of
either.

## Configuration keys

| Key | Meaning |
|---|---|
| `harness: claude-code \| pi` | fallback used only when detection cannot answer. Order: `SPECFLOW_HARNESS` → `PI_CODING_AGENT` → `CLAUDECODE` → `harness:` → `claude-code` |

There is no `provider:` key. Harnesses whose `--model` flag is `provider/id` (Pi) are
rendered with the provider specflow knows they need. That is not a preference: `specflow
gate` spawns the Claude CLI for every reviewer on every harness, and `gates.<stage>.model`
drives **both** those reviewers and the implement session's own model — so the pin must be
an Anthropic id, and a Pi implement session on a non-Anthropic model is not expressible.

## Verbs

| verb | does |
|---|---|
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
| `start <plan-id>` | create/re-attach the plan's worktree (`.specflow/worktrees/<id>`) |
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
- **The journal is history** — `.specflow/journal/<id>.jsonl`, append-only, committed, never compacted.
- **Every state commit carries `Specflow-State: 1`** — `specflow check` audits that spec/plan diffs appear only in trailer-bearing commits.
- **Canon roots are configurable** — `paths: { specs: docs/specs, plans: docs/plans }` in `specflow.config.yaml` (defaults: `specs/`, `plans/`); scan, commit scoping, the guard hook, and criteria excludes all follow it. `git mv` existing docs when changing it.
- Local, never committed: `.specflow/{lock,txn.json,allow.json,calibration.local.yaml}`.

## Development

```bash
npm install
npm test            # vitest, in-process CLI against throwaway git repos
npm run typecheck
npm run build
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
