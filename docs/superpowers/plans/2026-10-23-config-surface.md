# Config surface (D193) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every setting witness reads is written in `witness.config.yaml`, with a comment, and nothing is inherited. Schema 2 requires every setting. `witness migrate` brings older files up to date and names every change.

**Architecture:**
- One list of settings (`src/settings.ts`) drives everything else: the resolver, which returns a fully typed `Config` with no `raw`, the file `init` writes, the in-memory upgrade of older files, `witness migrate`, and the README table.
- The work lands in four stages:
  1. config is read once, typed, from the list, still at schema 1;
  2. the file renderer;
  3. the schema-2 flip;
  4. `migrate`.

**Tech Stack:** TypeScript (Node ≥ 20, ESM, `tsc`), `yaml` 2.x (`parse`, `parseDocument`, `stringify`), vitest, dependency-free `.mjs` hook files.

**Spec:** `docs/superpowers/specs/2026-10-23-config-surface-design.md` (approved 2026-10-23). The § references below are its sections. **Base:** `main` at 2ea9041 (0.20.0); branch `config-surface`. **Release:** 0.21.0 (minor: new verb, new schema).

## Global Constraints

- Names the hooks read never change: `session.contextLimit`, `paths.specs`, `paths.plans`, `paths.designs`, `autonomy` (spec §4.9). `autonomy` stays a top-level `on | off` string.
- Behavior changes only through a committed diff, and `migrate` names every change (spec §2, §4.6). An in-memory read never moves a value that is in the file (§4.8).
- Section lines (`paths:`, `gates:`, `caps:` …) carry no comment, and witness's comments go at the end of setting lines (P3).
- **Narrowing the spec, with its reason:** §4.5's "no word followed by a colon" becomes "no witness comment contains `specs:`, `plans:`, `designs:` or `contextLimit:`". Those are the keys the hook readers match (P2). `junit:<glob>` is the value's real syntax and has to appear in its comment.
- `kv()` values are comma-free (`src/toon.ts` quotes a `,`), so use ` · ` as the separator in CLI output.
- The hook files stay dependency-free. `plugin-context/hooks/context-core.mjs` must stay byte-identical to `plugin/hooks/context-core.mjs`; `node scripts/sync-versions.mjs` refreshes it. No change to it is expected.
- `DEFAULT_MODEL = 'claude-opus-5-5'` and `SCHEMA_VERSION = 2` (spec §4.4, §4.2).
- Fixtures reproduce the consumer configs' **shapes** with neutral prose. This repo is public, so the real files' comments, which describe private projects, never enter it.
- `pnpm test` exits 1 on known worker-RPC timeouts. Judge a run by `Tests N passed` and the `AssertionError` count, not the exit code.
- Commits are conventional and end with `(D193)`.

## Review Focus

These are the inputs most likely to bite a user that no other task's tests cover. Each has a test in the task that owns the code:

1. **A config with YAML anchors and aliases, or written entirely in flow style** (`{schema: 1, gates: {…}}`). `migrate` keeps the resolved values and writes block style. It never drops a value. *(Task 6)*
2. **A human comment at the end of a map, at a deeper indent between two settings, or at the end of the file.** It survives `migrate`, placed above the nearest following setting, or at the end of the file. *(Task 4)*
3. **CRLF line endings and a UTF-8 BOM**, as a Windows consumer would have (rows 163/164). `loadConfig` and `migrate` read the file. `migrate` writes LF without the BOM and keeps every comment, and `contextLimitOf` reads its output. *(Task 6)*
4. **`witness migrate` run inside `.witness/worktrees/<plan>`.** It acts on the primary root's file (`primaryRoot`, as `init` does), never on the worktree's copy. *(Task 6)*
5. **A schema-1 file whose per-gate pins differ from `gates.model`, or that pins only `design`.** Expansion keeps each gate's own pin. The other gates and `arbiter.model` take `gates.model`. *(Task 3)*

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `plugin/hooks/canon-guard.mjs` | Strip comments before reading `paths:` | 1 |
| `src/settings.ts` (new) | The list: settings, gates, classes, defaults per schema, comments, fingerprints | 2 |
| `src/pin.ts` | `checkPin`, the one pin check; `MODEL_ALIASES` moves here | 2 |
| `src/config.ts` | `resolveSettings` (strict and lenient), typed `Config` with no `raw`, `loadConfig` | 3, 5 |
| `src/migration.ts` (new) | `migrateValues`: memory mode in 3, write mode and default moves in 6; `olderSchemaWarning` in 5 | 3, 5, 6 |
| `src/config-file.ts` (new) | `renderConfig`, `readComments` | 4 |
| `src/legacy-comments.ts` (new) | `LEGACY_COMMENTS`: every comment text a released witness wrote | 4 |
| `src/verbs/migrate.ts` (new) | The verb: guards, output, `--dry-run`, commit | 6 |
| 14 consumer files (Task 3 lists them) | Read typed fields instead of `cfg.raw` | 3 |
| `src/verbs/init.ts`, `src/calibrate.ts` | Write schema-2 files | 5 |
| `tests/helpers.ts` | `configYaml`, `patchConfig`; schema-2 `singleConfig`, `workspaceConfig`, `autonomyOn` | 5 |
| `fixtures/configs/` (new) | Shape copies of the consumers, the 0.20.0 template, snapshots | 3, 4, 6 |
| `README.md`, `DESIGN.md`, `plugin/skills/witness-design/SKILL.md` | The record | 7 |

---

### Task 1: The canon guard reads `paths:` without its comments

**Files:**
- Modify: `plugin/hooks/canon-guard.mjs:29-43` (`canonDirs`)
- Test: `tests/canon-guard.test.ts` (add to `describe('canonGuard — configured canon roots')`)

**Interfaces:** unchanged (`canonGuard` export). Nothing later consumes new names.

