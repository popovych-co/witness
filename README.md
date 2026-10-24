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

**Claude Code** — the native path:

```bash
/plugin marketplace add popovych-co/witness    # skills, engine, guard and dashboard together
```

**Claude Code, on either route** (the marketplace plugin above, or `init --agent claude-code`),
also needs the `witness-context` plugin, installed once per machine — then start a new session:

```bash
claude plugin marketplace add popovych-co/witness && claude plugin install witness-context@witness
```

It puts the session's live context reading into every Bash command, which is what lets a
session hand over at `session.contextLimit` (see Run economics below). The reading comes from
a hooks module, and only a plugin can carry one. `init --agent claude-code` also declares the
plugin in `.claude/settings.json`, the way a project names a plugin it needs, but the
declaration alone does not load it in a headless session (`claude -p`, `witness drive`). A
session loads the plugin when it starts, so one already running when you install it does not:
start a new one. The install is a copy: after upgrading witness, `claude plugin update
witness-context@witness` refreshes it, for the sessions started afterwards. Without the plugin
witness still runs, on the step budget, and says so; `witness check`, run from a session, reports
whether that session sees the reading.

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
Global (`~/.pi/agent/skills`) is cwd-independent. `witness check` warns when six skills
are installed where a worktree cannot see them, and states which harnesses have none.

A tarball URL is version-pinned, so `skills update` cannot resolve forward: re-run `add`
with the new version URL to upgrade.

### Upgrading: skills first, then `init --agent`

Every surface that invokes witness pins the CLI — the engine prompt and all six skills
carry `npx -y @popovych.co/witness@<version>` — so a repo installed at an older release
only ever runs that release, which compares its payload against itself and reports clean.
The freeze is self-concealing, and a repo frozen at **0.6.0 or earlier cannot detect it**,
because the detection ships in a CLI that repo never invokes. Unstick it from outside, in
this order:

```bash
npx skills@latest add https://registry.npmjs.org/@popovych.co/witness/-/witness-<new-version>.tgz
npx -y @popovych.co/witness@latest init --agent <name>   # restamps the engine, guard and dashboard
```

Skills first: their fresh pins are what invoke a CLI new enough to see the outdated
payload. Claude Code users on the marketplace plugin get both halves from
`/plugin marketplace add` and need no second step.

From **0.7.0** onward the order stops mattering: `witness check` asks the registry what
the published `latest` is and reports both halves of the skew — a CLI behind `latest`
(`cli-behind`) and any visible skill pinning something older (`skills-behind`). The query
is best-effort and silent on failure, so an offline machine reports nothing rather than a
complaint about the network.

`witness init --agent <name>` overwrites payload files it did not write and names what it
replaced (`payload-overwritten`); the previous content is one `git revert` away, because
witness commits the payload. It refuses the whole run if a payload path carries an
uncommitted change (`payload-dirty`) or if the CLI you are running is older than the
payload already installed (`cli-behind-payload`).

From **0.10.0** onward `init` installs into **every home of the repository** — the primary
root and each live `.witness/worktrees/<plan-id>` — because a worktree is a branch
checkout, so its payload is a different file on a different timeline. A worktree cut
before an upgrade used to keep the old pin forever, and the old pin is what selects the
CLI that runs there. Every home is preflighted before any is written, so a dirty payload
in one refuses the whole run rather than leaving the set half-upgraded, and `witness check`
now reports `payload-stale` per home and names the stale one.

The same release makes the bound structural: every journal entry records the CLI that
wrote it, and a CLI older than anything the repository's state has seen refuses every verb
with `cli-behind-state` rather than answering from rules the repository has moved past.
`witness floor --show` reports the bound. If you are deliberately rolling back — a bad
release, say — lower it first with `witness floor --set <version> --note <why>`; the
decision is journaled, and `floor` is the one verb that still runs under a bound it fails.

### Support tiers

| Tier | Agents | What they get |
| --- | --- | --- |
| **Supported** | Claude Code, Pi | skills, `/witness` engine, canon guard, session dashboard |
| **Skills only** | the other agents the installer supports | the six skills; no engine, no guard, no dashboard — the `Witness-State` trailer audit remains the guarantee (DESIGN.md row 31) |

Verified against **pi 0.83.0** and **skills 1.5.21**. Re-verify on any major bump of
either.

## Configuration keys

