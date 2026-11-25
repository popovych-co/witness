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

**Definition.** The plan's diff against its base, minus every harness's payload targets, current and retired
(`.claude/settings.json` is shared and stays in); a rename counts as both of its paths (as built, rows 246, 248 and
250).

**Readers.** Reviewer prompts and coverage, the snapshot and the delta, red→green evidence, verify-red,
`diffReviewedSha`, machine checks, mutation scope, attribution and proof. Today `changedFiles` (`src/evidence.ts:180`) excludes nothing, so reviewers
judged witness's hooks (2 findings and 2 coverage anchors in fewhats; 2 and 5 in wot).

**Acceptance.**
- `init --agent` into a worktree leaves implement's reviewed sha unchanged.
- A payload-only change produces no plan file in any reader.
- A witness hook deleted in a worktree is named by `check`.
- A committed rename shows both paths in every reader, and verify-red's red tree keeps the old path.

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

**As built (T2c, rows 261–263).** `ship.lint` is one command (one part named `lint`) or `{name: command}` parts,
schema 3; every part runs in file order whatever an earlier one did, with no turn, and the lane stays one `lint` check
whose `parts` carry a verdict per part. "build" is a named part. A red part's base result is keyed
`<part>@<base commit>.<h12>` (over the part's and its reader's commands) and measured on demand (correction C13): a
gate that lacks it journals the key `pending` (red), and the `base-lint` job — the first production kind, in the
scratch — owes exactly those keys and returns the base's diagnostics as hashed keys with counts, at most 2,000; more is
"not judged". In chat mode the base reads "not measured", and its key is owed too, so a drive started later lints it; with scratch
runs off, a missing base result reads "not measured", never pending. Diagnostics compare on every file the reader reports, minus
witness's own paths (correction C12), not on PC files. A part passes when green, or red on the base too with nothing
new; an opaque part red on the base, a report either side could not read, or a red part whose reader finds nothing on
the plan's tree reads "not judged". A part's state joins the gate's resume signature, so the judged verdict is
journaled once the base result lands. Drive reads the config at each job's start, and owes no key the config no longer
gives.

**As built (T2d, rows 264–267).** The registry is `CHECKS` (`src/checks.ts`), in run order: `markers`, `lint`
(withholding); `implement-gate`, `diff`, `evidence`, `regression`, `tests`, `drift-lane` (judged). Each code gate hands
`runChecks` its steps; they run tier first, then in the registry's order, never by measured cost (correction C14), each
timed, cut after the first withholding red. Two tiers only (C15): `waiver` lands with `--book` (T2e), `precondition` and
`advisory` with their first checks; today's refusals stay where they are and the doc gates register nothing. The
checks-only round carries its checks up to the red one, `model` = `pin`, the full-review `prompts_sha`, the snapshot
fields any round carries and nothing a battery writes; its round number is shared with the round after it. It resumes,
or answers changed-nothing, only on the same key and the same `checksSignature` (a lint part's key joins it, so an edited
part command never resumes); once green it runs fresh. At the round bound nothing is journaled. `lensesRan` is read by
the budget, the discharge, the verdict cache (`answersKey`), the delta base, recurrence and demotions — not by drive's
rounds cap (which counts the round), `lastJudgedRun` and its readers (the gate's state anchors on the round, so its
decision is owed), the pairing, or the malformed-streak brake. No approve is live on it (`liveActs`); `decide` refuses
one `checks-only`, `recommend`'s rule `checks-only` offers the bare revise (the policy takes it), and the arbiter's menu
bars approve. Markers test `OPENS` on the lines the plan adds (C16). Implement runs the lint parts too, and `trustOwed`
owes them. A round red only for base results a drive will lint — keys the job owes, on unmoved content — is left to drive
(`Settled.waiting`); the landing makes the stop stale (`ActFacts.checksMoved`), so the policy routes the re-gate.

**As built (T2e, row 270).** The waiver is `CHECKS.waiver` (`checkWaiver`): `lint` is the human's; no other check has
one yet (T3 and T4a add the judge's). A checks-only round's withheld check with a waiver offers `--book <check>`, which
books each part `red`, `new`, `not-measured` or `not-judged` — never `pending` or `untrusted` — per diagnostic where the
lane gave it a `book`, whole otherwise, held at the part's base key until main moves (the map's C19). Base-red's
readers widen (C20): a red part with a bound, trusted reader reads the plan's tree whatever its base, but `pending`, so a
whole booking is left for parts witness cannot read (no reader, an unreadable report, past 500 distinct keys). A booking
waives its own plan only (C17), at both gates; a booked part reads `booked`, passes, and moves `checksSignature`. Rule
`book-owed` sends a round whose every non-passing part is `not-judged` to the human (C23); a part the author may own
keeps `checks-only`, the revise first and the booking after it.