- [ ] **Step 1: Write the failing tests.** Each writes a `witness.config.yaml` with `paths:` pointing at `docs/specs`, `docs/plans` and `docs/designs`. Each asserts that an `Edit` on `docs/specs/x.md` is blocked and that an `Edit` on `specs/x.md` is not.
  - `it('reads paths under a comment line that names a key (P2)')`: the block has `  # repo-relative; for specs: no . or ..` above `  specs: docs/specs`.
  - `it('reads paths when the section line carries a comment (P3)')`: the first line is `paths:  # canon roots`.
  - `it('reads paths with end-of-line comments')`: `  specs: docs/specs  # where specs live` (already passes; it pins the form `renderConfig` writes).
- [ ] **Step 2: Run them.** `pnpm exec vitest run tests/canon-guard.test.ts` should fail. P2 blocks nothing under `docs/specs`, and P3 guards `specs/`.
- [ ] **Step 3: Implement.** In `canonDirs`, strip comments with context-core's rule: `line.replace(/(^|\s)#.*$/, '')`, line by line, over the section line and its child lines, before either regex runs. The block regex must accept a `paths:` line whose remainder is empty after stripping.
- [ ] **Step 4: Run.** `pnpm exec vitest run tests/canon-guard.test.ts tests/hooks-guard.test.ts tests/pi-extension.test.ts`. Expect PASS.
- [ ] **Step 5: Commit.** `fix(guard): read paths: without its comments (D193)`

---

### Task 2: The settings list

**Files:**
- Create: `src/settings.ts`
- Modify: `src/pin.ts` (add `checkPin`, move `MODEL_ALIASES` here); `src/model.ts` (re-export `MODEL_ALIASES` from `./pin.js`; `stagePin` calls `checkPin`); `src/gate.ts` (the `GateName` and `ChangeClass` types and `DEFAULT_BATTERIES` come from `./settings.js`; re-export both types so existing imports keep working)
- Test: `tests/settings.test.ts`

**Interfaces (produces):**

```ts
// src/settings.ts
export const GATE_NAMES = ['decompose', 'plan', 'design', 'implement', 'ship'] as const   // file order
export type GateName = (typeof GATE_NAMES)[number]
export const CHANGE_CLASSES = ['feature', 'fix', 'chore'] as const
export type ChangeClass = (typeof CHANGE_CLASSES)[number]
export type Battery = string[] | Record<ChangeClass, string[]>
export const DEFAULT_MODEL = 'claude-opus-5-5'
export const DEFAULT_BATTERIES: Record<GateName, Battery>        // verbatim from gate.ts:107-117
export type Shape =
  | { kind: 'int'; min: number; max?: number } | { kind: 'bool' } | { kind: 'enum'; values: readonly string[] }
  | { kind: 'text' } | { kind: 'dir' } | { kind: 'files' } | { kind: 'globs' }
  | { kind: 'runner' } | { kind: 'report' } | { kind: 'pin' } | { kind: 'battery' }
export type Group = 'setup' | 'behavior' | 'tuning'
export interface Setting {
  path: string                                   // dotted, e.g. 'session.contextLimit'
  shape: Shape
  since: number                                  // first schema holding it
  defaults: Readonly<Record<number, unknown>>    // schema → default from that schema on
  ambient?: true    // absent in an older file meant something else (detection, the chain, "not configured"): stays absent in memory
  hookRead?: true   // read outside the CLI (§4.9): never moves or renames
  group: Group
  comment: string   // the end-of-line comment in the file
  want: string      // want: of an `invalid` refusal
}
export interface Retired { path: string; until: number; shape: Shape; instead: string }
export const SETTINGS: readonly Setting[]
export const RETIRED: readonly Retired[]
export const SECTION_ORDER: readonly string[]    // harness paths docs criteria ship autonomy arbiter session implement gates drive
export const FIRST_LINE: string                  // '# witness.config.yaml — every setting witness reads. Change a value in place; `witness migrate` keeps the file current.'
export const SCHEMA_COMMENT: string              // 'format version · witness migrate raises it; never edit by hand'
export const GROUP_HEADINGS: Record<Group, string>   // the three heading lines of §4.5, verbatim
export function settingAt(path: string, list?: readonly Setting[]): Setting | undefined
export function defaultAt(s: Setting, schema: number): unknown          // greatest key ≤ schema; undefined before `since`
export function knownAt(schema: number, list?: readonly Setting[]): Set<string>   // since ≤ schema, plus RETIRED with until ≥ schema
export function defaultValues(opts?: { harness?: string; schema?: number }): Record<string, unknown>   // nested raw, `schema` key included
export function withValues(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown>  // maps merge, everything else replaces, undefined deletes
export function fingerprint(schema: number, list?: readonly Setting[]): string     // sha256 hex
export const SCHEMA_FINGERPRINTS: Readonly<Record<number, string>>             // entries for 1 and 2

// src/pin.ts
export const MODEL_ALIASES: readonly string[]    // moved from model.ts unchanged
export function checkPin(field: string, raw: string): Result<string>   // parsePin + the alias refusal, today's rules and texts (model.ts:57-66)
```

**The list.** 36 entries, in this order. The file adds `schema` as its 37th line. Every setting except `arbiter.model` has `since: 1`. `defaults` is `{1: x}` unless the table says otherwise. Comments are §4.5's, verbatim. The per-class comments `for a feature`, `for a fix` and `for a chore` are rendered by `renderConfig` (Task 4), not stored here.

