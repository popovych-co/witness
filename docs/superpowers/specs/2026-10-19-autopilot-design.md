# Autopilot: witness runs without a human in the loop, and faster

Date: 2026-10-19 · Status: draft for approval · Evidence: fewhats.com usage, 2026-09-17 to 2026-10-19

## 1. Why

The user runs witness on fewhats.com through pi chat sessions, and has two problems with it.

**The human is asked constantly, and the asking adds nothing.**
- Witness stops for a human at:
  - every blocking finding;
  - every ship;
  - every feature's scope;
  - every screen design.
- It also ends the session whenever work moves between the main folder and a worktree, and after every three plan steps.
- The user answered 939 times in 33 days:
  - 86% of the answers were "proceed with the most correct next", "rec", "go" or a bare number;
  - about 30 more were anger at being shown options ("do not ever show me available options, tell me which to chose, i don't want to see two or more options, just one!");
  - fewer than 3% steered anything.
- DESIGN.md's north star 3 says a human "never rubber-stamps what evidence already settled". In practice the stops have become exactly that.

**Specs are slow.**
- A plan takes a median of 16.5 hours from `witness start` to a merged PR. The mean is 32 hours and the worst was 275.
- Up to half of all session time was sessions sitting idle, waiting for a reply. That figure includes nights.
- Most of the rest went to three things:
  - gate reviews that run their reviewers one after another;
  - test evidence that runs the whole suite for every red and every green;
  - review rounds that never converge.

**Decided by the user in this conversation:**
1. Witness comes back to them only when it physically cannot continue: an account, password or payment it doesn't have. It also shows them the look of a new screen.
2. Witness merges its own PRs once CI is green.
3. The three-part direction below:
   - an autonomy setting, under which witness settles its own stops through the CLI's recommendation or a separate model the CLI launches, never through the agent that wrote the code, with every call logged;
   - `witness drive` as the one command that starts every session itself and works on independent specs side by side;
   - the speed fixes.

## 2. Evidence base

All figures were measured on 2026-10-19 by Python passes over two sources:
- the pi session logs, `~/.pi/agent/sessions/--Users-home-x-personal-fewhats.com*/*.jsonl` (the main folder and 21 worktrees, 203 sessions): user turns, and tool-call start-to-result durations;
- `fewhats.com/.witness/journal/*.jsonl` (52 streams) and fewhats.com's git log (1,860 commits).

**E1: What the human typed.** There were 939 human replies. The 202 `/witness` engine expansions are excluded.

| Kind | Replies | Share |
|---|---|---|
| Rubber-stamp, or deferral to the agent | 811 | 86.4% |
| Frustration at being given options or told to act | 30 | 3.2% |
| "merged" (the human merged a PR on GitHub and reported it) | 20 | 2.1% |
| "verify yourself" | 18 | 1.9% |

About 25 replies (under 3%) actually steered the work, in three ways:
- **the look of a screen:** "groups/folders with ability to colaps them and reorder", "show me on ui";
- **an account or credential fact:** "ses prod access in review…", "stripe logged in", "use profile aws", "skip github";
- **a scope cut:** "skip billing", "we wouldn't gonna do this", "1 will never be fixed".

**E2: Where the stops come from.**
- There were 402 gate runs and 355 `human-decision` entries. 50 of those entries are `caused_by` reopen records written automatically, which leaves 305 real stops.

| Gate | Outcomes |
|---|---|
| implement | 197 stopped · 27 passed · 1 malformed |
| ship | 51 stopped (standing stop) |
| design | 26 stopped (standing stop) |
| decompose | 20 stopped · 1 passed |
| plan | 64 passed · 15 stopped |

- The recommender rule that matched on the 305 stops:

| Rule | Stops |
|---|---|
| `blocking-here` | 137 |
| `bound` | 42 |
| `non-blocking-only` | 34 |
| `manual-stop` | 31 |
| `ladder-spent` | 25 |
| `bound-recurrence` | 19 |
| `anchor-recurrence-2` | 12 |
| `reserved-stop-clean` | 4 |
| `bound-stale` | 1 |

- The human took the CLI's recommended option 249 times (82%), 191 of them by bare affirmation.
- 35 of the other 56 were at the round bound. There, option 1 is `--approve --override`, which a nod cannot take. In the sampled transcripts, those 56 followed the agent's own recommendation, after a reply like "proceed with the most correct next".