**As built (T3b, row 275).** `switch-offs` moved to the end of the registry (C33), so it reads the round's one suite run
at both gates; a loss of passing tests is its second kind of hit. **As built (T3a, rows 273–274).** `switch-offs` was a
judged check right after `diff`, whose waiver is the judge's
(`CheckWaiver` `'judge'`): the AI judge or the human may book its red. `--book switch-offs` is offered on a round the
lenses ran whose every failed check carries the judge's waiver and holds a line a booking takes, with no blocking finding,
on unmoved content below the bound (the map's C26); its re-gate replays the round's verdicts (row 112's `cached`), so it
spends a round and is never offered at the bound. Rule `waivable` (after the blocking-finding rules, before
`checks-failed`) leads with the revise, then the booking, the upstream, an approve that books nothing, and the stop; the
policy hands it to the arbiter, which books in-process and never approves over the red.

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

**As built (T2e, rows 269–270).** The stream is `ledger` (`src/ledger.ts`): `ledger-open` (an act), `ledger-closed`
(bookkeeping), `ledger-dismissed` (an act); ids `l-<8 hex>`, each open carrying `key` (16 hex over kind, check, plan,
part and subject), so an item's identity names its plan (C17) and a booking reuses an open item by it — unless the
round's part already applies that item. `born` and owed work wait for the first kind with a birth: a booked check is
never owed work (C21). Closing is by observation at two acts that already write a transaction (C18): the merge stamp of
plan M, from M's last ship round that ran lint with parts (the tree that merges, its `reviewed_tree` on the close), for
M's open items and merged plans' — a part green there, or the lane's `cleared` (per-diagnostic items whose every key the
tree lacks); and the abandon, for the abandoned plans' items. No base-lint job is owed for an item; an observation that
did not happen closes nothing. Dismissal is `witness dismiss ledger --item <id|index> --cause
<rule-retired|declined|judged-wrong> --note "<why>"` (C22), at a terminal, never under a session marker, after a y/N.
`decide … --book <check>` writes its decision (`decision: 'book'`, `book: {check, items}`) and its new opens in one
transaction under the repo lock, re-reading the ledger there; the gate's state is then `booked`, whose one act is the
re-gate. `status` lists open items (`booked[n]{item,plan,part,holds,since}`) with the dismissal; `log` names each
transition; `check` reports a `ledger` stream another history holds.

**As built (T3a, row 274).** The second kind, `booked-switch-off`, books a switch-off line: `file`, `token` and
`subject.lines` (each line key, 16 hex over token, file and the normalized line, with the copies it waives); its key is
16 hex over (kind, check, plan, file, token, the sorted lines), and the lint formula is unchanged. The check applies the
plan's own items only (C17). It closes when the line is gone: at the merge stamp of plan M, read from M's newest ship
round alone (what merged), M's own items close when that tree's blob at their file holds no line they book; an item of a
plan merged before M closes only where the round's base (`reviewed_base`) held such a line and the tree holds none —
this merge took it out. A missing file holds none; an unreadable tree, a round with no base or a failed read observes
nothing, and the observation reads the item's own token, never the config. The lint lane and the lint observation read lint items only
(M-g). `status` lists `booked[n]{item,plan,check,holds,since}` (`check` `lint/<part>` or `switch-offs`).

**As built (T3b, row 276).** The third kind, `booked-dropped`, books a spec's lost passing tests: `spec`, `base` (the
booked round's base passed and skipped counts) and `subject.cases`; its key is 16 hex over (kind, check, plan, spec, base
passed, base skipped, cases), and the other formulas are unchanged. The check applies the plan's own items by spec (C17).
It closes once main has the cases back: at the merge stamp of plan M, from M's newest ship round's junit summary, short is
fewer passing or more skipped than the item's base; M's own items close when the summary is not short, and an item of a
plan merged before M only where the round's `junit.base` (the base counts it compared against, per spec) was short and
the summary is not. A round with no summary observes nothing.

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