`witness init` writes every setting into `witness.config.yaml`, each with a comment saying
what it does and what it accepts, and nothing is inherited: each gate states its own `model`
and `reviewers`, and the arbiter its own `arbiter.model`. A missing setting, an unknown key and
an invalid value all refuse, and the refusal says how to fix it. The table is generated from
the list the CLI reads (`src/settings.ts`).

<!-- settings:start -->
| Setting | What it does | Default |
|---|---|---|
| `harness` | the judge: the agent CLI that runs this repo's gate reviewers and arbiter · claude-code \| pi — accepts: claude-code \| pi — the judge: which agent CLI runs this repo's gate reviewers and arbiter | `claude-code` |
| `paths.specs` | folder for specs, repo-relative · git mv the docs when you change it — accepts: a repo-relative directory | `specs` |
| `paths.plans` | folder for plans, repo-relative · git mv the docs when you change it — accepts: a repo-relative directory | `plans` |
| `paths.designs` | folder for approved designs, repo-relative · git mv the docs when you change it — accepts: a repo-relative directory | `designs` |
| `docs.conventions` | code docs handed to code-reviewer at implement and ship · file list, [] = none — accepts: a list of repo-relative file paths ([] = none) | `[]` |
| `docs.design` | design docs handed to design-critic and design-reviewer · file list, [] = none — accepts: a list of repo-relative file paths ([] = none) | `[]` |
| `criteria.runner` | how a spec's criteria run · a command with {id}, or full-suite — accepts: a filtered template containing {id}, or full-suite | `'npm test -- -t "@spec:{id}"'` |
| `criteria.report` | the junit report witness reads · junit:<glob>, or none · full-suite needs one — accepts: none, or junit:<glob> (only junit is supported) | `none` |
| `criteria.exclude` | extra globs never scanned for criteria tags · [] = none — accepts: a list of globs ([] = none) | `[]` |
| `ship.test` | the suite command ship runs · full-suite criteria run it too — accepts: a shell command | `npm test` |
| `ship.lint` | the lint command ship runs — accepts: a shell command | `npm run lint` |
| `ship.branch` | the branch witness ships into — accepts: a branch name | `main` |
| `ship.merge` | how ship merges its own PR under autonomy · merge \| squash \| rebase — accepts: merge \| squash \| rebase | `merge` |
| `ship.ciSettleMs` | ms green CI must hold still before an autonomous merge · 0–1800000 — accepts: an integer from 0 to 1800000 — milliseconds a green check set must hold before witness merges | `60000` |
| `autonomy` | on = the CLI settles its own stops and merges green PRs · on \| off · counts once committed — accepts: on \| off | `off` |
| `arbiter.model` | model for the arbiter that settles stops under autonomy · exact id, no aliases — accepts: [provider/]model[:thinking] | `claude-opus-5-5` |
| `session.contextLimit` | % of the context window at which a session hands over to a fresh one · 1–100 — accepts: an integer from 1 to 100 — % of the session's context window at which witness hands over to a fresh session | `20` |
| `implement.stepsPerDispatch` | steps an implement session takes when its context fill can't be read · ≥ 1 — accepts: an integer >= 1 — steps handed to each fresh implement agent | `3` |
| `gates.reviewerTimeoutMs` | ms one reviewer, or the arbiter, may run before it is stopped (10 min) · ≥ 1 — accepts: an integer >= 1 — milliseconds each reviewer invocation may take | `600000` |
| `gates.decompose.model` | model for this gate's reviewers · exact id, [provider/]id[:thinking], no aliases — accepts: [provider/]model[:thinking] | `claude-opus-5-5` |
| `gates.decompose.reviewers` | reviewers this gate runs · one list, or one list per class (feature, fix, chore) — accepts: a reviewer list or a per-class map of lists in witness.config.yaml — e.g. reviewers: [code-reviewer] — a per-class map names feature, fix and chore | `[slicing-critic]` |
| `gates.plan.model` | model for this gate's reviewers · exact id, no aliases — accepts: [provider/]model[:thinking] | `claude-opus-5-5` |
| `gates.plan.reviewers` | reviewers this gate runs · one list, or one list per class — accepts: a reviewer list or a per-class map of lists in witness.config.yaml — e.g. reviewers: [code-reviewer] — a per-class map names feature, fix and chore | `[plan-critic]` |
| `gates.design.model` | model for this gate's reviewers · runs only on specs marked ui — accepts: [provider/]model[:thinking] | `claude-opus-5-5` |
| `gates.design.reviewers` | reviewers this gate runs · one list, or one list per class — accepts: a reviewer list or a per-class map of lists in witness.config.yaml — e.g. reviewers: [code-reviewer] — a per-class map names feature, fix and chore | `[design-critic]` |
| `gates.implement.model` | model for this gate's reviewers AND for the agent that writes the code — accepts: [provider/]model[:thinking] | `claude-opus-5-5` |
| `gates.implement.reviewers` | reviewers this gate runs · one list, or one list per class — accepts: a reviewer list or a per-class map of lists in witness.config.yaml — e.g. reviewers: [code-reviewer] — a per-class map names feature, fix and chore | `{feature: [code-reviewer, silent-failure-hunter, type-design, pr-test, design-reviewer], fix: [code-reviewer, silent-failure-hunter, design-reviewer], chore: [code-reviewer]}` |
| `gates.ship.model` | model for this gate's reviewers · exact id, no aliases — accepts: [provider/]model[:thinking] | `claude-opus-5-5` |
| `gates.ship.reviewers` | reviewers this gate runs · one list, or one list per class — accepts: a reviewer list or a per-class map of lists in witness.config.yaml — e.g. reviewers: [code-reviewer] — a per-class map names feature, fix and chore | `[drift-reviewer, code-reviewer]` |
| `drive.parallel` | sessions drive runs at once, one per target · ≥ 1 — accepts: an integer >= 1 — sessions drive runs at once · one per target | `2` |
| `drive.parallelSuites` | let test runs in two worktrees overlap · true \| false — accepts: true \| false — whether test runs in two worktrees may overlap | `false` |
| `drive.sessionTimeoutMs` | ms one spawned session may run before it is stopped (1 h) · ≥ 1 — accepts: an integer >= 1 — milliseconds each spawned session may take before SIGTERM | `3600000` |
| `drive.caps.rounds` | gate rounds one target may run across budget resets, then it is parked · ≥ 1 — accepts: an integer >= 1 — gate rounds one target may run across budget resets before drive parks it | `16` |
| `drive.caps.upstream` | upstream resets one target may take, then it is parked · ≥ 1 — accepts: an integer >= 1 — upstream resets one target may take before drive parks it | `6` |
| `drive.caps.spawns` | sessions one target may take in one run, then it is parked · ≥ 1 — accepts: an integer >= 1 — sessions one target may take in one drive run | `24` |
| `drive.caps.wallClockMs` | ms of session time one target may take in one run (16 h), then it is parked · ≥ 1 — accepts: an integer >= 1 — milliseconds of session time one target may take in one drive run | `57600000` |
<!-- settings:end -->