**E3: Why "proceed" often could not proceed.**
- The engine prompt (`plugin/commands/witness.md`) ends the turn at every `witness decide` line and at every `run:` handoff.
- The stage skills end the turn at every gate stop and at every slice relay.
- `decide` refuses a bare affirmation for `--approve --override`, `--stop` and trust grants (`nod-cannot`, `src/verbs/decide.ts:198-204`). A block without a recommendation also has to be named.
- The transcripts show the agent refusing outright: "No. Asking again doesn't change what the request is … the selection has to come from you."
- `witness drive` (D145) exists to spawn sessions, but it never ran in fewhats, and `witness drive` does not appear in the shell history. It is TTY-only, and it still stops at every decision and every conversation stage.

**E4: Where the time goes.**
- **Idle time:** the 203 sessions spanned 696 hours. 339 of those hours are gaps between the agent's last message and the human's next reply. That is an upper bound, because it includes nights.
- **`witness gate implement`:** 319 calls; median 14.0 min, p90 31 min, max 181 min; 87 h in total.
  - The lenses run one after another (`src/gate.ts:394`), and each one is a blocking `spawnSync` (`src/reviewer.ts:135`).
  - Feature plans run five lenses.
- **`witness test-evidence`:** 489 calls; median 8.6 min, p90 16.5 min; 66 h in total.
  - fewhats uses `criteria.runner: full-suite`, so every red and every green runs the whole suite.
- **Polling:** 48 h went to polling gates and tests running in the background.
- **Start to merged PR,** over the 20 merged plans: median 16.5 h, mean 32 h, worst 275 h.

**E5: Review rounds don't converge.**
- Across all plans, the implement gates reported:
  - 375 blocking findings at an anchor that plan had not seen before;
  - 696 at an anchor seen in an earlier round.
- Every round surfaces about 1.7 new blocking anchors, so fixing what was found does not end the loop.
- thread-mirror-mirroring-plan-1 shows the worst case: 63 implement rounds, 89 decisions, 33 session slices, 95 evidence runs and 275 hours.

**E6: Spec-scoped test runs are fast in fewhats.** Probe run in the thread-mirror-tap-plan-1 worktree, against a full-suite median of 8.6 min:

| Command | Time | Tests |
|---|---|---|
| `pnpm test -t "@spec:laptop-liveness"` | 16 s | 20 |
| `pnpm test -t "@spec:thread-mirror-tap"` | 13 s | 72 |
| `pnpm test -t "@spec:signin-email-code"` | 48 s | includes two browser e2e files |

- **Over-matching is not harmless.** Evidence runs read filtered results from the junit report by exact tag (`src/evidence.ts:58-77`). The drift lane in filtered mode, however, judges a criterion by the run's exit code (`src/criteria.ts:71-80`).
  - So a filter that over-matches costs time in evidence, and it can fail the wrong spec's lane.
  - `-t "@spec:thread-mirror"` ran 204 tests from three specs, in 165 s.
- **Anchoring the pattern fixes both.** With `-t "@spec:{id}($|[^a-z0-9-])"`:
  - laptop-liveness ran its 20 tests in 15 s;
  - thread-mirror matched only its own tests (it has none yet), in 14 s.
- The same probe failed in the main checkout with `Cannot find package '@repo/logger'`. That checkout has a stale install, which is unrelated to the filter.

**E7: Session slices rarely reach their step budget.**
- There are 99 `dispatch` entries. Slices ran a median of 75 min, with p90 at 205 min.

| Steps completed | Slices |
|---|---|
| 0 | 23 |
| 1 | 30 |
| 2 | 23 |
| 3 | 22 |
| 4 | 1 |

- The 3-step budget (D79) is seldom the limit. Slices end early, on gate stops and rework.

**E8: What the builder check found, each re-verified against the journals and the code.**
- **`manual-stop` is misattributed.**
  - All 31 `manual-stop` decisions disposed of runs that had failed checks and no blocking finding, and none of those runs had `--manual`.
  - The failed checks: drift-lane 22, tests 4, amendment-ack 4, lint 1, regression 1, goal-coverage 1.
  - Rules 10 and 11 need every check green (`src/recommend.ts:328`, `:342`), so these runs fall to rule 12, which recommends approve.
  - Humans approved 25 of the 31, including 8 of the 9 ship gates with failing checks.