**As built (T2b, row 258; it landed in T2, the map's correction C1).** The scratch (`src/scratch-checkout.ts`) is `.witness/scratch`, a detached
worktree with a plan worktree's sparse patterns and its reflog off, set up on every open (a found one first loses
whatever a run left in a canon folder), excluded from the root's `git status` and exempt from the state-path audit.
Its lock (`withScratchLock`) is `.witness/live/scratch/lock.json`, leased once at the take, waited for while its holder lives, taken over
once dead or lapsed, released by drive's sweep; what a process holds is kept in memory, never read back from the
file's pid. Lock order is test turn → scratch → repo lock, and `takeTurn` throws inside the scratch. A commit runs as
itself; a bare tree is wrapped deterministically (`commit-tree --no-gpg-sign`, a fixed identity and date) and pinned at
`refs/witness/cf/<plan>/<tree>` — per (plan, tree), not per round — and the merge stamp drops the plan's refs. Reset
removes a killed reset's `index.lock`/`HEAD.lock` first. The run is `inScratch(root, ctx, cfg, at, step)`: synchronous,
headless, with a step rather than a command; it journals nothing and keeps no cache (each caller's journal is its
cache, correction C10), and returns a record of every sha. `expect` and the "green on current" reuse land with T4a's
guards. The junit rule is correction C8: `<error>`, or vitest's file-level case (a failed case named after its file
in the suite named after that file; under `test.projects`, a name that ends its classname after a `/`); a run with
load failures is reset, prepared again once and re-run, and a second is `load-failure`, never a red. A job kind may
run in the scratch, whose lock its verb takes after the turn and before its box starts.

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
  **As built (T3b, row 275; C32).** A round with no base counts — a filtered runner, no full-suite run, an unreadable
  base, a file that failed to load, or a base not measured yet — reads not checked: the check stays green and says so in
  its detail, `tests_effect` and the arbiter's facts. A missing base is owed through the check's `owes` to the
  `base-tests` job (ungated, under the turn, in the scratch, boxed at `drive.sessionTimeoutMs`); a result that lands
  never moves a stop, and the next round reads it.

Jobs register in the UI run registry (roadmap 1a.5).

**Acceptance.**
- A stuck session beside a running job is set aside after one spawn.
- A session waiting on a job's turn is not killed by its own deadline.

**As built (T2a, rows 255–257).** Waiters hold leased tickets in `.witness/live/turn/` (60 s, renewed every 10 s, put
back with their place), and only the head may take a free turn; an ungated job yields to plan work. The lock names a
job holder's kind, and a ticket names the session it waits for, so drive sees a session waiting behind a job. Ship's
lint lane takes no turn. A session waiting behind a job is held: its clock leaves that time out of
`drive.sessionTimeoutMs` (sleep stays sleep), drive moves its deadline through `WITNESS_DRIVE_DEADLINE_FILE`
(`.witness/live/deadline/<drive pid>-<spawn n>.json`; the busy bound and the reviewer's wait read the later of it and
`WITNESS_DRIVE_DEADLINE`), and the target's wall-clock cap is charged `ms − heldMs`. A job kind declares `turn`,
`gated`, its box, its owed units (`{kind, key, shards}`) and `run`; there is no setting. `witness job <kind> <key>
<k>/<n>` runs one shard as drive's child and reports on stdout (`running`, then `result`, at most 48 KiB). Drive runs
one shard at a time beside the lanes, in every drive; the box starts at `running`, on the awake clock; a timeout or a
failure is a strike, two read not measured, and a stop journals nothing. A refused journal write turns jobs off for
the run (a crash marker's excepted: no shard starts while one waits), drive journals nothing once a newer CLI has, the
human pause is said while a job runs, and a job still queued for the turn is stopped when the run would end. Drive journals each shard on the reserved
`jobs` stream (bookkeeping), and its report names machine time per kind. A missing result reads pending while a drive
holds the repo, otherwise not measured. No production kind exists until T2c.

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

**As built (T2c, row 262).** Each reader is a setting, `readers.{biome,eslint,clippy,tsc}` (schema 3, `none` by
default), bound to the `ship.lint` part of its tool's name; any other part is opaque. Biome's reader is SARIF (the JSON
reporter stays out), ESLint's `-f json`, clippy's cargo's `--message-format=json` (built from its documentation, not
probed), tsc's `--pretty false` lines. Error severity only. A reader prints every error, never stopping at the first
failure: the base and the plan compare whole. A report that does not parse whole, or a red exit that reports no error,
fails closed (`reader-unread`). Paths are placed in the run's tree (a `file://` URI, `\`, the folder's real path, a
cargo span from its manifest's folder); a path witness cannot place is kept as printed. Keys are 16 hex over (tool,
rule, file, snippet). `init` and `migrate` detect Biome and ESLint readers through the root lockfile's exec form; tsc
and clippy are written by hand. No reader takes a path, so typed tokens still land with T4a (correction C10).

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

