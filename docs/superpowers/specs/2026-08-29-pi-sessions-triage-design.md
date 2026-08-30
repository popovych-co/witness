# Triage design — pi-sessions field report 2026-08-29 (rows D137–D156)

**Input:** `know-your-customer-mvp/docs/pi-sessions-report-2026-08-29.md` — forensics over 210 pi sessions, 119MB, 2026-07-31 → 2026-08-30: $2,223, 84.6h active agent time, 1,744 commits, 13 features. Headline: a feature is 2–7h of agent work and 5–12 calendar days; ~90% of calendar time is human latency.

**Method:** every load-bearing claim was verified against 0.13.0 by probe (file:line) or experiment (scratch-repo reproduction) before any row was written. Two probe readings fell to experiment and are recorded in Refutations. Third field report from this downstream repo (after 0.5.1 → grill #12, 0.6.0 → grill #13); first one measuring economics rather than defects.

---

## Verified evidence base

### E1 — Git divergence (report killer #2), mechanism traced and reproduced

Two defects compound:

1. **Drift is invisible and reconciliation is manual.** State commits land on whatever branch the primary root has checked out (`gitio.ts:118-155`; no branch resolution anywhere in `src/`). The sole push path is `witness sync` (`verbs/sync.ts:47`) — and `sync` is advertised in zero driving surfaces: grep across `next.ts`, `check.ts`, `dashboard.ts`, `recommend.ts`, the engine command, and all six skills returns nothing. The post-merge lazy stamp then writes one more local-only commit (`stamp.ts:110`) at the exact moment origin/main advances. Local main drifted ahead 54 → 148 → 165 commits over the report window.
2. **Contamination turns drift unrecoverable.** `start` cuts the plan branch from the *local* ship branch with no fetch (`verbs/start.ts:36` → `worktree.ts:183`; no fetch in either file). When local main is ahead, the plan branch inherits the unpushed state commits; the PR carries them; squash-merge collapses them into a foreign commit on origin/main. **Reproduced by experiment:** in that shape `git pull --rebase` (what `sync` runs) conflicts in the journal file on the first replayed state commit and exits 1. Clean state-only drift, by contrast, rebases fine — including under `pull.ff=only` (second experiment).

The 8 pasted `fatal: Not possible to fast-forward` incidents were **user-run `git pull`** under the downstream repo's `pull.ff=only` config (verified set), against a divergence witness manufactured and never surfaced.

Adjacent confirmed defects: worktree removal has no cwd guard (`worktree.ts:192-196`) and fires from `next`/`check`/`dashboard` — including the SessionStart hook's bare `witness` — via the lazy stamp (`stamp.ts:113,126-128`), deleting the directory the session stands in (the ×3 `Working directory does not exist`); the ship skill's manual-conflict recipe rebases the *local* ref (`witness-ship/SKILL.md:53`) where the CLI deliberately uses `origin/<branch>`; the ship reviewer diff base is `merge-base HEAD <local branch>` (`evidence.ts:141-146`), so a rebased worktree can present a sibling's merged work as the diff.

### E2 — Approval treadmill (report killer #1), reframed by inventory

989 human turns, mostly `1`/`y`/`go`. Full stop-surface inventory shows the gates are not the treadmill: a clean single-slice feature costs **~14 human turns, of which ~3 are judgment** (feature scope, ship, merge). The rest are mechanics:

- Cross-home handoffs: `next` prints `run: cd … && claude … '/witness'` + relay line at every home crossing (`verbs/next.ts:797-803`), twice per plan.
- Dispatch relay: implement ends its turn every `stepsPerDispatch` steps (default 3, `config.ts:107`) and the human types `/clear` then `/witness` (`witness-implement/SKILL.md`, `harness.ts:317-319`).
- Affirmation rejection: all six skills rule "a bare affirmation is not a selection" (grep: 6/6; asserted `tests/skills.test.ts:212`) — every `y` becomes `y` → "which option?" → `1`.
- Harness permission dialogs: `install.ts` merges hooks only, no `permissions.allow` for the witness binary — each new command shape raises a harness dialog.
- The engine's `END YOUR TURN` contract is test-asserted (`tests/command.test.ts:28,49`); the green path exists only at the gate outcome (`gate.ts:445-449`) — nothing auto-advances a stage crossing.

Root: **the execution model conscripts the human as its process scheduler.** D82 made sessions fresh-per-slice for measured context-economics reasons, but implemented *fresh* as *human-spawned*.

### E3 — Edit-protocol friction, attribution

103× "Edit without read": the harness rule is inherent, the frequency is witness-amplified — cold relay sessions × symbol-anchored findings (`prompts/code-reviewer.md:54` bans line numbers) × no read-before-edit instruction anywhere in payload. 8× "modified since read" is witness-caused: `verify-red` stashes and checkouts churn files under the agent (`evidence.ts:166-186`), as does `start` re-attach. 40× guard refusals: the guard works as designed; its refusal names a category and three verbs but synthesizes no runnable command (`canon-guard.mjs:205-210`), and `designs/**` is guarded (`canon-guard.mjs:40`) but named in only one of six skills' ground rules. 10× gate refusals: `Violation = {field, rule, got, want}` has no remedy field; roughly half of `want` texts are descriptive-only. D64's write-refusal telemetry (first-try-valid trend on the dashboard) was never built — the metric this report had to count by hand.

### E4 — Reported bugs vs 0.13.0

| Report bug | Status |
|---|---|
| Wrong `next` recommendation (Aug 1) | fixed — D93 (`cfc0c58`), recommender since replaced (D121) |
| Wrong-stage redirect (Aug 1) | fixed — D92/D116-118/D134 (`aa60bba`); residual: silent cwd flow-scoping, see D153 |
| Didn't proceed after login (Aug 1) | fixed — D89 (`c463dc7`), reviewerExtensions |
| Untrusted runner failed all 4 `ac-*` while drift passed | live — `allowlist.ts:21` blocks on `!isTTY`; trust read from primary root (`gates/implement.ts:150`, `gates/ship.ts:79`) while runner config loads from the worktree (`criteria.ts:30-31`) → D154 |
| Worktree not cut from fresh main (Aug 16) | live → D137 |
| Ship leaves local main diverged | live by design → D137–D140 |
| `Working directory does not exist` ×3 | live → D141 |
| Ship blocked (Aug 24, issue #18) | live — regression from D132 → D151 |

Plus one live defect not in the report: issue #17, the malformed-rerun recommender emits `witness calibrate <model> --only <gate>`, which `--only` refuses for the ship and design gates (`recommend.ts:138` vs `verbs/calibrate.ts:50-63`) → D152.

### E5 — Design churn (report area 6)

The design stage **was** used: 10 `designs/*.html` in the downstream repo, design commits throughout the Aug 20–27 redesign window. Churn happened anyway ("show on ui" ×3; legend and floating button missing on the shipped page — the implement design lens D71 exists to catch exactly that). Which defect — lens miss, capture gap, re-entry UX — is unattributable without session forensics → deferred, D155.

---

## Decisions

### Close the git loop (A1 — root fix; approved over state-off-main A2 and docs-only A3)

**D137 — Worktrees are cut from the fetched remote tip.** `start` runs `git fetch origin <ship-branch>`; the create path cuts new plan branches from `origin/<ship-branch>`, not the local ref (re-attach of an existing branch is unchanged — its base is history). Fetch failure with a remote configured refuses with the git text and remedy — no silent local fallback, which would quietly reintroduce the root. A repo with no remote keeps the local cut (divergence needs a remote to exist). This alone makes squash-merge permanently harmless: plan branches can never carry state commits again, so the reproduced conflict shape (E1) becomes unconstructible.

**D138 — Sync becomes automatic at the two natural moments.** The post-merge lazy stamp runs the sync sequence (pull --rebase + push) immediately after its state commit — the moment origin is known to have moved; `start` preflights sync before cutting. Failure is a printed finding, never a crash; both invocations are journaled. Local main converges without the human knowing `sync` exists. Manual `witness sync` survives unchanged.

**D139 — Divergence is visible state.** `check` gains an ahead/behind/diverged finding against `origin/<ship-branch>` naming `witness sync` as remedy; the dashboard prints the same one-liner. (A user's `pull.ff=only` + hand-run `git pull` can still fatal inside the brief ahead-window; the check line is what explains it, and D138 keeps the window near zero.)

**D140 — `sync` stops lying.** Error classification in `verbs/sync.ts`: no-upstream / real rebase conflict (naming the conflicted paths) / other (verbatim git text). The catch-all that renders every non-upstream failure as "rebase conflict — resolve manually" (`sync.ts:42-45`) dies. Extends D114, which fixed one branch of this function and left the other.

**D141 — Worktree removal is cwd-safe.** `removeWorktree` callers (lazy stamp, done-sweep, `clean`, `abandon`) skip a worktree containing the invoking process's cwd and print a relocation line instead; the skipped removal re-runs harmlessly from any other cwd (the done-sweep already re-checks). Kills `Working directory does not exist` at the source.

**D142 — One rebase base, and it is the remote's.** Two halves. (prose) The ship skill's manual-conflict recipe rebases on `origin/<ship-branch>` after a fetch, matching `ship.ts:130-174` — following the current recipe recreates the stale base the CLI just refused. (behavior) `diffBase` for the ship gate resolves against `origin/<ship-branch>`, so a rebased worktree cannot hand reviewers a sibling's merged work as part of the judged diff. The halves ship in different waves (see Release).

### Dismantle the treadmill (B1 approved; interview stays one-question-at-a-time by explicit user choice)

**D143 — A bare affirmation selects the recommendation.** When a decision block carries a `recommended` option, `y`/`ok`/`go` selects it; the `human-decision` entry records `selected: affirmation` so closure-by-nod stays distinguishable from a named selection in the journal. Naming an option still works; blocks without a recommendation keep the ask-again rule, and so does anything outside a rendered decision block. One rule amendment across the six skills + engine (supersedes the 6/6 "bare affirmation is not a selection" bullet in the recommended-option case).

**D144 — Install writes the harness allowlist.** `init --agent claude-code` merges `permissions.allow` entries for the witness binary's invocation shapes (`npx -y @popovych.co/witness*` and the global `witness` binary) into `.claude/settings.json` the same way it already merges hooks (append-what's-missing, `install.ts:178-207`); the pi adapter does the equivalent in its config surface. Scope: the witness CLI only, never a blanket Bash grant. Kills the permission dialogs that were never witness stops at all.

**D145 — `witness drive`: the CLI becomes the scheduler (own effort).** New verb: loop `next` → green-path action → spawn a fresh **headless** session (declared harness's print mode — precedent `harness.ts:130-144`, the calibration worker; cwd = the action's `home`) → stream progress → repeat. Returns to the human terminal only at: judgment stops (feature scope, design, ship, blocking finding, pin contradiction, fallback), refusals with no mechanical remedy, round bounds, and spawn failure. Relay boundaries and cross-home handoffs become drive's spawns; the dispatch budget survives as spawn sizing (`stepsPerDispatch` default 3 unchanged — it was measured against context limits, D79; drive removes its human cost, not its value). All existing bound/budget/obligation machinery binds drive — autonomy cannot outspend the round bound. Decided here: mechanism, CLI ownership, stop set, and that orchestration lives in the CLI rather than skill prose (D128: prose is the most expensive surface). Verb surface, streaming format, timeout policy: its own brainstorm → plan.

### Edit-friction pack

**D146 — The guard refusal emits a runnable remedy.** `reasonFor` synthesizes from the blocked path: `specs/x.md` → the `witness write x --effort <e> --meta <m.json> --body <b.md>` shape, `plans/` likewise, `designs/x.html` → `witness design x`, a committed hand-edit → `witness adopt <path>`. D133 made the guard name the path and its writer; this completes it to the `run:` contract gate stops already honor (D121), under the same no-placeholder runnability test where ids are resolvable.

**D147 — CLI refusals get the same.** `Violation` gains optional `remedy`; `renderRefusal` prints a `run:` line under the `!/<[^>]+>/` runnability test (`recommend.ts:64`). The four descriptive-only `want`s named in E3 (`gates/plan.ts:30`, `gates/implement.ts:90`, `gates/ship.ts:44`, `gate.ts:106`) get filled.

**D148 — Stale reads are announced.** `verify-red` and `start` re-attach print "these files changed on disk — re-read before editing" with the churned paths. Witness stops silently invalidating the agent's read state (the 8× cluster).

**D149 — Ground-rule repairs.** `designs/**` joins the never-edit bullet in all six skills (today 1/6); a read-before-first-edit line joins the shared ground rules — the cold-relay × symbol-anchor combination is what amplified the 103× cluster.

**D150 — D64's promised metric ships.** The write-refusal first-try-valid trend lands on the dashboard. It took a downstream field report to count what the design already committed to display.

### Live bugs

**D151 — Canon anchors resolve at the primary root (fixes #18).** D132 sparse-excludes canon from worktrees, but `resolveCodeAnchor` validates against the reviewed tree (`verdict.ts:118-123,180`), so a reviewer citing the spec or plan it judges malforms the whole round — the counterexample to D132's "no CLI path reads that copy". Canon-path anchors resolve against the primary root (the read route D132 itself established); code anchors keep the reviewed tree.

**D152 — The malformed-rerun recommendation runs (fixes #17).** `recommend.ts:138` emits `witness calibrate <model> --only <gate>`, refused for ship and design gates — a D129 "rendered command runs" violation in the recommender itself. Emit an invocation `calibrate` accepts for every gate.

**D153 — Ambient flow-scoping prints its reason.** Standing in a worktree silently scopes `next`'s whole answer to that flow (`next.ts:774-779` — deliberate ambient-context doctrine, but unprinted; residual of the Aug 1 redirect report). `next` prints the scoping fact (`flow: <plan-id> — inferred from cwd`). Behavior unchanged; statement honesty.

**D154 — Trust is granted where a human is present, consumed where absent.** Headless gates block every untrusted per-criterion command (`allowlist.ts:21`, `!isTTY → blocked`) — the Aug 1 all-four-`ac-*`-fail false-negative. At the interactive moments a human already approves (feature scope at decompose, plan approval), witness offers to trust the spec's criteria commands into `allow.json`; headless gates then run them. The refusal names `WITNESS_TRUST_CMDS=1` as the manual override either way. Also unifies the root asymmetry: trust list and runner config both resolve at the **primary root** (canon-single-home doctrine, D132 — a branch checkout cannot re-point what the repo trusts or runs).

### Recorded, not designed

**D155 — Design churn deferred with cause.** First field evidence against D69–72/D71: the stage was used (10 designs, commits through the redesign window) and churn persisted — "show on ui" ×3, a shipped page missing the approved look's legend and floating button. Which defect (vision-lens miss, capture gap, re-entry UX) is unattributable without session forensics; attribute before designing. Re-measure trigger: next downstream UI effort.

**D156 — The interview floor is a floor.** User feedback: brainstorm currently asks too few questions. The 5-field ladder (`witness-brainstorm/SKILL.md:36-42`) is prose-amended to state the fields are the floor, not the count — keep interviewing while material scope uncertainty remains. One-question-per-turn stays by explicit user choice.

**Refutations (recorded so they are not re-derived):**
- "Same failure ~8 times, never root-fixed": the fatal was user-run `git pull` under `pull.ff=only`, never witness-emitted. But "never root-fixed" stands *stronger* than first read: in contaminated epochs even `witness sync` would have conflicted (reproduced, E1) — advertising sync was never sufficient; only D137 closes it. A probe's claim that `pull.ff=only` breaks `sync` itself was refuted by experiment (explicit `--rebase` overrides it, git 2.50).
- The 40× "witness refusing edits" cluster is the guard *working as designed*; the defect is remedy absence (D146), not refusal.
- Report bugs 1–3 were already fixed at 0.13.0 (D93, D92+D134, D89) — the report window spans versions back to 0.5.x.
- The "approval treadmill" is not the gate design: ~3 of ~14 turns per feature are judgment; the rest are scheduling mechanics (E2). The fix dismantles the mechanics, not north star 3.

**Context, no rows:** the dogfooding tax (35h/$791 MAIN, 42%) shrinks as a consequence of the rows above; nothing to design. The report's KYC-product bugs belong to that repo.

---

## Release waves (house line: does it change gate outcomes)

- **Wave 1 — statement honesty and text, no outcome changes:** D139, D140, D142-prose, D146, D147, D148, D149, D150, D152, D153, D156.
- **Wave 2 — behavior:** D137, D138, D141, D142-diffbase, D143, D144, D151 (changes round outcomes), D154.
- **Wave 3 — own effort:** D145 (`witness drive`), after its own brainstorm → plan cycle.

Waves 1–2 split so a downstream regression in either half stays bisectable; wave ordering follows grill #13's precedent (diagnostics land before the behavior they explain). Exact version numbers assigned at plan time per `docs/RELEASING.md`.