- **Standing stops with green checks and no blocking finding** usually carry non-blocking findings: ship 11 of 13, decompose 2 of 5, design 22 of 22. So `non-blocking-only` matches before `reserved-stop-clean`.
- **signin-email-code's unmet need.** Its spec carries `needs: ses-prod` (manual, unsatisfied), and all five of its plans have `needs: []`. Its `ac-baseline` (`cmd: pnpm verify:baseline`) failed in 33 gate runs across those five plans, and all five merged.

## 3. Goals

- **G1.** With autonomy on, witness carries an effort from the human's ask to merged PRs with no human reply, except at the kept stops (G2).
- **G2.** The kept stops are the only times witness comes back to the human:
  - the look of a new screen: a `ui` spec's design. *(User.)*
  - something it physically cannot do, such as an account, password, payment or real-world fact it doesn't have (`needs.manual`), or a refusal it cannot repair, such as `gh` not being authenticated. *(User.)*
  - letting an agent-written command run unattended: a trust grant. *(Designer's call; security.)*
  - work it gave up on: a parked flow. This one is reported, not asked.

  A kept stop blocks only the work behind it. Everything else keeps moving.
- **G3.** Every decision made without the human is journaled with who made it (the CLI policy or the arbiter) and why. It is readable through `witness log` and `witness status`, and summarized in the run report.
  - The choose block and the recovery fork are routing, not dispositions. Their pick is printed with its rule, and the act it causes (the plan write, the recovery commit) is what the journal keeps.
- **G4.** One command starts everything: `witness drive` in a terminal, or `/witness` in a chat session. Witness then starts every session itself and works on independent specs side by side.
- **G5.** Witness is faster:
  - per-step test evidence takes seconds;
  - a gate's review time is close to its slowest reviewer;
  - revise rounds converge.

**Success, measured on fewhats:**
- zero human replies outside the kept stops across a full effort;
- the start-to-merge median for a plan well under today's 16.5 h (the designer's target is under 4 h);
- no flow runs past its caps without being parked and reported.

## 4. Non-goals

- **Choosing what to build.** Witness builds what it is asked to. Picking the next feature from a PRD or a backlog is out of scope.
- **Changing witness's evidence rules.** These all stay unchanged:
  - red→green witnessing;
  - CLI-run reviewers;
  - the append-only journal;
  - the CLI as the sole writer;
  - re-entrancy.
- **Removing the human-driven path.** Autonomy is opt-in per repo. Other consumers, such as KYC and hear-your-customer, keep today's decision behavior unless they turn it on. They still get Part C and the `checks-failed` recommender fix.
- **Running anywhere but the user's machine,** such as the cloud or CI runners.
- **Improving plan quality.** Delta review and caps contain the loop when a plan fails at implement. They do not make the plan critic better.
- **Bigger session slices.** This was proposed in chat and dropped after E7 (see C4).

## 5. Anti-goals

Any of these would be a failure, even if the result technically works.

- **The coding agent deciding about its own work.** The agent that wrote the code never selects a disposition. Witness's adversary model (D48, D127) stays intact.
- **Silent decisions:** any disposition without a journal record of who decided and why.
- **Irreversible acts without a human:**
  - no autonomous `abandon`;
  - no deleting work;
  - no merging on red or pending CI.
- **Runaway loops:** an unattended run burning usage overnight on a flow that will not converge.
- **Agent-written commands running unattended** before a human has ever read them.
- **Asking anyway:** option lists, "say go and I'll …", or "worth a decision rather than me quietly …".

## 6. Constraints

