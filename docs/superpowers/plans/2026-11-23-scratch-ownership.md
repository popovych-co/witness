# witness — Every scratch directory has one owner (issue #99) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A green `pnpm test` leaves nothing in `$TMPDIR`, a failing test leaves exactly the directories it (and its file's shared setup) made and prints their paths, and `witness diff` stops leaving a `witness-diff-…` directory per run.

**Architecture:** One owner per side. Tests make scratch directories only through `scratchDir(prefix, opts)` in `tests/scratch.ts`, which binds each directory's lifetime to the scope vitest is running when it is made: inside a test (body, `beforeEach`, `afterEach`) to that test, through `onTestFinished`; anywhere else (`beforeAll`, `afterAll`, a describe body, module scope), or when asked with `shared: true`, to the test file, through a setup file's `afterAll`. A passing or skipped owner's directories are removed; a failed owner's are kept and named. Each scratch directory is `<home>/<name>` inside a home of its own, so a sibling a test makes beside it (`${root}-origin.git`, `join(root, '..', …)`) lands in the home and goes with it. The CLI makes scratch directories only through `withScratch(prefix, use)` in `src/scratch.ts`, which removes the directory when `use` returns or throws. A guard test holds both sides to their owner.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), vitest 3.2.7 (`onTestFinished` from `vitest`, `getCurrentTest` from `vitest/suite`), the git CLI.

**Spec:** GitHub issue #99 (`gh issue view 99`) — "tests: fixture temp dirs are never removed". Its *Root cause* and *Root fix* sections are the spec. Where this plan differs from them, *Settled while planning* below says why; the plan wins. This plan adds row **268** (rows 255–267 are taken by the unmerged `trust-t2` branch; T2e numbers from 269).

## Settled while planning (probed 2026-11-23, main 5594203)

