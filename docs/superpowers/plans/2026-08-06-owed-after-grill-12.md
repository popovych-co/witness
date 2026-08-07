# Owed after grill #12 — handoff

Written 2026-08-06, end of the session that produced DESIGN rows 93–101 and shipped the
0.5.2 half of them. Everything here is **not done**. Read `DESIGN.md` rows 93–101 first —
they are the spec; this file is the worklist and the traps.

---

## 1. State right now

| Thing | State |
| --- | --- |
| Branch `statement-honesty-0.5.2` | 11 commits, pushed |
| PR [popovych-co/witness#3](https://github.com/popovych-co/witness/pull/3) | **open, CI green (`test` 3m17s), not merged** |
| `package.json` | bumped to **0.5.2**, 9 payload files restamped via `npm run sync-versions` |
| npm | **not published** |
| Suite | 104 files, 759 tests green (baseline was 739) |
| DESIGN rows 93–101 | written, and row 100 already carries its implementation correction |
| DESIGN rows 95, 96, 97, 98b–d | written as prose, **zero code** |

Remotes are easy to get wrong here: **`origin` = `popovych-co/witness`** (current).
`old-origin` = `KostiantynPopovych/specflow` (pre-rename, dead). `git remote -v | head -2`
shows only `old-origin` and will mislead you — it did me.

---

## 2. Owed: merge and publish 0.5.2

1. Merge PR #3 (human's call — the CLI's own doctrine is that merging is never the agent's act).
2. `npm publish --otp <code>` — publishing **always** needs the OTP.
3. **Cold-verify from outside the repo.** Running `npx @popovych.co/witness@0.5.2` inside
   this checkout resolves the local project and gives a false pass. Verify from `/tmp`.
4. Check the plugin marketplace copy in **both scopes** if you distribute that way.

---

## 3. Owed: the 0.6.0 half

Four rows. They change **what passes a gate**, which is why they were split from 0.5.2.
Build them on their own branch with a fixture pass. Each already survived two adversarial
audits — the corrections below are the output of those audits, and skipping them
reintroduces defects that were caught before they shipped.

### Row 96 — reviewed identity is the diff the battery read

- `reviewedSha` becomes a hash over **the base commit + the sorted `(path, blob-sha)` pairs
  of `changedFiles(wt, base)`** — exactly what `promptBody` renders. Replaces
  `worktreeTreeSha`'s whole-worktree `add -A` / `write-tree` (`src/reviewed.ts:11`).
- **The base term is required.** Without it, a rebase that changes the diff *text* while
  leaving blobs identical replays a cached verdict, and implement loses the rebase
  re-arming it has today. `merge-base(HEAD, main)` is the fork point and does **not**
  advance when state commits land on main — verified.
- Deleted paths need an explicit marker or the hash throws.
- **Second rule, same row:** an `origin/main` advance whose commits **all touch only state
  paths** is not base movement. Both `shipPhase`'s `baseMoved` (`src/ship.ts:182`) and
  `rebaseIfMoved` use one path-based predicate (`isStatePath`); the `Witness-State`
  trailer is a secondary signal so a forged commit falls on the conservative side.
  Without this, the re-gate churn survives the sha fix — `shipPhase` re-gates on
  `baseMoved` regardless of any hash.
- Safe because the worktree's copy of `specs/`, `plans/` and `.witness/` is never review
  input: ship reads the parent spec from the **root** canon, and the drift lane runs spec
  content from main with execution in the worktree.
- **Migration:** every existing verdict goes cold once — each in-flight flow re-gates one
  extra time on upgrade. Accepted, not migrated.
- **Consequence to record:** this retires the *first* of the two justifications in
  `src/gates/ship.ts:59-65` for ship's sha-blindness (the `pr` stamp can no longer enter
  the reviewed set). The second still stands. Re-argue that comment or a future reader
  preserves a rule whose stated reason is dead.

### Row 97 — `evidence` / `regression` split

- `evidence` keeps the parent's red→green, still from tags on **added lines**.
- `regression` covers every other spec whose tests the diff touched, derived from the
  **current content of the changed test files** — not `diffTags`' added-lines rule.
  Added-lines detection would have missed the report's own `@spec:report-view` case.
- Run `runSpecTests` once per spec, **memoized** (in filtered mode `runCriteria` runs the
  template once per *criterion*, which is already redundant); reuse one suite run in
  full-suite mode.
- **`filter-matched-nothing` must degrade to a failed check, never a `Result` refusal out
  of `resolve()`** — a refusal there aborts the whole gate and creates a fresh
  unescapable dead end, the exact bug class this pass exists to remove. Follow
  `runCriteria`'s shape, which never aborts.
- Skip deleted test files; a tag naming a spec absent from canon is reported as unknown,
  not run.
- Do **not** run full `runCriteria` for foreign specs — it executes their `cmd` criteria
  (arbitrary trust-gated commands) inside an unattended gate.