- **Witness doctrine that holds:**
  - the CLI is the sole writer;
  - verdicts are CLI-witnessed (D48);
  - one rule applies across surfaces, chat and drive alike (D143's precedent);
  - rule tables are first-match and journal the id of the rule that matched (D121);
  - deferrals are a ledger (D122);
  - a stop parks its flow (D124);
  - the judge harness is resolved as D105 specifies;
  - a repo-global lock guards state writes (D76).
- **Both harnesses:** pi (the user's) and Claude Code.
- **Usage limits:** the user's model access is a subscription through pi's OAuth adapter, so limits ("session limit", 429) happen. An unattended run waits them out; they are not a failure.
- **Sleep:** the machine is a macOS laptop, and sleep kills long runs (see the README's operator notes).
- **Step budget:** D79's budget stays at 3, because it was measured against context growth.
- **D168:** the pin-resolution data loss on abandon/return is still owed. Autonomy never abandons, so this work does not widen D168's exposure, and it must add no new abandon path.
- **House rules:**
  - branch off `main`;
  - write tests first and watch them fail;
  - no commas in new CLI output text;
  - one DESIGN.md row per decision;
  - release with `pnpm release`.

## 7. Design

### Part A: Autonomy (who decides when nobody asks the human)

**A1. Opt-in per repo.**
- A committed, repo-level setting turns autonomy on. The default is off.
- `--manual` on a run still forces every gate to stop for the human, for that run.
- The CLI states that autonomy is on, and lists the kept stops, wherever a skill reads its position: `next`, `start` and gate output. Skills learn it from CLI output, never from memory.

**A2. The decision policy.**
- The CLI already computes a ranked, journaled recommendation for every stop it produces:
  - `src/recommend.ts` for gates;
  - `readyChoice` in `src/verbs/next.ts` for the choose block;
  - `recoverChoice` for a crashed write.
- Autonomy changes only who acts on it.

**Dispatch order.** The order below matters because recommender rules overlap. A design stop with only non-blocking findings, for example, matches `non-blocking-only` before `reserved-stop-clean` (E8).
1. **Kept stops first, keyed by gate or refusal, not by rule.**
   - Design's standing stop with clean evidence goes to the human, whatever rule matched. Clean means green checks and no blocking finding. With blocking findings or failed checks, the rule table applies first, so the critic's rounds stay autonomous (A6).
   - A trust-blocked command goes to the human.
   - An unmet plan need (A10) goes to the human.
2. **Standing stops with clean evidence go to the arbiter.** These are ship's standing stop, and decompose's feature-scope stop or fix-creates-spec stop. "Clean" means green checks and no blocking finding, whether there are zero findings or only non-blocking ones.
3. **Everything else follows the rule table below.**

**Failed checks.** A failed deterministic check is never approved by the policy. The recommender gains a `checks-failed` rule, ahead of `non-blocking-only`, that recommends revise with the prefilled "failed checks: …" note.
- This also fixes a bug that exists today in every repo: these runs fall through to `manual-stop`. That rule recommends `--approve` and claims the stop came from `--manual` (E8).
- Under autonomy, failed checks route by kind:
  - **trust-blocked command:** the kept trust stop;
  - **criterion held by an unmet need:** not a failure at all (A10);
  - **`amendment-ack`:** approving is the acknowledgement here, so it goes to the arbiter, judged against the ask and the recap;
  - **anything else** (drift lane, tests, lint, regression, goal coverage): revise, and the stage fixes it.

| Stop today | Under autonomy |
|---|---|
| Failed deterministic checks with no blocking finding (new `checks-failed` rule) | Routed by check kind, as described above. |
| Blocking findings inside the artifact (`blocking-here`) | The CLI takes its recommendation: revise, with its prefilled note. The stage skill fixes. |
| Findings that implicate the stage above (`blocking-parent`, `anchor-recurrence-N`, `bound-recurrence`) | The CLI takes its recommendation: revise upstream. |
| Non-blocking findings only | The CLI takes its recommendation: approve. |
| Stale verdict below the bound, or a malformed battery | The CLI takes its recommendation: re-run the gate. |
| Crashed write transaction (the recovery fork) | The CLI takes its recommendation. |
| Several specs ready to plan (`choose:`) | The CLI takes option 1, or the top N with parallel flows (B3). |
| Round budget spent (`bound`, `bound-stale`) | Arbiter. |
| Ladder spent (`ladder-spent`) | Arbiter. It may park or override, never abandon. |
| A finding contradicts a policy pin | Arbiter. |
| Reviewers ran on a substitute model (the fallback standing stop) | Arbiter. |
| Ship's standing stop with clean evidence | Arbiter. It judges whether this change should exist, against the effort's recap. |
| Decompose's feature-scope stop, or a fix that creates a spec | Arbiter. It judges the slicing against the recap. |
| Design's standing stop (the look) | Human. Kept. |
| Unmet plan need (`needs-unmet` at `start`) | Human. Kept. Only that plan waits (A10). |
| A spec's manual need, unmet | No stop. The criteria it names are held, not failed, and the need is reported (A10). |
| Untrusted command (trust grant) | Human. Kept. |
| Merging the PR | Witness merges it once the ship gate is approved and CI is green (A7). |

**A3. The arbiter.**
- It is a new reviewer lens that the CLI launches the same way it launches gate reviewers. That is the judgment lane of D48 and D88:
  - the repo's judge harness;
  - the `gates.model` pin;
  - hermetic flags;
  - a vendored prompt.
- **Input:**
  - the CLI-rendered block;
  - the gate run it is about: checks, findings and their claims;
  - the target's round history: prior decisions, recurrences, open obligations and pins;
  - for ship and decompose, the effort's recap and the spec.

  It never sees the coding session's transcript or narration.
- **Output:** one option from the block, plus a reason, as structured JSON that the CLI validates.
- **Its menu** is the block minus `witness abandon` and minus any trust-granting form.
  - It also loses every approve form, plain or `--override`, whenever a deterministic check other than `amendment-ack` failed. **The arbiter may overrule a reviewer, never a deterministic check.** At the bound with a failed check, it can revise upstream or park.
- **Placeholders:** the arbiter may fill exactly one, the `--note` text, with its reason. The note is journaled as written by the arbiter, so the re-authoring session learns why it was sent back.
  - The note is input for the author, not for any gate predicate. D121 and D143's rule therefore still holds: nothing a gate consumes binds to model-written text.
  - The arbiter never fills an id. Options whose ids the CLI cannot resolve are not offered.
- **Malformed output** gets the same single self-repair reroll that gate lenses get. A second failure leaves the stop standing, and the stop is reported as a parked flow.
- **Overrides:** the arbiter may take `--approve --override`. That mints the D122 obligation exactly as today, and open obligations appear in the run report.

**A4. Where decisions execute.**
- Decisions execute in the CLI, at the moment the stop is produced:
  - at the end of `witness gate`, for gate stops;
  - in `next`, for the choose block and the recovery fork.
- A pending decision that `next` finds under autonomy is resolved by the same policy. That covers a decision left pending by a crash, and decisions that were waiting when autonomy was turned on.
- The same rule therefore holds in a chat session and under drive.
- The coding agent never types `decide` under autonomy. `witness decide` stays the human's verb, used at kept stops or by a human who wants to step in.

**A5. The record.**
- Each autonomous disposition journals:
  - who decided (policy or arbiter);
  - the rule that matched;
  - the option taken;
  - for the arbiter, its reason and the model and prompt identity it ran under.
- Every reader that treats a decision as a disposition treats these exactly like a human's decision. That includes round accounting, the parked and settled predicates, `--show` and `status`.
- `witness status` and the run report show the counts and the most recent decisions.

**A6. Brainstorm and design under autonomy.**
- **Brainstorm** answers one ask (A9):
  - drafts the scope recap from the ask plus the repo (existing canon via `witness index`, and product docs), with no interview;
  - writes its assumptions down as constraints and non-goals;
  - persists the recap with `witness recap`, which records the ask it answers.

  The recap is then checked against the ask (A9). If there is no ask at all, there is nothing to build, and witness reports that.
- **Design:**
  - authors the look itself, with no directions-and-converge interview;
  - runs the design critic's rounds under the policy above;
  - then stops for the human, with the look ready to open.

  The human approves, or sends a note with `witness decide design <spec> --revise --note "…"`. The next round is autonomous again.
  - The autonomous critic rounds run without the sight precondition. `decide design --approve` keeps it, so the human still sees the look before it is approved. This amends D72.
  - A look re-armed by a spec amendment is always the human's stop. The session never runs `--reconfirm` on its own judgment; fewhats has had 3 reconfirms.

**A7. Merge.**
- Under autonomy, once the ship gate is approved and CI on the PR is green, witness merges the PR itself. It uses the repo's merge style; fewhats uses merge commits, 22 out of 22.
- Witness never merges in these cases:
  - CI is red or pending;
  - the ship approval lapsed, because a rebase moved the content (D75);
  - GitHub refuses, for example because of branch protection;
  - the PR reports no CI checks at all. Witness merges only on green CI, and says so.

  Each of these goes back through the gate, or into the run report.
- The lazy merge stamp then finishes the lifecycle, as it does today.

**A8. The prompts.**
- Under autonomy, the engine and the six skills drop "end your turn and ask". The agent makes the call, records it in one line, and continues. Plan deviations work the same way: "the plan says X; doing Y because Z".
- The agent stops only at what the CLI names as a kept stop.
- Because the CLI states autonomy and the kept-stop set in its output, the prose needs one conditional per skill, not a second copy of each skill.

**A9. The ask is state.** Today brainstorm runs only when no effort is live (`src/verbs/next.ts:615`), and the recap has no field for what the human asked (`src/verbs/recap.ts:14-21`).
- The human's ask becomes a journaled entry, added by a new verb and also by `witness drive` and `/witness` when they are given text.
- Asks queue. `next` gains a rung, tier 3 (start new work), that routes the oldest unanswered ask to brainstorm, so a new ask doesn't have to wait for other efforts to finish.
- The headless brainstorm reads the ask from the CLI, never from its prompt, so a crashed session loses nothing.
- Under autonomy, nobody confirms the recap. So `witness recap` runs the arbiter on the recap against the ask before the effort is born, for every class.
  - The arbiter checks the class explicitly. A feature misread as a fix or a chore would skip the design stage, and the design stage is the user's one kept look.
  - A rejected recap goes back to brainstorm with the arbiter's reason, bounded like any round.
- The decompose arbiter also receives the ask.

**A10. Needs.** Today only a plan's own needs block anything (`src/verbs/start.ts:97`). A spec's needs only appear on the dashboard.
- **Plan needs keep blocking their plan's start.** That plan waits at a kept stop, and drive moves on to other work.
- **A spec's manual need never blocks building or shipping.** It may name the criteria it holds: `holds: [<criterion-id>]`.
  - While the need is unmet, a held criterion reports `held: <need>` instead of failing, at every gate and in drift checks.
  - The run report lists the need, with its `witness satisfy` command.
  - Once the need is satisfied, the held criteria run normally and must pass. A failure then is ordinary drift.
- This matches the user's own call in the logs: "ses prod access in review … so atm can't we proceed without these???". signin-email-code shipped five plans with `ac-baseline` failing, through 33 gate runs (E8).
- **Satisfying a need must not look like a content change.** Today `needs[].satisfied` is part of a spec's content sha (`src/sha.ts:3` excludes only top-level `status · drift · pr · design`). So `witness satisfy` queues a new plan, and re-arms a ui spec's design, for no change in behavior.
  - Satisfying a need is a human assertion about the world, so `witness satisfy` journals it (`need-satisfied`), the same way D122 makes a debt state, and never rewrites the spec.
  - The frontmatter flag stays as legacy input.
  - One judge, `needMet`, reads both the flag and the journal.
  - No content sha moves, and nothing re-keys. None of the roughly 20 stored-sha comparison sites changes, and neither does the pin resolution D168 is about.

### Part B: Autopilot (`witness drive` runs everything)

**B1. Entry.**
- Two ways in:
  - `witness drive` in a terminal;
  - `/witness` in a chat session, which under autonomy starts drive in the background and ends its turn by saying where to watch.
- Under autonomy drive asks no decision questions, so it needs no terminal. The TTY requirement applies only when autonomy is off.
- D145 got a recursion guard from the TTY rule: "agents are what drive spawns, never what spawns drive". That guard moves to an explicit marker drive sets on every child. A child that carries the marker is refused.
- Only one drive runs per repo at a time.

**B2. The loop.**
- The loop stays as D145 built it: derive, spawn a fresh headless session in the action's home, re-derive.
- Two things change:
  - decisions are resolved by Part A instead of the `decide>` prompt;
  - conversation stages (brainstorm, design authoring) run headless under A6 instead of yielding to the human.
- Kept stops do not end the run. Drive keeps moving every flow they don't block.

**B3. Side by side.**
- Up to N flows run at once, each in its own worktree session. The designer's default is 2.
- D73's most-advanced-first ordering still drains work toward merge.
- When a flow waits on a kept stop, drive starts the next ready one.
- State writes wait briefly for the repo lock instead of refusing at once. The write window is about 100 ms (D76).
  - Planning B found that `test-evidence` held the lock across the whole suite (`src/verbs/evidence.ts:34-52`). The lock now wraps only the write.
- Test runs take turns across worktrees: every command witness runs (evidence, gate checks, ship lanes) waits its turn.
  - fewhats's e2e boots servers and browsers, so two suites at once can collide, and a collision costs a round.
  - With the filtered runner, taking turns costs seconds. `drive.parallelSuites: true` relaxes it.
- Two settlers racing one stop journal exactly one decision, because `applyDecision` re-reads the journal under the lock.
- Parallel PRs rebase and re-gate through ship's existing machinery.

**B4. Surviving unattended.**
- A usage-limit error, whether from a session or from a reviewer call, waits and retries instead of ending the run.
- Drive keeps the machine awake while it runs.

**B5. Caps.**
- Each flow has hard limits:
  - gate rounds across budget resets;
  - upstream resets;
  - spawns;
  - wall-clock time.
- A flow that hits a cap is parked, with the cap named, and reported.
- For calibration from fewhats: merged plans stayed at or under 13 implement rounds, apart from two that ran 20 and 63. The abandoned thread-mirror-plan-1 ran 25, and thread-mirror-tap-plan-1, still open, is at 14.

**B6. Coming back.**
- When nothing else can move, drive ends with one report:
  - what merged;
  - what waits on the human, each item with its exact command: screens to open and approve, needs to satisfy, commands to trust;
  - what was parked, and why;
  - obligations opened by overrides;
  - how many decisions the policy and the arbiter made.
- It also fires a desktop notification. That is a machine-local setting, and the platform notifier is the default.

### Part C: Speed

Part C applies to every repo, because it is gate mechanics, not a mood. The `checks-failed` recommender fix in A2 also applies to every repo. Parts A and B are opt-in.

**C1. fewhats switches to the filtered runner.** This one is a consumer setting, outside the witness build: no witness plan touches fewhats. It is a one-line change in fewhats's `witness.config.yaml`, plus one trust grant, made whenever the user chooses.
- The new setting is `criteria.runner: 'pnpm test -t "@spec:{id}($|[^a-z0-9-])"'`, keeping `report: "junit:reports/junit.xml"`.
  - The pattern is anchored so that a spec id never matches a longer id that starts with it: thread-mirror versus thread-mirror-tap (E6).
  - The residual, recorded in DESIGN.md: filtered-mode criteria are judged by exit code, so a template that over-matches would fail the wrong spec's lane.
- Per-step evidence goes from about 9 min to 13–48 s (E6).
- The whole suite still runs once per ship gate (`ship.test`), so nothing ships on a suite that only ever ran in slices.
- This is a config change in the consumer, made and verified there. It needs no witness code.

**C2. Parallel reviewers.**
- The gate launches its lenses concurrently, so a round's wall-clock time approaches its slowest lens.
- The journal keeps verdicts in lens order.
- Per-lens timeout, reroll and model-fallback rules keep their meaning. That includes the D106/D107 rule that a round is identified by the model it asked for.

**C3. Delta review from round 2.**
- Round 1 of any gate is a full review, as today.
- From round 2 on, each lens also receives:
  - the previous round's blocking findings;
  - the diff since the content the previous round reviewed.

  It is asked whether each prior finding still holds, and whether the changed parts are sound.
- **On the code gates only (implement and ship),** the CLI then applies one mechanical rule. Doc gates (plan, decompose, design) get the delta context but no demotion, because no later full review of the same artifact backstops them. A blocking finding qualifies when both hold:
  - its anchor was not reported in the previous round;
  - it sits in a file or section unchanged since the previous round.

  Such a finding is recorded as non-blocking ("demoted — unchanged since round N"), journaled, and shown in status.
- Ship's first round is always a full review. It is the backstop for anything a demotion let through.
  - Ship runs fewer lenses than implement, so it also receives the plan's demoted implement findings, solicited the way open deferrals are. A demoted finding that still holds blocks at ship.
  - Findings anchored in context (the parent spec, canon) are never demoted.
- This rule is what makes rounds converge (E5): once the prior findings are fixed and the fix is sound, the gate passes.

**C4. Not doing: bigger session slices.**
- This was proposed in chat, then dropped on the evidence (E7). Slices end early far more often than they use up 3 steps, and D79's context measurement still holds.
- Under drive, a relay costs no human time anyway.

## 8. Build order (designer's call)

Each step is its own plan and release.

C1 is not a build step: it is fewhats's own setting (see C1), and the plans touch only witness.

1. **Wave 1, C2 and the `checks-failed` recommender fix:** parallel reviewers, plus the fix that stops recommending approve over a failed check. Both are small, self-contained witness changes.
2. **A1:** autonomy's decisions, the merge and the prompts (A1–A5, A7, A8). It removes most stops even in chat sessions, before drive changes at all.
3. **A2:** autonomy's intake (A6, A9, A10): the ask, the recap check, design without the interview, needs `holds`, and the satisfy fix.
4. **B:** drive as autopilot. It builds on A1 and A2.
5. **C3:** delta review. It changes gate semantics and needs calibration fixtures, so it gets its own rows.

Wave 1 also carries a pre-existing fix found while planning C3. The deferral block told reviewers that silence reads as "still present", while the gate discharges on silence (`src/deferral.ts:55`). The block now states the gate's rule.

Plans: `docs/superpowers/plans/2026-10-19-autopilot-{wave-1,A1-decisions,A2-intake,B-drive,C3-delta-review}.md`.

## 9. What changes in DESIGN.md

- North star 3 gains the delegate: "Evidence, then a decider: a human, or the repo's declared policy and arbiter."
- The pipeline table's standing stops (ship, decompose feature scope, design) gain their autonomy behavior.
- Amended rows:
  - D82 and D145: the stop set;
  - D127 and D143: "the agent types, the human decides" (under autonomy nobody types, and the CLI acts);
  - D154: trust stays human.
- D79 is cited and unchanged.
- New rows get numbers when they are written. D168 is already owed for pin resolution.

## 10. Left to the builder

- The name and shape of the config setting or settings, and how the merge style is configured or detected.
- The journal shape for autonomous decisions: a new entry kind, or a new field on `human-decision`. Either works, as long as every disposition reader treats them identically (A5).
- The arbiter's prompt wording, output schema and calibration fixtures, including injection twins.
- These numbers and mechanisms:
  - the cap numbers (B5);
  - the lock wait (B3);
  - the backoff policy (B4);
  - the notification mechanism (B6);
  - how chat launches drive in the background (B1).
- How "unchanged since the previous round" is computed for each gate kind (C3), and the delta-mode calibration fixtures.
- Whether drive nudges a headless child that asked a question instead of acting, before declaring no progress.
- The ask verb's name and shape (A9), and the bound on recap re-drafts.
- The name of the need-to-criteria link, `holds` (A10), and how `held` renders in check rows and the drift report.

## 11. Calls made by the designer, not the user

1. Trust grants for agent-written commands stay a human stop (security), even under autonomy.
2. The arbiter never abandons. It may override, which mints an obligation.
3. Brainstorm runs without an interview under autonomy, starting from the human's ask.
4. Design authoring runs without the directions interview. The human sees the finished look once per round.
5. The parallel default is 2 flows.
6. Bigger session slices were dropped (E7), although the user liked the idea in chat.
7. C1 is a fewhats config change, not witness code. It is left to the user, and the plans never modify fewhats: they only read it, through a throwaway clone, for the release check.
8. The build order in §8.
9. The success target: a plan start-to-merge median under 4 h on fewhats.
10. A failed deterministic check is never approved by the policy, and never overridden by the arbiter. Such a flow is fixed, re-planned, or parked.
11. Kept stops and standing stops are dispatched by gate before rule (A2).
12. The arbiter may write the revise note, but never an id.
13. The ask becomes journaled state, and under autonomy the arbiter checks every recap against its ask, including the class (A9).
14. A spec's manual need holds only the criteria it names. It blocks neither building nor shipping (A10).
15. Part C and the `checks-failed` fix apply to every repo. Only A and B are opt-in.
16. A is split into two releases, A1 (decisions) and A2 (intake).
17. A second malformed arbiter answer parks the flow.
18. Witness never auto-merges a PR that has no CI checks.
19. A look re-armed by a spec amendment is always the human's stop.
20. Delta-review demotion applies to the code gates only. Ship round 1 also receives the demoted implement findings.
21. Satisfying a need is journaled instead of rewriting the spec, so the content sha never moves.
22. The deferral-block fix rides in wave 1.

## 12. Risks

- **Arbiter judgment is uncalibrated at first,** because fewhats's calibration matrix is empty by decision. Its decisions are audited through the journal and the run report.
- **Delta review can let a real defect in unchanged code reach ship.** Ship's full first round is the backstop.
- **Parallel flows multiply model usage.** B4's waiting absorbs the limits, but slows the run.
- **Auto-merge is only as good as the repo's CI.**