| path | shape | default | flags |
|---|---|---|---|
| `harness` | `text` (value checked where it is used, as today, row 87) | `'claude-code'` | ambient |
| `paths.specs` · `.plans` · `.designs` | `dir` | `'specs'` · `'plans'` · `'designs'` | hookRead |
| `docs.conventions` · `docs.design` | `files` | `[]` | |
| `criteria.runner` | `runner` | `'npm test -- -t "@spec:{id}"'` | ambient |
| `criteria.report` | `report` | `'none'` | |
| `criteria.exclude` | `globs` | `[]` | |
| `ship.test` · `ship.lint` | `text` | `'npm test'` · `'npm run lint'` | ambient |
| `ship.branch` | `text` | `'main'` | |
| `ship.merge` | `enum merge squash rebase` | `'merge'` | |
| `ship.ciSettleMs` | `int 0..1800000` | `60000` | |
| `autonomy` | `enum on off` | `'off'` | hookRead |
| `arbiter.model` | `pin` | `{2: DEFAULT_MODEL}`, `since: 2` | ambient |
| `session.contextLimit` | `int 1..100` | `20` | hookRead |
| `implement.stepsPerDispatch` | `int ≥1` | `3` | |
| `gates.reviewerTimeoutMs` | `int ≥1` | `600000` | |
| `gates.<g>.model` ×5 | `pin` | `{2: DEFAULT_MODEL}` (schema 1 had no default: the chain) | ambient |
| `gates.<g>.reviewers` ×5 | `battery` | `DEFAULT_BATTERIES[g]` | |
| `drive.parallel` · `drive.parallelSuites` · `drive.sessionTimeoutMs` | `int ≥1` · `bool` · `int ≥1` | `2` · `false` · `3600000` | |
| `drive.caps.rounds` · `.upstream` · `.spawns` · `.wallClockMs` | `int ≥1` | `16` · `6` · `24` · `57600000` | |

`group` follows §4.5's three groups. **Wants:** each existing setting keeps today's `want:` text verbatim (copy them from `src/config.ts`), with three exceptions: `docs.*` becomes `a list of repo-relative file paths ([] = none)`, `criteria.report` becomes `none, or junit:<glob> (only junit is supported)`, and `battery-shape` gains `— a per-class map names feature, fix and chore`. New wants:
- `harness`: `claude-code | pi — the judge: which agent CLI runs this repo's gate reviewers and arbiter`
- `ship.test`, `ship.lint`: `a shell command`
- `ship.branch`: `a branch name`
- `criteria.exclude`: `a list of globs ([] = none)`
- pins: `checkPin`'s texts

**`RETIRED`:** `[{ path: 'gates.model', until: 1, shape: { kind: 'pin' }, instead: "each gate's own model (gates.<gate>.model) and arbiter.model — witness migrate writes them from it" }]`.

**`fingerprint(s)`:** the sha256 of `JSON.stringify` over `[path, shape, since, defaultAt(·, s)]` for every setting known at `s`, sorted by path, plus `RETIRED` entries alive at `s`. It ignores `comment`, `want` and `group`, so a comment-only change raises no schema step (§4.1).

- [ ] **Step 1: Write the failing tests** (`tests/settings.test.ts`):
  - `it('holds 36 settings, each path once, each section in SECTION_ORDER')`
  - `it('marks exactly the settings the hooks read')`: `SETTINGS.filter(s => s.hookRead).map(s => s.path)` equals `['paths.specs', 'paths.plans', 'paths.designs', 'autonomy', 'session.contextLimit']`, as a set.
  - `it('no comment names a key the hook readers match')`: no `comment`, `FIRST_LINE`, `SCHEMA_COMMENT` or heading matches `/\b(specs|plans|designs|contextLimit):/`.
  - `it('knows gates.model at schema 1 and arbiter.model only from 2')`: `knownAt(1).has('gates.model')`, `!knownAt(1).has('arbiter.model')`, `knownAt(2).has('arbiter.model')`, `!knownAt(2).has('gates.model')`.
  - `it('gives the defaults of §4.5')`: `defaultValues({ harness: 'claude-code' })` deep-equals the YAML block in spec §4.5, parsed (copy it into `fixtures/configs/default.yaml` now; Task 4 snapshots the same file). `defaultAt(gates.plan.model, 1)` is `undefined`; at 2 it is `'claude-opus-5-5'`.
  - `it('withValues merges maps, replaces lists, deletes on undefined')`
  - `it('pins every schema fingerprint')`: for each `s` in `SCHEMA_FINGERPRINTS`, `fingerprint(s) === SCHEMA_FINGERPRINTS[s]`. The test's failure message names the rule: a change to a path, shape or default needs a new schema step.
  - In `tests/pin.test.ts`: `it('checkPin refuses an alias and a malformed pin with today\'s texts')`, for example `checkPin('gates.plan.model', 'opus')` → `alias-refused`.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/settings.test.ts tests/pin.test.ts`. Expect FAIL (module missing).
- [ ] **Step 3: Implement** `src/settings.ts` and `checkPin` per the interfaces. To record the two fingerprints, run the test once and copy the values it prints. `gate.ts` and `model.ts` switch their imports. No behavior changes.
- [ ] **Step 4: Run** the two test files, then `pnpm typecheck`, then `pnpm exec vitest run tests/gate-engine.test.ts tests/model.test.ts tests/battery.test.ts`. Expect PASS.
- [ ] **Step 5: Commit.** `feat(settings): one list of every config setting (D193)`

---

### Task 3: Config is read once, typed, from the list (still schema 1)

`SCHEMA_VERSION` stays 1 in this task. A schema-1 file goes through `migrateValues` in memory and then the lenient resolver, so every reader gets schema-2-shaped typed values with today's behavior. The whole existing suite is the regression test.

**Files:**
- Create: `src/migration.ts`; `fixtures/configs/consumer-a.yaml`, `consumer-b.yaml`, `consumer-c.yaml`, `init-0.20.0.yaml`
- Modify: `src/config.ts` (replace `resolveImplement`, `resolveSession`, `resolveGates`, `resolveDrive`, `resolveAutonomy`, `resolveShip`, `resolveDocs` and the body of `loadConfig`; keep `resolvePaths` and `resolveSession` exported as seams; remove `Config.raw`)
- Consumers, each `cfg.raw` read becoming a typed field:

| File and line | Change |
|---|---|
| `src/model.ts:52-110` | `stagePin(cfg, role: GateName \| 'arbiter')`, `resolveModel(cfg, matrix, role)` |
| `src/arbiter.ts:79,84` | `resolveJudge(ctx.env, cfg.harness)`; `resolveModel(cfg, …, 'arbiter')` |
| `src/gate.ts:120-128,314` | `batteryFor` reads `cfg.gates[gate].reviewers` |
| `src/harness.ts:262-293` | `resolveJudge(env, declared: string \| undefined)`, `resolveDriver(env, declared: string \| undefined)` |
| `src/runner.ts:14-51` | `cfg.criteria.*`, `cfg.ship.test` |
| `src/ship.ts:213,376`, `src/evidence.ts:155`, `src/verbs/start.ts:41`, `src/verbs/check.ts:125`, `src/verbs/dashboard.ts:256` | `cfg.ship.branch` |
| `src/gates/ship.ts:79` | `cfg.ship.test`, `cfg.ship.lint` |
| `src/drive.ts:160`, `src/drift.ts:136`, `src/drive-report.ts:74`, `src/slice.ts:176`, `src/verbs/next.ts:687,979,985`, `src/verbs/calibrate.ts:75`, `src/verbs/dashboard.ts:239`, `src/verbs/dispatch.ts:84`, `src/verbs/check.ts:70,339,345`, `src/context.ts:22`, `src/verbs/init.ts:95` | Pass `cfg.harness` (or `undefined`) to the two resolvers |

- Test: `tests/config-typed.test.ts` (new); update `tests/config.test.ts`, `tests/model.test.ts`, `tests/paths.test.ts`, `tests/context-core.test.ts` (the `resolveSession` seam stays) and every test reading `.raw`.

**Interfaces:**
- Consumes: Task 2's `SETTINGS`, `RETIRED`, `defaultAt`, `knownAt`, `checkPin`, `Battery`, `GateName`.
- Produces:

```ts
// src/config.ts
export interface GateSettings { model?: string; reviewers: Battery }
export type GatesConfig = { reviewerTimeoutMs: number } & Record<GateName, GateSettings>
export interface CriteriaConfig { runner?: string; report?: string; exclude: string[] }   // report undefined = none
export interface ShipConfig { test?: string; lint?: string; branch: string; merge: MergeStyle; ciSettleMs: number }
export interface Config {
  schema: number; paths: CanonPaths; docs: DocsRegistry; criteria: CriteriaConfig; ship: ShipConfig
  harness?: string; autonomy: boolean; arbiter: { model?: string }; session: SessionConfig
  implement: ImplementConfig; gates: GatesConfig; drive: DriveConfig; warning?: string
}  // optional members are undefined only for an older file read in memory; schema 2 guarantees them (Task 5)
export type Resolved = Omit<Config, 'schema' | 'warning'>
export function resolveSettings(raw: Record<string, unknown>, mode: 'strict' | 'lenient'): Result<Resolved>

