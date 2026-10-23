# Context-fill relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A witness working session ends when the harness-measured context fill reaches `session.contextLimit` (default 20%), or when the next plan step would carry it past, at points where the journal already carries the position.

**Architecture:** Each harness adapter (a Claude Code hooks module, the Pi extension) puts the live reading into every Bash command's environment as `WITNESS_CONTEXT`. The CLI trusts it only when its session matches the harness session variable (a new registry facet), stamps a hashed session and the reading on every journal line through `entryLine`, learns which plan steps are closed from step-tagged evidence and a scaffolding close, and decides at step closes and at hand-over points whether to print `slice: end` or a same-home `relay:`. The adapters also warn the agent once per session when a command finishes over the limit.

**Tech Stack:** TypeScript (NodeNext, strict, `noUncheckedIndexedAccess`), vitest 3, `node:async_hooks` AsyncLocalStorage, Claude Code plugin hooks modules (early-access API; `claude plugin validate|test`), Pi extension API.

**Spec:** `docs/superpowers/specs/2026-10-22-context-fill-relay-design.md` (DESIGN row 191). Every task's implementer reads spec §3–§4 first; §4.x references below point there.

## Global Constraints

- The measure is the harness's own fill. The CLI never counts or estimates tokens and keeps no table of model windows (spec §2 anti-goal "a second token ledger").
- `session.contextLimit` lives in `witness.config.yaml`: an integer from 1 to 100, default **20**. A bad value is refused the way `implement.stepsPerDispatch` is.
- `implement.stepsPerDispatch` (default 3) stays, as the fallback for unmeasured sessions only.
- The contract, verbatim: `WITNESS_CONTEXT={"session":"<harness session id>","tokens":31627,"window":1000000,"percent":3}`. Trusted only if it parses, its `session` equals the harness session variable named by the registry (`CLAUDE_CODE_SESSION_ID`, `PI_SESSION_ID`), and `tokens`/`window` are positive integers with `tokens ≤ window`. Otherwise unmeasured with reason `no adapter` | `stale` | `malformed` | `no reading yet`. The CLI computes the percentage itself; the adapter's `percent` is display only.
- The journal stores a 12-hex-char hash of the session id, never the raw id.
- A session never relays mid-red. The relay mechanism (`relayLine`, `/clear then /witness` · `/new then /witness`) is unchanged.
- Unmeasured means today's behavior, and witness says so.
- No noise outside witness sessions, and none in gate-reviewer spawns (`WITNESS_REVIEWER=1`).
- Adapters fail open: a broken adapter never blocks or breaks a Bash call. On Pi a throwing `tool_call` handler blocks the tool, so every try/catch there is load-bearing.
- The adapter core is dependency-free and imported by relative path (Decision 13; `plugin/hooks/canon-guard.mjs` is the precedent).
- Harness-specific strings live in the CLI and the registry. Skills and the engine file name no relay command (`tests/harness-neutrality.test.ts`).
- No gate consumes the context numbers (row 81's fence, restated by row 191).
- The plugin API is early access: the installed `types/claude-code.d.ts` (the plugin-authoring skill's, e.g. `/private/tmp/claude-501/bundled-skills/2.1.307/*/plugin-authoring/types/claude-code.d.ts`) is the authority over anything this plan says about it.
- TOON values must not contain a comma (`toon.ts` `esc()` quotes them; see `harness.ts:348`). Every line this plan pins is comma-free.
- `pnpm test` exits 1 even when every test passes (vitest worker-RPC timeouts). Judge a run by `Tests N passed` and `grep -c AssertionError`, never by the exit code.
- Commits: conventional style with the row, e.g. `feat(context): … (D191)`. Never `git commit` canon or `.witness/` by hand.

## Plan's calls

Decisions the spec left open (§9) or that the plan adds, made on the user's standing "most architecturally correct" preference. Each is pinned in its task.

1. **Journal stamp through AsyncLocalStorage.** `main` runs each verb inside a scope holding this invocation's `{session, tokens?, window?}`; `entryLine` reads it. Row 116's single funnel keeps its signature, and concurrent invocations in one process cannot cross. Outside a harness session nothing is stamped, so the two exact-shape tests P8 found stay valid unchanged.
2. **Decisions in integer tokens, display floored.** `tokens × 100 ≥ limit × window` decides; `⌊tokens × 100 / window⌋` displays, so a printed `19%` never relays and a printed `20%` always does.
3. **A vacuous red opens no cycle.** Step closure needs a red with a failing test, matching `evidenceForDiff`'s `!vacuous`.
4. **`--step` is required where the CLI can tell it is owed:** on a plan whose progress is known, before its first implement gate run. After that gate (fix rounds) and on legacy plans it stays optional. Without this, one forgotten flag silently turns the plan's step awareness off; with it, untagged evidence before an implement gate can only come from an older CLI, which is exactly what "legacy" means.
   *Amended during the build, 2026-10-22 (Task 5 review):* only on a plan whose manifest has a criteria step. A plan with none has no step a cycle could close, so `--step` is never owed there and its untagged evidence never makes its progress unknown. As first built, `next` routed such a plan an untagged evidence command that `step-required` refused whatever `--step` named.
5. **`next` routes to the next unfinished step** while progress is known and no implement gate has run. **Beyond the spec, flagged for review.** Today a relayed slice's fresh session meets `next: witness gate implement` as soon as the parent tag has one red→green pair (`flowAction`, `src/verbs/next.ts:269-306`, has no step input), so every mid-plan relay gates early. Probed 2026-10-22 at HEAD 962fec1: a three-step plan with only s1's red→green recorded, `next` from the worktree printed `next: witness gate implement auth-refresh-plan-1` and no `stage:` line. Fill-based relays make relays more frequent, so without this the feature multiplies early gate rounds. The escape for a step whose behavior already exists is the existing `verify-red`, which now takes `--step`.
6. **Scaffolding close:** verb `witness step-close <plan-id> --step <id>`, entry kind `step-close` `{artifact, step}`. A second close of the same step prints `already closed`, exits 0 and journals nothing (re-entrancy: killed and re-run must converge).
7. **Hand-overs at a revise and at a ship exit skip the act guard.** It holds there by construction (spec §4.5), and no "ship pass" entry kind exists to test it against (watch-phase ship passes journal nothing). Only `next` and the opening warning test for acts. `runGate` takes `handover: false` from `runShip`, so a ship run prints at most one `relay:`.
   *Amended during the build, 2026-10-22 (Task 7 review):* a ship exit keeps the act guard. A ship pass can journal nothing (`revise owed`, a textual conflict, a decision still awaited, a watch-only pass), and with the guard skipped a session that opened over the limit relayed at `revise owed` forever (reproduced), each fresh session doing the same, and drive would park the flow as no progress. `runShip` hands over with the guard, as `next` does; a revise still skips it, since the decision is the session's journaled act. A pass that runs the gate journals a `gate-run`, so a ship run that ran the gate still hands over once.
8. **Act kinds** (confirmed against every `appendEntry` site): `recap`, `write`, `design-write`, `design-reconfirm`, `gate-run`, `human-decision`, `test-evidence`, `step-close`, `dispatch`, `drift-check`, `adopt`. Everything else is bookkeeping, `status` included.
9. **The opening warning** prints at `start` and `next` while the fill is at or over the limit and the session has no act yet (deterministic; it can repeat on a fresh session's second `next`).
10. **`start` drops `dispatch-budget:` and `dispatches:`** for `slices:`, `steps:` and `context:`; the plan gate's `dispatches:` becomes `slices:`.
11. **Install route:** the claude-code payload carries a minimal local marketplace and a `witness-context` plugin holding only the module; `mergeSettings` declares it in `.claude/settings.json`. Task 9 opens with probe P9; if a settings-only declaration does not load the module headless and in a worktree, that task stops for the human.
   *Amended during the build, 2026-10-22 (probe P9):* it did not load. The committed declaration was skipped headless (`Skipping orphaned enabledPlugins entry witness-context@witness-local: marketplace not registered`), while the same plugin installed at user scope from a registered marketplace loaded headless at the root and in a worktree. The task stopped; the human asked for the architecturally correct route, and the ruling replaces this call and Task 9's text below. There is one carrier: the `witness-context` plugin (`plugin-context/`), listed in witness's GitHub marketplace and installed once per machine at user scope (`claude plugin marketplace add popovych-co/witness && claude plugin install witness-context@witness`). It holds the module and a byte-identical copy of the core, which `sync-versions` makes. The full plugin drops `modules`, so a machine with both never runs the module twice, and the payload carries no plugin. `mergeSettings` declares the GitHub marketplace and `enabledPlugins` (inert headless), `init` prints the install line, and `check` judges the adapter by the reading itself.
12. **One pure adapter core** (`plugin/hooks/context-core.mjs`) serves both adapters; the CLI keeps its own two-line arithmetic, and a parity test pins them together (the CLI must not import from `plugin/` at runtime — the packaging trap `harness.ts:121-126` describes).

## Review Focus

1. **The suite itself runs inside a measured session** (dogfooding, or a Claude Code session running `pnpm test`): the ambient `WITNESS_CONTEXT` and `CLAUDE_CODE_SESSION_ID` must not reach test CLIs, or every exact-shape journal assertion breaks. Pinned in Task 3 (`ignores the session the test process itself runs in`).
2. **Two CLI invocations overlapping in one process with different sessions** (lock-race tests, drive's in-process settle): each line carries its own invocation's session. Pinned in Task 3 (`keeps overlapping invocations apart`).
3. **The window changes mid-plan** (model switch 200k ↔ 1M): growth is kept in tokens and converted with the current window. Pinned in Task 6 (`converts growth with the current window`).
4. **Pi's estimate goes down between turns** (P2: 17,064 → 15,489): a negative growth is never a sample, and rule 3 never fires on it. Pinned in Task 6 (`never samples a negative growth`).
5. **The config is written in a style the adapter's regex misreads** (flow map, trailing comment, the key under another section): adapter and CLI must agree or the warning fires at a different limit than the relay. Pinned in Task 8 (`agrees with the CLI resolver on every config shape`).

## File structure

| File | Responsibility |
|---|---|
| `src/context.ts` (new) | The reading: contract validation, session id via the registry facet, session hash, journal stamp, floored percent, window label |
| `src/steps.ts` (new) | Step progress from a plan's manifest and stream: closure, legacy detection, `--step` validation, the `steps:` renderer |
| `src/slice.ts` (new) | The rule: step-close verdict, growth samples, act guard, the `context:`/`slice:`/`slices:`/`warn:` renderers, and the two printers every verb shares |
| `src/verbs/step-close.ts` (new) | The scaffolding-close verb |
| `src/config.ts` | `session.contextLimit` |
| `src/harness.ts` | `session` facet; payload entries for the adapter files |
| `src/journal.ts` | `ctx` stamp scope; `step-close` kind |
| `src/cli.ts` | Runs each verb inside the stamp scope; registers `step-close` |
| `src/evidence.ts`, `src/verbs/evidence.ts` | `--step` on `test-evidence` and `verify-red`; the step-close report |
| `src/verbs/next.ts` | Step routing; same-home hand-over; opening warning |
| `src/gate.ts`, `src/verbs/decide.ts`, `src/ship.ts` | Hand-over after a revise and at a ship exit; `slices:` on the plan gate |
| `src/verbs/start.ts`, `src/verbs/log.ts` | `slices:`/`steps:`/`context:` lines |
| `src/drive.ts`, `src/reviewer.ts` | Strip `WITNESS_CONTEXT` from drive children; mark reviewer spawns |
| `src/install.ts`, `src/verbs/check.ts` | Declare the project plugin; report the adapter state |
| `plugin/hooks/context-core.mjs` (new) | Pure adapter core: config limit, ancestor config paths, witness-command latch, reading JSON, warning line |
| `plugin/hooks/context.ts` (new), `plugin/hooks/context.test.ts` (new) | Claude Code hooks module and its `claude plugin test` file |
| `plugin/hooks/hooks.json`, `plugin/hooks/witness-pi.ts` | Wire the module; Pi env handoff and warning |
| `plugin/project-plugin/{marketplace,plugin,hooks}.json` (new) | Payload sources for the project-route plugin |
| `plugin/skills/*/SKILL.md`, `plugin/commands/witness.md` | Protocol text |
| `DESIGN.md`, `README.md` | Row 191 and its amendments; config, verbs, install, run economics |

---

### Task 1: `session.contextLimit` in the config

**Files:**
- Modify: `src/config.ts:21-32` (`Config`), after `:130` (new resolver), `:385-433` (`loadConfig`)
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `export const DEFAULT_CONTEXT_LIMIT = 20` · `export interface SessionConfig { contextLimit: number }` · `export function resolveSession(raw: Record<string, unknown>): Result<SessionConfig>` · `Config.session: SessionConfig`

- [ ] **Step 1: Write the failing tests**

```ts
describe('session.contextLimit (row 191)', () => {
  it('defaults to 20 when session or the key is absent', () => {
    expect(resolveSession({})).toMatchObject({ ok: true, value: { contextLimit: 20 } })
    expect(resolveSession({ session: {} })).toMatchObject({ ok: true, value: { contextLimit: 20 } })
  })
  it('accepts the bounds', () => {
    expect(resolveSession({ session: { contextLimit: 1 } })).toMatchObject({ ok: true, value: { contextLimit: 1 } })
    expect(resolveSession({ session: { contextLimit: 100 } })).toMatchObject({ ok: true, value: { contextLimit: 100 } })
  })
  it.each([0, 101, 20.5, '20', null, -5])('refuses contextLimit %s', (bad) => {
    const r = resolveSession({ session: { contextLimit: bad } })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.violations[0]).toMatchObject({ field: 'session.contextLimit', rule: 'invalid' })
  })
  it('refuses a session value that is not a map', () => {
    expect(resolveSession({ session: 20 })).toMatchObject({ ok: false })
  })
  it('loadConfig carries the value, and a bad one refuses the whole config', () => {
    // tmp dir with witness.config.yaml "schema: 1\nsession:\n  contextLimit: 15\n" → value.session.contextLimit === 15
    // same with contextLimit: 0 → ok false, violations[0].field === 'session.contextLimit'
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm exec vitest run tests/config.test.ts -t "session.contextLimit"`
Expected: FAIL — `resolveSession` is not exported.

- [ ] **Step 3: Implement `resolveSession` on `resolveImplement`'s pattern**

Want text: `an integer from 1 to 100 — % of the session's context window at which witness hands over to a fresh session`. Unknown keys under `session:` are ignored, as `implement:`'s are. Wire it into `Config` and into `loadConfig` right after `resolveImplement`.

- [ ] **Step 4: Run to see it pass**

Run: `pnpm exec vitest run tests/config.test.ts && pnpm typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): session.contextLimit — the fill a session hands over at (D191)"
```

---

### Task 2: The reading — session facet, `WITNESS_CONTEXT` validation, drive strips it

**Files:**
- Modify: `src/harness.ts:22-56` (`Harness.session`), `:127-213` (registry values)
- Create: `src/context.ts`
- Modify: `src/drive.ts:167-170` (child env)
- Modify: `tests/helpers.ts:68-74` (scrub) and add `measuredEnv`
- Test: `tests/context.test.ts` (new), `tests/harness.test.ts`, `tests/drive.test.ts`

**Interfaces:**
- Consumes: `resolveDriver(env, raw)` (`src/harness.ts:272`)
- Produces (in `src/context.ts`, with `type Env = Record<string, string | undefined>`):
  - `export const CONTEXT_ENV = 'WITNESS_CONTEXT'`
  - `export interface Reading { session: string; tokens: number; window: number }`
  - `export type Unmeasured = 'no adapter' | 'stale' | 'malformed' | 'no reading yet'`
  - `export type Fill = { measured: true; reading: Reading } | { measured: false; reason: Unmeasured }`
  - `export function sessionIdOf(env: Env): string | undefined` — `env[h.session]` (non-empty) where `h` is `resolveDriver(env, {})`'s harness
  - `export function sessionHash(id: string): string` — sha256 hex, first 12 chars
  - `export function readFill(env: Env): Fill`
  - `export function journalStamp(env: Env): JournalCtx | undefined` — `{ session: hash }` plus `tokens`/`window` when the reading is trusted; `undefined` when no session id
  - `export function pctOf(tokens: number, window: number): number` — `Math.floor(tokens * 100 / window)`
  - `export function reached(tokens: number, window: number, limit: number): boolean` — `tokens * 100 >= limit * window`
  - `export function windowLabel(window: number): string`
  - `Harness.session: string` — `'CLAUDE_CODE_SESSION_ID'` (claude-code), `'PI_SESSION_ID'` (pi)
- Produces (helpers): `export function measuredEnv(session: string, tokens: number | undefined, window: number): Record<string, string>` → `{ CLAUDE_CODE_SESSION_ID: session, WITNESS_CONTEXT: JSON.stringify({ session, tokens?, window }) }`
- `JournalCtx` is defined in Task 3; in this task declare it in `src/journal.ts` as `export interface JournalCtx { session: string; tokens?: number; window?: number }` so `journalStamp` can return it.

Validation order in `readFill` (pinned, the tests encode it): variable absent or empty → `no adapter`; not JSON, not an object, `session` not a non-empty string, `window` not a positive integer, `tokens` present and not a non-negative integer or `null`, or `tokens > window` → `malformed`; `session` ≠ `sessionIdOf(env)` (including no session variable) → `stale`; `tokens` absent, `null` or `0` → `no reading yet`; else measured.

- [ ] **Step 1: Write the failing tests** (`tests/context.test.ts`)

```ts
const S = 'ce2ad214-aaaa'
const env = (r: unknown, extra: Record<string, string> = {}) =>
  ({ CLAUDE_CODE_SESSION_ID: S, WITNESS_CONTEXT: typeof r === 'string' ? r : JSON.stringify(r), ...extra })

it('trusts a reading whose session is the harness session', () => {
  expect(readFill(env({ session: S, tokens: 31627, window: 1000000, percent: 3 })))
    .toEqual({ measured: true, reading: { session: S, tokens: 31627, window: 1000000 } })
})
it.each([
  ['absent', { CLAUDE_CODE_SESSION_ID: S }, 'no adapter'],
  ['empty', env(''), 'no adapter'],
  ['unparseable', env('{nope'), 'malformed'],
  ['an array', env('[1]'), 'malformed'],
  ['tokens over the window', env({ session: S, tokens: 2000001, window: 1000000 }), 'malformed'],
  ['fractional tokens', env({ session: S, tokens: 1.5, window: 1000000 }), 'malformed'],
  ['a zero window', env({ session: S, tokens: 0, window: 0 }), 'malformed'],
  ['another session (a chat session’s value inherited by drive)', env({ session: 'other', tokens: 5, window: 100 }), 'stale'],
  ['no session variable', { WITNESS_CONTEXT: JSON.stringify({ session: S, tokens: 5, window: 100 }) }, 'stale'],
  ['tokens absent — Claude Code before the first response', env({ session: S, window: 1000000 }), 'no reading yet'],
  ['tokens 0 — Pi before the first response', env({ session: S, tokens: 0, window: 100000 }), 'no reading yet'],
  ['tokens null — Pi right after a compaction', env({ session: S, tokens: null, window: 100000 }), 'no reading yet'],
])('%s → unmeasured', (_, e, reason) => expect(readFill(e)).toEqual({ measured: false, reason }))
it('reads PI_SESSION_ID under pi, and ignores the claude variable there', () => {
  const r = JSON.stringify({ session: 'p1', tokens: 6020, window: 100000 })
  expect(readFill({ PI_CODING_AGENT: 'true', PI_SESSION_ID: 'p1', WITNESS_CONTEXT: r })).toMatchObject({ measured: true })
  expect(readFill({ PI_CODING_AGENT: 'true', CLAUDE_CODE_SESSION_ID: 'p1', WITNESS_CONTEXT: r })).toEqual({ measured: false, reason: 'stale' })
})
it('hashes the session to 12 hex chars, stably, never echoing the id', () => {
  expect(sessionHash(S)).toMatch(/^[0-9a-f]{12}$/)
  expect(sessionHash(S)).toBe(sessionHash(S))
  expect(sessionHash(S)).not.toContain('ce2ad214')
})
it('stamps the session alone without a trusted reading, and the reading with one', () => {
  expect(journalStamp({ CLAUDE_CODE_SESSION_ID: S })).toEqual({ session: sessionHash(S) })
  expect(journalStamp(env({ session: S, tokens: 5, window: 100 }))).toEqual({ session: sessionHash(S), tokens: 5, window: 100 })
  expect(journalStamp({})).toBeUndefined()
})
it('floors the display so it agrees with the limit test', () => {
  expect(pctOf(196000, 1000000)).toBe(19)
  expect(reached(196000, 1000000, 20)).toBe(false)
  expect(reached(200000, 1000000, 20)).toBe(true)
})
it('labels windows', () => {
  expect(windowLabel(1000000)).toBe('1M')
  expect(windowLabel(200000)).toBe('200k')
})
```

In `tests/harness.test.ts`: `loadHarness('claude-code')` → `.session === 'CLAUDE_CODE_SESSION_ID'`, pi → `'PI_SESSION_ID'`; and `it('names session variables only in the registry')`: walk `src/**/*.ts`, every file but `src/harness.ts` contains neither `CLAUDE_CODE_SESSION_ID` nor `PI_SESSION_ID`.

In `tests/drive.test.ts` (`spawnSession` block, `fakeAgent` exists there):

```ts
it('strips WITNESS_CONTEXT from the child (row 191 §4.9)', async () => {
  // fakeAgent('echo "ctx=${WITNESS_CONTEXT-unset}"'), ctx env { WITNESS_DRIVE_AGENT_BIN: bin, WITNESS_CONTEXT: '{"session":"chat"}' }
  // → lines contain '[1 implement/p1] ctx=unset'
})
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/context.test.ts tests/harness.test.ts tests/drive.test.ts -t "unmeasured|trusts|session|strips|hash|floors|labels|stamps"`
Expected: FAIL — `src/context.ts` missing; drive child prints `ctx={"session":"chat"}`.

- [ ] **Step 3: Implement**

Add the facet to the `Harness` interface (one comment line: the env var naming this harness's session, read by `src/context.ts`) and to both registry entries. Write `src/context.ts` to the interfaces above. In `spawnSession`, delete `CONTEXT_ENV` from the env object handed to `resolveSpawn` (a comment citing row 191 §4.1: the chat session's value is stale in the child; the session check makes it harmless, this is the second guard). In `tests/helpers.ts` `tmpRepo`, scrub `WITNESS_CONTEXT`, `CLAUDE_CODE_SESSION_ID` and `PI_SESSION_ID` beside the detection vars, with a comment saying the suite may run inside a measured session; add `measuredEnv`.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm exec vitest run tests/context.test.ts tests/harness.test.ts tests/drive.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context.ts src/harness.ts src/drive.ts src/journal.ts tests/context.test.ts tests/harness.test.ts tests/drive.test.ts tests/helpers.ts
git commit -m "feat(context): the harness reading, validated against the session facet (D191)"
```

---

### Task 3: Every journal line carries its session (`ctx`)

**Files:**
- Modify: `src/journal.ts:69-76` (`entryLine`), add the scope
- Modify: `src/cli.ts:114-191` (`main`)
- Modify: `src/verbs/log.ts:50-53` (generic detail skips `ctx`)
- Test: `tests/journal.test.ts`

**Interfaces:**
- Consumes: `journalStamp(env)` (Task 2)
- Produces: `export function withJournalCtx<T>(c: JournalCtx | undefined, fn: () => T): T` (an `AsyncLocalStorage.run`); `entryLine` emits `{ v: 1, w, ...entry, ctx }` with `ctx` last and only when the scope holds one.

- [ ] **Step 1: Write the failing tests** (`tests/journal.test.ts`)

```ts
describe('ctx stamp (row 191 §4.8, extends 116)', () => {
  it('stamps ctx last inside a scope', () => {
    const line = withJournalCtx({ session: 'abc123abc123', tokens: 5, window: 100 },
      () => entryLine({ t: 'sync', trigger: 'start', result: 'ok' }))
    expect(line).toBe(JSON.stringify({ v: 1, w: version(), t: 'sync', trigger: 'start', result: 'ok',
      ctx: { session: 'abc123abc123', tokens: 5, window: 100 } }))
  })
  it('writes no ctx outside a scope', () => {
    expect(entryLine({ t: 'sync' })).not.toContain('"ctx"')
  })
  it('a verb run in a measured session stamps the hash, never the raw id', async () => {
    // seededRepo(); repo.cli(['ask', 'do a thing'], { env: measuredEnv('raw-session-1', 170000, 1000000) })
    // last line of .witness/journal/<ASK_STREAM>.jsonl has ctx { session: sessionHash('raw-session-1'), tokens: 170000, window: 1000000 }
    // the file text does not contain 'raw-session-1'
  })
  it('stamps the session alone when the reading is untrusted', async () => {
    // env { CLAUDE_CODE_SESSION_ID: 'raw-2', WITNESS_CONTEXT: '{bad' } → ctx equals { session: sessionHash('raw-2') }
  })
  it('keeps overlapping invocations apart', async () => {
    const a = withJournalCtx({ session: 'aaaaaaaaaaaa' }, async () => { await new Promise((r) => setTimeout(r, 10)); return entryLine({ t: 'sync' }) })
    const b = withJournalCtx({ session: 'bbbbbbbbbbbb' }, async () => entryLine({ t: 'sync' }))
    const [la, lb] = await Promise.all([a, b])
    expect(JSON.parse(la).ctx.session).toBe('aaaaaaaaaaaa')
    expect(JSON.parse(lb).ctx.session).toBe('bbbbbbbbbbbb')
  })
  it('ignores the session the test process itself runs in', async () => {
    // vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'ambient'); vi.stubEnv('WITNESS_CONTEXT', JSON.stringify({ session: 'ambient', tokens: 9, window: 10 }))
    // repo.cli(['ask', 'x']) with no opts.env → the new line has no ctx; vi.unstubAllEnvs()
  })
})
```

The existing exact-shape assertions (`tests/journal.test.ts:14`, `tests/status-entry.test.ts:18`) stay as they are: nothing is stamped outside a session, so they keep passing (P8's two failures came from stamping unconditionally). The last test passes already (Task 2 added the scrub); it is here to pin it.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/journal.test.ts`
Expected: FAIL — `withJournalCtx` not exported.

- [ ] **Step 3: Implement**

`journal.ts`: one module-level `AsyncLocalStorage<JournalCtx | undefined>`, `withJournalCtx`, and `entryLine` spreading `ctx` last. Extend the row 116 comment: row 191 stamps the session here for the same single-funnel reason. `cli.ts` `main`: compute `journalStamp(ctx.env)` once and run both the bare-`witness` dashboard route and the verb dispatch inside `withJournalCtx`. `log.ts` generic `detail`: destructure `ctx` out beside `v` and `t`.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm exec vitest run tests/journal.test.ts tests/status-entry.test.ts tests/log.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal.ts src/cli.ts src/verbs/log.ts tests/journal.test.ts
git commit -m "feat(journal): entryLine stamps the session and reading as ctx (D191)"
```

---

### Task 4: Steps the CLI can see — `--step`, `step-close`, `steps:`

**Files:**
- Create: `src/steps.ts`, `src/verbs/step-close.ts`
- Modify: `src/journal.ts:6-25` (`'step-close'` kind)
- Modify: `src/evidence.ts:101-145` (`journalEvidence`/`recordEvidence` carry `step`), `:187-250` (`verifyRed` takes and passes `step`)
- Modify: `src/verbs/evidence.ts` (parse and validate `--step` before any suite runs; positional parsing must skip the values of `--phase`, `--step`, `--base`)
- Modify: `src/cli.ts` (`VERBS['step-close']`; `VERB_USAGE` for `test-evidence`, `verify-red`, `step-close`)
- Modify: `src/verbs/start.ts` (print `steps:` in both branches), `src/verbs/log.ts` (`steps:` after a plan's rows; `detail` cases for `test-evidence` with its step and for `step-close`)
- Modify: `tests/helpers.ts` (move `THREE_STEPS`/`THREE_STEP_BODY`/`planReady` from `tests/dispatch-economics.test.ts` as `threeStepPlan(extraYaml?)`; add `evidenceCycle`), `tests/dispatch-economics.test.ts` (import them from helpers)
- Test: `tests/steps.test.ts` (new), `tests/step-close.test.ts` (new), `tests/evidence.test.ts`, `tests/start.test.ts`, `tests/log.test.ts`

**Interfaces:**
- Produces (`src/steps.ts`):
  - `export type StepKind = 'criteria' | 'scaffolding'`
  - `export interface StepState { id: string; kind: StepKind; closedAt?: number }` — `closedAt` is the index in the plan stream of the closing entry
  - `export type Progress = { known: true; steps: StepState[]; done: number; next?: StepState } | { known: false }`
  - `export function stepProgress(plan: CanonDoc, entries: Entry[]): Progress`
  - `export function closedAt(p: Progress, index: number): string | undefined`
  - `export function implementGated(entries: Entry[]): boolean` — any `gate-run` with `gate === 'implement'`
  - `export function openRed(entries: Entry[], stepId: string): boolean` — a non-vacuous red tagged with the step and no closing green after it
  - `export function stepsLine(p: Progress): string` — `2/5 done · next s3` · `5/5 done` · `unknown (evidence predates step tags)`
  - `export function checkStep(plan: CanonDoc, entries: Entry[], step: string | undefined, verb: 'evidence' | 'close'): Violation[]`
- Produces (verb): `witness step-close <plan-id> --step <id>` → entry `{ t: 'step-close', artifact: planId, step }`; prints `step-close: <plan> · <id> closed` or `step-close: <plan> · <id> already closed`
- Produces (helpers): `threeStepPlan(extraYaml = ''): Promise<TestRepo>` (s1, s2 criteria `ac-rotate`; s3 scaffolding; plan approved, not started) · `evidenceCycle(repo, wt, planId, step, env?): Promise<CliResult>` (TOKEN_BROKEN → `test-evidence --phase red --step`, TOKEN_FIXED → `--phase green --step`; returns the green's result; expects the vitest-single fixture already copied into `wt`)

Closure (pinned): a criteria step closes at the first `test-evidence` entry tagged with it, `phase: 'green'`, every test ok, that follows a red tagged with it having a failing test and no `vacuous: true`; later entries tagged with it change nothing. A scaffolding step closes at its first `step-close`. Progress is **unknown** when a `test-evidence` entry without `step` precedes the stream's first implement `gate-run` (or exists at all when there is none).

`checkStep` rules: `step` given but not in the manifest → `v('--step', 'unknown-step', id, 'a step of <plan>: s1 · s2 · s3')`; `verb === 'evidence'` and the step is scaffolding → `scaffolding-step`, want `witness step-close <plan> --step <id> — a scaffolding step closes without evidence`; `verb === 'close'` and the step is criteria → `criteria-step`, want `witness test-evidence <plan> --phase red --step <id> — a criteria step closes at its red→green`; `verb === 'close'` without a step → `required`. (The `evidence`-without-step rule arrives in Task 5.)

- [ ] **Step 1: Write the failing pure tests** (`tests/steps.test.ts`)

```ts
const plan = planDoc([{ id: 's1', criteria: ['ac'] }, { id: 's2', criteria: ['ac'] }, { id: 's3', scaffolding: true }])
// planDoc(steps) → { rel: 'plans/p.md', meta: { id: 'p', type: 'plan', parent: 'x', steps }, body: '', violations: [], satisfiedNeeds: [] }
const red = (step?: string, x = {}) => ({ v: 1, t: 'test-evidence', artifact: 'p', phase: 'red', tests: [{ name: 'a @spec:x', ok: false }], ...(step ? { step } : {}), ...x })
const green = (step?: string, ok = true) => ({ v: 1, t: 'test-evidence', artifact: 'p', phase: 'green', tests: [{ name: 'a @spec:x', ok }], ...(step ? { step } : {}) })
const close = (step: string) => ({ v: 1, t: 'step-close', artifact: 'p', step })

it('a tagged red→green closes the step at the green', () => {
  const p = stepProgress(plan, [red('s1'), green('s1')] as Entry[])
  expect(p).toMatchObject({ known: true, done: 1, next: { id: 's2' } })
  expect(closedAt(p, 1)).toBe('s1')
})
it('a re-recorded green changes nothing', () => {
  const p = stepProgress(plan, [red('s1'), green('s1'), green('s1')] as Entry[])
  expect(closedAt(p, 2)).toBeUndefined()
})
it('closes nothing without a red, on a vacuous red, or on a failing green', () => {
  expect(stepProgress(plan, [green('s1')] as Entry[])).toMatchObject({ done: 0 })
  expect(stepProgress(plan, [red('s1', { vacuous: true, tests: [{ name: 'a', ok: true }] }), green('s1')] as Entry[])).toMatchObject({ done: 0 })
  expect(stepProgress(plan, [red('s1'), green('s1', false)] as Entry[])).toMatchObject({ done: 0 })
})
it('closes a scaffolding step at its step-close', () => {
  expect(stepProgress(plan, [close('s3')] as Entry[])).toMatchObject({ done: 1, next: { id: 's1' } })
})
it('next is the first unfinished step in manifest order', () => {
  expect(stepProgress(plan, [red('s2'), green('s2')] as Entry[])).toMatchObject({ next: { id: 's1' } })
})
it('untagged evidence before the first implement gate run makes progress unknown', () => {
  expect(stepProgress(plan, [red(), green()] as Entry[])).toEqual({ known: false })
})
it('untagged evidence after an implement gate run is a fix round', () => {
  const gate = { v: 1, t: 'gate-run', gate: 'implement' }
  expect(stepProgress(plan, [red('s1'), green('s1'), gate, red(), green()] as Entry[])).toMatchObject({ known: true, done: 1 })
})
it('renders steps:', () => {
  expect(stepsLine(stepProgress(plan, [red('s1'), green('s1')] as Entry[]))).toBe('1/3 done · next s2')
  expect(stepsLine(stepProgress(plan, [red('s1'), green('s1'), red('s2'), green('s2'), close('s3')] as Entry[]))).toBe('3/3 done')
  expect(stepsLine({ known: false })).toBe('unknown (evidence predates step tags)')
})
it('openRed holds between a tagged red and its closing green', () => {
  expect(openRed([red('s1')] as Entry[], 's1')).toBe(true)
  expect(openRed([red('s1'), green('s1')] as Entry[], 's1')).toBe(false)
})
it.each([
  ['nope', 'evidence', 'unknown-step'], ['s3', 'evidence', 'scaffolding-step'],
  ['s1', 'close', 'criteria-step'], [undefined, 'close', 'required'],
])('checkStep(%s, %s) refuses %s', (step, verb, rule) => {
  expect(checkStep(plan, [], step, verb as 'evidence' | 'close')[0]).toMatchObject({ field: '--step', rule })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/steps.test.ts`
Expected: FAIL — `src/steps.ts` missing.

- [ ] **Step 3: Implement `src/steps.ts`** to the interfaces and the pinned rules. Add `'step-close'` to `EntryType` with a row 191 comment.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm exec vitest run tests/steps.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing verb tests**

`tests/evidence.test.ts` (use `threeStepPlan` + `start` + copy the vitest-single fixture into the worktree, as `shippableRepo` does):
- `refuses an unknown step before running the suite`: `test-evidence p --phase red --step nope` → code 2, stderr contains `unknown-step`, `existsSync(screensDir(wt, p))` is false, stream has no `test-evidence` entry.
- `refuses a scaffolding step`: `--step s3` → code 2, `scaffolding-step`.
- `journals the step on the entry`: `evidenceCycle(repo, wt, p, 's1')` → both new entries carry `step: 's1'`.
- `verify-red carries the step on both entries`: in `tests/verify-red.test.ts`, `verify-red p --step s1` → the reconstructed red and green both have `step: 's1'`.

`tests/step-close.test.ts`:
- `closes a scaffolding step once`: `step-close p --step s3` → code 0, stdout `step-close: p · s3 closed`, one `{ t: 'step-close', artifact: 'p', step: 's3' }` entry; again → code 0, `step-close: p · s3 already closed`, still one entry.
- `refuses a criteria step, an unknown step, and a missing --step` → code 2 with `criteria-step`, `unknown-step`, `required`.
- `refuses an unknown plan` → code 2 `unknown-plan`.

`tests/start.test.ts`: `start` prints `steps: 0/3 done · next s1`. `tests/log.test.ts`: after one s1 cycle, `log p` prints `steps: 1/3 done · next s2`; a `test-evidence` row's detail names `step=s1`.

- [ ] **Step 6: Run to see them fail**

Run: `pnpm exec vitest run tests/evidence.test.ts tests/verify-red.test.ts tests/step-close.test.ts tests/start.test.ts tests/log.test.ts`
Expected: FAIL on the new tests only.

- [ ] **Step 7: Implement the verbs**

`verbs/evidence.ts`: read `--step`, load the plan's stream, run `checkStep(…, 'evidence')` before `recordEvidence`/`verifyRed`, and pass `step` through `extra`. `verbs/step-close.ts`: shape of `verbs/dispatch.ts` (primary root, `guardTxn`, plan lookup, `checkStep(…, 'close')`, the already-closed check from `stepProgress`, then lock + `withTxn` + `appendEntry` + `stateCommit` with op `step-close(<plan>)`). Register it and the usage strings in `cli.ts`. `start`/`log`: print `kv('steps', stepsLine(stepProgress(plan, readStream(root, planId))))`.

- [ ] **Step 8: Run to see them pass**

Run: `pnpm exec vitest run tests/steps.test.ts tests/evidence.test.ts tests/verify-red.test.ts tests/step-close.test.ts tests/start.test.ts tests/log.test.ts tests/verb-usage.test.ts tests/dispatch-economics.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/steps.ts src/verbs/step-close.ts src/journal.ts src/evidence.ts src/verbs/evidence.ts src/cli.ts src/verbs/start.ts src/verbs/log.ts tests/
git commit -m "feat(steps): step-tagged evidence, step-close, and steps: (D191)"
```

---

### Task 5: `next` routes the next unfinished step; `--step` is required before the first implement gate

**Files:**
- Modify: `src/verbs/next.ts:187-208` (`evidenceRow` takes an optional step), `:240-306` (`flowAction` step row)
- Modify: `src/steps.ts` (`checkStep` gains the `step-required` rule), `src/verbs/evidence.ts` (no change beyond what `checkStep` now returns), `src/gates/implement.ts:63` (the `screens-matched-nothing` want text names `--phase green --step <id>`: that refusal journals no gate run, so the re-run it prescribes is still pre-gate)
- Modify: every pre-gate `'test-evidence'` / `'verify-red'` call in `tests/` (find them with `grep -rn "'test-evidence'\|'verify-red'" tests`), including `tests/helpers.ts:420,427` (`shippableRepo`), and the `next:` expectations in `tests/next.test.ts`, `tests/evidence.test.ts`, `tests/verify-red.test.ts`, `tests/drive.test.ts` (`grep -rn "witness test-evidence\|witness verify-red" tests`)
- Test: `tests/next.test.ts`, `tests/evidence.test.ts`

**Interfaces:**
- Consumes: `stepProgress`, `implementGated`, `openRed`, `stepsLine`, `checkStep` (Task 4)
- Produces: `flowAction` returns, when progress is known, no implement gate has run and a step is unfinished: `{ line, stage: 'implement', target, ...inWorktree, note: 'steps <stepsLine>' }` where `line` is `witness step-close <plan> --step <id>` for a scaffolding next step, else `witness test-evidence <plan> --phase <openRed ? 'green' : 'red'> --step <id>`. When progress is known, no gate has run and every step is closed, `evidenceRow`'s commands carry ` --step <id>` of the latest tagged red (else the last criteria step — never a scaffolding id, which `test-evidence` refuses). Legacy plans and gated plans get today's rows unchanged.
- `checkStep(…, 'evidence')` without a step, on a known plan with no implement gate run → `v('--step', 'step-required', 'absent', '--step <id> — every cycle before the first implement gate is a plan step\'s · steps <stepsLine>')`

Place the step row after the `gateSettled(entries, 'implement', diffSha)` check and before `evidenceForDiff` (`src/verbs/next.ts:279-286`).

- [ ] **Step 1: Write the failing tests**

`tests/next.test.ts` (`threeStepPlan`, `start`, fixture in the worktree, `nextLine(repo, { cwd: wt })` or `next --flow p`):
- `routes a fresh known plan to its first step`: stdout has `next: witness test-evidence p --phase red --step s1`, `stage: implement`, `note: steps 0/3 done · next s1`.
- `routes the green of an open red`: after a red `--step s1` → `next: witness test-evidence p --phase green --step s1`.
- `routes a scaffolding step to step-close`: after cycles for s1 and s2 → `next: witness step-close p --step s3`.
- `routes to the implement gate once every step is closed`: after s3's close → `next: witness gate implement p`.
- `keeps today's rows for a legacy plan`: append an untagged red with `appendEntry` and commit it with the `Witness-State: 1` trailer (as `flipStatus` does) → `next:` line has no `--step`.

`tests/evidence.test.ts`:
- `requires --step on a known plan before its first implement gate`: `test-evidence p --phase red` → code 2, `step-required`, want names `next s1`; no `test-evidence` entry; no screens dir.
- `accepts an untagged cycle after an implement gate run`: append a `{ t: 'gate-run', gate: 'implement', … }` entry the way the legacy test does → untagged red is not refused for `step-required`.
- `accepts an untagged cycle on a legacy plan`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/next.test.ts tests/evidence.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement** the `step-required` rule, the `flowAction` step row and `evidenceRow`'s optional step. One comment on the step row citing row 191 and the early-gate defect it closes (Plan's call 5).

- [ ] **Step 4: Update the call sites**

Run both greps from Files: add `'--step', '<id>'` to every pre-gate `test-evidence`/`verify-red` call on a plan with known progress (the default `PLAN_META` plan's only step is `s1`), including commands inside the shell scripts drive tests hand to `fakeAgent`, and update the five `next:` expectations. Leave post-gate calls (after a `gate implement` in the same test) untagged.

- [ ] **Step 5: Run the touched files**

Run: `pnpm exec vitest run $(grep -rln "'test-evidence'\|'verify-red'\|witness test-evidence\|witness verify-red" tests | tr '\n' ' ')`
Expected: `Tests N passed`, 0 `AssertionError`.

- [ ] **Step 6: Commit**

```bash
git add src/verbs/next.ts src/steps.ts tests/
git commit -m "feat(next): route the next unfinished plan step; --step required before the implement gate (D191)"
```

---

### Task 6: The rule at a step close — `context:`, `steps:`, `slice:`

**Files:**
- Create: `src/slice.ts`
- Modify: `src/verbs/evidence.ts` (after a recorded green, and after `verify-red`), `src/verbs/step-close.ts` (after a close)
- Test: `tests/slice.test.ts` (new, pure), `tests/context-relay.test.ts` (new, verb output)

**Interfaces:**
- Consumes: `readFill`, `sessionIdOf`, `sessionHash`, `pctOf`, `reached`, `windowLabel` (Task 2); `stepProgress`, `closedAt`, `implementGated`, `stepsLine` (Task 4); `Config.session`, `Config.implement` (Task 1)
- Produces (`src/slice.ts`):
  - `export const ACT_KINDS: ReadonlySet<string>` — Plan's call 8
  - `export function sessionActed(root: string, hash: string): boolean` — any entry in any `.witness/journal/*.jsonl` with `ctx.session === hash` and `t` in `ACT_KINDS`
  - `export function largestGrowth(entries: Entry[], p: Progress): number | undefined` — over the closing entries in stream order, each consecutive pair whose `ctx.session` matches and both carry `ctx.tokens`: `later − earlier`; the largest positive one
  - `export function closedThisSession(entries: Entry[], p: Progress, hash: string): number`
  - `export type SliceVerdict = { kind: 'gate' } | { kind: 'continue' } | { kind: 'end'; why: string } | { kind: 'own-count'; budget: number }`
  - `export function stepCloseVerdict(i: { fill: Fill; limit: number; budget: number; progress: Progress; growth?: number; closedHere?: number }): SliceVerdict`
  - `export function contextLine(fill: Fill, limit: number, budget: number, growth?: number): string`
  - `export function sliceLine(v: SliceVerdict): string`
  - `export function reportStepClose(ctx: Ctx, root: string, cfg: Config, plan: CanonDoc, opts: { closed?: string; passingGreen: boolean }): void`

`stepCloseVerdict`, in this order (pinned; spec §4.5 and §4.7):
1. progress known and no `next` → `gate`
2. measured and `reached(tokens, window, limit)` → `end`, why `<pct>% reached the <limit>% limit`
3. measured, progress known, `growth` defined and `reached(tokens + growth, window, limit)` → `end`, why `<pct>% + next step ≈ <pctOf(tokens + growth)>% passes the <limit>% limit`
4. measured → `continue`
5. unmeasured and (progress unknown or `closedHere === undefined`) → `own-count`
6. `closedHere >= budget` → `end`, why `<n> step(s) closed this session · step budget <budget> (context unmeasured)`
7. → `continue`

`contextLine` values: measured `17% of 1M · limit 20%`, plus ` · next step ≈ +<⌈growth × 100 / window⌉>%` when growth is defined; unmeasured `unmeasured (<reason>) — step budget <budget>`. `sliceLine` values: `continue` · `end — <why>` · `gate — no steps remain` · `own count — the CLI cannot count this session's steps · end after <budget> step(s) by your own count`.

`reportStepClose` prints `context:` when `closed` is set or `passingGreen` is true; it adds `steps:` and `slice:` when `closed` is set, or when `passingGreen` is true, the plan's progress is unknown and no implement gate has run. A green that closes no step on a known plan therefore prints `context:` alone (spec §4.4). `step-close` passes `{ closed, passingGreen: false }`. Exit codes never change. `closedHere` is `closedThisSession(…)` when `sessionIdOf(ctx.env)` is defined, else `undefined`; `growth` is `largestGrowth(…)`.

- [ ] **Step 1: Write the failing pure tests** (`tests/slice.test.ts`)

```ts
const m = (tokens: number, window = 1_000_000): Fill => ({ measured: true, reading: { session: 'S', tokens, window } })
const un: Fill = { measured: false, reason: 'no adapter' }
const known = (done: number, total: number): Progress => /* steps s1..sN, first `done` closed, next = s(done+1) when done < total */
it.each([
  ['rule 1 — no unfinished steps', { fill: m(900_000), progress: known(3, 3) }, { kind: 'gate' }],
  ['rule 2 — reached', { fill: m(200_000), progress: known(1, 3) }, { kind: 'end', why: '20% reached the 20% limit' }],
  ['rule 3 — projected', { fill: m(170_000), progress: known(1, 3), growth: 50_000 }, { kind: 'end', why: '17% + next step ≈ 22% passes the 20% limit' }],
  ['continue', { fill: m(100_000), progress: known(1, 3), growth: 50_000 }, { kind: 'continue' }],
  ['no sample yet skips rule 3', { fill: m(190_000), progress: known(1, 3) }, { kind: 'continue' }],
  ['no first-step exemption', { fill: m(260_000), progress: known(1, 5) }, { kind: 'end', why: '26% reached the 20% limit' }],
  ['unmeasured — budget reached', { fill: un, progress: known(3, 5), closedHere: 3 }, { kind: 'end', why: '3 step(s) closed this session · step budget 3 (context unmeasured)' }],
  ['unmeasured — under budget', { fill: un, progress: known(2, 5), closedHere: 2 }, { kind: 'continue' }],
  ['unmeasured — session unknown', { fill: un, progress: known(1, 5) }, { kind: 'own-count', budget: 3 }],
  ['legacy — rule 2 still applies', { fill: m(250_000), progress: { known: false } }, { kind: 'end', why: '25% reached the 20% limit' }],
  ['legacy — unmeasured', { fill: un, progress: { known: false }, closedHere: 9 }, { kind: 'own-count', budget: 3 }],
])('%s', (_, input, want) => expect(stepCloseVerdict({ limit: 20, budget: 3, ...input })).toEqual(want))

it('samples growth within one session only', () => { /* closes ctx A@100k, A@150k, B@400k, B@420k → 50_000 */ })
it('takes the largest sample', () => { /* A: +30k then +70k → 70_000 */ })
it('never samples a negative growth', () => { /* A@17_064 then A@15_489 → undefined */ })
it('skips a close that carries no tokens', () => { /* A(no tokens) then A@150k → undefined */ })
it('converts growth with the current window', () => {
  expect(contextLine(m(100_000, 200_000), 20, 3, 30_000)).toBe('50% of 200k · limit 20% · next step ≈ +15%')
})
it('renders context and slice', () => {
  expect(contextLine(m(170_000), 20, 3, 50_000)).toBe('17% of 1M · limit 20% · next step ≈ +5%')
  expect(contextLine(m(170_000), 20, 3)).toBe('17% of 1M · limit 20%')
  expect(contextLine({ measured: false, reason: 'stale' }, 20, 3)).toBe('unmeasured (stale) — step budget 3')
  expect(sliceLine({ kind: 'gate' })).toBe('gate — no steps remain')
  expect(sliceLine({ kind: 'own-count', budget: 3 })).toBe("own count — the CLI cannot count this session's steps · end after 3 step(s) by your own count")
})
it('counts only this session’s closes', () => { /* closes A, B, A → closedThisSession(…, 'A') === 2 */ })
it('sessionActed counts acts and ignores bookkeeping', () => {
  // tmp root with .witness/journal/x.jsonl lines: { t: 'ask', ctx: { session: 'h' } } → false; add { t: 'gate-run', ctx: { session: 'h' } } → true; other hash → false
})
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/slice.test.ts`
Expected: FAIL — `src/slice.ts` missing.

- [ ] **Step 3: Implement** the pure half of `src/slice.ts`.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm exec vitest run tests/slice.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing verb tests** (`tests/context-relay.test.ts`; `threeStepPlan`, `start`, fixture copied into the worktree; env = `{ ...fixtureEnv(), ...measuredEnv('S1', tokens, 1_000_000) }`)

- `a green that closes a step prints context, steps and slice`: s1 cycle at 170_000 → stdout has `context: 17% of 1M · limit 20%`, `steps: 1/3 done · next s2`, `slice: continue`; exit 0.
- `the slice ends when the fill reached the limit`: s1 green at 210_000 → `slice: end — 21% reached the 20% limit`, exit 0.
- `the projection uses this session's growth`: s1 closes at 100_000, s2 closes at 150_000, both session `S1` → s2's output has `next step ≈ +5%` and `slice: end — 15% + next step ≈ 20% passes the 20% limit`.
- `the last close says gate`: s1, s2 cycles, then `step-close p --step s3` → `slice: gate — no steps remain`.
- `a re-recorded green prints context alone`: a second green `--step s1` → has `context:`, lacks `slice:`.
- `unmeasured counts steps per session against the budget`: `threeStepPlan('implement:\n  stepsPerDispatch: 2\n')`, env `{ CLAUDE_CODE_SESSION_ID: 'S9' }` (s3 stays unfinished, so rule 1 does not fire) → after s1 `context: unmeasured (no adapter) — step budget 2` and `slice: continue`; after s2 `slice: end — 2 step(s) closed this session · step budget 2 (context unmeasured)`.
- `no session at all means own count`: no session env → `slice: own count — …`.

- [ ] **Step 6: Run to see them fail**

Run: `pnpm exec vitest run tests/context-relay.test.ts`
Expected: FAIL — no `context:` printed.

- [ ] **Step 7: Implement `reportStepClose`** and call it from `verbs/evidence.ts` (green phase, and after `verify-red`'s green) and `verbs/step-close.ts` (after a close; not on `already closed`). Read the stream after the write; the new entry is the last line.

- [ ] **Step 8: Run to see them pass**

Run: `pnpm exec vitest run tests/slice.test.ts tests/context-relay.test.ts tests/evidence.test.ts tests/step-close.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/slice.ts src/verbs/evidence.ts src/verbs/step-close.ts tests/slice.test.ts tests/context-relay.test.ts
git commit -m "feat(slice): the fill rule at a step close — context, steps, slice (D191)"
```

---

### Task 7: Hand-overs — revise, ship exit, `next`; the opening warning; the display lines

**Files:**
- Modify: `src/slice.ts` (three printers and `slicesLine`)
- Modify: `src/gate.ts:212-221` (`printDispatchArithmetic` → `printSliceShape`; callers `:395`, `:625`), `:226-240` (`runGate` flag and hand-over)
- Modify: `src/verbs/decide.ts` `run` (hand-over after a successful `--revise`)
- Modify: `src/ship.ts:342-493` (rename the body `shipPass`; `runShip` wraps it; `runGate(…, { …, handover: false })` at `:411`)
- Modify: `src/verbs/next.ts:899-1026` (opening warning above the routing unit; hand-over after `home:`; hoist the launch/watch condition)
- Modify: `src/verbs/start.ts:59-77,140-146`
- Test: `tests/context-relay.test.ts`, `tests/dispatch-economics.test.ts` (the start and plan-gate assertions)

**Interfaces:**
- Consumes: `readFill`, `sessionIdOf`, `sessionHash`, `pctOf`, `reached`, `windowLabel` (Task 2); `sessionActed`, `contextLine` (Task 6); `relayLine`, `resolveDriver` (`src/harness.ts`)
- Produces (`src/slice.ts`):
  - `export function reportHandover(ctx: Ctx, root: string, cfg: Config, opts: { guard: boolean }): boolean` — measured, `reached`, and (`!guard` or `sessionActed`) → prints `kv('context', contextLine(…))` then `kv('relay', relayLine(driver))` and returns true; the driver is `resolveDriver(ctx.env, cfg.raw)`, and an unresolvable one prints nothing
  - `export function reportOpening(ctx: Ctx, root: string, cfg: Config): void` — measured, `reached`, no act yet → `kv('warn', 'this session opens at 26% of 200k — over the 20% limit before any work; each slice will be one step')`
  - `export function slicesLine(cfg: Config): string` — `by context — relay at 20% (step budget 3 if unmeasured)`
- Produces: `runGate(ctx, gate, target, flags: { fresh: boolean; manual: boolean; handover?: boolean })` — after `settleStop` returns `decided` with `revise` or `revise-upstream`, and `handover !== false`, calls `reportHandover(…, { guard: false })`

Placement rules (pinned):
- `next`: `reportOpening` prints with the pre-unit lines (after `flow:`/`drive:`, before `next:`). After the `home:`/`run:`/`relay:` block, when no `run:` was printed, the action is neither `witness decide …` nor `witness check`, and no `launch:`/`watch:` line will print, call `reportHandover(…, { guard: true })`.
- `decide`: only `--revise` (exit 0) hands over; `guard: false`.
- `ship`: `runShip` calls `reportHandover(…, { guard: false })` once when `shipPass` exits `OK` or `FINDINGS`.
- `start`: replace `dispatch-budget:` and `dispatches:` with `slices:`; add `steps:` (Task 4 already prints it), `context: <contextLine(fill, limit, budget)>`, and `reportOpening`. Update the `help:` line to `… --phase red|green --step <id> as you go`.
- Plan gate: `printSliceShape` prints `kv('slices', slicesLine(cfg))`.

- [ ] **Step 1: Write the failing tests** (`tests/context-relay.test.ts`)

- `next at home hands over once this session has acted and the fill reached the limit`: session `S1` records a red `--step s1` at 100_000; then `next` from the worktree with `measuredEnv('S1', 210_000, 1_000_000)` → stdout has `context: 21% of 1M · limit 20%` and `relay: /clear then /witness`, and no `run:`.
- `a session that has not acted does not relay — it warns`: `measuredEnv('S2', 260_000, 1_000_000)` → no `relay:`; has `warn: this session opens at 26% of 1M — over the 20% limit before any work; each slice will be one step`.
- `bookkeeping is not an act`: `S3` runs `ask 'x'` at 10_000, then `next` at 250_000 → no `relay:`.
- `under the limit nothing hands over`: `S1` acted; `next` at 150_000 → no `relay:`, no `context:`.
- `decide --revise hands over`: a plan gate stopped by a blocking finding (`putVerdict` with a blocking finding, as `tests/decide.test.ts` sets one up); `decide plan p --revise --note x` with `measuredEnv('S4', 220_000, …)` → `relay:` printed; the same at 100_000 → none.
- `a settled revise under autonomy hands over`: `autonomyOn(repo)`, the same blocking verdict, `gate plan p` at 220_000 → stdout has `decided: plan p → revise` and `relay:`.
- `a ship run prints one relay`: reuse `tests/ship-lanes.test.ts`'s setup for a ship run that stops at the gate; at 220_000 → exactly one `relay:` line in stdout.

`tests/dispatch-economics.test.ts` (replace the row 79 display tests):
- `start prints slices, steps and the opening context`: `slices: by context — relay at 20% (step budget 3 if unmeasured)`, `steps: 0/3 done · next s1`, `context: unmeasured (no adapter) — step budget 3`; no `dispatch-budget:`.
- `a configured budget and limit show in slices`: config `session:\n  contextLimit: 15\nimplement:\n  stepsPerDispatch: 2\n` → `slices: by context — relay at 15% (step budget 2 if unmeasured)` on start and on re-attach.
- `the plan gate prints slices`: `slices: by context — relay at 20% (step budget 3 if unmeasured)`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/context-relay.test.ts tests/dispatch-economics.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement** the printers and the placements. Comments cite row 191 §4.4–§4.6; the `next` one says why the hand-over sits outside the `run:` branch (a `run:` already hands over to another session).

- [ ] **Step 4: Run to see them pass**

Run: `pnpm exec vitest run tests/context-relay.test.ts tests/dispatch-economics.test.ts tests/next.test.ts tests/next-home.test.ts tests/decide.test.ts tests/ship-lanes.test.ts tests/autonomy-gate.test.ts tests/start.test.ts tests/gate-plan.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/slice.ts src/gate.ts src/verbs/decide.ts src/ship.ts src/verbs/next.ts src/verbs/start.ts tests/
git commit -m "feat(relay): hand over at a revise, a ship exit and next by measured fill (D191)"
```

---

### Task 8: Adapters — shared core, Pi extension, Claude Code module; reviewer spawns marked

**Files:**
- Create: `plugin/hooks/context-core.mjs`, `plugin/hooks/context.ts`, `plugin/hooks/context.test.ts`
- Modify: `plugin/hooks/hooks.json` (add `"modules": ["./context.ts"]` beside `"hooks"`), `plugin/hooks/witness-pi.ts`
- Modify: `src/harness.ts:172-180` (pi payload gains `{ from: 'plugin/hooks/context-core.mjs', to: '.pi/extensions/context-core.mjs' }`)
- Modify: `src/reviewer.ts:168-170` (spawn env gains `WITNESS_REVIEWER: '1'`), `fixtures/fakebin/claude` and `fixtures/fakebin/pi` (record it beside `lens`)
- Test: `tests/context-core.test.ts` (new), `tests/pi-extension.test.ts`, `tests/reviewer.test.ts`

**Interfaces:**
- Produces (`plugin/hooks/context-core.mjs`, dependency-free, no imports):
  - `export const DEFAULT_LIMIT = 20`
  - `export function contextLimitOf(text)` → the `session.contextLimit` integer 1–100, `20` when absent, `undefined` when present but invalid (block and flow styles, trailing comments; the key under any other top-level section does not count)
  - `export function configCandidates(cwd)` → `witness.config.yaml` paths from `cwd` up to the filesystem root, nearest first (`/` and `\` separators)
  - `export function invokesWitness(command)` → true when the command runs the witness CLI: `$WITNESS` or `${WITNESS}` followed by a verb, `witness <verb>`, or `…/witness@<version> <verb>`
  - `export function readingJson(session, tokens, window, percent)` → `JSON.stringify({ session, tokens, window, percent })` (undefined fields drop out; `null` stays)
  - `export function pctOf(tokens, window)`, `export function windowLabel(window)` — same results as `src/context.ts`'s
  - `export function warnLine(tokens, window, limit)` → `witness: context 21% of 1M has reached the 20% limit — finish what you are in (implement: the red→green), then hand over`, or `undefined` under the limit or without a positive integer `tokens`
- Produces (`plugin/hooks/context.ts`): `export const register: Register` hooking `tool.call` on `Bash`. Before `next(e)`: read `$.session.id()` and `$.session.usage()`; `$.env.set('WITNESS_CONTEXT', readingJson(…))`; latch the session when `invokesWitness(e.command)`. When latched, not yet warned, `$.env.get('WITNESS_REVIEWER')` is undefined, and the nearest config (walk `configCandidates(await $.session.cwd())` with `$.fs.read`; the first file found decides) yields a limit that `warnLine` reports reached: mark the session warned and return `{ ...r, context: [...(r.context ?? []), line] }` for a result that is not a deny. Latched and warned sets are keyed by session id (a `/clear` starts over). Everything before `next(e)` sits in one try/catch that falls through to `next(e)`. `$.env.*` names are string literals (the API requires it).
- Produces (Pi): `witness-pi.ts`'s `tool_call` keeps the guard first (a block returns before anything else), then for `bash` sets `process.env.WITNESS_CONTEXT` from `ctx.getContextUsage()` (`contextWindow` → `window`) and `ctx.sessionManager.getSessionId()`, and latches on `invokesWitness(event.input.command)`. A new `tool_result` handler appends `{ type: 'text', text: line }` to `event.content` once per session under the same conditions (`process.env.WITNESS_REVIEWER`, config found with `configCandidates` + `readFileSync`). Both in their own try/catch.

- [ ] **Step 1: Write the failing core tests** (`tests/context-core.test.ts`, importing `../plugin/hooks/context-core.mjs` as `tests/canon-guard.test.ts` imports its sibling)

```ts
const SHAPES = [
  'schema: 1\n',
  'schema: 1\nsession:\n  contextLimit: 15\n',
  'schema: 1\nsession: { contextLimit: 15 }\n',
  'schema: 1\nsession:\n  contextLimit: 15   # percent\n',
  'schema: 1\nsession:\n  contextLimit: 0\n',
  'schema: 1\nsession:\n  contextLimit: 150\n',
  'schema: 1\nsession:\n  contextLimit: abc\n',
  'schema: 1\nimplement:\n  contextLimit: 9\n',
]
it.each(SHAPES)('agrees with the CLI resolver on every config shape: %j', (text) => {
  const cli = resolveSession(parseYaml(text) as Record<string, unknown>)
  expect(contextLimitOf(text)).toBe(cli.ok ? cli.value.contextLimit : undefined)
})
it('lists config candidates nearest first', () => {
  expect(configCandidates('/a/b/c')).toEqual(['/a/b/c/witness.config.yaml', '/a/b/witness.config.yaml', '/a/witness.config.yaml', '/witness.config.yaml'])
})
it.each([
  ['$WITNESS next', true], ['${WITNESS} next', true], ['witness next', true],
  ['npx -y @popovych.co/witness@0.19.4 test-evidence p --phase red --step s1', true],
  ['WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.19.4}"; $WITNESS next', true],
  ['cd ~/x/personal/witness && git status', false], ['grep -rn "witness test" src', false], ['ls', false],
])('invokesWitness(%j) is %s', (cmd, want) => expect(invokesWitness(cmd)).toBe(want))
it('renders the reading and the warning', () => {
  expect(JSON.parse(readingJson('S', 31627, 1000000, 3))).toEqual({ session: 'S', tokens: 31627, window: 1000000, percent: 3 })
  expect(JSON.parse(readingJson('S', undefined, 1000000, undefined))).toEqual({ session: 'S', window: 1000000 })
  expect(warnLine(210000, 1000000, 20)).toBe('witness: context 21% of 1M has reached the 20% limit — finish what you are in (implement: the red→green), then hand over')
  expect(warnLine(190000, 1000000, 20)).toBeUndefined()
  expect(warnLine(undefined, 1000000, 20)).toBeUndefined()
})
it.each([[196000, 1000000], [31627, 200000], [6020, 100000]])('matches the CLI arithmetic for %i/%i', (t, w) => {
  expect(core.pctOf(t, w)).toBe(cli.pctOf(t, w))
  expect(core.windowLabel(w)).toBe(cli.windowLabel(w))
})
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/context-core.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `context-core.mjs`.** Header comment on canon-guard.mjs's precedent: dependency-free on purpose (Decision 13), shared byte for byte by both adapters.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm exec vitest run tests/context-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing Pi and reviewer tests**

`tests/pi-extension.test.ts` — extend `stubPi()`'s ctx with `getContextUsage: () => usage`, `sessionManager: { getSessionId: () => session }`; restore `process.env.WITNESS_CONTEXT`/`WITNESS_REVIEWER` after each test:
- `sets WITNESS_CONTEXT for a bash call`: usage `{ tokens: 16523, contextWindow: 1000000, percent: 1.65 }`, session `p1` → `JSON.parse(process.env.WITNESS_CONTEXT!)` toMatchObject `{ session: 'p1', tokens: 16523, window: 1000000 }`.
- `a canon block still wins`: the existing block test still returns `{ block: true }`.
- `warns once after the session ran the witness CLI, at or over the limit`: config `session:\n  contextLimit: 20\n`, usage 21% → `tool_call` with `$WITNESS next`, then `tool_result` returns `content` whose last block's text starts `witness: context 21% of 1M`; a second `tool_result` returns undefined.
- `stays silent before any witness command`, `in a reviewer spawn` (`WITNESS_REVIEWER=1`), `without a witness.config.yaml`, `under the limit`.
- `a new session id can warn again`.
- `never throws when the context API throws`: `getContextUsage` throws → `tool_call` and `tool_result` resolve without throwing, and the guard's verdicts are unchanged.

`tests/reviewer.test.ts`: after a gate run with the fake `claude`, `readFileSync(join(scenario, 'claude-calls', 'call-1', 'reviewer'), 'utf8')` is `'1\n'`; same for `pi`.

- [ ] **Step 6: Run to see them fail**

Run: `pnpm exec vitest run tests/pi-extension.test.ts tests/reviewer.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 7: Implement** the Pi changes, the payload entry, the reviewer env and the two fakebin lines (`if [ -n "${WITNESS_REVIEWER:-}" ]; then printf '%s\n' "$WITNESS_REVIEWER" > "$call/reviewer"; fi`).

- [ ] **Step 8: Run to see them pass**

Run: `pnpm exec vitest run tests/pi-extension.test.ts tests/reviewer.test.ts tests/context-core.test.ts tests/check.test.ts tests/init-agent.test.ts`
Expected: PASS (`check`/`init-agent` stay green with the new pi payload file).

- [ ] **Step 9: Write the Claude Code module and its kit test**

`plugin/hooks/context.ts` to the interface above; `hooks.json` gains `"modules": ["./context.ts"]`. `plugin/hooks/context.test.ts` (run by `claude plugin test`, excluded from vitest by `**/plugin/**`): in each test the engine is stood in by hooks answering `$` calls with `{ value }` — `session.id` → `'S1'`, `session.usage` → `{ startedAt: 0, context: { tokens, window: 1000000, percent }, rateLimits: [] }`, `session.cwd` → a dir, `fs.read` → the config text, `env.get` → the reviewer value, `env.set` → record the value and answer `{}`, `tool.call` → `{ result: {} }` (event names per the installed declaration file). Tests: `sets WITNESS_CONTEXT before the command`; `appends the warning once after a witness command`; `stays silent in a reviewer spawn`; `stays silent before a witness command`.

- [ ] **Step 10: Validate and run the kit**

Run: `claude plugin validate plugin && claude plugin test plugin`
Expected: validate passes and lists `WITNESS_CONTEXT`, `WITNESS_REVIEWER` among the env names; the kit's tests pass. If the kit cannot express a case, note which and rely on Step 11 for it.

- [ ] **Step 11: Live probe (headless, the P1 shape)**

In a scratch git repo holding `witness.config.yaml` = `schema: 1\nsession:\n  contextLimit: 1\n`:
`WITNESS_BIN=true claude -p 'Run these two Bash commands, then quote any line that starts with "witness:": 1) printenv WITNESS_CONTEXT  2) WITNESS=true; $WITNESS next' --plugin-dir <repo>/plugin --model claude-haiku-5-5 --dangerously-skip-permissions --debug-file <scratch>/p.log`
Expected: the first command prints a JSON reading whose `session` equals `CLAUDE_CODE_SESSION_ID` (macOS `printenv` prints only its first argument — one name per call); the reply quotes `witness: context …% of … has reached the 1% limit`; `p.log` has `hooks module witness` … `loaded`. Record the output in the commit message body.

- [ ] **Step 12: Commit**

```bash
git add plugin/hooks/ src/harness.ts src/reviewer.ts fixtures/fakebin/claude fixtures/fakebin/pi tests/
git commit -m "feat(adapters): put the live reading in every Bash command and warn once at the limit (D191)"
```

---

### Task 9: Install route — the project plugin declaration (probe P9 first); `check` reports the adapter

**Run Step 1 in the controller session, not a subagent: its outcome can stop the plan.**

**Files:**
- Create: `plugin/project-plugin/marketplace.json`, `plugin/project-plugin/plugin.json`, `plugin/project-plugin/hooks.json`
- Modify: `src/harness.ts:134-139` (claude-code payload), `src/install.ts:177-220` (`mergeSettings`), `src/verbs/check.ts:400-422` (adapter line)
- Test: `tests/init-agent.test.ts`, `tests/check.test.ts`

**Interfaces:**
- Payload (claude-code) additions:
  - `plugin/project-plugin/marketplace.json` → `.claude/witness-plugin/.claude-plugin/marketplace.json` = `{ "name": "witness-local", "owner": { "name": "witness" }, "plugins": [{ "name": "witness-context", "source": "./context", "description": "witness: the live context reading for Bash commands" }] }`
  - `plugin/project-plugin/plugin.json` → `.claude/witness-plugin/context/.claude-plugin/plugin.json` = `{ "name": "witness-context", "description": "…" }` (no `version`: nothing for `sync-versions` to keep in step)
  - `plugin/project-plugin/hooks.json` → `.claude/witness-plugin/context/hooks/hooks.json` = `{ "modules": ["./context.ts"] }`
  - `plugin/hooks/context.ts` → `.claude/witness-plugin/context/hooks/context.ts`
  - `plugin/hooks/context-core.mjs` → `.claude/witness-plugin/context/hooks/context-core.mjs`
- `src/install.ts`: `export const LOCAL_MARKETPLACE = 'witness-local'`, `export const CONTEXT_PLUGIN = 'witness-context@witness-local'`, `export const LOCAL_MARKETPLACE_SOURCE = { source: 'directory', path: './.claude/witness-plugin' }` (path form fixed by P9). `mergeSettings` adds `extraKnownMarketplaces[LOCAL_MARKETPLACE]` and `enabledPlugins[CONTEXT_PLUGIN] = true` when missing; it never overwrites a user's entry, including an explicit `false`.
- `check` prints, for the driver harness, one stated line (not a finding): `adapter: claude-code — reading seen · 17% of 1M` · `adapter: claude-code — present · no reading in this process (no adapter)` · `adapter: claude-code — absent (expected under the marketplace plugin · else run npx -y @popovych.co/witness@latest init --agent claude-code)` · `adapter: pi — absent (run npx -y @popovych.co/witness@latest init --agent pi)`. "Present" = claude-code: the payload's `context.ts` exists and `.claude/settings.json` enables `CONTEXT_PLUGIN`; pi: `.pi/extensions/context-core.mjs` exists.

- [ ] **Step 1: Probe P9 — does a settings-only declaration load the module?**

In a scratch repo laid out exactly as the payload above (copy the five files by hand), with `.claude/settings.json` = `{ "extraKnownMarketplaces": { "witness-local": { "source": { "source": "directory", "path": "./.claude/witness-plugin" } } }, "enabledPlugins": { "witness-context@witness-local": true } }`, committed:
1. Back up `~/.claude/plugins/known_marketplaces.json`, `~/.claude/plugins/installed_plugins.json` and `~/.claude.json`.
2. Case A (untrusted, headless): `claude -p 'Run: printenv WITNESS_CONTEXT' --model claude-haiku-5-5 --dangerously-skip-permissions --debug-file <scratch>/a.log` from the repo root.
3. If A does not load: read `a.log` for the gate that held it (P6 met `repoAuthoredContent` behind workspace trust). Mark the scratch root trusted the way `~/.claude.json` records trust, then Case B: repeat A.
4. Case C: `git worktree add .witness/worktrees/x` and repeat from inside it (implement sessions run there).
5. Restore the three files from the backups and confirm with `cmp`.

Decide: A passes → proceed. A fails and B and C pass → proceed, and the README install note (Task 11) says the project route needs workspace trust, which `check`'s `present · no reading` line exposes. B or C fails → **stop**: report the debug-log lines to the human; the install route needs a design decision (spec §4.11), and the marketplace route still works. A relative path that fails where an absolute one works is a stop too (committed settings would break teammates and worktrees).

- [ ] **Step 2: Write the failing tests**

`tests/init-agent.test.ts`:
- `installs the project plugin and declares it`: `init --agent claude-code` writes the five payload files and `.claude/settings.json` has `extraKnownMarketplaces['witness-local'].source` equal to `LOCAL_MARKETPLACE_SOURCE` and `enabledPlugins['witness-context@witness-local'] === true`.
- `keeps the user's marketplaces, plugins and an explicit false`: pre-existing `{ extraKnownMarketplaces: { mine: {…} }, enabledPlugins: { 'x@mine': true, 'witness-context@witness-local': false } }` → both kept, the `false` untouched.
- `a second init changes nothing`: `mergeSettings(first.text).changed === false`.

`tests/check.test.ts`: the four `adapter:` lines above (after `init --agent claude-code`; with `measuredEnv('S', 170000, 1000000)`; in a repo with no payload; under `PI_CODING_AGENT: 'true'` with no pi payload).

- [ ] **Step 3: Run to see them fail**

Run: `pnpm exec vitest run tests/init-agent.test.ts tests/check.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 4: Implement** the payload entries, `mergeSettings` additions (comment: D144's append-what's-missing discipline; P5/P9 are the evidence) and the `adapter:` line.

- [ ] **Step 5: Run to see them pass**

Run: `pnpm exec vitest run tests/init-agent.test.ts tests/init.test.ts tests/init-homes.test.ts tests/check.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugin/project-plugin/ src/harness.ts src/install.ts src/verbs/check.ts tests/
git commit -m "feat(install): declare the context plugin in project settings; check reports the adapter (D191)"
```

---

### Task 10: Skills and the router speak the new protocol

**Files:**
- Modify: `plugin/skills/witness-implement/SKILL.md:39,41-78,88-93`
- Modify: `plugin/commands/witness.md:25,28-42,52`
- Modify: `plugin/skills/witness-plan/SKILL.md:98`, `plugin/skills/witness-decompose/SKILL.md:104`, `plugin/skills/witness-design/SKILL.md:46`, `plugin/skills/witness-ship/SKILL.md:44-48`
- Test: `tests/dispatch-economics.test.ts` (skill-text block), `tests/harness-neutrality.test.ts` (unchanged, must stay green)

**Interfaces:**
- Consumes: the CLI lines pinned in Tasks 4–7 (`steps:`, `context:`, `slice:` values, `step-close`, same-home `relay:`) and the adapter warning prefix `witness: context`.

What the text must say (implementer writes the prose in the file's voice):
- Implement, slices section: `start` prints `slices:`, `steps:` and `context:`; work step by step from `steps:`; each step's cycle is `--phase red --step <step-id>` then `--phase green --step <step-id>`; a scaffolding step closes with `$WITNESS step-close <plan-id> --step <step-id>`; after each close act on `slice:` — `slice: continue` (next step), `slice: end` (dispatch-report, then the relay as today), `slice: gate` (go to the gate), `slice: own count` (end after the named number of steps by your own count); `steps: unknown` means a pre-tag plan — keep your own count from `log` and still obey `slice: end`. The mid-step warning (`witness: context …`) means finish the red→green you are in (never stop mid-red), then dispatch-report and relay. The early exit keeps only "left the step's scope to fight infrastructure"; the `~15 inner-loop iterations` trigger and the `dispatch-budget` count are gone.
- Router: a new table row, placed after the `drive: done` row — "a `relay:` line is printed with no `run:` (by `next`, `gate`, `decide` or `ship`) → this session reached its context limit where the journal carries the position: print the `relay:` line verbatim, say the work continues in a fresh session in this directory, END YOUR TURN". Line 25's "`run:` and `relay:` are printed only when…" gains that a `relay:` can also print alone.
- Implement, plan, decompose, design autonomy paragraphs: after a settled `→ revise`, if a `relay:` line printed under the decision, print it and END YOUR TURN — a fresh session takes the revise.
- Ship: after a `witness ship` run, if it printed a `relay:` line, print it and END YOUR TURN — the next ship pass runs in a fresh session (covers the CI loop).

- [ ] **Step 1: Rewrite the skill-text assertions (failing)**

```ts
describe('implement skill carries the context-fill protocol (rows 79–80, 191)', () => {
  it.each([
    '--step <step-id>', 'step-close', 'slices:', 'steps:', 'context:',
    'slice: continue', 'slice: end', 'slice: gate', 'slice: own count', 'steps: unknown',
    'witness: context', 'never stop mid-red', 'finish the red→green you are in',
    "left the step's scope to fight infrastructure", 'dispatch-report',
    "the test's own name, never the spec tag", 'only inside the witnessed evidence cycle',
    'never whole into your context', 'keep the app server alive',
  ])('mentions %s', (s) => expect(implement).toContain(s))
  it.each(['~15 inner-loop iterations', 'dispatch-budget', 'at most the next'])('no longer says %s', (s) => expect(implement).not.toContain(s))
})
it('the router ends the turn on a relay: with no run:', () => {
  expect(router).toMatch(/`relay:` line is printed with no `run:`/)
})
it.each(['witness-implement', 'witness-plan', 'witness-decompose', 'witness-design'])('%s hands a settled revise to a fresh session', (s) => {
  expect(skill(s)).toContain('a fresh session takes the revise')
})
it('ship runs its next pass in a fresh session', () => {
  expect(skill('witness-ship')).toContain('the next ship pass runs in a fresh session')
})
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/dispatch-economics.test.ts`
Expected: FAIL on the new text assertions.

- [ ] **Step 3: Edit the six files.**

- [ ] **Step 4: Run to see them pass**

Run: `pnpm exec vitest run tests/dispatch-economics.test.ts tests/harness-neutrality.test.ts tests/skills.test.ts tests/calibrate-skills.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/skills plugin/commands tests/dispatch-economics.test.ts
git commit -m "docs(skills): slices by measured fill, step tags, same-home relay (D191)"
```

---

### Task 11: The design record and the README

**Files:**
- Modify: `DESIGN.md` — status line (header) entry for row 191, in the form rows 188–190 use; new row 191 after row 190 (`:504`); in-place amendments to rows 26 (`:339`), 44 (`:357`), 54 (`:367`), 79 (`:392`), 80 (`:393`), 81 (`:394`), 82 (`:395`), 116 (`:429`), 145 (`:459`); the pipeline table's implement row (`:32`); the `witness.config.yaml — the whole surface` block (`:282-302`) gains `session: { contextLimit: 20 }` with a one-line comment; `## Open / deferred` (`:508`)
- Modify: `README.md` — `## Configuration keys` (`:145`): `session.contextLimit` (and `implement.stepsPerDispatch` as the unmeasured fallback if the table lacks it); `## Verbs` (`:181`): `step-close`, `--step` on `test-evidence`/`verify-red`; `## Install per harness` (`:59`): the project route declares the context plugin (plus P9's trust note if it applies); `## Run economics` (`:237`): rewritten around the fill relay, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` kept as an operator note
- Test: none new; `tests/docs-injection.test.ts` and `tests/verb-usage.test.ts` stay green

Content (spec §5, plus the Plan's calls that change recorded behavior):
- Row 191: the reading and its contract (§4.1), the limit (§4.2), steps the CLI can see with the `--step` requirement before the first implement gate (calls 4, 6), the decision points and the rule (§4.4–§4.5, calls 2, 3, 7, 9), what the agent sees (§4.6), unmeasured behavior (§4.7), the journal `ctx` stamp (§4.8, call 1), drive (§4.9), display lines (§4.10, call 10), install (§4.11 with P9's outcome), and `next`'s step routing (call 5) with the defect it closes. Evidence column: P1–P9 by name and result.
- Amendments, one sentence each in the row's own text: 26 (every entry may carry `ctx`; new `step-close` kind); 44 (`--step`); 54 (closure computed; scaffolding close); 79 (trigger is measured fill; budget is the unmeasured fallback; "token counts are invisible to the agent" answered by the harness reading); 80 (early-exit trigger is the measured warning); 81 (numbers are harness-measured, not reported; the fence is "no gate consumes"); 82 (same-home `relay:` without `run:`); 116 (`entryLine` stamps `ctx` beside `w`); 145 (drive's spawns are sized by fill; drive strips `WITNESS_CONTEXT`).
- Open / deferred: spec §7's deferred list, plus: step routing applies only before the first implement gate (a plan re-authored after an implement gate keeps today's rows); the opening warning can repeat until a session's first act.

- [ ] **Step 1: Edit `DESIGN.md` and `README.md`.**
- [ ] **Step 2: Check the docs tests**

Run: `pnpm exec vitest run tests/docs-injection.test.ts tests/verb-usage.test.ts tests/harness-neutrality.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add DESIGN.md README.md
git commit -m "docs(design): row 191 — the context-fill relay; amends 26 44 54 79–82 145, extends 116"
```

---

### Task 12: Verification run

- [ ] **Step 1: Build, typecheck, full suite**

Run: `LOG=$(mktemp) && pnpm build && pnpm typecheck && { pnpm test > "$LOG" 2>&1; grep -E "Tests +[0-9]+" "$LOG"; grep -c AssertionError "$LOG"; }`
Expected: build and typecheck clean; `Tests N passed` with no failures; `AssertionError` count 0. A non-zero exit with only `Timeout calling "onTaskUpdate"` errors is the known vitest noise.

- [ ] **Step 2: Plugin checks**

Run: `claude plugin validate plugin && claude plugin test plugin`
Expected: both pass.

- [ ] **Step 3: Live probes on the built tree**

Repeat Task 8 Step 11 against `plugin/`, and Task 9's Case A (or B and C) against a scratch repo set up with `node <repo>/dist/bin.js init --agent claude-code`. For Pi, a scripted local model as in the probes (`PI_CODING_AGENT_DIR` pointing at a scratch `models.json` mock, run with `< /dev/null`), or the live haiku when the Pi login is valid: the bash child sees the reading with `session` equal to `PI_SESSION_ID`, and the warning block reaches the model.

- [ ] **Step 4: Adversarial review passes** (the user's standard; opus agents, re-run every finding before acting on it)

Two independent passes over the branch diff: (a) design versus record — every spec §4 clause and every Plan's call against the code and DESIGN row 191; (b) behavior attack — a stale reading, a session that opens over the limit, a legacy plan mid-flight after upgrade, a fix round past the limit, a drive child over the limit, a reviewer spawn, `/clear` mid-session.

- [ ] **Step 5: Owed after merge** (spec §6; not automatable here)

The first interactive session after the build confirms in chat mode that the module loads and the warning reaches the model; `--scope project` reach to a teammate's clone is confirmed by Task 9's outcome or stays owed. Record what remains in the PR description.