**The judge (`harness`).** Which harness runs this repo's gate reviewers and its arbiter, is
measured by `calibrate`, and is probed by `check`. It is declared, never detected: `witness
init` writes the harness `--agent` names, else the one whose session runs `init`, else
`claude-code`, and says which. Session lines (`next`'s handoff, `dispatch`'s relay, `init
--agent auto`) resolve detection first, because those name the CLI you are about to type at.
Committed, so it binds every teammate's gates; `init --agent` never re-points it. An older file
without `harness:` is judged by whichever agent's session is open until `witness migrate` writes
it — `witness check` and `witness status` say so.

**The context limit (`session.contextLimit`).** The harness measures the fill; the CLI decides
where the journal carries the position — at a step close, after a revise, at a `witness ship`
exit and at `next` — and never mid-red. A session whose fill cannot be read says so (`context:
unmeasured (<reason>)`): an implement session then hands over by `implement.stepsPerDispatch`,
and nothing else hands over (DESIGN.md row 191).

**Autonomy (`autonomy`, `ship.merge`, `ship.ciSettleMs`).** Under `autonomy: on` the CLI settles
its own stops — through its recommendation or the arbiter it launches on `arbiter.model` — and
merges its own PRs once CI is green. A committed repo fact: it counts only once HEAD says it, and
the merge also needs the ship branch on origin to say it. `--manual` on a gate run keeps that
run's stop for a human, and three stops always reach one: the look of a new screen, an unmet plan
need and a trust grant. `witness ship` merges with `ship.merge` only once the ship gate is
approved and CI is green — never when the approval lapsed or GitHub refuses — and only after the
check set has held still for `ship.ciSettleMs`: gh's watch ends the moment nothing is pending, so
a check that registers late would otherwise be missed. Green means at least one check passed and
none failed, was cancelled or is pending. Brainstorm and design stay conversations with a human in
every mode: `/witness` starts drive for the machine work and keeps the human's own items —
decisions left for them, asks to grill, looks to design — in the chat.