**As built (T2b, rows 259–260).** `scratch.prepare` is declared once (schema 3) and granted once. Prepare pins nothing
(correction C9): a pin earns its stop only where a command runs with access the agents lack — explore's login reads
real secrets — while prepare runs as every session runs, and pinning manifests and lockfiles would ask again after 11
of fewhats' 22 merges and 14 of wot's 16. Pins land in T8 with the explore host and login, with the acceptance "a
changed blob-pinned file raises the trust item again". Typed tokens land with the first command that appends one (T2c's
readers or T4a's guards, correction C10); nothing in T2b appends a token. A repo command — the runner, `ship.test`,
`ship.lint`, `scratch.prepare` — is granted with no target, `witness trust --cmd '<exact>'`, journaled on witness's
reserved `trust` stream, since a job or a scratch prepare serves no artifact; a doc's command still takes its target.
`migrate` at a terminal asks once per command it proposes and grants each yes in the config's own commit. A job kind
declares its commands; one whose commands (with `scratch.prepare` for a scratch kind) are untrusted is skipped, never
struck, and drive sets aside one `jobs` trust wait naming the targetless grant.

### 3.8 Proof and record models (PM) — record in T1, proof in T6

`proofOf(plan)` and `record(repo)` live in `src/models.ts`, as one computation with many renderers (rows 139/203,
UI 1a.1): PR body, drive report, status, `decide --show`, UI 3.2/3.3.

**What the journal gains.**
- test-evidence: the tree sha, plus each capture's producing test.
- GateCheck: `duration_ms`.
- drift-check: testcase outcomes.
- Ship: its junit summary.

With `report: none` no test names exist, and the proof says so.

**As built (T1, rows 251 and 254).** `record(repo)` lives in `src/record.ts` and `src/models.ts` exports it; status,
`status --record` and drive's report render it. The journal gains are additive and never part of an identity:
`GateCheck.duration_ms` (wall time with waits, every check of every gate, `timedCheck`); a test-evidence `tree` (the
snapshot tree before the run) and `captures[].test` from a `<name>.png.json` sidecar holding the junit testcase name,
read once through its descriptor; drift `outcomes` (full-suite runs only: counts and at most 50 failing names); and
ship's `junit` summary of its one suite run (full-suite mode only, with the reviewed tree).

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

**As built (T2e, rows 270–271).** A typed `--book` under committed autonomy — HEAD's config, which a working-copy edit
cannot lift — needs `isTTY` and a y/N listing each part; it is refused for the policy and the arbiter, on a nod, and
under any session marker witness set (`WITNESS_DRIVE`, `WITNESS_JOB`; a reviewer is refused every acting verb at
dispatch). `witness dismiss ledger` is always a terminal act, autonomy or not. `gate --manual` refuses
`manual-in-session` under any session marker, before anything is read or journaled. The two-stream acts built here —
`--book`, the merge stamp's and the abandon's closes, the dismissal — each run in one transaction with the ledger read
again under its lock.

**As built (T2d, row 266).** `checkFacts` prints each check's name and verdict, each lint part's state with its counts
and rule ids, how many commands trust kept from running, and the held criteria's ids — never a check's `detail`, a part's
`why` or a command; foreign names are spelled out. Every gate's checks read so. A checks-only round says so on the stop's
round line, as `model: no reviewer was asked`, and in the round history.

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
- **#94.** `gh pr create` reads the body from stdin (`--body-file -`, through `ghBody`); the title stays an argument
  (as built, row 249).
- **#95.** As built (row 250; the map's correction C6): the hooks move to `.witness/hooks/` (`PAYLOAD_HOME`), which
  both consumers already exclude from lint, carved out of the `.witness` state dir — not state, not canon, and
  re-included in every worktree's sparse patterns. The old `.claude/hooks/*` targets retire (`Harness.retired`, still
  witness-owned in PC): `init` rewires `.claude/settings.json`'s two witness commands in place, writes the file in the
  formatter's default style and removes the old files at the root; the ship gate drops them from a plan whose base and
  own settings no longer carry them. `check` and `init` warn `payload-linted` when the root Biome config would check
  witness's files.
- **Renames.** A rename is both of its paths in PC and in a state-only advance (row 248).

**Acceptance.**
- A SIGTERM during the red run restores the work before the process exits.
- After a SIGKILL there, on a plan with no criteria step and on a step with no vacuous red, `next` routes
  `witness recover` (which puts the work back or refuses) and never routes `test-evidence`.
- `check` warns about a standing verify-red ref.
- `init --agent` into a worktree leaves implement's reviewed sha unchanged.
- A payload-only change produces no plan file in any reader.
- A 40,000-character body passes on Windows.
- fewhats' `biome check` is green on payload files.
- A committed rename shows both paths in every PC reader, and verify-red's red tree keeps the old path.
- A worktree created after `init --agent` has the hooks, and neither `start` nor `check` raises `canon-in-worktree`.
- Re-running `init --agent` leaves one set of witness hook entries in `.claude/settings.json`.

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