1. **The issue reproduces exactly.** `npx vitest run tests/diff.test.ts tests/fixtures.test.ts tests/arbiter-ask.test.ts`: 11 tests pass and leave 11 `witness-…`, 2 `witness-fake-…` and 1 `witness-diff-…` (holding `base.md`, `current.md`).
2. **What a full green run leaves today.** `caffeinate -dims npx vitest run` from the main checkout: 3,686 tests passed, 23 skipped, 1,127 s wall clock, and **3,819 new entries** in `$TMPDIR` — 2,049 `witness-…` (tmpRepo), 905 `witness-fake-…`, 173 `witness-…-origin.git`, 160 `witness-live-…`, 100 `witness-screens-…`, 81 `witness-arbiter-walk-…`, then 60-odd smaller prefixes, every one a raw site Task 4 lists, a sibling (item 3), or `witness-diff-…` (1). Every leftover's prefix is a string literal in `tests/` or `src/`; nothing came from elsewhere. (The run also reported 44 failed *files*: the main checkout's gitignored `.superpowers/sdd/**` holds old probe `*.test.ts` files that vitest collects and cannot load. Not this issue; the build's worktree has no `.superpowers/`.)
3. **A third leak class the issue does not name: siblings of a scratch directory.** Tests make `${repo.root}-origin.git` (`addOrigin`, `tests/helpers.ts:923`), `-other`, `-collab`, `-wt`, `-empty.git`, `-origin.gone`, `-first`, `-second`, `-base`, `-clash` (`tests/ship-lease.test.ts:31`) and, through `join(repo.root, '..', …)`, `-ask-a1.json` and `-wt` (`tests/draft.test.ts:98`, `tests/gitio.test.ts:47`) — directly in `$TMPDIR`. Not only beside repos: `tests/protocol/pipeline.test.ts:79` uses a `fakeScenario()` directory as its repo root and makes `${root}-origin.git` beside it (the full run left `witness-fake-…-origin.git`). This machine's `$TMPDIR` held 1,384 `witness-…-origin.git` before the run. So containment belongs to the primitive, not to `tmpRepo`: every scratch directory is `<home>/<name>`, and whatever a test names beside it is in the home.
4. **The issue's "every call site runs inside a test body" is false.** An AST pass over `tests/**` (following wrappers transitively) finds allocations in 11 `beforeAll`s — `decide-live:41`, `drive-turn-end:88`, `handback-arbiter:563`, `reviewer-guard:7`, `screens-live:50` and `:536`, `ship-phase-disposition:241` and `:385`, `protocol/pipeline:79` and `:80` — one describe body (`verdict:187`, at collection) and module scope (`ship-carry:122`, `gitSpeaksGerman()`). A factory that threw outside a test would break all thirteen; they are shared fixtures (a real gate round, 120 s budget) whose right lifetime is the file.
5. **Three caches hold a scratch directory across tests:** `tests/shells.ts` `stubScript()` (row 239 measured a fresh stub's first run at 140–190 ms, so one stub serves the file), and the `built` maps behind `copyOf` in `tests/decide-live.test.ts:116` and `tests/handback-arbiter.test.ts:533`. Each is made lazily inside whichever test first needs it, so scope detection alone would bind it to that test and remove it under the next. They ask for `shared: true`. A cache this plan misses fails loudly (ENOENT in a later test of that file), never silently.
6. **The runner, read and then run (vitest 3.2.7, `@vitest/runner/dist/chunk-hooks.js`).** `setCurrentTest(test)` precedes `beforeEach`; per attempt the order is body → state → `afterEach` → `onFinished` (stack order) → `onFailed` (only on fail), so `onTestFinished` sees the final state and dirs kept on failure are still there for anything printed after. `ctx.skip()` still reaches `onFinished` (state `skip`). A throwing `beforeAll` fails its suite before `afterAll` runs, and nested suites' results are final by the file's `afterAll`. `getCurrentTest` is public through `vitest/suite`. A throwaway prototype of this plan's `scratchDir` + setup file, run by the repo's vitest with `TMPDIR` pointed at an empty probe: in a passing run every directory went (test, skipped test, `beforeEach`, `beforeAll`, collection-time) and the probe ended empty — the nested vitest itself leaves nothing there; in a failing run the probe held exactly the failing tests' directories, the timed-out test's, the throwing `beforeAll`'s and the failed file's shared ones, each printed.
7. **The CLI has six scratch sites; five wrap theirs.** `src/snapshot.ts:56`, `src/held.ts:90` and `:286`, `src/carry.ts:405`, `src/verbs/migrate.ts:107` each pair `mkdtempSync` with `finally { rmSync }` by hand; `src/verbs/diff.ts:79` does not. The root is that each site hand-rolls the pairing: one primitive makes forgetting impossible, and the guard keeps a seventh site from hand-rolling it again.
8. **Ruled out:** no test state leaks into `$HOME` (`~/.pi/agent/sessions/witness-drive` is empty; `allow.json` is repo-local, `src/allowlist.ts:11`); the fakes (`fixtures/fakebin/`) and `scripts/` make no temp directories; no test uses `.concurrent`, `.fails`, `retry` or `ctx.skip`, and only `fake-trails.ts` uses `onTestFailed`; CI is ubuntu-only.

**Designer calls.**
- *Keep on failure is per owner.* A failed test keeps its own directories; a file in which any task failed keeps its file-scoped ones (they are the shared state the failing test read). A passing or skipped owner's go.
- *A removal that fails, fails the test.* No `maxRetries`: on macOS and Linux `rmSync(…, { force: true })` fails only when something still writes into the fixture, and that is a test leaving a process running (row 218's rule), which the failure's path names.
- *Every scratch directory is realpath'd* (today only `tmpRepo` and the `copyOf`s are), so paths compare equal to what git and the CLI report on macOS (`/var` → `/private/var`).
- *A scratch directory is `<home>/<name>`*, `<name>` its prefix without the trailing `-`, so every fixture repo's basename is `witness`. Tests that print it read `basename(repo.root)` (`tests/drive.test.ts:1287`, `tests/drive-report.test.ts:58`); pi's transcript folder hashes the full path (`src/harness.ts:283`); no test regexes a path's random suffix; no test or src path is a Unix socket (the extra level is ~10 characters).
- *Fake trails are `fakeScenario`'s failure report*, so `tests/scenarios.ts` and `tests/fake-trails.ts` retire: one lifecycle, one place a failure is explained.

**Upgrade effect.** None on any consumer surface except that `witness diff` no longer leaves a directory in the user's `$TMPDIR`. No config, schema, prompt, journal or output change. Ships as a patch.

## Global Constraints

- vitest stays at `^3.0.0` (3.2.7 installed); use only `onTestFinished`/`afterAll` from `vitest` and `getCurrentTest` from `vitest/suite`.
- A setup file loads nothing of `src/` and never `tests/helpers.ts`, directly or through its imports (`tests/setup-files.test.ts`, row 213). `tests/scratch.ts` imports only `node:*`, `vitest` and `vitest/suite`.
- A test that runs real processes awaits them (`spawnAsync`, `tests/helpers.ts:301`), never chains `spawnSync`/`execFileSync` past one call (row 213: vitest's worker RPC times out at 60 s).
- Kept-directory lines read exactly `scratch kept: <absolute dir>`; a fake trail reads exactly `fake <bin> trail · <trace path>` followed by the trail (today's text, `tests/scenarios.ts:13`).
- Write control and bidi characters only as `\u` escapes; after every write run `perl -CSD -ne 'while (/([\x{0}-\x{8}\x{b}-\x{1f}\x{7f}\x{2028}\x{2029}\x{202a}-\x{202e}\x{2066}-\x{2069}])/g) { printf "%s line %d: U+%04X\n", $ARGV, $., ord($1) }' <files>` — it must print nothing.
- House build rules: build inline (superpowers:executing-plans); per task the covering test files + `pnpm typecheck` (it covers `src/` only: `tsconfig.json` includes `src`, so a test file's types are checked by nothing — read them) + the bidi scan, never the full suite; the full suite once, in Task 5, under `caffeinate -dims`. A RED check reverse-applies the fix hunk and restores from HEAD — never `git stash` (the repo holds the user's stash entries). Review passes run on opus subagents.
- Branch `scratch-ownership` off main in a worktree under `.claude/worktrees/` (already excluded from collection). The PR body ends with `Closes #99`.

## Review Focus

The inputs no task's main assertions would reach, most likely first:

1. **A test whose body outlives its timeout.** vitest fails it and runs `onTestFinished` while the body may still run: its directories are kept and named, never removed under a running body. → Task 1, `life-slow-` in the failing run.
2. **A `beforeAll` that throws after allocating.** The file's tests are skipped; its directories are kept and named, not removed as if the file had passed. → Task 1, `broken-setup.test.ts`.
3. **A test that skips itself at runtime (`ctx.skip()`).** Its directories go like a pass, in both runs. → Task 1, `life-skip-` absent from both.
4. **`witness diff`'s git call throwing mid-way** (or any `use` that throws). The scratch directory still goes and the error still reaches the caller. → Task 3, `withScratch removes its directory when use throws`.
5. **A cache that outlives the test that filled it** (`shared: true`). It survives into later tests of the file and goes at the file's end. → Task 1, `life-cache-` read by a later test and absent after a passing run.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `tests/scratch.ts` | create | `scratchDir`, `settleFile`: the tests' one owner of scratch directories |
| `tests/scratch-setup.ts` | create | setup file: the file-lifetime `afterAll` |
| `vitest.config.ts` | modify | `setupFiles`: `tests/scratch-setup.ts` replaces `tests/fake-trails.ts` |
| `fixtures/scratch-life/{vitest.config.ts,life.test.ts,broken-setup.test.ts,factories.test.ts}` | create | a nested suite whose leftovers the lifecycle test reads |
| `tests/scratch.test.ts` | create | runs the nested suite passing and failing; asserts what is left |
| `tests/helpers.ts` | modify | `tmpRepo` and `fakeScenario` on `scratchDir`, the fake's trails as its report |
| `tests/scenarios.ts`, `tests/fake-trails.ts` | delete | folded into `scratchDir`'s failure report |
| `src/scratch.ts` | create | `withScratch`: the CLI's one owner of scratch directories |
| `src/snapshot.ts`, `src/held.ts`, `src/carry.ts`, `src/verbs/migrate.ts`, `src/verbs/diff.ts` | modify | each site through `withScratch` |
| `tests/with-scratch.test.ts` | create | `withScratch` on return and on throw |
| `tests/diff.test.ts` | modify | `witness diff` leaves no scratch directory |
| `tests/scratch-owner.test.ts` | create | the guard: one owner per side, no `.concurrent`/`.fails` |
| 53 test files (Task 4 lists them) | modify | raw `mkdtempSync(join(tmpdir(), …))` → `scratchDir` |
| `DESIGN.md` | modify | row 268, Open / deferred |

---

### Task 1: `scratchDir` and its lifetimes

**Files:**
- Create: `tests/scratch.ts`, `tests/scratch-setup.ts`, `fixtures/scratch-life/vitest.config.ts`, `fixtures/scratch-life/life.test.ts`, `fixtures/scratch-life/broken-setup.test.ts`, `tests/scratch.test.ts`
- Modify: `vitest.config.ts` (`setupFiles`: add `'tests/scratch-setup.ts'`; `tests/fake-trails.ts` stays until Task 2)

**Interfaces:**
- Produces:
  - `export interface ScratchOpts { shared?: boolean; report?: (dir: string) => string }` — `shared`: file lifetime even when made inside a test; `report`: text printed under the kept line.
  - `export function scratchDir(prefix: string, opts?: ScratchOpts): string` — `home = realpathSync(mkdtempSync(join(tmpdir(), prefix)))`, returns `dir = join(home, prefix.replace(/-+$/, '') || 'scratch')`, made with `mkdirSync`; owner = the current test (`getCurrentTest()` from `vitest/suite`, and not `shared`), registered with `onTestFinished`, else the file (a module-level list).
  - `export function settleFile(file: RunnerTestFile): void` — drains the file list; keeps and prints when any task in `file`'s tree has `result.state === 'fail'`, else removes.
  - Settling: kept → `console.error` of `scratch kept: <dir>` (the path the test was handed), then `report(dir)` on the next line when given and non-empty; removed → `rmSync(home, { recursive: true, force: true })`, errors propagate.
  - `tests/scratch-setup.ts`: `afterAll((file) => settleFile(file))` and nothing else.

- [ ] **Step 1: Write the nested suite**

`fixtures/scratch-life/vitest.config.ts`: `root: import.meta.dirname`, `cacheDir: process.env.SCRATCH_LIFE_CACHE`, `test: { include: ['*.test.ts'], setupFiles: ['../../tests/scratch-setup.ts'], pool: 'forks' }`. The switch is `SCRATCH_LIFE` (`pass` | `fail`) — never `MODE`, which vite overwrites with `'test'`.

```ts
// fixtures/scratch-life/life.test.ts
import { existsSync, mkdirSync } from 'node:fs'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { scratchDir } from '../../tests/scratch.js'

const FAIL = process.env.SCRATCH_LIFE === 'fail'
scratchDir('life-collect-')
beforeAll(() => { scratchDir('life-shared-') })
let cache: string | undefined
it('fills a cache', () => { cache = scratchDir('life-cache-', { shared: true }) })
it('reads the cache a passed test filled', () => { expect(existsSync(cache!)).toBe(true) })
it('passes, with a sibling beside its directory', () => { mkdirSync(`${scratchDir('life-pass-')}-beside`) })
it('skips itself', (ctx) => { scratchDir('life-skip-'); ctx.skip() })
describe('each', () => {
  beforeEach(() => { scratchDir('life-each-') })
  it('uses each', () => { if (FAIL) expect.fail('deliberate') })
})
it('owns and fails', () => {
  scratchDir('life-own-', { report: (d) => `report for ${d}` })
  if (FAIL) expect.fail('deliberate')
})
it.runIf(FAIL)('outlives its timeout', async () => {
  scratchDir('life-slow-')
  await new Promise((r) => setTimeout(r, 600))
}, 100)
```

```ts
// fixtures/scratch-life/broken-setup.test.ts
import { beforeAll, it } from 'vitest'
import { scratchDir } from '../../tests/scratch.js'

beforeAll(() => { scratchDir('life-setup-'); if (process.env.SCRATCH_LIFE === 'fail') throw new Error('setup broke') })
it('runs once setup is whole', () => {})
```

- [ ] **Step 2: Write the lifecycle test**

`tests/scratch.test.ts`. A helper `lifeRun(mode: 'pass' | 'fail'): Promise<{ code: number; out: string; probe: string; left: string[] }>` makes `probe = scratchDir('witness-life-probe-')` and `cache = scratchDir('witness-life-cache-')`, runs `spawnAsync(process.execPath, [vitestBin(), 'run', '--config', <repo>/fixtures/scratch-life/vitest.config.ts], { cwd: <repo>, env: fixtureEnv({ TMPDIR: probe, TMP: probe, TEMP: probe, SCRATCH_LIFE: mode, SCRATCH_LIFE_CACHE: cache }) })`, and returns `out = stdout + stderr` and `left = readdirSync(probe).sort()` (the homes). `const stem = (n: string) => n.replace(/[A-Za-z0-9]{6}$/, '')`; `const handed = (r, home: string) => join(r.probe, home, stem(home).replace(/-+$/, ''))` — the path the nested test was handed.

```ts
it('a passing run leaves nothing behind, whatever scope made it (issue #99)', async () => {
  const r = await lifeRun('pass')
  expect(r.code, r.out).toBe(0)
  expect(r.left).toEqual([])
}, 60_000)

it('a failing run keeps exactly its failed owners\' directories and names each (issue #99)', async () => {
  const r = await lifeRun('fail')
  expect(r.code, r.out).toBe(1)
  expect(r.left.map(stem).sort()).toEqual([
    'life-cache-', 'life-collect-', 'life-each-', 'life-own-', 'life-setup-', 'life-shared-', 'life-slow-',
  ])
  for (const home of r.left) expect(r.out).toContain(`scratch kept: ${handed(r, home)}`)
  expect(r.out).toContain(`report for ${handed(r, r.left.find((n) => n.startsWith('life-own-'))!)}`)
}, 60_000)
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm exec vitest run tests/scratch.test.ts`
Expected: FAIL — the nested run cannot resolve `../../tests/scratch.js` / `../../tests/scratch-setup.ts`.

- [ ] **Step 4: Implement `tests/scratch.ts` and `tests/scratch-setup.ts`; add the setup file to `vitest.config.ts`**

Comment the setup-file entry with why it is there (the file lifetime), as its neighbours are commented. `tests/setup-files.test.ts` now also reads `tests/scratch-setup.ts`.

- [ ] **Step 5: Run the covering tests**

Run: `pnpm exec vitest run tests/scratch.test.ts tests/setup-files.test.ts && pnpm typecheck`
Expected: PASS; `git status --short` shows no `fixtures/scratch-life/node_modules`.

- [ ] **Step 6: Commit**

```bash
git add tests/scratch.ts tests/scratch-setup.ts tests/scratch.test.ts fixtures/scratch-life vitest.config.ts
git commit -m "test: scratchDir owns a test scratch directory for its test or its file, kept and named on failure (row 268, #99)"
```

### Task 2: The fixture factories on `scratchDir`

**Files:**
- Modify: `tests/helpers.ts:86-87` (`tmpRepo`), `tests/helpers.ts:413-418` (`fakeScenario`), `vitest.config.ts` (drop `tests/fake-trails.ts` from `setupFiles`)
- Delete: `tests/scenarios.ts`, `tests/fake-trails.ts`
- Create: `fixtures/scratch-life/factories.test.ts`
- Test: `tests/scratch.test.ts`

**Interfaces:**
- Consumes: `scratchDir(prefix, opts)` (Task 1).
- Produces:
  - `tmpRepo()`: `root = scratchDir('witness-')` (no longer realpath'd here: `scratchDir` does). `TestRepo` is unchanged; its doc comment states the contract: a path `${root}-<name>` (or `join(root, '..', …)`) lies in the fixture's home and goes with it.
  - `fakeScenario()`: `scratchDir('witness-fake-', { report: fakeTrails })`, where `fakeTrails(dir: string): string` (in `helpers.ts`) returns today's `trailsSince` text for that one directory: for each of `claude`, `pi` whose `<dir>/<bin>-trace` exists, `fake <bin> trail · <trace>\n<trail, trailing whitespace trimmed>`, joined by `\n`; `''` when neither exists.

- [ ] **Step 1: Write the factories' nested case**

```ts
// fixtures/scratch-life/factories.test.ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { addOrigin, fakeScenario, tmpRepo } from '../../tests/helpers.js'

it('makes a repo, its origin and a fake scenario', () => {
  const repo = tmpRepo()
  addOrigin(repo)
  writeFileSync(join(fakeScenario(), 'claude-trace'), 'start 1\nclaim 1 1\n')
  if (process.env.SCRATCH_LIFE === 'fail') expect.fail('deliberate')
})
```

In `tests/scratch.test.ts`, the failing run's expected stems gain `'witness-'` and `'witness-fake-'`, and:

```ts
const home = r.left.find((n) => stem(n) === 'witness-')!
expect(readdirSync(join(r.probe, home)).sort()).toEqual(['witness', 'witness-origin.git'])
const fake = handed(r, r.left.find((n) => stem(n) === 'witness-fake-')!)
expect(r.out).toContain(`fake claude trail · ${join(fake, 'claude-trace')}\nstart 1\nclaim 1 1`)
```

The passing run's `left` stays `[]` (now also proving the repo, its origin and the fake went).

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run tests/scratch.test.ts`
Expected: FAIL — the passing run leaves `witness-…`, `witness-…-origin.git` and `witness-fake-…` in the probe.

- [ ] **Step 3: Move `tmpRepo` and `fakeScenario` onto `scratchDir`; delete `tests/scenarios.ts` and `tests/fake-trails.ts`; drop the latter from `setupFiles`**

`helpers.ts` no longer imports `scenariosMade`.

- [ ] **Step 4: Run the covering tests**

Run: `pnpm exec vitest run tests/scratch.test.ts tests/setup-files.test.ts tests/diff.test.ts tests/fixtures.test.ts tests/arbiter-ask.test.ts tests/fakebin.test.ts tests/battery.test.ts tests/ship-merge.test.ts tests/ship-lease.test.ts tests/draft.test.ts tests/gitio.test.ts tests/protocol/pipeline.test.ts && pnpm typecheck`
Expected: PASS (the last eight exercise fakes, `addOrigin`, `${root}-…` and `join(root, '..', …)` siblings, and a fake scenario used as a repo root).

- [ ] **Step 5: Commit**

```bash
git add -A tests/helpers.ts tests/scenarios.ts tests/fake-trails.ts tests/scratch.test.ts fixtures/scratch-life vitest.config.ts
git commit -m "test: tmpRepo and fakeScenario own their directories; a fixture's siblings live in its home (row 268, #99)"
```

### Task 3: `withScratch` — the CLI's one owner

**Files:**
- Create: `src/scratch.ts`, `tests/with-scratch.test.ts`, `tests/scratch-owner.test.ts`
- Modify: `src/verbs/diff.ts:79-83`, `src/snapshot.ts:43-66`, `src/held.ts:90-111` and `:286-295`, `src/carry.ts:405-433`, `src/verbs/migrate.ts:106-122`
- Test: `tests/diff.test.ts`

**Interfaces:**
- Consumes: `scratchDir` (Task 1), for the probe.
- Produces: `export function withScratch<T>(prefix: string, use: (dir: string) => T): T` — `mkdtempSync(join(tmpdir(), prefix))`, `use(dir)`, `finally rmSync(dir, { recursive: true, force: true })`. Synchronous: every site is.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/with-scratch.test.ts
it('withScratch hands use a directory, returns its value and removes the directory', () => {
  let seen = ''
  const v = withScratch('witness-t-', (d) => { seen = d; writeFileSync(join(d, 'f'), 'x'); return 7 })
  expect(v).toBe(7)
  expect(existsSync(seen)).toBe(false)
})

it('withScratch removes its directory when use throws, and the error reaches the caller', () => {
  let seen = ''
  expect(() => withScratch('witness-t-', (d) => { seen = d; throw new Error('boom') })).toThrow('boom')
  expect(seen).not.toBe('')
  expect(existsSync(seen)).toBe(false)
})
```

In `tests/diff.test.ts`, beside `'diffs current content against the latest plan pin'` (same setup):

```ts
it('removes its scratch directory once the diff is printed (issue #99)', async () => {
  // ...the same seed, plan pin and rewrite as 'diffs current content against the latest plan pin'
  const probe = scratchDir('witness-probe-')
  for (const k of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(k, probe)
  try {
    const res = await repo.cli(['diff', 'auth-refresh'])
    expect(res.stdout).toContain('+summary: Rotation plus revocation')
  } finally {
    vi.unstubAllEnvs()
  }
  expect(readdirSync(probe)).toEqual([])
})
```

`tests/scratch-owner.test.ts`, first half (Task 4 adds the second):

```ts
it('the CLI makes scratch directories only through withScratch (row 268)', () => {
  expect(offenders('src', ['src/scratch.ts'], /\bmkdtemp(Sync)?\b|\btmpdir\b/)).toEqual([])
})
```

`offenders(dir: string, allowed: string[], pattern: RegExp): string[]` walks `<repo>/<dir>` **recursively** for `*.ts` (`tests/protocol/` included), returning repo-relative `file:line` for each matching line outside `allowed`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run tests/with-scratch.test.ts tests/diff.test.ts tests/scratch-owner.test.ts`
Expected: FAIL — `withScratch` is not exported; the probe holds `witness-diff-…`; the guard lists the six sites.

- [ ] **Step 3: Implement `src/scratch.ts` and move the six sites onto it**

Prefixes stay as they are (`witness-snap-`, `witness-verify-red-`, `witness-kept-`, `witness-migrate-`, `witness-diff-`). `snapshotTree` keeps its `catch → undefined`; only the index work moves into `use`. No output changes.

- [ ] **Step 4: Run the covering tests**

Run: `pnpm exec vitest run tests/with-scratch.test.ts tests/diff.test.ts tests/scratch-owner.test.ts tests/snapshot.test.ts tests/verify-red.test.ts tests/held-signal-land.test.ts tests/carry-primitives.test.ts tests/ship-carry.test.ts tests/migrate.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: RED check for the diff test**

Reverse-apply only `src/verbs/diff.ts`'s hunk (`git diff -- src/verbs/diff.ts > /tmp/…; git apply -R …`), run `pnpm exec vitest run tests/diff.test.ts -t 'removes its scratch'` — FAIL with `witness-diff-…` in the probe — then `git apply` the hunk back.

- [ ] **Step 6: Commit**

```bash
git add src/scratch.ts src/snapshot.ts src/held.ts src/carry.ts src/verbs/migrate.ts src/verbs/diff.ts tests/with-scratch.test.ts tests/diff.test.ts tests/scratch-owner.test.ts
git commit -m "fix: witness makes every scratch directory through withScratch; witness diff no longer leaves one per run (row 268, #99)"
```

### Task 4: Every test scratch directory through `scratchDir`

**Files:**
- Modify (raw `mkdtempSync`/`tmpdir`): `tests/{busy,canon-guard,carry-primitives,check,clash-guard,clash-refusals,config,config-file,console,contain,decide-live,design-open,drive,drive-detach,evidence-for-diff,evidence-tree,fakebin,handback-arbiter,harness,held-signal-land,hooks-dashboard,hooks-guard,hooks-upgrade,lint-config,lock-race,next-home,opener,paste,pi-extension,quote,recap,release-main-guard,reviewer,reviewer-turn-end,runner-exec,screens-live,settings-merge,ship-carry,ship-finish-move,ship-junit,ship-phase-disposition,ship-pr,slice,spawn,start,sync,verdict,verify-red-signal,version-read,wait-for-line,write-spec}.test.ts`, `tests/shells.ts`, `tests/protocol/design-sight.test.ts`
- Modify (drops `afterAll(dropStub)`): `tests/one-note.test.ts`
- Test: `tests/scratch-owner.test.ts`

**Interfaces:**
- Consumes: `scratchDir(prefix, opts)` (Task 1).

- [ ] **Step 1: Write the guard's test half**

```ts
it('tests make scratch directories only through scratchDir (row 268)', () => {
  expect(offenders('tests', ['tests/scratch.ts', 'tests/scratch-owner.test.ts'], /\bmkdtemp(Sync)?\b|\btmpdir\b/)).toEqual([])
})

// scratchDir names a directory's owner by the test vitest is running: a concurrent test would
// hand its directories to a neighbour, and an inverted one (`.fails`) is kept though it reads green.
it('no test runs concurrently or inverts its result (row 268)', () => {
  expect(offenders('tests', ['tests/scratch-owner.test.ts'], /\.(concurrent|fails)\b/)).toEqual([])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run tests/scratch-owner.test.ts`
Expected: FAIL — the first lists the 53 files' lines (154 `mkdtemp` lines plus the `tmpdir` imports and uses); the second passes already (it pins Settled 8).

- [ ] **Step 3: Migrate, by these rules**
- `mkdtempSync(join(tmpdir(), P))` and `realpathSync(mkdtempSync(join(tmpdir(), P)))` → `scratchDir(P)`; drop imports left unused.
- A cache that holds a directory across tests asks for `{ shared: true }`: `tests/shells.ts` `stubScript()`; `copyOf` behind the `built` maps in `tests/decide-live.test.ts` and `tests/handback-arbiter.test.ts`. `dropStub` and its `afterAll(dropStub)` callers (`tests/paste.test.ts:381`, `tests/one-note.test.ts`) go.
- Hand cleanup of a scratch directory goes — `afterEach`/`afterAll`/`finally` blocks whose whole job was removing one (`tests/paste.test.ts`'s `made` list and its `afterAll`; `tests/shells.ts` `pasteIn`'s `finally` removals of `stubs` and its default `cwd`; the other self-cleaners: `handback-arbiter`, `pi-extension`, `quote`, `recap`, `ship-carry`, `ship-finish-move`, `ship-junit`, `verdict`, `write-spec`). An `rmSync` that sets up a test's state stays.
- A `tmpdir()` that names a path never made (`tests/design-open.test.ts:131`, `tests/pi-extension.test.ts:156`) → `join(scratchDir('witness-absent-'), '<same name>')`.
- A test file that fails after migrating, and passed before, names a cache this plan missed: give it `shared: true`, ledger it.

- [ ] **Step 4: Run the covering tests**

Run: `pnpm exec vitest run tests/scratch-owner.test.ts` then every file listed above plus `tests/one-note.test.ts`, then `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests
git commit -m "test: every test scratch directory has scratchDir as its owner, held by a guard (row 268, #99)"
```

### Task 5: Acceptance, row 268

**Files:**
- Modify: `DESIGN.md` (row 268, placed after row 254 — or after 267 if `trust-t2` merged first; Open / deferred)
- Create: the PR body (ledger dir, never committed)

- [ ] **Step 1: The issue's acceptance, on the whole suite**

From the build worktree (the main checkout also collects its gitignored `.superpowers/sdd/**` probes — Settled 2), with no other suite running on the machine:

```sh
T=$(node -p "require('os').tmpdir()"); ls -1A "$T" | sort > before.txt
caffeinate -dims pnpm test; ls -1A "$T" | sort > after.txt; comm -13 before.txt after.txt
```

Expected: `Tests N passed`, exit 0, and `comm` prints nothing. Any entry names its prefix; trace it to its maker and fix it there, never by sweeping. Then the issue's three-file repro prints nothing either. Record the suite's wall clock beside the baseline in Settled 2.

- [ ] **Step 2: Row 268 and Open / deferred**

Row 268 ⊜ "Every scratch directory has one owner": *Fixes issue #99; touches 30, 193, 198, 213, 243, 247 and 251.* It states: the two owners and their guard; the lifetimes (test, file, `shared`); keep-and-name on failure, the fake trails folded in; the home layout and why (the siblings); why not a per-run `TMPDIR` (it hides the missing owner, leaves the CLI's leak, deletes what a failed test needs, and a killed run leaves it anyway); why a removal that fails fails the test. Open / deferred gains:
- **A run killed mid-way leaves its in-flight tests' directories** — bounded by the workers' current tests, not the run (row 268).
- **A test file that fails to load keeps what its collection made, unprinted** (row 268).
- **On Windows a directory a live process still holds fails its test's removal** (EBUSY); measured on macOS and Linux only (row 268).
- **Directories left by runs before row 268 stay until removed by hand** (row 268).

- [ ] **Step 3: Review, then commit and PR**

Final review on an opus subagent over the branch diff, then:

```bash
git add DESIGN.md
git commit -m "docs: row 268, every scratch directory has one owner (#99)"
```

PR body ends with `Closes #99`. Pushing, the PR and `pnpm release patch` are the user's calls.