**`drive`.** `drive.parallelSuites: false` makes test runs in two worktrees take turns, because
suites that boot servers or browsers collide. A target that reaches any `drive.caps.*` bound is
parked.

### Upgrading

After each witness upgrade, run `witness migrate --dry-run` to see what the new version adds or
changes, then `witness migrate`: it brings `witness.config.yaml` to the current schema, keeps
every value you chose and every comment you wrote, names each change, and commits the file. A
value still at an old default moves to the new one, and the output says so. Until you migrate,
an older file keeps working: witness reads it as `migrate` would, changes nothing in it, and warns
(`witness check` shows `older-schema`). A file from a newer witness refuses: upgrade witness.

There is no `provider:` key. `witness gate` spawns the DECLARED harness's headless
mode for every reviewer (Decisions 88, 105): claude-code renders bare Anthropic ids, pi
renders `provider/model[:thinking]` with the provider witness knows it needs. The pi
reviewer runs hermetic (`--no-extensions --no-skills --no-context-files`); machine
extensions it must keep — e.g. an OAuth adapter that supplies your Anthropic auth —
are declared in machine config, not env:

```yaml
# .witness/config.local.yaml — machine facts, gitignored, never committed
reviewerExtensions:
  - /Users/you/.pi/agent/npm/node_modules/pi-claude-oauth-adapter
opener: xdg-open   # optional; nonstandard desktops only
notify: /usr/local/bin/ping-me   # optional; the run summary is its one argument · default: the platform notifier
```

Repo facts live in `witness.config.yaml` (committed); machine facts live in
`.witness/config.local.yaml` (gitignored). Every key has exactly one home — a key in
the wrong file refuses. There are no `WITNESS_*` env vars for configuration.

## Verbs