**As built (rows 251–254).** Escapes read not measured until one live fix carries a cause. A fix's cause is its own
`cause` journal entry beside the recap, never a recap field; the recap file carries it, a fix birth or an amend naming
another cause journals it, and `witness recap --effort <slug> --cause escape|decision` classifies a fix that predates
causes — the human's act, refused in any witness-spawned session. An escape is charged to the last non-chore plan of a
spec it amended that shipped before its birth, and only when the merge clock places every candidate; otherwise it
reads `order unknown`, `nothing shipped before` or `no amended spec`. The merge clock is one `git log` over witness's
trailered `merge(<plan>): pr #N` and `recap(<slug>): <class>` subjects (each optionally ` (recovered)`), ages count
the merges between, and versions come from the charged plan's ship gate-run `w`. Live specs failing is the current
state per live spec: a named red is failing only in the names it shares with the run before it, a red naming no
failing testcase could not verify, and runs without outcomes are not measured. Checks added and repairs read not
measured until T4a and T8b. Plain `status` prints the `record:` line and the fixes owing a cause; `status --record`
prints the record in full.

### T2 — Machine checks before reviewers

**Builds:** CR (§3.2), DJ (§3.5), LD with booked-check items (§3.3), TR readers (§3.7).

**Checks.**
- Conflict openers on the PC files, using `clash.ts`'s `OPENS` rule; a plain `=======` never counts. As built (C16,
  row 265): on the lines the plan adds to text files in PC — a tracked file's added lines against the base, an
  untracked file whole — so a marker the base already holds is not the plan's; binaries and symlinks are skipped, and
  a diff that fails reads the file whole.
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

