# Relay cleanup (D192) — row 191's deferred minors

> **For agentic workers:** execute task by task (superpowers:subagent-driven-development); each code change RED → GREEN in the repo's test style.

**Goal:** Close the minors the D191 reviews deferred: one definition of "a red is open", the readings the CLI misnames, a few silent paths, test coverage that pins shipped behavior, small DRY refactors, and an accurate, shorter record. No new feature.

**Base:** `main` at 2ea9041 (0.20.0). **Spec:** `docs/superpowers/specs/2026-10-22-context-fill-relay-design.md` and DESIGN.md row 191 (the shipped record). **Release:** 0.20.1 (patch).

## Global Constraints
- A session never relays mid-red; no loop that never makes progress; unmeasured means today's behavior (spec §2).
- Harness-specific variable names live only in `src/harness.ts`; TOON values are comma-free.
- The adapter core is dependency-free and its copy `plugin-context/hooks/context-core.mjs` stays byte-identical (`node scripts/sync-versions.mjs` refreshes it; the parity test guards it).
- `pnpm test` exits 1 on known worker-RPC timeouts — judge by `Tests N passed` and the `AssertionError` count.
- Commits: conventional, ending `(D192)`.

---

### Task 1: Behavior fixes (each RED first)

1. **One definition of "a red is open"** (`src/steps.ts`, `src/verbs/next.ts` `evidenceRow`). Today the step row, `midRed` and `stepCloseVerdict` read `redInFlight` (the latest genuine red with no passing green after it), while `evidenceRow` decides green-vs-red and its `midRed` from `evidenceForDiff`'s `liveRed`. They disagree on `[red, passing green, failing green]` (only `liveRed` says open) and `[genuine red, vacuous red]` (only `redInFlight` does). Ruled definition: **a cycle is in flight iff the plan stream's latest non-vacuous `test-evidence` entry saw a failure** (a red with a failing test, or a green that did not pass); its step, when one is needed for `--step`, is the tag of the latest genuine red. Every reader (step row, `evidenceRow`'s phase and `midRed`, the verdict) uses it; `evidenceForDiff` keeps its own gate semantics untouched. Tests: both disagreeing shapes now agree (open in both); the legacy shape from D191 (`tagged red s2` → routed untagged passing green) stays closed; a vacuous red after a genuine red keeps it open.
2. **A reading with no window is `no reading yet`, not `malformed`, when its session matches** (`src/context.ts` `readFill`). The Pi adapter writes `{session}` alone when `ctx.getContextUsage()` returns nothing; today the CLI reads `malformed`. Rule: `window` absent is allowed through the shape checks; after the session check, `window` absent (or `tokens` absent / null / 0) → `no reading yet`. A present-but-invalid window stays `malformed`. Tests: `{session: S}` → `no reading yet`; `{session: other}` → `stale`; `{session: S, window: 0}` → `malformed`.
3. **The projection's display agrees with its sum** (`src/slice.ts` `contextLine`). Today `next step ≈ +⌈g⌉%` can print `+4%` beside `17% + next step ≈ 20%`. Show the step as `pctOf(tokens + growth) − pctOf(tokens)` whenever that is ≥ 1, else `+1%` (a positive growth never shows `+0%`). Test: 170,000 + 30,001 on 1M prints `+3%` beside `≈ 20%`; the D191 example (`17% … +5%` / `22%`) still prints.
4. **The step-close report says when it cannot read the config** (`src/slice.ts` `reportStepClose`): `ctx.err('warn: no context line — witness.config.yaml did not load (<first rule>)')`; stdout and the exit code unchanged. Test: a broken config prints the stderr line and no `context:`.
5. **The warning claim is released when the command rejects** (`plugin-context/hooks/context.ts`): wrap `next(e)` so a rejection or throw releases the session's claim before rethrowing. Kit test with a `tool.call` stand-in that rejects.
6. **A quoted key reads a value only in a flow map** (`plugin/hooks/context-core.mjs` `contextLimitOf`; refresh the copy): block style `session:\n  "contextLimit":15` is a YAML error the CLI refuses, so the core returns `undefined` for it. Parity row added.
7. **A chore with an empty diff is told to make its change** (`src/verbs/next.ts` `evidenceRow`, "nothing changed yet — write the failing test first"): on a plan with no criteria step the note reads `nothing changed yet — make the change · a chore owes no failing test`. Test on an all-scaffolding plan.

Commit per item or in two or three logical commits.

### Task 2: Coverage and small refactors (no behavior change)

Pin shipped behavior where only a mutation would notice:
- `next` guards: step routing does NOT apply after an implement gate run (`!implementGated`) — a known plan with an unclosed step and a gate-run gets today's rows; and the `!elsewhere` skip — a session that acted, over the limit, running `next` from the primary root into a worktree flow prints exactly one `relay:` (with its `run:`) and no `context:`.
- Hand-over negatives: the `witness check` row never relays; `decide --approve` and `--stop` over the limit print no `relay:`; `gate` and `ship` under the limit, and unmeasured, print none.
- `readFill` precedence: two reasons pitted against each other (`{session: other, tokens: 200, window: 100}` → `malformed`; `{session: other, window: 100}` → `stale`); `session` missing / empty / non-string, `null` and primitive JSON, negative tokens.
- `stepCloseVerdict` rule order: fill at the limit with a growth → the rule-2 why; growth with unknown progress → `continue`.
- `steps.ts`: a green with an empty `tests` array closes nothing; `step-close` with no plan id refuses; the `log` detail shows `vacuous` / `reconstructed` markers.
- Config (`tests/config.test.ts`): the loadConfig case uses `tmpRepo()`; the non-map test asserts `{ field: 'session', rule: 'invalid' }`; null and array `session` refuse; an unknown key under `session:` is ignored; the want text is pinned; the `%s` title becomes `%j`.
- Drive: after a drive run launched with `measuredEnv(...)`, NO line in any `.witness/journal/*.jsonl` carries `ctx`.
- Prose: the five stage skills' ground-rule warning bullet, the router's `--manual`-across-a-relay sentence and its stop bullet are asserted in `tests/dispatch-economics.test.ts`.

Refactors: export the argv helpers from `src/verbs/evidence.ts` (`planIdOf`, the `--step` reader) and use them in `src/verbs/step-close.ts`; one `handOverIfDue(ctx, opts)` in `src/slice.ts` replaces the root + config + `reportHandover` glue in `src/ship.ts` and `src/verbs/decide.ts`; `streamIds(root)` exported from `src/journal.ts` and used by `sessionActed` (and `effortStreams`); `reportGreen` derives the closed step from one stream read.

### Task 3: The record

- DESIGN.md row 191 trimmed to about 10k characters with no decision lost: drop the Why's "found during the build" restatement (the Choice states each fix with its reason), the full JSON sample and the duplicated P7 forms; keep every decision, residual and probe citation.
- Row 191's residuals: losing the reading is visible (`unmeasured (no adapter)`), while the warning and the unmeasured hand-overs at a revise, a ship exit and `next` are silent; outside implement nothing prints `unmeasured` but `check`.
- Row 134: name the exceptions to "wherever `next` prints no `run:`" (a `witness decide` or `witness check` row, a run handed to drive, a red in flight).
- The legend's "Row 168 stays reserved for the owed pin-resolution fix" — row 168 shipped; correct it.
- New row 192 (`Amends 191`): the unified in-flight definition, the window-absent reading rule, the display rule, the silent paths now announced.
- Comments: `src/steps.ts:18-20` (every chore plan has no criteria step), `src/config.ts:135` (a machine overlay is deferred, not ruled out).
- Implement skill: quote the `slice: own count — …` line whole; "a green that closes no step prints `context:` alone" gains "on a known plan".