// src/migration.ts
export type ChangeKind = 'added' | 'filled' | 'expanded' | 'moved'
export interface Change { kind: ChangeKind; path: string; from?: unknown; to: unknown }
export function migrateValues(raw: Record<string, unknown>, from: number, opts: {
  mode: 'memory' | 'write'; to?: number; settings?: readonly Setting[]; harness?: string
}): Result<{ raw: Record<string, unknown>; changes: Change[] }>
```

**Rules:**
- **`resolveSettings` validates each present value by its shape, in both modes.** Each shape refuses with today's rule codes and texts: `invalid`, `reserved`, `overlap`, `nested`, `unknown-doc-key`, `unknown-drive-key`, `pin-malformed`, `alias-refused`, `battery-shape`, `no-id-placeholder` and `report-format`. Empty `files` and `globs` lists are valid, and an empty `docs` list leaves that key out of `DocsRegistry`. `report: 'none'` resolves to `undefined`. A per-class battery must name all three classes.
- **Lenient mode** (an older file, after `migrateValues`) ignores unknown keys outside `docs` and `drive`, as schema 1 did, and allows an absent `ambient` setting (it becomes `undefined`).
- **Strict mode** refuses those cases. Task 5 tests it; implement it here, because it is the same walk.
- **`migrateValues` in memory mode** runs each schema step from `from` to `to`. `to` defaults to the newest schema in `SCHEMA_FINGERPRINTS`, which is 2.
  - The 1 → 2 step: each gate's `model` is its own pin, else `gates.model` if present; `arbiter.model` becomes `gates.model` if present; `gates.model` is deleted. Each copy is recorded as `expanded`.
  - Then, for any `from ≤ to` (equal included, which `migrate` relies on), every missing non-ambient setting is set to `defaultAt(·, to)` and recorded as `added`.
  - Ambient settings stay absent.
  - An invalid `gates.model` is refused under its own name before it is copied.
  - Memory mode never moves a value.
- **`loadConfig`:** when the schema is lower than the list's newest (2), it runs `migrateValues(…, { mode: 'memory' })`, then `resolveSettings(…, 'lenient')`. It then applies the committed-autonomy rule (`config.ts:315`) and today's warnings. With `SCHEMA_VERSION` still 1, a `schema: 1` file takes this path and prints no older-schema warning yet.
- **`stagePin(cfg, 'arbiter')`** reads `cfg.arbiter.model`, and a gate reads `cfg.gates[gate].model`. A refusal names `arbiter.model` or `gates.<gate>.model`. `checkPin` runs at use in both places, as today.
- **`check`'s `unknown-harness` finding** (`check.ts:339`) reads `cfg.harness`.

**Fixtures** (`fixtures/configs/`): shape copies with neutral prose (Global Constraints).
- `consumer-a.yaml` is fewhats.com's shape: flow `paths`; `docs` block with block comments; `gates.model` plus pins on `implement` and `ship`; multi-line flow `feature:` list; `criteria` with comments; flow `ship`; `harness: pi   # the judge — …` (recordHarness's text); `autonomy: on` under a block comment.
- `consumer-b.yaml` and `consumer-c.yaml` are the other two consumers' shapes. They include the old template's own-line lines (`# any gate block may pin its own model (wins over the global pin), e.g.` and the line after it) verbatim.
- `init-0.20.0.yaml` is today's `DEFAULT_CONFIG` (`src/verbs/init.ts:18-38`), byte for byte.