| verb | does |
| --- | --- |
| `init [--agent claude-code\|pi\|auto]` | scaffold config, principles, journal — one trailer commit; `--agent` also installs that harness's engine, guard and dashboard (idempotent) |
| `recap [--amend] --file <json>` | validate + persist a scope recap; births the effort journal |
| `write <id> --effort <e> --meta <json> --body <md>` | validated manifest → spec/plan on disk + journal entry |
| `diff <spec-id>` | delta since the last realized state (plan pin → empty) |
| `read <id> [--design] [--outline] [--lines <a>-<b>]` | print a spec/plan/design from the primary root — the read route, since a worktree carries no canon copy; `--outline` names each anchor's line range for fat artifacts |
| `check` | schema, graph, invariants, needs, trailer audit, probes |
| `index` | id · summary · status · depends across the canon, then each spec's plans |
| `satisfy <id> --need <id\|n\|text>` | journal a manual need as met — the spec is never rewritten |
| `log <id>` | render a journal stream |
| `gate <decompose\|plan\|implement\|ship\|design> <id>` | run the reviewer gate; journals the round, stamps on pass |
| `decide <gate> <id> --approve\|--revise [--pin <policy>]` | record the human decision on a stopped gate; `--pin` adds a standing content policy |
| `design <spec-id> --file <html>\|--open\|--reconfirm` | register/show a `ui` spec's approved look |
| `start <plan-id>` | create/re-attach the plan's worktree (`.witness/worktrees/<id>`) — code only: the canon dirs are excluded from it, so a plan cannot go stale in there |
| `next` | the one next action across every effort |
| `drive [--flow <plan-id>] [--max-spawns <n>] [--manual] [--detach]` | runs every session itself · under autonomy it needs no terminal and reports when nothing else can move. Up to `drive.parallel` targets at once, one session per target; usage limits are waited out; a target past a cap is parked. `--detach` (autonomy only) runs it in the background into `.witness/drive.log`; `--manual` runs serially and asks you at every stop. One drive per repo. A session drive spawned is refused — agents are what drive spawns, never what spawns drive |
| `ship <plan-id> [--manual]` | lanes → ship gate → PR → CI watch → under autonomy: merge on green · `--manual` keeps that run's stop and merge for a human |
| `test-evidence <plan-id> --phase red\|green [--step <id>]` / `verify-red <plan-id> [--base <ref>] [--step <id>]` | journal red/green criteria evidence from a worktree; `--step` names the plan step the cycle closes — required before the plan's first implement gate (on a plan with a criteria step), left off for a fix round after it. A green that closes a step prints `context:`, `steps:` and `slice:` |
| `step-close <plan-id> --step <id>` | close a scaffolding step, which has no red→green to witness; prints `context:`, `steps:` and `slice:` as a closing green does, and closing it again changes nothing |
| `adopt <path>` | absolve a finished hand-edit into the journal |
| `abandon <plan-id \| effort-slug…>` | wind a plan/effort down; reverts only specs that effort itself wrote — several efforts go as one act, so a split or an amendment they share goes back together |
| `dispatch-report <plan-id> --steps-assigned <n> --steps-completed <n>` | journal a session slice's telemetry |
| `rename <old> <new>` | id rename across canon, refs, journal |
| `clean` | reap stale worktrees |
| `sync` | pull --rebase + push state commits |
| `calibrate <model>` | run the reviewer calibration battery |
| `recover [--complete\|--rollback]` | resolve a crashed write transaction |
| `status` | orientation: flows, blocked docs, reconcile rows, pending gates, calibration state |
| *(no verb)* | the same screen as `status` |

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
pnpm run release patch   # bump + stamp pins + commit + tag, in one act — see docs/RELEASING.md
```

Releasing is `node scripts/release.mjs <major|minor|patch|x.y.z>` followed by two pushes; the tag push is what publishes. The order is fixed because CI checks the tagged tree, not the intent — [docs/RELEASING.md](docs/RELEASING.md) explains why and what to do if a tag was pushed early.

## Run economics (operator notes)

A witness session ends at a configured share of its context window:
`session.contextLimit`, 20% by default (DESIGN.md row 191). The harness measures the
fill — the `witness-context` plugin on Claude Code and the witness extension on Pi put the
live reading into every shell command's environment — and witness counts no tokens of its
own. The CLI decides only where the journal already carries the position: at a step
close (`slice: end`), after a revise, at a `witness ship` exit and at `next`, by
printing a `relay:` line. A session never hands over mid-red. Once per session, at the
limit, one line follows a command's result, so a long step learns it is over:

```
witness: context 21% of 1M has reached the 20% limit — finish what you are in (implement: the red→green), then hand over
```

Where nothing supplies the reading, witness says so —
`context: unmeasured (no adapter) — step budget 3` — and an implement session hands over
after `implement.stepsPerDispatch` steps instead; nothing else hands over.

Operator notes, non-load-bearing — the design depends on none of them:

- **Mind the window.** The limit is a share, so one warm-up weighs differently by model:
  51k tokens is 5% of a 1M window and 25% of a 200k one. A session that opens over the
  limit is warned (`warn: this session opens at …`) and works one step per slice; on a
  small window, raise `session.contextLimit` or accept a warm-up per step. `witness drive`'s
  defaults were set when a slice was three steps: `drive.sessionTimeoutMs` (1 h) and
  `drive.caps.spawns` (24). A measured slice on a large window can run past an hour, and on a
  200k window every slice is one step, so a plan takes more sessions; raise either if drive
  times out or caps a plan that is still moving.
- **Keep the host awake.** A suspend longer than an hour mid-run expires the prompt
  cache; on wake the full agent context is re-written at cache-write price. On macOS:
  `witness drive` holds `caffeinate -ims` for its own lifetime (a closed lid on battery
  still sleeps); for a chat session, `caffeinate -dims`, or plug in and disable sleep.
- **`CLAUDE_CODE_AUTO_COMPACT_WINDOW`** (set at CLI launch) lowers the harness's
  auto-compaction threshold, as belt-and-suspenders under the fill relay. Compaction
  stays the harness's continuity mechanism, never witness's; the variable is documented
  for main sessions only — whether subagents honor it is unverified.
- The designed mechanisms are the fill relay (`session.contextLimit`, with
  `implement.stepsPerDispatch` for sessions it cannot measure), the loop-width protocol,
  and `dispatch-report` telemetry — see DESIGN.md rows 79–81 and 191.