**As built (T3a, rows 273–274; T3 splits at planning, the map's C24).** T3a builds the token layer, the `switch-offs`
judged check at implement and ship, `--book switch-offs` for the judge and the human, booked lines closing on main, and
the repo's own tokens; T3b builds the effect layer (`checks.definitions`, the lint effect, the tests effect) feeding the
same check and booking, and takes the first two acceptances. Each token counts where its tool reads it (C25): a directive
only where it opens a comment; a code token never on a comment line; the test API only in test files, its options only
with their turning-on literal (`{ skip: true }`, `retry: 3`; never `retry: false`), and `xit(` never inside
`process.exit(`. The repo's extra patterns are `checks.switchOffs` (schema 4): literal tokens, never regexes, matched on
any line of any text file. A switch-off is a line (C27): the plan adds the copies of each (token, file, normalized line)
key beyond the base's count, so a moved or re-indented line is not new and a duplicated one is. The reviewers are told
each line from the tree. What the token layer reads by lines and cannot see — strings, evasive spellings, files outside
the four languages — is in DESIGN.md's Open / deferred.

**As built (T3b, rows 275–276; T3b splits at planning, the map's C28).** T3b builds the tests effect and takes the
acceptance "`{skip: true}` drops the passing count and is caught"; T3c builds `checks.definitions` and the lint effect
and takes "`.gitignore`-hiding a file is caught". The base is ship's summary when the **code** trees match (C29): the
tree minus canon, `.witness` and witness's payload, under the same suite command (`suiteKey`); otherwise a `base-tests`
job runs the base's suite in the scratch. Per spec canon still holds, new skips always count and passing cases lost
beyond new failures and new skips count, unless the plan's own parent was amended since its previous plan, which licenses
removals only (C30, C31). A loss is a judged red in `switch-offs`, booked by the judge or the human like a line, and a
booked loss closes once main's shipped summary has the spec's cases back.

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

**As built (T2e, row 270).** The policy leaves a `book-owed` stop to the human (`autonomy: left for a human — only the
human books lint — <parts> red on the base too`), with no model call; drive sets it aside as a decision, and needs-you's
decision item names its act on a `book:` row (`witness decide <gate> <plan> --book lint`), read from the journal's facts.

---

## 6. Settings and migrate

| Train | Settings |
|---|---|
| A (T0–T2) | ship.lint named parts; readers.{biome,eslint,clippy,tsc}; scratch.prepare (as built, T2b–T2c: all schema 3; the map's C5) |
| B (T3–T6) | switch-off extra patterns (as built, T3a: `checks.switchOffs`, schema 4 — Train B's one step); reader/writer commands per tool; by-name test template (optional); mutation list; proof.screens; check-definition paths |
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
- A = T0–T2: one migrate for the named parts; one re-review. As built: migrate writes `scratch.prepare` and the
  detected readers and grants them; it keeps a one-command `ship.lint` one part named `lint`, so a reader binds only
  once the human names the part for its tool — migrate and init say so (`note: readers.<tool> is set, but no ship.lint
  part is named <tool>`), as `check` does.
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
- **C6 (T0b, row 250).** The `.witness/hooks/` home this design named was invisible in worktrees: `.witness` is a state
  dir, and every worktree's sparse checkout drops it, so a committed hook there was absent and writing it made `start`
  refuse `canon-in-worktree`. Built as a carve-out (`PAYLOAD_HOME`) re-included in every worktree's patterns, with the
  old home retired at the root by `init` and from plans by the ship gate (§4 T0 above).
- **Renames (T0b, row 248).** PC followed git's rename detection, so a committed rename listed only its new path;
  `--no-renames` lists both (the user's call of 2026-11-22, from T0a's final review).
- **C3 (T1, rows 251–254).** All four journal gains landed in T1, their readers later (`duration_ms` → T2d, ship's
  junit summary → T3, the producing test and the evidence tree → T6). A capture names its test through a sidecar,
  `<name>.png.json` = `{"test": "<full test name>"}`, which both consumers' vitest harnesses can write; T6 owns the
  fallback without one.
- **A cause is an entry (T1, row 253).** §4 T1's `cause` is its own journal entry, never a recap field:
  `effortReviewedSha` hashes the whole recap, the arbiter reads it, and an amendment re-arms decompose, so a cause set
  later would move a finished effort's identity and reach a reviewer.
- **Ship runs its suite once (T1, row 252).** Full-suite ship ran the suite twice, in the tests lane and again in the
  criteria lane; the criteria lane now reads the tests lane's run, so "ship's junit summary" names one run.
- **Drive journals its jobs' shards (T2a, row 257).** §3.5 left who journals a shard open; row 145 says children
  journal their own acts. A job child stopped at its box dies at once, even blocked in `execSync` (probe
  `t2a-group-kill`), so it prints its result and drive journals it: row 145 is amended for jobs only.
- **A failure is a strike (T2a, row 257).** §3.5 names timeouts only; a shard that fails counts too, so a crashing
  job cannot loop drive.
- **Boxes and shard counts belong to each kind (T2a, row 257).** §6's Train A list gains nothing from T2a.
- **The box starts at `running` (T2a, row 257).** Time a shard spends queued for the turn is never boxed.
- **Results live on the reserved `jobs` stream (T2a, row 257)**, one state commit per shard; `jobs` is a reserved id.
- **`turn: false` passes the env unchanged (T2a, row 255).** A job's command inside its verb's turn keeps
  `WITNESS_RUNNER_TURN`, so a witness it invokes re-enters rather than waiting on its own parent.
- **Charging is conservative (T1, row 254).** An escape is charged only when the merge clock places every candidate
  plan, since one it cannot place may have shipped later; a fix whose writes name no spec in canon reads `no amended
  spec`. Transaction ops equal their commit subjects, so a merge stamp or birth that `recover` completes keeps its
  place.
- **C8 (T2b, row 258).** §3.4 said a junit `<error>` is a load failure; vitest 4.1.10, both consumers' runner, never
  writes one: a missing import, a syntax error, a module that throws at import and a throwing `beforeAll` each write
  `<failure>` on a synthetic case named after its file (probe `t2b-junit-vitest-4.1.10.xml`). A load failure is a case
  holding `<error>`, or that file-level case — in the suite named after its file, so jest-junit's
  `'{classname} {title}'` names stay reds (slice 1 review), with a `/`-suffix name under `test.projects` (slice 2 review).
- **C9 (T2b, row 259).** §3.7 had prepare, the explore host and login pin their files' blob shas; prepare pins nothing,
  and pins land in T8 with the host and login (the user's call of 2026-11-23, "what is not a band aid").
- **C10 (T2b, rows 258–259).** §3.4's `run(tree, overlay, command, expect)` was cached and reused the round's junit, and
  §3.7 appended typed tokens; CF keeps no cache — each caller's journal is its cache, since a job child never journals
  (row 257) — and takes a step, not a command; `expect`, the reuse and the tokens land with their first users (T4a's
  guards, T2c's readers) — the user's call of 2026-11-23.
- **C11 (T2b, row 259).** §3.4's prepare ran "when the lockfile or manifests differ"; its inputs are a built-in list of
  lockfiles and package-manager configs at any depth, never a setting, with `package.json` left out (a dependency edit
  moves the lockfile; a scripts-only edit needs no reinstall); an input the list misses is caught by the load rule.
- **Refs per (plan, tree) (T2b, row 258).** §3.4's per-(plan, round) refs: nothing finds, keeps or drops one by its
  round, so a ref names its plan and tree only.
- **The detected pnpm prepare (T2b, row 259).** §6's `pnpm install --frozen-lockfile` gains
  `--config.confirm-modules-purge=false`: run headless, pnpm aborts whenever the scratch's kept `node_modules` must be
  purged (a pnpm upgrade, a hoisting setting that differs between trees), and prepare would fail for good (slice 2
  review).
- **C12 (T2c, row 263).** §3.2 compared diagnostics "on PC files"; they compare on every file the reader reports, minus
  witness's own paths — a change can raise a diagnostic in a file it never touched (a type error in an importer, a rule
  it switches on), and tsc prints cwd-relative paths, so a PC-only filter dropped a plan's new error and read green. A
  path witness cannot place is kept as printed, never dropped (the user's call of 2026-11-23).
- **C13 (T2c, row 263).** Base diagnostics came from a DJ job "cached per base tree"; the job runs on demand: a gate
  that finds a part red journals the key it lacked (`pending`), and `base-lint` owes exactly those keys, keyed per
  part, base commit and commands (the user's call of 2026-11-23).
- **"build" is a named part (T2c, row 261).** §3.2's withholding "build" is a `ship.lint` part, with no check of its own.
- **Readers bind by part name (T2c, row 262).** A reader is a setting per tool, reading the part of its tool's name.
- **Error severity only (T2c, row 262).** A warn-level diagnostic is never a red, on either tree.
- **The base's keys ride the shard's result (T2c, row 263)**, at most 2,000 distinct keys per result (one pipe write).
- **Drive reads the config at each job's start (T2c, row 263).** Gates read the file fresh, so a part edited mid-run is
  keyed and trusted as the gate that asked keyed it.
- **C14 (T2d, row 264).** §3.2 ordered checks by a cold-start order, then the journaled median `duration_ms`; they run
  by tier, then in the registry's order, never by cost: cost could only reorder within a tier, and across tiers ship's
  criteria lane reads the tests lane's suite (row 252), so a measured order could run the suite twice. `duration_ms`
  keeps no reader.
- **C15 (T2d, row 264).** §3.2's four tiers and its waiver: T2d builds `withholding` and `judged`; `waiver` lands with
  `--book` (T2e), its first reader; `precondition` with T5's `mutation-pending` and T7b's `map-unseen`, `advisory` with
  T5's survivors. Today's refusals (steps-open, screens-matched-nothing, design-unseen) stay put.
- **C16 (T2d, row 265).** §4 T2 scanned conflict openers "on the PC files"; it scans the lines the plan adds to text files
  in PC, per base-red's per-diagnostic rule: a marker the base already holds is not the plan's.
- **A checks-only round at the bound journals nothing (T2d, row 264).** The endgame decides at the bound (row 67), and a
  moved tree already reads stale; a checks-only round never brings the bound nearer.
- **A round red only for drive's base lint waits for drive (T2d, row 267).** The settle ran before the base lint existed,
  so under autonomy such a round was revised; it is now `waiting` to the settle — drive's work in flight — and the
  landed result makes the stop stale, so the policy routes the re-gate. With jobs off for the run, drive sets it aside
  for the human.
- **The scratch checkout's names (T2e, row 258).** Main's row 268 (#99) took `src/scratch.ts` and `withScratch` for its
  temp-directory owner; T2b's unreleased checkout moved to `src/scratch-checkout.ts` and its lock holder to
  `withScratchLock` before the merge, and the scratch run's temp index goes through main's `withScratch`.
- **C17 (T2e, row 270).** §3.3 keys items (kind, check, subject); a booked check's subject names its plan, so a booking
  waives its own plan's lint at both gates and reaches main only through its plan's merge. Ids are minted; the 16-hex
  key is the idempotence key.
- **C18 (T2e, row 269).** "Closes when they are gone", observed by the owning check on the merged tree, is the merge
  stamp of the merging plan reading that plan's last ship lint (a green part, or the lane's `cleared` ids) for its own
  items and merged plans'; an abandoned plan's items close in the abandon's transaction; no base-lint job is owed for
  an item.
- **C19 (T2e, row 270).** A base-red part's human-only booking, extent unsaid, holds whole at the part's base key (base
  commit and commands): asked again once main moves (the user's call of 2026-11-24).
- **C20 (T2e, row 270).** Readers diffed (tool, rule, file, snippet) only when the base was red; a reader-bound red part
  reads the plan's own diagnostics whatever its base (green, not measured, unreadable), so bookings are exact wherever
  witness can read the plan's tree, whole only for opaque or unreadable parts or past 500 distinct keys.
- **C21 (T2e, row 269).** Owed work is "open and not born"; a booked check (and T3's booked switch-off) has no birth, so
  it is never owed work: it closes by observation or dismissal, and nothing routes it.
- **C22 (T2e, row 269).** `witness dismiss <item> --cause <cause>` is `witness dismiss ledger --item <id|index> --cause
  <rule-retired|declined|judged-wrong> --note "<why>"`, row 122's verb shape with the reserved stream as its artifact,
  always at a terminal (isTTY and a prompt), never in a session.
- **C23 (T2e, row 270).** Human-only waivers arrive in needs-you as decisions where no author could clear the red: the
  policy leaves a lint stop to the human (`book-owed`) only when every part that does not pass is `not-judged`; a part
  the author may fix (`new`, `red`, `not-measured`) is revised first, the booking offered beside it — a machine cannot
  tell whose such a red is.
- **Any session marker (T2e, rows 270–271; security review).** §3.9 refused `gate --manual` inside a drive session; it
  and `--book` refuse under any marker witness sets (a drive job's too), as `dismiss ledger` does.
- **C24 (T3a, rows 273–274).** T3 was one item and more than L: the token layer, the first check the AI judge books, and
  an effect layer needing two job-backed runs. It split at planning into T3a (the token layer, the judged check, the
  judge's `--book`, booked lines closing, `checks.switchOffs`, schema 4 opening) and T3b (`checks.definitions`, the lint
  effect and the tests effect, feeding T3a's check and booking); one branch, one PR at T3b's close.
- **C25 (T3a, row 273).** "Token-aware matching on the spec's lists, plus a repo setting for extra patterns" became each
  token where its tool reads it: naive matching flagged 13 `retry:` lines in fewhats' code and none was a switch-off.
  Directives only where they open a comment; code tokens never on a comment line; the test API only in test files, its
  options with their turning-on literal; extra patterns literal tokens, never regexes. Two automated security reviews
  and the slice review widened what counts (a closed leading comment, a `*`-led line, a lone CR or line separator, a
  directive opening a block comment's later line, a NUL in a source file, a byte order mark), each toward reporting.
- **C26 (T3a, row 274).** "Revise, or `--book` it (AI judge or human)" became: `--book switch-offs` is live only on a
  round the lenses ran whose every failed check carries the judge's waiver, with no blocking finding, unmoved, below the
  bound; the policy hands rule `waivable` to the arbiter; a typed booking keeps T2e's terminal and session rules. A
  blocking finding or another red is the author's first, and a booking's re-gate spends a round, so it is never offered
  at the bound.
- **C27 (T3a, rows 273–274).** "Scans added PC lines" and "the line" became copies beyond the base's: per file, the
  multiset of (token, file, normalized line) keys on the plan's version minus the base's, since a `-U0` diff calls a
  moved or re-indented line added; a booked item is one line (file, token, keys) and closes when the merging plan's
  shipped tree holds none of its keys.
- **C28 (T3b, rows 275–276).** T3b as mapped (`checks.definitions`, the lint effect, the tests effect) was more than L:
  two job kinds, a new withholding wait and two ledger kinds. It split at planning: T3b the tests effect, T3c
  `checks.definitions` and the lint effect; T4a and T5 wait on T3c. The tests effect went first: it catches the test-API
  spellings a line scan misses and lays the path every effect hit takes (an `OffVerdict` variant, a ledger kind, a
  merge-stamp observation).
- **C29 (T3b, row 275).** "When the trees match" became the code trees: every journal line and stamp is a commit on main,
  so main's whole tree moves without any code moving (fewhats: 7 of 22 merge trees equal their PR head's, 21 of 22 code
  trees do). The summary journals `code` and `suite`; a `base-tests` result serves every base commit of its code.
- **C30 (T3b, row 275).** "Passing tagged cases per @spec never drop" became: per spec, new skips always count; passing
  cases lost beyond new failures and new skips count; counts net out (the summary keeps no names); a base spec gone from
  canon is not compared; a round whose suite failed to load a file reads not checked (slice 2 review).
- **C31 (T3b, row 275).** "Without a spec amendment" became row 160's one derivation: the plan's own parent is licensed
  when its content moved past its previous plan's pin (`baseForSpec`), or no other plan exists; the license covers
  removals only, never skips; a licensed loss is named, never red.
- **C32 (T3b, row 275).** "The base's DJ job; not checked for that round" became: a missing base reads not checked and
  owes the `base-tests` job through the check's `owes` (C13's on-demand rule); the kind is ungated, under the turn, in the
  scratch, boxed at `drive.sessionTimeoutMs`; a landing never moves a stop.
- **C33 (T3b, row 275).** `switch-offs` sat right after `diff`; it moved to the end of the registry so it reads the round's
  one suite run (implement's criteria lane hands it on; ship's tests lane holds it). Judged checks all run whenever any
  does and the signature sorts its terms, so the move changes no judgment.