- [ ] **Step 1: Write the failing tests** (`tests/config-typed.test.ts`):
  - `it('resolves consumer-a to today\'s values')`. The expected values are written out in the test, not computed:
    - every `gates.<g>.model` is `claude-opus-5-5`, and so is `arbiter.model`;
    - every `reviewers` equals `DEFAULT_BATTERIES`;
    - `ship` is `{ test: 'pnpm test', lint: 'pnpm lint && pnpm typecheck', branch: 'main', merge: 'merge', ciSettleMs: 60000 }`;
    - `criteria` is `{ runner: 'full-suite', report: 'junit:reports/junit.xml', exclude: ['docs/superpowers/**'] }`;
    - `harness` is `'pi'`, `session.contextLimit` is 20, the drive caps are the defaults, and `autonomy` is false (uncommitted fixture).
  - `it('resolves consumer-b and consumer-c to today\'s values')`: the same check for their shapes. Every pin and `arbiter.model` is `claude-opus-5`, and their `ship.lint` values are written out in the test.
  - `it('keeps a per-gate pin and gives the rest gates.model')` (Review Focus 5): `gates: { model: X, plan: { model: Y }, design: { model: Z } }` resolves plan to Y, design to Z, and decompose, implement, ship and the arbiter to X.
  - `it('leaves pins, harness, runner and ship commands absent when the file never set them')`: `schema: 1` alone gives `harness`, every `model`, `arbiter.model`, `criteria.runner`, `ship.test` and `ship.lint` as `undefined`, and `reviewers` as the defaults.
  - `it('refuses an alias gates.model under its own name')`: field `gates.model`, rule `alias-refused`.
  - `it('accepts empty docs lists as none')`: `docs: { conventions: [] }` resolves to `docs` equal to `{}`.
  - `it('arbiter resolves the pin it used before')`: `resolveModel(cfg, matrix, 'arbiter').value.chain[0]` is the `gates.model` value for consumer-a.
  - Update `tests/config.test.ts`: `loads schema 1 and preserves unknown keys` becomes `loads schema 1 and ignores unknown keys` and asserts no `raw`, `cfg.ship.test === 'npm test'`. `refuses empty lists…` becomes "accepts empty lists as none; refuses non-lists, traversal and .witness paths".
- [ ] **Step 2: Run** `pnpm exec vitest run tests/config-typed.test.ts tests/config.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `resolveSettings`, `migrateValues` (memory mode only; write mode throws `not yet` until Task 6) and the `loadConfig` rewiring. Then switch every consumer in the table, and delete `Config.raw` and the replaced resolvers. `DEFAULT_*` constants, `DOC_KEYS`, `DriveCaps`, `MergeStyle`, `canonPaths`, `configPath`, `localConfigPath`, `loadLocalConfig` and `autonomyAt` keep their exports.
- [ ] **Step 4: Run** `pnpm typecheck`, then the full suite with `pnpm test`. Expect the same pass count as before this task, plus the new tests, and 0 `AssertionError`. A failure here is a behavior change. Fix it in the code, not in the test, unless the test read `raw`.
- [ ] **Step 5: Commit.** `refactor(config): one typed read of every setting, from the list (D193)`

---

### Task 4: The file renderer and comment ownership

**Files:**
- Create: `src/config-file.ts`, `src/legacy-comments.ts`
- Test: `tests/config-file.test.ts`; snapshot `fixtures/configs/default.yaml` (spec §4.5's block, from Task 2)

**Interfaces:**
- Consumes: `SETTINGS`, `SECTION_ORDER`, `GROUP_HEADINGS`, `FIRST_LINE`, `SCHEMA_COMMENT`, `GATE_NAMES`, `CHANGE_CLASSES` (Task 2).
- Produces:

```ts
// src/config-file.ts
export interface HumanComments {
  top: string[]                      // human lines above the first setting, kept under FIRST_LINE
  above: Map<string, string[]>       // dotted setting or section path → human lines to print above it
  end: string[]                      // human lines after the last setting
}
export function renderConfig(values: Record<string, unknown>, comments?: HumanComments): string
export function readComments(text: string): { human: HumanComments; legacy: number }   // legacy = witness-written lines dropped or replaced
// src/legacy-comments.ts
export const LEGACY_COMMENTS: ReadonlySet<string>   // trimmed text after '#'
```

**Rules (spec §4.5):**
- **`renderConfig`** emits `FIRST_LINE`, then `schema: N  # SCHEMA_COMMENT`, then the sections in `SECTION_ORDER`, each group introduced by its heading after one blank line.
- Every map is block style and lists are flow `[a, b]`. Witness's comment goes at the end of every setting line, never on a section line.
- An implement-style battery map prints one line per class, with `# for a <class>`.
- Scalars are quoted only where YAML needs it. `criteria.runner`'s default is written in the single quotes §4.5 shows.
- Human lines from `comments.above` print, indented to their key, directly above it.
- **`readComments`** walks `parseDocument(text)`: `commentBefore` on keys, `comment` on values, `doc.commentBefore`/`doc.comment` and map-end comments.
- A line whose trimmed text is in `LEGACY_COMMENTS`, or is a current witness comment, heading or first line, counts as witness's. Every other line is the human's.
- A human comment at the end of a setting's line moves to `above` for that setting.
- A comment above a key that no longer exists (`gates.model`) is filed under the next setting in the same section.
- **`LEGACY_COMMENTS`**: collect every comment text in every version of `DEFAULT_CONFIG` (`git log -p -- src/verbs/init.ts`, v0.4.1 onward) and `recordHarness`'s text (`src/install.ts:272`). Each continuation line counts as its own entry.

