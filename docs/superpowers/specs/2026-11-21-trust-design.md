# witness — results humans can trust (design)

Date: 2026-11-21 · Status: designed (grill + three adversarial verification passes); not built; uncommitted.
Source: Lauren Tan, "All Code Is Slop (Except Mine)" (AI Engineer; official transcript at
https://ai.engineer/talks/O_zcc6Xl12g-all-code-is-slop-except-mine).
Reality checks: fewhats.com (pnpm TypeScript monorepo, vitest + Puppeteer, biome + eslint + scripts, full-suite runner
with junit, private, Pi drive, macOS) and wot-mod-manager (TypeScript + Rust Tauri desktop app for Windows, its own
WebView2 + puppeteer-core e2e harness, biome + eslint + clippy over 5 crates, full-suite with junit, autonomy on,
Pi judge, no CI since commit 9b481d1).
Filed while designing: #92 (verify-red stranding), #93 (payload files in plan diffs), #94 (PR body via argv),
#95 (payload fails the consumer's lint).

---

## 0. Summary

witness already makes its own pipeline hard to fake: the CLI is the only writer, red→green is watched, and reviewers
are launched by the CLI. It does not yet do the same for the code it ships. There, judgment comes mostly from AI
reviewers, the costliest layer in the talk's pyramid, and every correction disappears when the plan ends.

The data says so: fewhats journaled 1,222 blocking findings (1,143 at code gates) and wot 292. The same kinds recur
across nearly every plan: swallowed errors in 15 plans, type design in 16, test weakness in 15. Meanwhile fewhats'
lint configuration has not changed since 2026-09-18.

The design adds eight items, built one at a time:

| # | Item | What the human gets |
|---|---|---|
| T0 | Patch: #92, #93, #94, #95 | no stranded work; witness's own files stop polluting plans and lint |
| T1 | Track record | a baseline: escapes per plan, live specs failing, checks added |
| T2 | Machine checks before reviewers | lint, format and conflict errors never reach (or cost) an AI reviewer |
| T3 | Switch-offs | a new `eslint-disable`, `.skip` or loosened config can no longer slip in unseen |
| T4 | Fixes add checks | every machine-catchable correction becomes a permanent rule; old copies are cleaned up by drive |
| T5 | Test strength | a mutation tool's verdict on the changed lines, where a tool exists |
| T6 | PR proof | the PR says what it promised, what is proven, what is not, and who decided |
| T7 | Behavior maps | one human look at how each feature behaves, before code is planned |
| T8 | Explore | the built app is exercised like a user; proven breaks become fixes, charged to the PR that caused them |

---

## 1. Background

### 1.1 The talk, in short

- Trust comes from investing in the agent's environment until the agent can check its own work.
- An upside-down pyramid, cost rising toward the tip: codebase design → static analysis → runtime and formal
  verification → prose (rules, skills) → human review.
- Code is memory: agents copy what they see, workarounds included.
- Every correction becomes a lint rule or an API change that makes the mistake impossible. The speaker's team went
  from 7 rules to 167 in four months.
- Comments and markdown become agents' excuses; guidance belongs in lint messages.
- Review shrinks to looking at proof: screenshots, videos, diagrams, a feature map. Formal and property checks add
  further layers. Most tokens go to verification.
- Outcome: 11,000 PRs a month at about a 0.5% revert rate, and the app is faster than at launch.
- Order: fix the inner loop before automating the outer loop.

### 1.2 Gaps in witness (probed at main b92a461, 0.29.0)

1. The implement gate runs no lint, typecheck or conflict-marker check (`src/gates/implement.ts:137-174`; lint runs
   only at ship, `src/gates/ship.ts:87-88`). The battery runs even when a machine check is red (`src/gate.ts:573`
   runs before `:598`). In fewhats, three lenses flagged the same conflict markers and a lens flagged a formatter
   failure.
2. A correction lives only inside one plan (pins, row 83; recurrence, row 123) or in prose (`principles.md`).
3. red→green proves a test fails without the whole change (`src/evidence.ts:198-214`). pr-test is fewhats' top
   blocking lens (324).
4. The PR body is one line plus held needs (`src/ship.ts:138-145`). Captures reach only the vision reviewer.
5. Nothing detects a new switch-off.
6. No outcome numbers exist anywhere.
7. witness's own payload pollutes consumers: it sits in plan diffs (#93), and fewhats' `biome check` fails on it
   (#95: 46 errors).

---

## 2. Decisions (the user's; binding)

0. Build order is decided at the end, after every branch is walked.
1. A fix adds a check when a machine could catch the mistake, proven to fail on the old code and pass on the new.
2. Old copies: ban new ones, tolerate the old, queue a cleanup.
3. Drive runs cleanups by itself when idle.
4. Test strength comes from each repo's own mutation tool. The "undo each file" idea is dropped.
5. Proof lives in the PR description.
6. Screenshots live on a side proof location in the same repo.
7. A switch-off is removed, or booked as a known problem.
8. A bad record never tightens autonomy by itself.
9. A new feature's behavior map is a human stop.
10. A fix stops only if it changes a map.
11. Explore timing is configurable, with different options per case.
12. An explorer finding is fixed like any fix, failing test first. 12b: a finding the spec is silent about goes to the
    human.
13. Each always-rule needs its own test.
14. Build order: measure, prevent, prove, explore.

---

## 3. Concepts and shared primitives

Each primitive is built inside the first item that needs it (§4 lists where).

### 3.1 Plan change set (PC) — T0

**Definition.** The plan's diff against its base, minus every harness's payload targets (`.claude/settings.json` is
shared and stays in).

**Readers.** Reviewer prompts and coverage, the snapshot and the delta, red→green evidence, verify-red,
`diffReviewedSha`, machine checks, mutation scope, attribution and proof. Today `changedFiles` (`src/evidence.ts:180`) excludes nothing, so reviewers
judged witness's hooks (2 findings and 2 coverage anchors in fewhats; 2 and 5 in wot).

**Acceptance.**
- `init --agent` into a worktree leaves implement's reviewed sha unchanged.
- A payload-only change produces no plan file in any reader.
- A witness hook deleted in a worktree is named by `check`.

### 3.2 Check registry and the checks-only round (CR) — T2

Each machine check registers beside GateSpec with three properties.

- **tier**
  - `precondition`: refuses with one mechanical remedy. Examples: steps-open, design-unseen,
    screens-matched-nothing, map-unseen, mutation-pending.
  - `withholding`: a red means review is pointless, so the round ends as a **checks-only round**. Members:
    conflict markers; lint, format and typecheck (ship.lint parts); build.
  - `judged`: a red stops the gate after the battery runs, as today. Members: evidence, regression, criteria,
    switch-offs, guards.
  - `advisory`: evidence for lenses and the proof only.

  Pass-3 data: withholding test reds would add a revise cycle in 43 of 277 fewhats rounds, so red tests keep the
  battery.
- **waiver**: who may waive a red, and how.
  - Markers, diff, regression, evidence and criteria have no booking. Revise is the remedy. A human approve on a
    judged round stays as row 93 has it, journaled as an override.
  - Lint diagnostics, whether new or red on base too: **human-only** `--book` (§3.3).
  - Switch-offs: the AI judge or the human may book them (decision 7).
  - A missing guard: the AI judge or the human may waive it (decision 1).
  - The AI judge never books markers, lint, evidence, criteria, regression or tolerated growth (row 172 holds).
- **cost**: the journaled median `duration_ms` per check. Checks run in a fixed cold-start order (markers, lint,
  evidence, criteria), then by measured cost, and short-circuit at the first withholding red.

**The checks-only round.**
- It is a gate-run entry with `checks_only: true`, `pin = model`, `prompts_sha` set, no `verdicts`, and checks cut
  at the first red.
- Predicate: `lensesRan(run) = !run.checks_only && run.outcome !== 'malformed'`. The name avoids the branch's
  `lastJudgedRun`, which means "not malformed".
- `lensesRan` is read by:
  - the verdict cache;
  - `appendKind` (resume, repair, changed-nothing);
  - row 112's conversion;
  - deferral discharge (a checks-only round discharges nothing);
  - recurrence and the delta base;
  - demotions;
  - `liveActs` / `pendingActs` (no approve on a checks-only round);
  - `roundsSinceApprove`, `boundReached` and drive's caps;
  - the arbiter's evidence, `decide --show` and the gate view.
- A checks-only round resumes only when its checks are identical. If the checks are now green the gate runs fresh;
  if they are red differently it writes a new checks-only round. A booking made since the last round counts as
  "checks changed".
- It is exempt from the human's 3-round budget and counted in `drive.caps.rounds`.
- Nothing was judged, so there is nothing to approve: decide refuses approve, and recommend and the arbiter omit it.

**Base-red.** A red that is also red on the base is judged per **diagnostic**, never per exit code.
- ship.lint's parts are named in settings; witness never parses `&&`.
- A part with a diagnostics **reader** (§3.7) diffs (tool, rule, file, normalized snippet) on PC files.
- An opaque part that is red on base reports "not judged — red on base too", never green because the outputs
  matched. Pass 3 found fewhats' `&&` chain stopping at biome on a red base, so tsc never ran.
- Only a human may book a base-red part (an LD item that closes when base goes green).

**Acceptance.**
- A checks-only round spawns no reviewer and discharges no deferral.
- decide refuses `--approve` on it.
- It counts toward drive.caps.rounds and not toward the human's budget.
- A trust grant on the same tree re-runs fresh.

### 3.3 Repo ledger (LD) — T2 (booked checks), extended in T3, T4 and T8

Artifact debts stay as row 122 has them. Repo-level items live on a reserved stream, `ledger` (reserved like `asks`
and `floor`; a `check` row and a release note cover a consumer doc with that id). Items are keyed (kind, check,
subject) and never move between streams.

**Kinds.**

| Kind | Subject | How it closes |
|---|---|---|
| booked-check | the exact multiset of booked diagnostics | it closes when they are gone |
| booked-switch-off | the line | it closes when the line is gone |
| tolerated-set | (tool, rule) | multiset of old spots generated on the base |
| repro | a test file path + testcase name, charged to a PR | it closes when the plan whose red→green witnessed that test merges |
| cleanup | (tool, rule), born from a tolerated set | — |

**State machine.** `open → born → closed`, or `open → dismissed`.
- `closed` comes from a journaled observation by the owning check (merge stamp, drift sweep or ship lane, evaluated
  on the merged tree and keyed by tree sha), or from a merged red→green.
- `dismissed` causes are `rule-retired`, `declined` and `judged-wrong`.
- Owed work = open and not born.

**Transitions.**

| Transition | Who | How |
|---|---|---|
| open | a decision | `decide … --book <check>` |
| open | the CLI | guard proof, explore |
| born | birth act | `recap --from <item>` |
| closed | the CLI | observation |
| dismissed | a human, at a terminal | `witness dismiss <item> --cause <cause>` (row 122's verb shape) |
| declined | the abandon of a born item | — |

- Items are never injected into reviewers.
- Ledger observations are bookkeeping in `ENTRY_PROGRESS`; book, birth and dismiss are acts.

**`--book`.** One decision entry (`decision: 'book'`) plus the ledger item, written in one `withTxn` +
`journalMulti` with an idempotence key. The re-gate is routed by `next` and drive; decide never runs a gate.

**Acceptance.**
- Every transition is journaled once, even across a kill.
- Owed work drops when an item is declined.
- A booked switch-off closes on the first merged tree without the line.

### 3.4 Counterfactual runs (CF) — T3

**Where.** One persistent, provisioned scratch worktree per repo, at a short fixed path, under the scratch lock.
- Trees are wrapped with `commit-tree` under per-(plan, round) refs, deleted at merge. A bare tree cannot be checked
  out (probed).
- Reset: `checkout --force --detach <commit>` plus `clean -ffdx -e node_modules -e target`.
- `scratch.prepare`, a trusted command, runs when the lockfile or manifests differ from the last successful prepare.
  A prepare is recorded only after exit 0, and cleared before it starts.
- Containment as row 218.

**The run.** `run(tree, overlay, command, expect)`, journaled with every tree sha. Results are cached by
(tree, overlay, command), and a "green on current" reuses the round's own junit.

**Junit.** The parser splits `<error>` (load) from `<failure>` (assertion). A load error is an infrastructure
failure: re-prepare once, then fail the job. It is never a red, and never feeds the waiver menu.

**Use.** CF serves trees other than the plan's worktree: switch-off effect checks (T3), guard proofs (T4), mutation
(T5), and attribution and repros (T8). verify-red stays in the worktree (T0). Explore gets its own worktree (§3.9).

**Acceptance.**
- An unchanged tree gives the same criteria result in the scratch as in the worktree.
- A killed prepare re-runs next time.
- A load error never becomes a red.

### 3.5 Drive jobs and the queued test turn (DJ) — T2

**What a job is.** Base runs, mutation and explore are jobs that drive schedules, never work inside a session's gate
command. In chat mode no jobs run, and results that depend on them read "not measured".

**The test turn** (`runner-lock.ts`).
- It gains a FIFO queue whose entries are leased `{pid, since, until}`, as `busy.ts` does, and drive sweeps them.
- Lint takes no turn.
- Job units are shards (per file, or `--shard k/n`), each time-boxed, each journaled as bookkeeping (row 206's
  progress check is not fooled). A shard that times out twice reads "not measured".
- A waiting session's deadline moves forward while a job holds the turn, through a deadline file drive rewrites.
  `WITNESS_DRIVE_DEADLINE` is fixed at spawn today (drive.ts:242).

**Results.** Gates read job results that exist; a missing result has a per-check rule.
- Mutation: the `mutation-pending` precondition at ship, bounded by the job's time box. A timed-out job reads "not
  measured" and ship proceeds.
- T3's test half: "not checked" for that round.

Jobs register in the UI run registry (roadmap 1a.5).

**Acceptance.**
- A stuck session beside a running job is set aside after one spawn.
- A session waiting on a job's turn is not killed by its own deadline.

### 3.6 Machine births (MB) and realization-repair plans (RP) — MB in T4, RP in T8

**Birth.** A ledger item that owes work is born through a non-conversation act, `witness recap --from <item>`.
- The recap is templated from the item's structured refs, with `origin: machine, from: <item>`. The effort id
  derives from the item, and the verb enforces one machine birth in flight per repo under the lock.
- The CLI copies references, never the explorer's or an agent's free text.
- Drive may spawn the act when no runnable human-originated target exists.
- `next` re-evaluates the item when it routes it; a vanished subject closes it.
- Amends row 194 ("every recap is confirmed by a human") by name.

**Classes.**
- A cleanup is class `chore` with parent `principles` (chores already plan under principles, `next.ts:1102-1118`).
- A repair is class `fix` with `origin: machine`. It routes straight to a plan write on the item's spec and skips
  decompose: owed work becomes "the spec's content moved past its last plan's pin, OR an open repro item against
  it" (amends row 160; one derivation for `next` and `diff`). The plan's first step is the witnessed failing test,
  and the item names it.

Reconcile's "fix the code" advice (`drift.ts:84`) gains its first pipeline path.

**Abandon.** Abandoning a born item marks it declined. Under committed autonomy, abandoning a machine birth is a
terminal act (§3.9).

### 3.7 Tool adapters and trust (TR) — T2 onward

**Per-tool readers and writers.**

| Tool | Diagnostics reader | Tolerated-list writer |
|---|---|---|
| ESLint | JSON formatter | native suppressions at the root file, pruned |
| Biome | SARIF or checkstyle (the JSON reporter is "unstable"); a parse failure fails closed | a witness-owned extended config with per-(file, rule) overrides, verified byte-equal |
| clippy | `--message-format=json` | none |
| tsc | its diagnostic lines | none |

**Normalized snippet.** The flagged source line with whitespace runs collapsed and the ends trimmed, paired with the
rule id. Diagnostics compare as multisets.

**Check-definition paths.** A declared list per repo. By default: lint and format configs, `tsconfig*`,
package.json scripts, Cargo `[lints]`, `.gitignore`, test-runner config, mutation config.

**Trust** (amends rows 154 and 205).
- A repo declares each tool command once (lint parts, reader and writer commands, mutation, `scratch.prepare`,
  explore host and login), and the human grants it once.
- Grants for commands that run repo scripts (prepare, explore host, login) also pin the blob shas of their declared
  files. A changed file raises the trust item again.
- witness appends only witness-validated, typed tokens: rule ids (charset), paths (from PC), line ranges, test names
  (from the last junit) and witness-owned report paths.
- Tokens go as separate argv with no shell, or through a file witness writes. Agent text is never appended.
- A job whose command is untrusted raises a trust needs-you item.

### 3.8 Proof and record models (PM) — record in T1, proof in T6

`proofOf(plan)` and `record(repo)` live in `src/models.ts`, as one computation with many renderers (rows 139/203,
UI 1a.1): PR body, drive report, status, `decide --show`, UI 3.2/3.3.

**What the journal gains.**
- test-evidence: the tree sha, plus each capture's producing test.
- GateCheck: `duration_ms`.
- drift-check: testcase outcomes.
- Ship: its junit summary.

With `report: none` no test names exist, and the proof says so.

### 3.9 Locks, leases, sessions, re-entrancy — every item

**Lock order.** Test turn, then scratch, then repo lock. Explore uses its own worktree and declares exclusive
resources, which become locks every runner command takes.

**Leases.** Every long act holds a lease (the busy.ts pattern): scratch prepare, CF runs, job shards, the explore host.

**The explore host** contract adds an idempotent `reset`, run before every provision and at drive start.

**Two-stream acts.** `decide --book`, `recap --from` and the observation close run in one transaction with an
idempotence key.

**Sessions cannot launder human acts.**
- Under committed autonomy, a typed `--book`, a guard waiver or a machine-birth abandon needs a terminal (`isTTY`
  plus a prompt, as `trust --yes`).
- `gate --manual` refuses inside a drive session.
- The arbiter acts in-process and needs neither.
- The env marker alone is not enough, because the agent can strip it.

**Arbiter input** gets only CLI-structured facts about checks (names, counts, rule ids), never tool output, diff
text or finding prose written by the agent.

---

## 4. Items

### PRE — `remaining-issues-2` merges first

The branch reworks verify-red (the held commit with a record), gate/ship/decide/next, `liveActs` and `clash.ts`
(rows 243–245). This design's rows run from 246, one per issue or behavior, in build order (246 #93, 247 #92).

### T0 — Patch (#92, #93, #94, #95)

- **#92.** Builds on row 243 (as built, row 247; the map's correction C2):
  - every verb that reads a plan's worktree — `test-evidence`, the implement and ship gates, `ship` at its top and
    before each commit, `witness turn` — puts held work set aside in that tree back first, or refuses
    `verify-red-pending`; `recover` puts held work back into the checkout its record names; `next` stays read-only
    and routes `witness recover`; `start` names the ref and `check` warns `verify-red-held`;
  - no implement or ship sha reads while work is held;
  - the held record names its base, and committed work is held too;
  - a run ended by a signal is `run-interrupted`, and verify-red's SIGTERM/SIGINT/SIGHUP trap puts the work back
    before the process ends — best effort: SIGKILL and Windows' tree stop run no handler.
  A second verify-red refuses while one is held.
- **#93.** PC (§3.1).
- **#94.** `--body-file -` for every gh text.
- **#95.** The payload hooks move under `.witness/hooks/`; both consumers already exclude `.witness` from lint, and
  `.claude/settings.json` points at the new path. witness formats its `settings.json` writes, and `check` warns
  statically about payload paths a repo's lint config covers.

**Acceptance.**
- A SIGTERM during the red run restores the work before the process exits.
- After a SIGKILL there, on a plan with no criteria step and on a step with no vacuous red, `next` routes
  `witness recover` (which puts the work back or refuses) and never routes `test-evidence`.
- `check` warns about a standing verify-red ref.
- `init --agent` into a worktree leaves implement's reviewed sha unchanged.
- A payload-only change produces no plan file in any reader.
- A 40,000-character body passes on Windows.
- fewhats' `biome check` is green on payload files.

### T1 — Track record

`record(repo)` has these folds, each printing "not measured" until it has data:

- **escapes**
  - A fix effort carries `cause: escape | decision`, confirmed in its grill.
  - An escape is charged to the last non-chore plan that shipped the amended spec, labeled approximate. Explorer
    items use T8's flip attribution.
  - Chores are never charged.
- **live specs failing**: failed testcases surviving the two-run debounce, shown apart from "could not verify"
  (0 tagged, all skipped, a cmd failing for environment reasons). In fewhats, 31 of 32 reds were environment.
- **environment trend**: checks added, and tolerated spots left per (tool, rule).
- **repairs.**

Ages are measured in merges. Escapes are grouped by the `w` stamp on the charged plan's ship gate-run, so T1 is the
baseline for T2–T8. Each PR shows only the rows charged to it, with denominators. Shown in status (`record:`) and
drive's report. Never feeds a gate or autonomy.

**Acceptance.**
- fewhats prints its 3 fixes split escape/decision.
- wot prints "not measured" where it has no data.
- A chore is never charged.

### T2 — Machine checks before reviewers

**Builds:** CR (§3.2), DJ (§3.5), LD with booked-check items (§3.3), TR readers (§3.7).

**Checks.**
- Conflict openers on the PC files, using `clash.ts`'s `OPENS` rule; a plain `=======` never counts.
- ship.lint by named parts; trustOwed includes ship.lint for gate implement.
- The existing evidence, regression and criteria checks.

ship.lint keeps its key; its comment says implement runs it too.

**Acceptance** (from §3.2), plus:
- A wot round whose clippy fails withholds the battery.
- A red test round still runs the battery.

### T3 — Switch-offs

**Builds:** CF (§3.4).

**Token layer** (added PC lines, token-aware, so `process.exit(` never matches `xit(`):
- TS/JS: `eslint-disable*`, eslint inline config, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `biome-ignore`,
  `.skip(`, `.only(`, `.fails(`, `xit(`, `xdescribe(`, `fails:`, `retry:`, `Stryker disable`.
- Rust: `#[allow(`, `#![allow(`, `#[expect(`, `cfg_attr(…allow`, `#[ignore]`, `mutants::skip`.
- Python: `noqa`, `type: ignore`, `pylint: disable`.
- Go: `nolint`.
- Plus a repo setting for extra patterns.

**Effect layer.**
- A CF run executes the **base's** check definitions over the base plus the plan's changed files. A diagnostic on a
  PC line that the plan's own definitions do not report counts as "loosened". This covers `.gitignore`, config
  overrides, script allowlists and inline disables.
- For tests: passing tagged cases per @spec never drop without a spec amendment. The base comes from ship's
  persisted junit summary when the trees match; otherwise a DJ job runs it.

A new switch-off is a judged red (the battery runs and reviewers see it): revise, or `--book` it (AI judge or human).

**Acceptance.**
- `.gitignore`-hiding a file is caught.
- `{skip: true}` drops the passing count and is caught.
- `process.exit(` is not a match.

### T4 — Fixes add checks

**Builds:** MB (§3.6), TR writers.

**Marking.** The verdict contract gains an optional per-finding `guard: lint | test`.

**The `guards` check** (judged). Every marked finding from rounds where lenses ran since the last reset needs a
guard proven by `witness guard <plan> --finding <anchor> --files <paths>`. That is a session verb under the test
turn, and it journals `guard`.
- The overlay may hold only check-definition paths and test files, never PC source files or the anchored file.
- Red is checked in CF on the raising round's pinned reviewed tree; green on the current tree.
- A red counts only if it is attributable:
  - **lint**: the declared rule id, at error severity, at the anchored path, on the pinned tree's own bytes, run
    through the base's script indirection. A breadth probe copies the flagged code beside the anchor with renamed
    locals and changed formatting, and the rule must still fire there.
  - **test**: the guard's named testcases record `<failure>` then pass. Only those run when the repo declares a
    by-name test template; otherwise the full suite runs, at the stated cost.

**Waiver.** `--book guards --finding <anchor>` (AI judge or human).

**Tolerated sets** (an LD item per (tool, rule)).
- Writers generate them on the base, compared as multisets: anything not in the base is new, whatever the counts.
- New spots in a tolerated set are a T3 switch-off.
- Tools with no writer (clippy, tsc, scripts) get no list, so the guard lands with zero old spots.
- Ship's rebase regenerates witness-generated tolerated files.

**Cleanups.** One MB birth per (tool, rule). Done when the rule's entries are gone, lint is green, and the guard's
pinned red still reproduces.

**Acceptance.**
- A guard whose overlay includes the anchored file refuses.
- A warn-level rule is not a red.
- A swap of one old spot for one new one is caught.
- A load error is not a red.

### T5 — Test strength (decision 4)

**Builds:** mutation adapters.

**Setting.** A list-shaped `mutation` setting (`none` allowed) names each tool's command and report.
- Stryker's mutation-testing report schema.
- cargo-mutants' outcomes.

**The run.** One invocation per plan on PC changed lines, as a DJ job in CF.
- The tool runs with the **base** tree's tool and test-runner configuration overlaid; a change to that config is a
  T3 definition change.
- witness owns the report path and deletes it before each run.
- The file scope goes through a file witness writes.

**What counts.** Only mutants a test actually ran (Survived, not NoCoverage). A tool without that split reports "not
measured" for files no tool-visible test reaches, which is most of wot's e2e-proven Rust. The proof says "measured
by <tool> against <scope>".

**Lens.** The `mutation-pending` precondition at ship; survivors feed ship's code-reviewer lens and the proof. A lens
is added to a battery only where the repo produces what it reads.

**Acceptance.**
- The result is keyed by the change-set sha.
- Ship never decides before the result exists or the job's time box ends.

### T6 — PR proof

The PR body is rendered from `proofOf(plan)` between witness markers (human edits outside them survive), via
`--body-file -`, and re-rendered at every ship run.

**Fixed top block, at most 8 lines:**
- what the PR promises;
- steps proven N/N by M witnessed tests;
- what this PR leaves unproven. Only gaps a different decision in this PR could have closed: booked switch-offs,
  waived guards, held needs, demoted findings, survivors. An empty list prints "Nothing in this PR is left
  unproven.";
- rounds and who decided;
- the map and look approved at which sha.

**Below the block:**
- at most 6 inline screenshots, only from this plan's step tests (by each capture's producing test);
- everything else inside `<details>`: tests per step, new checks and tolerated counts, review dispositions ("not
  reported after round N", booked, demoted, waived), and the record rows charged to this PR;
- repo-wide limits once, in a footer;
- capped by counts per lens plus a `witness log` pointer.

**Foreign text** (findings, test names, agent prose) goes only inside fenced code blocks (row 237's allowlist rule),
so GitHub's closing keywords (`fix #93`), cross-repo references and mentions never fire. Confirm with a probe PR at
build.

**Screenshots** go to per-plan refs outside `refs/heads`; verify at build that GitHub serves blob links for them,
with a per-plan branch as the fallback.
- Visibility is checked on every push. A public repo pushes nothing unless it opts in.
- migrate writes `proof.screens: branch` for a private repo, and `none` plus a check warning for a public one.

**Acceptance.**
- A 1,200-finding fixture stays under GitHub's body limit and reads at phone width.
- `fix #93` in a finding closes nothing.

### T7 — Behavior maps and always-rules

**Which specs get a map.** Specs a user reaches: ui specs, or specs that declare an entry point. Engine specs show
their always-criteria instead and never warn about a missing map.

**The section.** `## Behavior map` is one mermaid fence starting `stateDiagram-v2`, in a restricted subset (no
styling, init, theme or click; printable labels). It is required on the write path for new and amended specs; scan
and adopt tolerate its absence.

**The map gate** runs on any spec write.
- Reviewed sha = the map section + the `## Behavior` prose + the always-criteria (ids and statements).
- One reviewer emits `map_mismatch` findings, and the AI judge settles them against the confirmed recap first.
- **The human stop**
  - It fires only when the map's identity differs from the stamp. That covers a new feature (decision 9), a fix
    that changes a map or its always-rules (decision 10), and an old spec's first map. It also fires on a
    mismatch the recap says nothing about.
  - It is **one act per decompose or amendment**: one page shows every new or changed map, highlighted against the
    stamped map, with each spec's always-rules in plain sentences and one question, approve recommended.
  - Approve stamps them all; `--revise <spec>` works from the same page.
  - Pass-3 data: decomposes wrote 14 (fewhats) and 34 (wot) specs.
- **ui specs.** The map and always-rules ride on the design look's page, and the look's approval stamps both. A
  behavior answer given at the look amends the map in that session.
- **Stamp.** `map: {sha}` is volatile: it joins VOLATILE_FIELDS, write's keep-list, `FIELD_ORDER`, a shape check
  and a non-spec ban. "No map and no stamp" means the spec predates maps, not that it is pending.
- **Refusals.** Plan write refuses while a map is pending. The arbiter's and decide's approve bars include `map`.
- **Sight.** `witness map --open` renders a pinned mermaid build (SRI-checked) and shows the source beside it.
- **Unchanged.** Decompose stays with the AI judge (row 171).
- **Settings.** `gates.map.{model,reviewers}` join the migrate batch.

**Always-rules** are criteria with a rule sub-tag. The syntax must survive the matcher's normalization and Rust
identifiers, and match exactly, not by prefix (T7's plan fixes the exact form). The statement lives in
`## Behavior`. Each rule is evaluated per criterion and refused at write without a junit report. Step↔criterion
totality forces plan steps, drift counts per sub-tag, and pr-test judges whether those tests explore many orders or
inputs.

**Acceptance.** A truth table for map-pending:

| Case | Pending? |
|---|---|
| no map and no stamp | no |
| prose-only change | no |
| changed map | yes |
| removed always-rule | yes |
| `%%{init}` in a map | refused at write |

### T8 — Explore

**Contract** per repo, all trusted with blob-pinned scripts:
- a host command that provisions and resets the app with its stand-ins. For wot: build and install the test flavor,
  fresh Postgres and S3, the test api, a seeded catalog and fake game, and CDP / mailbox / tray drivers as typed
  scripts;
- a login command that uses only stand-in identities;
- declared exclusive resources.

Missing any of these means explore is off.

**Timing.** `explore.when` is one value or a per-class map: `merge` (each merge at its own commit), `idle` (the
latest main when free), `release`, or `off`. init writes `off`.

**The explorer is hermetic.**
- Its tools are typed driver verbs supplied by the host. It gets no shell, no read access to gitignored env or user
  files, and never a real account. One consumer bridges the user's logged-in third-party accounts.
- Its findings are structured (spec, map node, steps, a proposed test).
- Its text reaches agents quoted, as untrusted input. Machine recaps copy references only.

**From claim to finding.**
- A finding is a claim until a CF red is seen k of k times (k = 2).
- It counts only if it **flips**: green at some commit in range, or at the spec's last shipped merge, in the same
  job on the same machine. Otherwise it is recorded as "could not verify", with no birth and no ask. In fewhats,
  31 of 32 reds were environment.
- **Attribution** is always the repro's green→red flip, found by bisecting first-parent merges. The spec delta only
  orders which commits are tried first.

**Routing.**
- A finding that contradicts an existing spec becomes a repro item, then RP.
- A finding the spec is silent about becomes one decision for the human: the quoted finding, the failing test and a
  proposed rule, approve recommended. "No" opens the grill.

**Results** go to drive's report, the record and needs-you, never to comments on merged PRs (the user's own comments
notify no one). An explore after a machine birth's merge only reports. Setting: `explore.model`.

**Acceptance.**
- An environment-red finding births nothing.
- A finding introduced in merge M is charged to M.
- The explorer cannot read the gitignored env.

---

## 5. Human stops after all items

Design look (with the map, on ui specs) · behavior maps (one act per decompose or amendment) · unmet need · trust
grant.

Booked switch-offs and waived guards are decisions the AI judge may take, and they show in the PR's top block.
Human-only waivers (lint bookings) arrive as decisions in needs-you.

---

## 6. Settings and migrate

| Train | Settings |
|---|---|
| A (T0–T2) | ship.lint named parts |
| B (T3–T6) | switch-off extra patterns; reader/writer commands per tool; by-name test template (optional); mutation list; proof.screens; scratch.prepare; check-definition paths |
| C (T7–T8) | gates.map.{model,reviewers}; explore.{when, host, login, resources, model, budgetMs} |

**migrate** detects and proposes values:
- `pnpm-lock.yaml` → `pnpm install --frozen-lockfile` as `scratch.prepare`;
- biome or eslint configs → the matching readers and writers;
- a private repo → screens `branch`.

`--dry-run` shows the proposals. Run at a terminal, migrate writes them and grants their trust in the same act, so
nothing raises a trust stop at night. Explore login secrets live in the repo's own gitignored env, read only by the
trusted login command. `check` names each feature that is off for lack of a setting, once.

---

## 7. Rollout, upgrade effects and machine time

**Trains.**
- A = T0–T2: one migrate for the named parts; one re-review.
- B = T3–T6: one migrate.
- C = T7–T8: one migrate; map stops begin.

The floor is the highest `w` stamp, so the first write of a new release locks out older pins. Global skills bump only
at train points, and a running drive is superseded by a newer floor.

**Day 1 counts.**
- Train A: fewhats and wot have no in-flight re-reviews; #95 is fixed before T2 can judge lint.
- Train C: 45 old specs predate maps, with no warning; the next decompose brings one map act.

**Machine time per median plan** (pass-2 estimates, test turn):
- fewhats: about 2.9–3.2 h today, about 4.5–6 h afterwards.
- wot: about 12–15 h today, about 14–18 h afterwards, plus explore at about 1.5–4 h per run.

Savers on the repo side:
- a by-name test template (cuts guard proofs and repros);
- for wot, one Cargo workspace or a shared `CARGO_TARGET_DIR`.

Drive's report shows machine time per kind. Jobs that no gate reads yield the turn to plan work.

---

## 8. Residuals (honest limits)

- Machine time grows (§7), and `drive.parallelSuites: false` serializes the turn.
- Charging a human-started fix is approximate.
- Tools without a writer (clippy, tsc, scripts) get no tolerated list.
- Mutation measures only code its tool's tests reach; e2e-proven code reads "not measured".
- Explore needs per-repo host work and is off by default. With explore off, nothing checks maps against code.
- AI marks (`guard`, `map_mismatch`) are judgments. witness checks guards deterministically, not the marks.
- A trivially passing always-rule test is caught only by the reviewer.
- In chat mode (no drive), job-based results read "not measured".

---

## 9. Sequencing and overlap

- Merge `remaining-issues-2` first, then rows from 246, one per issue or behavior, in build order (246 #93, 247 #92).
- Code shared with the branch: `gate.ts`, `rounds.ts`, `ship.ts`, `decide.ts`, `next.ts`, `liveActs`, `clash.ts`.
- UI roadmap:
  - 1a.5: the run registry includes jobs and the explorer.
  - 1b.6: new WaitKinds, each naming its act — the map act, machine births, job trust, human bookings.
  - 2.1: the transition table includes the ledger, the map stamp and repair.
  - 3.2/3.3: render from PM.
- Every new journal kind gets an `ENTRY_PROGRESS` row:

| Bookkeeping | Acts |
|---|---|
| ledger observations, job shards, CF runs | book, birth, dismiss, guard, map-shown, map-stamp |

---

## 10. Verification record

- **Grill.** 14 decisions plus re-asks (4, 11, 12b), in plain-words questions with ranked answers.
- **Pass 1** (doctrine; real flows and tools; pairwise): about 40 findings. It replaced refusals with checks-only
  rounds, introduced one counterfactual primitive, drive jobs, typed debts, per-tool adapters and effect-based
  switch-offs, and dropped "undo each file".
- **Pass 2** (primitives versus doctrine; both consumers in practice; releases): about 30 findings.
  - #92 stays on row 243.
  - The scratch worktree became persistent and provisioned.
  - No approve on unjudged rounds, and `--book`.
  - One predicate for "lenses ran", and the ledger stream.
  - Births through `recap --from`.
  - The map became a real gate.
  - Base-red per diagnostic, and multiset tolerance.
- **Pass 3** (build readiness; crash, concurrency and gaming; the user's seat): about 60 findings.
  - The dependency order.
  - The ledger state machine.
  - A waiver authority per check, and terminal-only human acts under autonomy.
  - Guard overlay limits.
  - Mutation run on base config.
  - Lock order and leases.
  - The hermetic explorer, and trust pinned to script blobs.
  - One map act per decompose, ui maps on the look page, maps only where users reach.
  - Proof top block and inline screen limits.
  - Flip-only explorer findings.
  - Charged rows only, and chores never charged.
- **Probes** (all read-only on consumers):
  - fewhats and wot journals (findings by lens, rounds, efforts, drift causes);
  - PR shapes (added versus modified files);
  - verify-red's git sequence replayed (work stranded, then unreferenced);
  - payload in plan diffs; biome on payload (46 errors);
  - ESLint and Biome suppression behavior;
  - wot's CI removal and e2e harness.
- **Issues filed:** #92, #93, #94, #95.

### Corrections folded while building

- **C2 (T0a, rows 246–247).** #92's residual was wider than §4 T0 said: after a verify-red killed mid-run, `next`
  routed `test-evidence` on the reverted tree and a red was recorded there, and `start`, `recover` and `check` said
  nothing. Built as a held-ref guard in every verb that reads the plan's worktree, `recover` as the put-back `next`
  routes, and a best-effort signal trap (§4 T0 above).