### Row 95 — reopens must route, re-authoring must not end the flow

- `flowAction` consults `openReopen(entries, 'plan')` before routing to implement.
- **`write` must preserve an in-flight plan's `status`** — `buildPlanMeta`
  (`src/verbs/write.ts:299-310`) hardcodes `status: 'draft'` and carries only `pr`, so
  re-authoring a started plan silently demotes it out of flow-hood and four readers
  (`flowAction`, `flowBlocked`, `dashboard`, `--flow`) start lying about a plan that holds
  a `pr` and a live worktree. Plan-only rule; a re-authored spec still returns to draft.
  `write` also refuses on a `done`/`abandoned` plan. `PLAN_STATUS` already admits
  `in-progress`, so this validates unchanged.
- A **spec** named to `--revise --upstream` resolves to the owning effort and writes the
  decompose reopen onto the **effort** stream (decompose gates are keyed on efforts, so
  today's spec-stream reopen is unreachable by every reader).
- **The split that keeps parts 1 and 2 from cancelling:** a reopen on the plan's **own**
  plan gate is routable motion and must **not** enter `flowBlocked`; a reopen on the
  **parent's decompose** must. Put a blanket reopen term in `flowBlocked` and the flow is
  stranded — tier 2 needs a pending decision, the bound loops don't fire, the plans-first
  loop is draft-only, the start loop is approved-only, and the ladder ends at
  `witness check`.
- Implement re-arms on a **plan-content sha**. `canonicalSha` already strips
  `status`/`pr`/`design`/`drift`, so the only field to exclude on top is
  **`derives-from`** — ship's own `repin` rewrites it inside the same transaction as the
  gate run, which would self-invalidate exactly like row 96's bug.

### Row 98b–d — the calibration matrix

- Ship a populated `calibration.yaml`. It is **not a label**: `resolveModel` builds
  `chain = [pin, …calibrated, SESSION_DEFAULT]`, so publishing one changes the fallback
  ladder for every user.
- Therefore: a round whose verdict came from a **fallback** model carries a standing stop
  and cannot pass on its own. Compose it where `standing` is composed
  (`src/gate.ts:315-318`) — fallback is not knowable at `resolve()` time. Cached rounds
  replay without it, correctly.
- Blocked on `witness calibrate` being trustworthy enough to publish — see the
  `decompose`-row noise in DESIGN's Open/deferred, and the absence of retry on transient
  invocation failure.

---

## 4. Owed: reply to the downstream report

`know-your-customer-mvp/docs/witness-issues.md` is still unanswered, and its author is
blocked on 0.5.2 landing. They deserve an issue-by-issue disposition, including the four
**refuted** diagnoses (all recorded in DESIGN rows 93, 96, 99, 101):

1. `--override` never governed deterministic checks.
2. `--fresh` never reset the round counter or bypassed the bound.
3. The two ship rounds that "found different things in the same code" reviewed different
   shas — `3fc3d4a` vs `47cbccc`.
4. `check` vs the dashboard was two different verbs, not a cwd bug.

---

## 5. Traps for whoever picks this up

- **Test commands.** `npx vitest run tests/<file> --poolOptions.forks.maxForks=4`. The
  fork pool IPC-times-out under full concurrency on this machine — the error reads
  `[vitest-worker]: Timeout calling "onTaskUpdate"` and is a flake, not a failure.
  Redirect long output with `>`, never pipe to `tail`.
- **`rm -rf .witness/worktrees` before every full-suite run.** A leaked nested worktree
  drags fixtures into a root-level run and produces false failures.
- **`gate-engine.test.ts`'s synthetic gate is once-guarded.** Calling
  `repo.cli(['decide', …])` in that file imports `gates/index.js`, registers the real
  `plan` gate over the synthetic one, and poisons every later test in the file. Settle
  gates there with a passed `runGate` instead. (`decide.test.ts`'s `synthetic()`
  re-registers per call, so it is safe there.)
- **`stoppedGate()` in `decide.test.ts` targets the spec id `auth-refresh`** through a
  synthetic *plan* gate — not a plan id.
- **`currentSha` returning `undefined` means "cannot compute", never "moved".** Both the
  revised-anchor rule and `--show`'s staleness line depend on that; inverting it silently
  disables them.
- **The bound outranks staleness in `liveExits`.** At the bound the gate short-circuits
  and will not run again, so a moved sha must not route to `witness gate` — it only
  removes approve from the endgame. Learned by breaking it in this session.
- **Audit the fix, not just the bug.** Four of the nine 0.5.2 decisions were wrong in
  their first form and were caught only by re-auditing the proposed fixes: a blanket
  `flowBlocked` reopen term, a `write` that demoted a live flow, a two-branch phase rule
  routing to a verb that refuses, and a `--show` branch pointing at `changed-nothing`.
  Every one would have shipped a new dead end of the class being removed.