- [ ] **Step 1: Write the failing tests:**
  - `it('renders the defaults as spec §4.5')`: `expect(renderConfig(defaultValues({ harness: 'claude-code' }))).toMatchFileSnapshot('../fixtures/configs/default.yaml')`. The snapshot must equal the spec block; review any difference against §4.5, not against the code.
  - `it('round-trips values')`: `parse(renderConfig(v))` deep-equals `v`, for the defaults and for `withValues(defaults, consumer-a's values)`.
  - `it('stays readable by the hook readers')`: `contextLimitOf(renderConfig(withValues(d, { session: { contextLimit: 35 } })))` is 35, and `canonGuard` on the rendered file with `paths` set to `docs/*` blocks `docs/specs/x.md`.
  - `it('puts no comment on a section line')`: every line matching `/^\s*[a-zA-Z]+:\s*(#|$)/` has no `#`.
  - `it('drops every line the 0.20.0 template wrote')`: `readComments(init-0.20.0.yaml)` returns empty `human` and `legacy > 0`.
  - `it('drops the old inheritance advice and keeps edited copies')`: consumer-b's `# any gate block may pin its own model (wins over the global pin), e.g.` is counted as legacy. The same line with one word changed is human, under the next setting.
  - `it('files human comments by setting')`: in consumer-a, the block comment above `docs:` sits under `docs`, the one above `gates.model` under `gates.reviewerTimeoutMs`, and the one above `autonomy` under `autonomy`.
  - `it('keeps comments at a map end, between deeper settings and at file end')` (Review Focus 2): a crafted file with all three; each line comes back in `human`, and `renderConfig(values, human)` contains it.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/config-file.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the two modules per the rules.
- [ ] **Step 4: Run** the test file. Expect PASS.
- [ ] **Step 5: Commit.** `feat(config): render the commented file; tell witness comments from the human's (D193)`

---

### Task 5: Schema 2

**Files:**
- Modify:
  - `src/config.ts`: `SCHEMA_VERSION = 2`. `loadConfig` resolves a current-schema file with `resolveSettings(raw, 'strict')`. An older file takes Task 3's path and sets `warning` from `olderSchemaWarning`.
  - `src/migration.ts`: add `olderSchemaWarning`.
  - `src/verbs/init.ts`: drop `DEFAULT_CONFIG`; write `renderConfig(defaultValues({ harness }))`; print the harness line; `init --agent` on an older file prints `warn: <warning>`.
  - `src/calibrate.ts:437`: the scratch repo's config becomes `renderConfig(withValues(defaultValues({ harness: harness.name }), { criteria: { runner: 'node --test --test-name-pattern "@spec:{id}"' } }))`. The model is passed explicitly to every reviewer there, so the default pins change nothing.
- Modify tests:
  - `tests/helpers.ts`: new `configYaml` and `patchConfig`. `singleConfig` and `workspaceConfig` return `configYaml({...})` with their current values. `autonomyOn` patches. Lines 423 and 476 patch instead of appending.
  - Every test that appends text to an init'd config or to `singleConfig` switches to `patchConfig` or `configYaml`: `tests/check.test.ts`, `context-relay.test.ts`, `init.test.ts`, `runner-exec.test.ts`, `drive.test.ts`, `init-agent.test.ts`, `dashboard.test.ts`, `config.test.ts`, `next.test.ts`, `ship-merge.test.ts:30` and `protocol/pipeline.test.ts:89`.
- Test: `tests/schema-2.test.ts` (new); update `tests/init.test.ts` and `tests/check.test.ts` (the older-schema finding).

**Interfaces:**
- Consumes: Task 3's `resolveSettings` and `migrateValues`, Task 4's `renderConfig`, Task 2's `defaultValues` and `withValues`.
- Produces:

```ts
// src/migration.ts
export function olderSchemaWarning(from: number, to: number, changes: readonly Change[]): string
// tests/helpers.ts
export function configYaml(patch?: Record<string, unknown>): string      // stringify(withValues(defaultValues({ harness: 'claude-code' }), patch)), no comments
export function patchConfig(repo: TestRepo, patch: Record<string, unknown>): void   // parseDocument + setIn/deleteIn on the existing file; writes, does not commit
```

**Exact texts:**
- **Missing setting.** Field: the path. Rule: `missing-setting`. Got: `absent`. Want: `<key>: <default> under <section>: — or run witness migrate`. Example: `contextLimit: 20 under session: — or run witness migrate`.
- **Unknown key.** Rule: `unknown-key`. `docs` and `drive` keep `unknown-doc-key` and `unknown-drive-key`. Want: `a witness setting — did you mean <path>?` when one setting in the same section is within edit distance 2. Otherwise `a witness setting — the comments in witness.config.yaml list them`. A `RETIRED` path's want is its `instead`.
- **Warning:** `schema <from> is older than this witness (<to>) — witness migrate adds <n> settings (<first three paths joined by ' · '>[ · …])`. It continues with ` · expands gates.model` when an `expanded` change exists, and ends ` · refreshes comments`.
- **The harness line `init` prints:** `kv('harness', `${name} · ${from}`)`, where `from` is `from --agent`, `detected from this session` or `the default`.

- [ ] **Step 1: Write the failing tests** (`tests/schema-2.test.ts`):
  - `it('loads the file init writes, with every default')`: `cli(['init'])`, then `loadConfig` gives `schema` 2, `warning` undefined, and every resolved value equal to `defaultValues`. The file equals `fixtures/configs/default.yaml`, and its `harness` follows detection: `pi` under `PI_CODING_AGENT=1`, otherwise `claude-code`, with the matching `harness:` stdout line.
  - `it('refuses a missing setting with the line to add')`: delete `session.contextLimit` with `patchConfig(repo, { session: { contextLimit: undefined } })`. Expect field `session.contextLimit`, rule `missing-setting`, want `contextLimit: 20 under session: — or run witness migrate`.
  - `it('refuses a typo and names the setting')`: `session.contextLimt: 30` gives `unknown-key`, with a want ending `did you mean session.contextLimit?`.
  - `it('refuses gates.model in a schema-2 file')`: rule `unknown-key`, want equal to `RETIRED[0].instead`.
  - `it('reads a schema-1 file through the upgrade and warns')`: consumer-a's warning equals `schema 1 is older than this witness (2) — witness migrate adds 12 settings (ship.merge · ship.ciSettleMs · session.contextLimit · …) · expands gates.model · refreshes comments`. The added paths come in `SETTINGS` order. Consumer-a lacks `ship.merge`, `ship.ciSettleMs`, `session.contextLimit`, `implement.stepsPerDispatch`, `gates.reviewerTimeoutMs` and the seven `drive.*` settings. `check` shows it as `older-schema`.
  - `it('the CLI schema is the list\'s newest')`: `SCHEMA_VERSION === Math.max(...Object.keys(SCHEMA_FINGERPRINTS).map(Number))`.
  - `it('init --agent on an older repo prints the migrate line')`: stderr has `warn: schema 1 is older than this witness (2)`.
  - `it('calibrate writes a schema-2 scratch config')`: the scratch repo's `loadConfig` has no warning.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/schema-2.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the source changes, then the helper changes. Convert the listed append sites to `patchConfig` or `configYaml`. A YAML duplicate-key error (`Map keys must be unique`) in a run marks a site that was missed.
- [ ] **Step 4: Run** `pnpm typecheck`, then `pnpm test`. Expect 0 `AssertionError`. Remaining breaks will be exact-output assertions hit by the new warning on a `schema: 1` inline fixture. Fix each by moving that fixture to `configYaml`, unless the test is about schema 1, which keeps its text. The hook-reader suites (`context-core`, `canon-guard`, `pi-extension`, `hooks-guard`) keep their `schema: 1` texts: those readers ignore `schema`.
- [ ] **Step 5: Commit.** `feat(config)!: schema 2 — every setting in the file, init writes them all (D193)`

---

### Task 6: `witness migrate`

**Files:**
- Create: `src/verbs/migrate.ts`
- Modify: `src/cli.ts` (`VERBS.migrate`; `VERB_USAGE.migrate: 'witness migrate [--dry-run]'`); `src/migration.ts` (write mode, default moves)
- Test: `tests/migrate.test.ts`; snapshots `fixtures/configs/consumer-{a,b,c}.migrated.yaml`

**Interfaces:**
- Consumes: `migrateValues`, `resolveSettings`, `renderConfig`, `readComments`, `primaryRoot`, `acquireLock`, `commitWithTrailer`, `tryGit`, `resolveDriver`, `renderRefusal`, `kv`.
- Produces:

```ts
// src/verbs/migrate.ts
export async function run(ctx: Ctx, argv: string[]): Promise<number>
export function guardMigration(input: {
  before: Resolved; after: Resolved; changes: readonly Change[]; human: HumanComments; newText: string
}): Violation[]   // empty = safe to write
```

**Write mode** (`migrateValues(…, { mode: 'write', harness })`) does everything memory mode does, plus:
- each absent ambient setting is filled and recorded as `filled`:
  - `harness` takes `opts.harness`, the detected driver or else `claude-code`;
  - pins take `DEFAULT_MODEL`;
  - `criteria.runner`, `ship.test` and `ship.lint` take their defaults;
- for each schema step `s → s+1` up to `opts.to`, a value deep-equal to `defaultAt(·, s)` whose default changes at `s+1` takes the new default, recorded as `moved`;
- `schema` is set to `to`.

**The verb**, in order:
1. Resolve the primary root, then parse `--dry-run`. An unknown flag or a stray positional refuses `bad-arguments` with the usage line and exit 2, as row 113 requires of every verb that parses argv strictly.
2. Refuse when there is no config (`missing`), a YAML error, or a newer schema (today's rules).
3. Refuse when the file has keys unknown at its own schema (`knownAt(schema)`), naming each with the same suggestion rule as Task 5.
4. Refuse when the old file holds an invalid value. Resolve it the way `loadConfig` reads an older file, `migrateValues(…, { mode: 'memory' })` then `resolveSettings(…, 'lenient')`, and print its violations. Memory mode also fills settings missing from a current-schema file, so a deleted setting is restored here, not refused. This result is the guard's `before`.
5. Refuse `dirty` when `git status --porcelain -- witness.config.yaml` is not empty. Want: `commit or clean witness.config.yaml first`.
6. Compute the write-mode values, `readComments(oldText)` and `renderConfig(newValues, human)`. Compare `resolveSettings(old-through-memory, 'lenient')` with `resolveSettings(parse(newText), 'strict')` through `guardMigration`. Refuse on any violation:
   - `value-changed`: a typed value differs and no `filled` or `moved` change names it;
   - `comment-lost`: a human line's text is missing from `newText`;
   - `invalid-output`: the new text does not strict-resolve.
7. When `newText === oldText`, print `config: schema N · up to date`, exit 0, and do nothing else.
8. Print one `kv` line per change, in `SETTINGS` order:
   - `added: session.contextLimit 20 — <comment>`
   - `filled: harness claude-code — was undeclared · the open session's harness judged`
   - `expanded: gates.model claude-opus-5-5 → decompose · plan · design · arbiter.model`
   - `moved: drive.caps.spawns 24 → 30 — default changed in schema 3`
   
   Then `comments: kept <k> · moved <m> · dropped <l> old template lines`, then `config: schema N → M`.
9. With `--dry-run`, add a `diff:` block of `git diff --no-index --no-color` between temp copies of the old and new text, and write nothing. Otherwise take the repo lock, write LF text without a BOM, and `commitWithTrailer(root, ['witness.config.yaml'], 'migrate: config schema N → M')`.

- [ ] **Step 1: Write the failing tests** (`tests/migrate.test.ts`). Each copies a fixture into a `tmpRepo()` and commits it first.
  - `it('migrates consumer-%s and keeps every value and human comment')` (each of a, b, c):
    - exit 0;
    - the file matches `fixtures/configs/consumer-<x>.migrated.yaml` (`toMatchFileSnapshot`);
    - `loadConfig` has no warning, and its values equal the pre-migrate in-memory values, apart from the `filled` changes the output lists;
    - every human comment line from `readComments(before)` appears in the file;
    - consumer-b and consumer-c report `dropped 2 old template lines`;
    - the last commit's subject is `migrate: config schema 1 → 2` and it carries the state trailer.
  - `it('is idempotent')`: a second run prints `config: schema 2 · up to date` and makes no new commit.
  - `it('restores a deleted setting in a current file')`: remove `drive.caps.spawns` from a schema-2 file. The output has `added: drive.caps.spawns 24 —`, and the file strict-resolves.
  - `it('refuses unknown keys with a suggestion')`: `session.contextLimt` gives `unknown-key … did you mean session.contextLimit?`, and the file is unchanged.
  - `it('refuses an uncommitted config')`: rule `dirty`.
  - `it('refuses a newer schema')`: `schema: 3` gives `newer-than-cli`.
  - `it('guard refuses a changed value and a lost comment')`: `guardMigration` with a crafted `after` where `ship.branch` differs and nothing names it gives `value-changed`; with a `newText` missing one human line, it gives `comment-lost`.
  - `it('moves a value at the old default and keeps a choice')`: run `migrateValues` with a synthetic list where `drive.caps.spawns` has `{1: 24, 3: 30}` and `to: 3`. A file at 24 moves to 30 and is recorded `moved`; a file at 20 stays.
  - `it('--dry-run prints the changes and a diff and writes nothing')`
  - `it('an unknown flag renders the usage (row 113)')`: `migrate --dryrun` exits 2, and its output contains `bad-arguments` and `witness migrate [--dry-run]`, never `unexpected-error`.
  - `it('fills what a bare schema-1 file never declared and names each')`: run `schema: 1` alone under `PI_CODING_AGENT=1`. The output has `filled: harness pi — was undeclared …`, a `filled:` line for each of the five gate pins and `arbiter.model` (`claude-opus-5-5`), and `filled:` lines for `criteria.runner`, `ship.test` and `ship.lint`.
  - `it('keeps anchored and all-flow values')` (Review Focus 1): `{schema: 1, gates: {model: &m claude-opus-5-5, ship: {model: *m}}}` migrates with every gate at `claude-opus-5-5`, in block style.
  - `it('reads CRLF and a BOM and writes LF')` (Review Focus 3): consumer-a with `\r\n` and a BOM migrates. The output has no `\r` and no BOM, every human comment is kept, and `contextLimitOf(output)` is 20.
  - `it('acts on the primary root from a worktree')` (Review Focus 4): run from `.witness/worktrees/<id>`. The primary root's file is migrated, and the worktree's copy is untouched.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/migrate.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** write mode, `guardMigration` and the verb. Review the three `*.migrated.yaml` snapshots by hand against spec §4.5's layout before committing them.
- [ ] **Step 4: Run** `pnpm exec vitest run tests/migrate.test.ts tests/cli.test.ts`, then `pnpm test`. Expect 0 `AssertionError`.
- [ ] **Step 5: Commit.** `feat(migrate): bring witness.config.yaml to the current schema, naming every change (D193)`

---

### Task 7: The record

**Files:**
- Modify:
  - `README.md:163-180`: the table between `<!-- settings:start -->` and `<!-- settings:end -->` markers is generated. The prose after it stays (the judge ladder note, "There is no `provider:` key", …). Add a short "Upgrading" paragraph: `witness migrate` after each upgrade, `--dry-run` first.
  - `DESIGN.md` (rows and blocks below).
  - `plugin/skills/witness-design/SKILL.md:56-57`: the example becomes the block form `docs:` / `  design: [docs/ui/design-language.md, …]`.
  - `src/settings.ts`: add `settingsTable()`.
- Test: `tests/settings-docs.test.ts`

**Interfaces:** produces `export function settingsTable(): string`. Its columns are `| Setting | What it does | Default |`. One row per `SETTINGS` entry. The middle column joins `comment` and `want`.

**DESIGN.md:**
- **New row 193 (⊜, 2026-10-23, no grill).** One paragraph, in the house shape (Choice | Why), covering spec §4.1–§4.9, probes P1–P4 and the residuals of spec §7. Plus one more residual: a schema-1 file holding an invalid value that used to refuse only when its stage ran (an alias pin, a runner without `{id}`) now refuses at load.
- **Amended rows** (13, 14, 23, 55, 68, 105, 172) each get a one-line `Amended by 193: …` in their Choice column, with the wording of spec §5. Row 191 gets the one-line touch from §5: `session.contextLimit` is now in every file, and the adapter's own default matters only for older files.
- **Legend:** append the row 193 sentence.
- **Config block** (`DESIGN.md:283-302`) becomes `fixtures/configs/default.yaml`'s text.
- **"Config:" bullet** (`DESIGN.md:280`) becomes: "complete and explicit: every setting in the file with its comment; strong defaults survive as the values `init` writes; `witness migrate` keeps a repo's file current (193)."

- [ ] **Step 1: Write the failing test:** `it('README lists every setting, generated from the list')` extracts the README text between the markers and expects it to equal `settingsTable()`. Its failure message prints `settingsTable()`, so the block can be pasted.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/settings-docs.test.ts`. Expect FAIL (markers missing).
- [ ] **Step 3: Implement** `settingsTable()`, paste the block, and write the DESIGN.md row, amendments and blocks, plus the skill example.
- [ ] **Step 4: Run** `pnpm exec vitest run tests/settings-docs.test.ts tests/harness-neutrality.test.ts tests/calibrate-skills.test.ts`, then `pnpm test`. Expect 0 `AssertionError`.
- [ ] **Step 5: Commit.** `docs: the config surface record — README table, DESIGN row 193 (D193)`

---

## After the plan

- **Release 0.21.0.** The user runs `pnpm release minor`: the classifier blocks the release script for the agent.
- **Rollout.** This is the user's act, or needs their yes:
  - fewhats.com: upgrade, `witness migrate --dry-run`, review, `witness migrate`, then `witness check`, which should show 0 errors and no `older-schema` finding;
  - hear-your-customer-mvp: the same;
  - know-your-customer-mvp stays on 0.14.4.
- **Payload refresh.** `init --agent pi` and `init --agent claude-code` in each consumer, so the fixed canon guard (Task 1) reaches it.
