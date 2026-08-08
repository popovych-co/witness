# witness 0.7.0 — payload sync and check's subject (DESIGN rows 102, 103, 104, 108) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the 0.7.0 half of grill #13 — the payload becomes witness's artifact that upgrades instead of freezing, `check` audits this repository instead of its caller and learns from the registry that it is behind, and the round bound stops rendering as a malfunction.

**Architecture:** Four DESIGN rows, eight tasks, one branch, no verdict semantics touched — that is the split line: 0.7.0 changes install, diagnostics and one block of text; 0.8.0 (rows 105/106/107) changes what gates decide. Row 102 collapses `installPayload`'s four-way rule to three (absent → write, identical → skip, differing → **overwrite and report**), kills `pinOnlyDifference`, and replaces it with two preflight guards — a `payload-dirty` refusal over the payload targets and an **ordered write** that refuses `cli-behind-payload` when the running CLI is older than the installed engine's pin. Row 103 adds one best-effort registry query to `check` and reports both halves of the skew from it — the CLI behind `latest`, and each visible `SKILL.md` behind `latest`. Row 104 takes `resolveHarness` out of `check`'s audit: payload and skills are reported per registry entry over what exists on disk, and absence becomes a single stated line rather than a finding. Row 108 stops `decide`'s two bound-endgame sites from rendering through `renderRefusal`, whose trailer is a false sentence at the bound.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), vitest, git plumbing via `src/gitio.ts`'s `git`/`tryGit`, Node 20 global `fetch`, biome for formatting.

## Global Constraints

- **No per-task commits.** This project's standing preference: implement every task's code and tests, run the verifications, leave the working tree uncommitted, and ask about commit granularity only once the whole plan is green end to end. Every task below ends in a verification step, never a commit step.
- **Branch:** cut a fresh branch off `main` (`git switch -c payload-sync-0.7.0`). `main` already carries the merged 0.6.0 work. `DESIGN.md` is currently **uncommitted** with rows 102–108 written — leave it alone; it is the spec this plan implements, and it gets committed with the work.
- **Test command:** `npx vitest run tests/<file> --poolOptions.forks.maxForks=4`. The fork pool IPC-times-out under full concurrency on this machine — `[vitest-worker]: Timeout calling "onTaskUpdate"` is a flake, not a failure. Redirect long output with `>`, never pipe to `tail`.
- **`rm -rf .witness/worktrees` before every full-suite run.** A leaked nested worktree drags fixtures into a root-level run and produces false failures.
- **Baseline suite: 107 files, 790 tests green** (measured on this tree, 2026-08-07, 205s). No task may reduce the test count without replacing what it removed.
- **The suite must never reach the network.** Task 4 pins `WITNESS_REGISTRY: 'off'` in `tests/helpers.ts` for every in-process CLI run; the two tests that exercise the query point it at a local `node:http` server. If you add a `check` test in a later task, it inherits the pin for free — do not undo it.
- **`WITNESS_REGISTRY` is a test seam, not a configuration key. Do not document it in the README.** The README states the doctrine outright — *"There are no `WITNESS_*` env vars for configuration"* — and row 90 killed `WITNESS_HARNESS` to establish it: configuration has exactly one home, `witness.config.yaml` for repo facts and `.witness/config.local.yaml` for machine facts. The precedent for a test-only seam living in production code is `crashPoint`'s `WITNESS_CRASH_AFTER` (`src/txn.ts:26`), which is undocumented on purpose. If suppressing the query ever becomes a real user need, its home is `.witness/config.local.yaml` and its cost is a `loadLocalConfig` key — not an env var.
- **Rows 105, 106 and 107 are NOT in this plan.** `resolveHarness` keeps today's ladder (detection → config → default) for the CLI probe and the model floor. Row 104 removes it from the **audit** only. Do not "finish" the judgment/session lane split here — it changes gate outcomes and ships in 0.8.0.
- **Silent-on-failure is a rule, not a nicety.** The registry query returns `undefined` for offline, air-gapped, proxied, rate-limited and malformed responses alike, and `undefined` is never a finding. `check`'s exit code is a contract about canon validity (row 101) — nothing added here may change it.
- Style: comments explain *why the rule exists and what breaks without it*, in the voice of the surrounding code. Match it — this codebase carries its design rationale inline and a bare mechanical comment reads as a regression. `src/**` uses no semicolons, 2-space indent, single quotes.

---

## File Structure

**Created:**
- `src/version.ts` — pure. The one home for "which version of witness is which": the `@popovych.co/witness@<semver>` pin regex, `pinIn(text)`, `compareTriple(a, b)`, and the `NPX_LATEST` remedy prefix. Consumed by `install.ts` (ordered write) and `check.ts` (skew findings). Deliberately holds no I/O.
- `src/registry.ts` — the one network call in the codebase: `latestPublished(env)`, best-effort, silent, 2s timeout.
- `tests/version-compare.test.ts` — Task 1.
- `tests/registry.test.ts` — Task 4, against a local http server.

**Modified:**
- `src/install.ts` — `pinOnlyDifference` dies. `preflightPayload` gains two guards (`payload-dirty`, `cli-behind-payload`). `installPayload` becomes three-way. `SyncResult` trades `modified`/`restamped` for `written`/`overwritten`.
- `src/verbs/init.ts` — reports `payload-overwritten` instead of `payload-modified`; `files` collects `written` + `overwritten`.
- `src/harness.ts` — `skillsVisibility` becomes a one-line wrapper over a new `resolveSkills` that also returns the resolved directory; adds `skillPins(dir)`, which answers *what pin does each installed SKILL.md carry* and nothing else.
- `src/verbs/check.ts` — the harness block splits in two: a judgment-lane probe that still resolves a harness, and a per-registry-entry audit that does not. Payload staleness becomes a content compare. Absence becomes a stated line. Adds `cli-behind` and `skills-behind`.
- `src/verbs/decide.ts` — the two bound-endgame sites render a terminus, not a refusal.
- `tests/helpers.ts` — pins `WITNESS_REGISTRY: 'off'`.
- `README.md` — the upgrade order for a frozen repo (skills first, then `init --agent`).
- `package.json` + every `plugin/**` pin — 0.7.0, via `pnpm run sync-versions`.

**Modified tests:** `tests/init-agent.test.ts`, `tests/check.test.ts`, `tests/decide.test.ts`, `tests/harness.test.ts`.

---

### Task 1: `src/version.ts` — the pin, the triple, the remedy prefix

Three call sites needed the same two answers about witness's own version and each had grown a private copy: `install.ts`'s `PIN` (about to die with `pinOnlyDifference`), `check.ts`'s inline regex, and `scripts/sync-versions.mjs`. The script keeps its own copy on purpose — it is a dependency-free `.mjs` by contract and cannot import TypeScript. The other two collapse here.

**Files:**
- Create: `src/version.ts`
- Test: `tests/version-compare.test.ts`

**Interfaces:**
- Consumes: nothing. This module imports no other module in the codebase — keep it that way, it is what makes it safe to import from both `install.ts` and `check.ts`.
- Produces:
  - `pinIn(text: string): string | undefined` — the semver inside the first `@popovych.co/witness@<v>` occurrence, or `undefined`.
  - `compareTriple(a: string, b: string): number | undefined` — `-1 | 0 | 1`, or `undefined` when either side has no parseable numeric triple.
  - `NPX_LATEST: string` — `'npx -y @popovych.co/witness@latest'`.

- [ ] **Step 1: Write the failing test**

Create `tests/version-compare.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { NPX_LATEST, compareTriple, pinIn } from '../src/version.js'

describe('pinIn', () => {
  // Both payload files and every SKILL.md embed the pin inside a shell default:
  // `${WITNESS_BIN:-npx -y @popovych.co/witness@0.6.0}`. A capture class that ends at
  // whitespace swallows the closing brace and never equals a version — that exact bug
  // made payload-stale fire on every fresh install once already.
  it('stops at the semver inside a shell default expansion', () => {
    expect(pinIn('WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.6.0}"')).toBe('0.6.0')
  })

  it('reads a prerelease pin whole', () => {
    expect(pinIn('npx -y @popovych.co/witness@1.0.0-rc.1 check')).toBe('1.0.0-rc.1')
  })

  it('answers undefined for the three payload files that carry no pin', () => {
    expect(pinIn('export function canonGuard() {}\n')).toBeUndefined()
  })
})

describe('compareTriple', () => {
  it('orders by numeric field, not lexically', () => {
    expect(compareTriple('0.9.0', '0.10.0')).toBe(-1)
    expect(compareTriple('0.10.0', '0.9.0')).toBe(1)
    expect(compareTriple('1.0.0', '0.99.99')).toBe(1)
  })

  it('treats equal triples as equal — the witness-developer case, where the write still happens', () => {
    expect(compareTriple('0.7.0', '0.7.0')).toBe(0)
  })

  // Prerelease ordering is out of scope by decision (row 102): witness has never
  // published one, and a guard that guessed at it would refuse a legal upgrade.
  it('ignores the prerelease suffix rather than guessing at its order', () => {
    expect(compareTriple('1.0.0-rc.1', '1.0.0')).toBe(0)
  })

  // undefined means "cannot compare", never "equal". Every consumer is a guard or a
  // warning, and a guard that fired on an unparseable version would refuse an upgrade
  // over a typo — the same doctrine currentSha's undefined carries (row 94).
  it('answers undefined when either side has no triple', () => {
    expect(compareTriple('latest', '0.7.0')).toBeUndefined()
    expect(compareTriple('0.7.0', '')).toBeUndefined()
  })
})

describe('NPX_LATEST', () => {
  // Row 103: a remedy naming a bare witness command is executed BY the frozen CLI that
  // printed it — `witness init --agent pi` through a frozen /witness is
  // `npx …@0.5.1 init`, which restamps 0.5.1 onto 0.5.1 and reads as compliance.
  it('names the version explicitly so the remedy escapes a frozen CLI', () => {
    expect(NPX_LATEST).toBe('npx -y @popovych.co/witness@latest')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/version-compare.test.ts`
Expected: FAIL — `Failed to resolve import "../src/version.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/version.ts`:

```typescript
// The one home for "which version of witness is which". install.ts parsed the pin to
// decide whether a payload was only a pin apart (row 102 killed that rule) and check.ts
// re-declared the same regex inline — one question answered in two places, which is the
// shape rows 93, 95, 96 and 104 all name. scripts/sync-versions.mjs keeps a third copy
// on purpose: it is dependency-free by contract and cannot import TypeScript.

// Both payload files and every SKILL.md embed the pin as
// `${WITNESS_BIN:-npx -y @popovych.co/witness@<v>}`, so the capture MUST end at the
// semver and never swallow the closing brace.
const PIN = /@popovych\.co\/witness@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/

export function pinIn(text: string): string | undefined {
  return PIN.exec(text)?.[1]
}

// Numeric triple only. Prerelease ordering is deliberately out of scope (row 102):
// witness has never published one, and equal triples compare equal — which is also the
// witness-developer case, where the running CLI and the installed payload are the same
// version and the write must still happen.
function triple(raw: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim())
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])]
}

// `undefined` means CANNOT COMPARE, never "equal". Every consumer is a guard or a
// warning, and a guard that fired on an unparseable version would refuse a legal
// upgrade over a typo — the doctrine currentSha's undefined already carries (row 94).
export function compareTriple(a: string, b: string): number | undefined {
  const [x, y] = [triple(a), triple(b)]
  if (x === undefined || y === undefined) return undefined
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return (x[i] as number) < (y[i] as number) ? -1 : 1
  }
  return 0
}

// Row 103. Every remedy that names a witness command is executed BY the CLI that
// printed it, and on a frozen repo that CLI is the frozen one: `witness init --agent pi`
// through a frozen /witness is `npx …@0.5.1 init`, which restamps 0.5.1 onto 0.5.1 — a
// no-op that reads as compliance. Remedies name the version.
export const NPX_LATEST = 'npx -y @popovych.co/witness@latest'
```

`noUncheckedIndexedAccess` is on, which is why `x[i]` needs the cast in the comparison branch — the `!==` guard above it does not narrow an index access.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/version-compare.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm run typecheck`
Expected: no output, exit 0.

---

### Task 2: `preflightPayload` — the two guards that replace `pinOnlyDifference`

Row 102 removes the rule that protected an edited payload from being overwritten, and replaces it with two whole-run preconditions. Both must refuse **before the lock and before any write**, exactly as the `git check-ignore` precondition beside them does, so a refusal leaves the repo exactly as it was. A half-upgraded payload set — guard at one version, engine at another — is the skew the row exists to close, so a partial write is worse than no write.

`harness.settings` (`.claude/settings.json`) stays outside the dirty guard on purpose: `mergeSettings` appends and never clobbers, so a dirty settings file is not at risk.

**Files:**
- Modify: `src/install.ts` (`preflightPayload`, `src/install.ts:35-42`)
- Test: `tests/init-agent.test.ts`

**Interfaces:**
- Consumes: `pinIn`, `compareTriple` from `src/version.js`; `NPX_LATEST` from the same; `tryGit(root, ...args): { ok: boolean; out: string }` from `src/gitio.js`; `version()` from `src/cli.js`; `v`/`refuse`/`ok` from `src/refusal.js`.
- Produces: `preflightPayload(root: string, harness: Harness): Result<void>` — same signature, three refusal classes now (`payload-ignored`, `payload-dirty`, `cli-behind-payload`).

Note on the import: `src/cli.ts` does not import `src/install.ts`, so `install.ts` importing `version` from `./cli.js` creates no cycle. Verify that before you write the import — a cycle here surfaces as an undefined-at-call-time function, not a compile error.

- [ ] **Step 1: Write the failing tests**

In `tests/init-agent.test.ts`, **replace** the test named `'restamps an uncommitted pin edit without attempting an empty commit'` (currently at line 82, together with its comment block) with the two tests below, and append the third after it. Add `writeFileSync` from `node:fs` to the imports if it is not already there.

```typescript
  // Row 102: the guard that used to protect an edited payload is gone, so the write
  // clobbers. That is only safe if the previous content is recoverable, and it is
  // recoverable only from git — so an uncommitted payload edit refuses the WHOLE run
  // rather than being silently swallowed by an overwrite.
  it('refuses the whole run when a payload path carries an uncommitted change', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/prompts/witness.md'
    const head = repo.git('rev-parse', 'HEAD')
    repo.write(rel, `${repo.read(rel)}\n<!-- uncommitted -->\n`)

    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('payload-dirty')
    expect(res.stderr).toContain(rel)
    expect(repo.read(rel)).toContain('<!-- uncommitted -->')   // nothing written
    expect(repo.git('rev-parse', 'HEAD')).toBe(head)           // nothing committed
  })

  // --untracked-files=all, not the default: a payload file that exists but was never
  // committed is exactly the state the guard must catch, and the default `normal` mode
  // reports an untracked FILE but the pathspec makes that reachable only with `all`.
  it('counts an untracked-but-present payload file as dirty', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/extensions/canon-guard.mjs'
    repo.git('rm', '--cached', rel)
    repo.git('commit', '-m', 'untrack the guard')

    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('payload-dirty')
    expect(res.stderr).toContain(rel)
  })

  // The write is ORDERED. Without this, running an old CLI in a repo someone else
  // upgraded silently REVERTS the payload — and the engine file's pin decides which CLI
  // the whole pipeline runs, so the revert re-freezes the repo one version further back.
  it('refuses to revert a payload installed by a newer CLI', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/prompts/witness.md'
    repo.write(rel, repo.read(rel).replace(/@popovych\.co\/witness@[\d.]+/g, '@popovych.co/witness@99.0.0'))
    repo.git('add', rel); repo.git('commit', '-m', 'installed by a newer CLI')

    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('cli-behind-payload')
    expect(repo.read(rel)).toContain('@popovych.co/witness@99.0.0')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/init-agent.test.ts --poolOptions.forks.maxForks=4`
Expected: the three new tests FAIL — the first two because `init` exits 0 and restamps, the third because it exits 0 and reverts the pin to 0.6.0.

- [ ] **Step 3: Write the implementation**

In `src/install.ts`, add to the imports:

```typescript
import { version } from './cli.js'
import { NPX_LATEST, compareTriple, pinIn } from './version.js'
```

Delete the `const PIN = …` line (line 26) — `pinOnlyDifference` is the only thing that used it and Task 3 removes that function; the regex now lives in `version.ts`.

Replace `preflightPayload` (lines 28-42, comment included) with:

```typescript
// The engine file is the one payload entry every harness carries, and its pin is what
// decides which CLI the whole pipeline runs — so it is also the only file whose pin can
// answer "which version installed what is here".
const ENGINE_SOURCE = 'plugin/commands/witness.md'

// Revision 6, extended by row 102. Committing the payload is load-bearing: the implement
// stage runs with cwd inside .witness/worktrees/<plan-id>, which is a checkout of the
// branch, so only committed files reach it. A gitignored target therefore has exactly one
// honest answer — refuse. `git add -f` would override a rule the human wrote down; writing
// without committing would leave the payload in the primary root and the worktree with no
// guard, while every `check` reads clean.
//
// Row 102 adds two more preconditions, because the rule that spared an edited file is
// gone and the write now clobbers:
//
//   payload-dirty      — a clobbered edit is recoverable only from git, so an uncommitted
//                        payload change must refuse rather than be overwritten into
//                        nothing. --untracked-files=all, so a present-but-untracked
//                        payload counts.
//   cli-behind-payload — an older CLI running in a repo a newer one installed would
//                        REVERT the payload, re-freezing the repo one version further
//                        back. Equal triples write (the witness-developer case);
//                        prerelease ordering is out of scope.
//
// All three refuse the WHOLE run, called BEFORE the lock and before any scaffold write,
// so a refusal leaves nothing half-installed — and a half-upgraded payload set (guard at
// one version, engine at another) is precisely the skew row 102 exists to close.
//
// harness.settings is deliberately outside the dirty guard: mergeSettings appends and
// never clobbers, so a dirty settings file is not at risk.
export function preflightPayload(root: string, harness: Harness): Result<void> {
  const targets = harness.payload.map((p) => p.to)
  const ignored = [...targets, ...(harness.settings ? [harness.settings] : [])]
    .filter((rel) => tryGit(root, 'check-ignore', '-q', '--', rel).ok)
  if (ignored.length > 0) {
    return refuse(ignored.map((rel) => v(rel, 'payload-ignored', 'matched by .gitignore',
      'a committable path — worktrees are branch checkouts, so only committed payloads reach ' +
      '.witness/worktrees/<plan-id>; un-ignore it, or install a different agent here')))
  }

  // A failed status call is not evidence of dirt: primaryRoot already proved this is a
  // repo, and inventing a refusal out of a git error would block the upgrade this row
  // exists to deliver.
  const status = tryGit(root, 'status', '--porcelain', '--untracked-files=all', '--', ...targets)
  const dirty = status.ok
    ? status.out.split('\n').filter((l) => l !== '').map((l) => l.slice(3).trim())
    : []
  // The remedy has to cover both authors of the dirt. `init` writes the payload and
  // commits it under a lock but NOT a transaction (verbs/init.ts), so a crash between
  // the two leaves a dirty payload the human never wrote — and telling them to commit it
  // would be telling them to commit bytes they did not author. Name both cases.
  if (dirty.length > 0) {
    return refuse(dirty.map((rel) => v(rel, 'payload-dirty', 'uncommitted change on a payload path',
      'a committed payload tree — init overwrites payload files now, and a clobbered edit is ' +
      'recoverable only from git; commit it if the change is yours, or revert it — a payload ' +
      'left dirty by a crashed init should be reverted, never committed')))
  }

  const engine = harness.payload.find((p) => p.from === ENGINE_SOURCE)
  const installedPin = engine !== undefined && existsSync(join(root, engine.to))
    ? pinIn(readFileSync(join(root, engine.to), 'utf8'))
    : undefined
  if (installedPin !== undefined && (compareTriple(version(), installedPin) ?? 0) < 0) {
    return refuse([v(engine!.to, 'cli-behind-payload', `payload pins ${installedPin}, this CLI is ${version()}`,
      `a CLI at or ahead of the installed payload — run ${NPX_LATEST} init --agent ${harness.name}`)])
  }
  return ok(undefined)
}
```

`?? 0` on the comparison is the "cannot compare, so do not refuse" rule from Task 1: an unparseable pin must not block an upgrade.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/init-agent.test.ts --poolOptions.forks.maxForks=4`
Expected: the three new tests PASS. `'leaves a human-edited payload alone and reports it'` and `'restamps a payload whose only difference is the version pin'` still pass at this point — both commit their edit before re-running, so the dirty guard does not fire and `pinOnlyDifference` still exists. Task 3 rewrites the first of them.

- [ ] **Step 5: Typecheck**

Run: `pnpm run typecheck`
Expected: no output, exit 0.

---

### Task 3: `installPayload` — absent → write, identical → skip, differing → overwrite

Row 87's four-way rule collapses to three. `pinOnlyDifference` is exact about what it claims and cannot separate *untouched-but-outdated* from *edited*, because nothing records what witness last wrote: `modified` meant *differs from what we ship now* where it had to mean *differs from what we wrote then*. The asymmetry decides it — a clobbered edit is named in `init`'s output and sits one `git revert` away, because row 87 already commits the payload, while a frozen pin is invisible until someone diffs a tarball.

**Files:**
- Modify: `src/install.ts` (`SyncResult` at line 24, `pinOnlyDifference` at 44-51, `installPayload` at 53-87)
- Modify: `src/verbs/init.ts` (lines 139, 182-186)
- Test: `tests/init-agent.test.ts`

**Interfaces:**
- Consumes: `preflightPayload` from Task 2.
- Produces: `SyncResult { written: string[]; overwritten: string[] }` — `modified` and `restamped` are gone. `src/verbs/init.ts` is the only consumer.

- [ ] **Step 1: Write the failing tests**

In `tests/init-agent.test.ts`, **replace** the test `'leaves a human-edited payload alone and reports it'` (line 97, comment-free) with:

```typescript
  // Row 102: the payload is witness's artifact. `pinOnlyDifference` could not tell an
  // untouched-but-outdated file from an edited one — nothing recorded what witness last
  // wrote — so one release read as "modified" declined every later one, permanently and
  // compoundingly, and the ${WITNESS_BIN:-npx …@<v>} pin froze with the file. The
  // asymmetry decides it: a clobbered edit is named here and sits one `git revert` away,
  // because row 87 already commits the payload; a frozen pin is invisible until someone
  // diffs a tarball.
  it('overwrites a human-edited payload, reports it, and leaves it one revert away', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/prompts/witness.md'
    repo.write(rel, `${repo.read(rel)}\n<!-- my own note -->\n`)
    repo.git('add', rel); repo.git('commit', '-m', 'local edit')
    const edited = repo.git('rev-parse', 'HEAD')

    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('payload-overwritten')
    expect(res.stdout).toContain(rel)
    expect(repo.read(rel)).not.toContain('<!-- my own note -->')
    expect(repo.git('status', '--porcelain')).toBe('')
    // named AND recoverable: the edit is the parent commit's content, not lost bytes
    expect(repo.git('show', `${edited}:${rel}`)).toContain('<!-- my own note -->')
  })

  // The half the pin probe could never see: three of the five payload files carry no
  // pin at all (canon-guard.mjs, guard-state.mjs, witness-pi.ts), so a guard bugfix was
  // undeliverable AND undetectable on every existing repo. Content compare covers all five.
  it('upgrades a pin-less payload file, which the pin rule could never reach', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/extensions/canon-guard.mjs'
    repo.write(rel, '// stale build\n')
    repo.git('add', rel); repo.git('commit', '-m', 'simulate a repo frozen before a guard bugfix')

    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('payload-overwritten')
    expect(repo.read(rel)).toContain('export function canonGuard')
  })
```

Also **rename** the test at line 65 from `'restamps a payload whose only difference is the version pin'` to `'upgrades a payload behind the shipped content'` and replace its comment block with:

```typescript
  // Row 102: the rule is content, not pins. This case (an older pin, nothing else
  // changed) is the one the old rule DID handle; it must keep working, because the
  // engine file's pin is the single point deciding which CLI the whole pipeline runs.
```

The test body is unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/init-agent.test.ts --poolOptions.forks.maxForks=4`
Expected: `'overwrites a human-edited payload…'` FAILS with `payload-modified` in stdout and the note still present; `'upgrades a pin-less payload file…'` FAILS the same way.

- [ ] **Step 3: Write the implementation**

In `src/install.ts`, replace the `SyncResult` interface (line 24):

```typescript
export interface SyncResult { written: string[]; overwritten: string[] }
```

Delete `pinOnlyDifference` entirely (lines 44-51, comment included).

Replace `installPayload` (lines 53-87, comment included) with:

```typescript
// Revision 1: SYNC, not install-once. Row 102: three-way, not four. The payload files
// are witness's artifacts that happen to live in the user's repo — the engine file's pin
// is the single point deciding which CLI the entire pipeline runs, and there is no
// sanctioned way to customise any of them (the human's config home is
// witness.config.yaml, repo prose reaches reviewers through row 68's docs: registry).
// The rule that spared an edited file was defending an unsupported hack while the file
// it defended froze the repo forever, so it is gone: differing content is overwritten
// and NAMED, one `git revert` away because row 87 already commits the payload.
export function installPayload(root: string, harness: Harness): Result<SyncResult> {
  const pre = preflightPayload(root, harness)
  if (!pre.ok) return refuse(pre.violations)
  const out: SyncResult = { written: [], overwritten: [] }
  for (const { from, to } of harness.payload) {
    const src = join(packageRoot(), from)
    if (!existsSync(src)) {
      return refuse([v('payload', 'source-missing', from,
        'a file shipped in the witness tarball — reinstall @popovych.co/witness')])
    }
    const shipped = readFileSync(src, 'utf8')
    const dst = join(root, to)
    if (!existsSync(dst)) {
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, shipped)
      out.written.push(to)
      continue
    }
    if (readFileSync(dst, 'utf8') === shipped) continue
    writeFileSync(dst, shipped)
    out.overwritten.push(to)
  }
  return ok(out)
}
```

In `src/verbs/init.ts`, line 139, replace:

```typescript
      files.push(...synced.written, ...synced.restamped)
```

with:

```typescript
      files.push(...synced.written, ...synced.overwritten)
```

and replace lines 182-186 (the `payload-modified` block and its comment) with:

```typescript
      // Never silent: row 102 lets init clobber, and a clobber the human cannot see is
      // the one thing that would make overwriting the wrong trade. The previous content
      // is the parent commit's, because row 87 commits the payload.
      if (synced && synced.overwritten.length > 0) {
        ctx.out(kv('payload-overwritten', `${synced.overwritten.join(' · ')} — replaced with what ${version()} ships; the previous content is one git revert away`))
      }
```

`version` is not yet imported in `src/verbs/init.ts` — add it to the existing `cli.js` import: `import { EXIT, version, type Ctx } from '../cli.js'`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/init-agent.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Verify nothing else consumed the dead fields**

Run: `rg -n "restamped|payload-modified|pinOnlyDifference" src/ tests/`
Expected: **no matches.** If `tests/dead-fields.test.ts` or any other file still names one, fix it now — a stale reference here compiles fine and fails at runtime.

- [ ] **Step 6: Typecheck**

Run: `pnpm run typecheck`
Expected: no output, exit 0.

---

### Task 4: `src/registry.ts` — one best-effort query, and a suite that never reaches the network

`version()` (`src/cli.ts:79`) reads the *running* CLI's own package.json, and all seven invocation surfaces pin the CLI. On a frozen repo every witness invocation therefore **is** the old CLI, which compares the payload against itself and reports clean. Under Task 3's content compare it is the same story, because the old tarball's payload is byte-identical to what is installed. The freeze is self-concealing, and the only fact living outside that loop is what the registry publishes.

**Files:**
- Create: `src/registry.ts`
- Create: `tests/registry.test.ts`
- Modify: `tests/helpers.ts` (the `cli` env construction, around line 59)

**Interfaces:**
- Consumes: nothing from the codebase; Node 20's global `fetch` and `AbortSignal.timeout`.
- Produces: `latestPublished(env: Record<string, string | undefined>): Promise<string | undefined>` — the `latest` dist-tag, or `undefined` for every failure mode. Task 6 is its only production caller.

The endpoint is `GET <base>/-/package/@popovych.co%2Fwitness/dist-tags`, which answers `{"latest":"0.6.0"}` — verified against the live registry on 2026-08-07. The abbreviated-packument route (`/@popovych.co%2Fwitness/latest`) answers the same question with a multi-kilobyte body; this one is the whole question and nothing else.

- [ ] **Step 1: Write the failing test**

Create `tests/registry.test.ts`:

```typescript
import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { latestPublished } from '../src/registry.js'

// A real server on an ephemeral port, not a stubbed global: this module's whole job is
// the network call, and a test that stubs fetch would assert nothing about the URL, the
// timeout or the parse. Hermetic — nothing leaves the loopback interface.
function serve(handler: (url: string) => { status: number; body: string }): Promise<{ base: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const { status, body } = handler(req.url ?? '')
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
  })
}

const servers: Array<() => void> = []
afterAll(() => servers.forEach((close) => close()))

async function base(handler: (url: string) => { status: number; body: string }): Promise<string> {
  const s = await serve(handler)
  servers.push(s.close)
  return s.base
}

describe('latestPublished', () => {
  it('reads the latest dist-tag from the scoped package route', async () => {
    let seen = ''
    const b = await base((url) => {
      seen = url
      return { status: 200, body: JSON.stringify({ latest: '9.9.9' }) }
    })
    expect(await latestPublished({ WITNESS_REGISTRY: b })).toBe('9.9.9')
    // the scope's slash must be encoded; an unencoded one is a different route
    expect(seen).toBe('/-/package/@popovych.co%2Fwitness/dist-tags')
  })

  // Silent on ANY failure. An offline or air-gapped machine must report nothing rather
  // than a finding about the network — a finding about the wrong subject is exactly what
  // row 104 is fixing elsewhere in this release.
  it('answers undefined on a non-2xx response', async () => {
    const b = await base(() => ({ status: 503, body: 'nope' }))
    expect(await latestPublished({ WITNESS_REGISTRY: b })).toBeUndefined()
  })

  it('answers undefined on a body that is not the shape it expects', async () => {
    const b = await base(() => ({ status: 200, body: JSON.stringify({ latest: 7 }) }))
    expect(await latestPublished({ WITNESS_REGISTRY: b })).toBeUndefined()
  })

  it('answers undefined on unparseable JSON', async () => {
    const b = await base(() => ({ status: 200, body: '<html>proxy interstitial</html>' }))
    expect(await latestPublished({ WITNESS_REGISTRY: b })).toBeUndefined()
  })

  it('answers undefined when nothing is listening', async () => {
    expect(await latestPublished({ WITNESS_REGISTRY: 'http://127.0.0.1:1' })).toBeUndefined()
  })

  // The seam the suite pins. Without it every `witness check` test in this repo would
  // make a real registry call — silent, correct, and slow enough to matter across 100+
  // invocations, plus flaky the moment CI runs without egress.
  it('skips the query entirely when the registry is off', async () => {
    expect(await latestPublished({ WITNESS_REGISTRY: 'off' })).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/registry.test.ts`
Expected: FAIL — `Failed to resolve import "../src/registry.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/registry.ts`:

```typescript
// Row 103. The freeze is self-concealing: version() reports the RUNNING CLI, and all
// seven invocation surfaces (the engine prompt plus six skills) pin the CLI — so a
// frozen repo only ever runs the frozen CLI, which compares the payload against itself
// and reports clean. The one fact living outside that loop is what the registry
// publishes, which is why this is the single network call in the codebase.
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
// The scope's slash must be percent-encoded; the `@` must not be. Same shape pacote uses.
const PACKAGE = '@popovych.co%2Fwitness'
// Short on purpose: this rides inside `check`, and a validator that hangs on a bad
// network is worse than one that stays quiet about it.
const TIMEOUT_MS = 2000

// Best-effort and SILENT on every failure — offline, air-gapped, proxied, rate-limited,
// HTML interstitial, garbage JSON. `undefined` means "we do not know", which is never a
// finding: an air-gapped machine must report nothing about the network rather than a
// complaint about it, and nothing here may touch check's exit code (row 101).
//
// WITNESS_REGISTRY is a TEST SEAM, not a configuration key — it overrides the base URL
// and the literal `off` skips the query, which is what keeps the suite off the network.
// It is deliberately undocumented, on the precedent of crashPoint's WITNESS_CRASH_AFTER
// (txn.ts:26): row 90 killed WITNESS_HARNESS to establish that configuration has exactly
// one home, and the README says so outright. If suppressing this call ever becomes a
// real user need, it belongs in .witness/config.local.yaml with the other machine facts.
export async function latestPublished(
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  const base = env.WITNESS_REGISTRY ?? DEFAULT_REGISTRY
  if (base === 'off') return undefined
  try {
    const res = await fetch(`${base}/-/package/${PACKAGE}/dist-tags`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return undefined
    const tags = (await res.json()) as { latest?: unknown }
    return typeof tags.latest === 'string' ? tags.latest : undefined
  } catch {
    return undefined
  }
}
```

If `pnpm run typecheck` complains that `fetch`, `Response` or `AbortSignal.timeout` is not defined, the cause is `tsconfig.json` having no `"lib"` entry and `@types/node` not being picked up for globals — do **not** add `"lib": ["DOM"]`, which would pull in a browser `fetch` this code does not run against. Add `"types": ["node"]` to `compilerOptions` instead and re-run.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/registry.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Pin the registry off for the whole suite**

In `tests/helpers.ts`, in the `cli` function's `Ctx` construction (around line 59), change:

```typescript
      env: { ...process.env, PI_CODING_AGENT: undefined, CLAUDECODE: undefined, ...opts.env },
```

to:

```typescript
      // Detection vars scrubbed AFTER process.env and BEFORE opts.env: the ambient
      // session's CLAUDECODE/PI_CODING_AGENT must not decide what `next` renders
      // (this suite dogfoods under pi), and a harness test asks for one by setting
      // the SAME detection var production reads — row 90 killed the env override.
      //
      // WITNESS_REGISTRY off (row 103): `check` makes a real registry call, and a suite
      // that reaches the network is slow when it works and flaky when it does not. Tests
      // that exercise the skew findings override this with a local server's base URL.
      // It is a test seam, not a config key — see the note in src/registry.ts.
      env: {
        ...process.env, PI_CODING_AGENT: undefined, CLAUDECODE: undefined,
        WITNESS_REGISTRY: 'off', ...opts.env,
      },
```

Delete the now-duplicated comment block that sat above the old line.

- [ ] **Step 6: Verify the pin holds**

Run: `npx vitest run tests/check.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS, unchanged — the pin is inert until Task 6 adds the caller, and this run proves it broke nothing.

- [ ] **Step 7: Typecheck**

Run: `pnpm run typecheck`
Expected: no output, exit 0.

---

### Task 5: `check` audits the repo, not its caller

`witness check` printed `0 errors` in a repo whose `.pi/` payload was a release behind, because it reused row 90's **spawn** ladder to decide which harness to **audit**: from a Claude Code session the resolved harness is `claude-code`, so `skillsVisibility` looked in `.claude/skills`, the payload audit found `.claude/…` absent, `installed.length === 0`, `bundled: true` — silent. The `bundled` bit converted a wrong subject into confident silence. Row 104 splits the two questions: the CLI probe asks whether *this machine* can run the repo's reviewers and keeps resolving a harness; the audit asks what is installed *here* and stops asking who is calling.

The absence answer is deliberately **one stated line for the whole repo, never a finding**: row 87's frequency argument is right — a permanent warning row for every correctly-configured plugin user costs attention on every run, and the indictment was never the missing warning, it was the confident silence. `bundled` survives as the bit that *explains* an absence rather than one that *suppresses* a finding, which is what its comment in `harness.ts` always claimed it meant.

**Files:**
- Modify: `src/harness.ts` (`skillsVisibility` at 280-289; add `resolveSkills`, `skillPins`)
- Modify: `src/verbs/check.ts` (imports; the harness block at 198-260; stated lines before the `checks:` line at 272)
- Test: `tests/check.test.ts`, `tests/harness.test.ts`

**Interfaces:**
- Consumes: `HARNESSES`, `loadHarness`, `Harness` from `src/harness.js`; `packageRoot` from `src/install.js`; `version` from `src/cli.js`; `NPX_LATEST`, `pinIn` from `src/version.js`.
- Produces (in `src/harness.ts`):
  - `resolveSkills(env, root, harness): { scope: 'global' | 'project-only' | 'absent'; dir?: string }` — `dir` is set exactly when `scope !== 'absent'`.
  - `skillPins(dir: string): Array<{ skill: string; pin: string }>` — one entry per `STAGE_SKILLS` name whose `SKILL.md` exists and carries a pin. Task 6 is its only caller; it answers *what pin* and never *is that a problem*.
  - `skillsVisibility` keeps its exact current signature and return type — it is a one-line wrapper now.

- [ ] **Step 1: Write the failing tests**

In `tests/check.test.ts`, replace the four tests named below with these. Add `mkdirSync`/`writeFileSync` and `join` imports if the file does not already have them (it does).

Replace `'warns when a harness that needs an ecosystem install has no skills at all'`:

```typescript
  // Row 104: absence is a STATED LINE, never a finding. A permanent warning row for
  // every correctly-configured user costs attention on every run (row 87's frequency
  // argument), and the indictment was never the missing warning — it was the confident
  // silence. One answer for the whole repo, naming every harness.
  it('states skills absence once, for every registry entry, without a finding', async () => {
    const repo = await seededRepo()
    const home = mkdtempSync(join(tmpdir(), 'ckhome-'))
    const res = await repo.cli(['check'], { env: { HOME: home } })
    expect(res.code).toBe(0)
    expect(res.stdout).not.toContain('skills-not-installed')
    expect(res.stdout).toContain('skills: none visible here')
    expect(res.stdout).toContain('claude-code')
    expect(res.stdout).toContain('pi')
  })
```

Replace `'stays quiet about skills on claude-code'`:

```typescript
  // `bundled` EXPLAINS an absence; it does not suppress the report of one. The
  // marketplace plugin ships skills out of band of both directories, so the honest line
  // says so rather than saying nothing.
  it('explains a bundled absence rather than suppressing it', async () => {
    const repo = await seededRepo()
    const home = mkdtempSync(join(tmpdir(), 'ckhome-'))
    const res = await repo.cli(['check'], { env: { HOME: home } })
    expect(res.stdout).toContain('claude-code — expected under the marketplace plugin')
  })
```

Replace `'warns when the resolved harness has no payload installed'`:

```typescript
  it('states payload absence once, for every registry entry, without a finding', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['check'])
    expect(res.code).toBe(0)
    expect(res.stdout).not.toContain('payload-not-installed')
    expect(res.stdout).toContain('payload: none installed here')
    expect(res.stdout).toContain(`pi — run ${NPX_LATEST} init --agent pi`)
  })
```

Replace `'stays quiet about payloads on claude-code'` with the test that proves the actual bug is dead:

```typescript
  // The field report: `check` reported `0 errors` in a repo whose .pi/ payload was a
  // release behind, then reported payload-stale on the SAME repo in the SAME second
  // under `env -u CLAUDECODE PI_CODING_AGENT=1`. The only difference between the runs
  // was which agent's environment variable was set. The audit has no caller now.
  it('reports the same payload state whichever harness is driving the session', async () => {
    const repo = await seededRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/extensions/canon-guard.mjs'
    repo.write(rel, '// a release behind\n')
    repo.git('add', rel); repo.git('commit', '-m', 'freeze the guard')

    const fromClaude = await repo.cli(['check'], { env: { CLAUDECODE: '1' } })
    const fromPi = await repo.cli(['check'], { env: { PI_CODING_AGENT: 'true' } })
    for (const res of [fromClaude, fromPi]) {
      expect(res.stdout).toContain('payload-stale')
      expect(res.stdout).toContain(rel)
    }
  })

  // Content, not pins. Three of the five payload files carry no pin at all, so the pin
  // probe could see neither a shipped guard bugfix nor its absence — a guard bugfix was
  // undeliverable AND undetectable on every existing repo, silent in both directions.
  it('sees staleness in a payload file that carries no pin', async () => {
    const repo = await seededRepo()
    await repo.cli(['init', '--agent', 'pi'])
    repo.write('.pi/extensions/witness.ts', '// stale adapter\n')
    repo.git('add', '.pi/extensions/witness.ts'); repo.git('commit', '-m', 'freeze the adapter')
    const res = await repo.cli(['check'])
    expect(res.stdout).toContain('payload-stale')
    expect(res.stdout).toContain('.pi/extensions/witness.ts')
  })

  // A repo carrying BOTH payload sets is a reachable state (a marketplace plugin install
  // and a project-scope init both fire), and the honest report is per harness.
  it('reports both payload sets in a repo that carries both', async () => {
    const repo = await seededRepo()
    await repo.cli(['init', '--agent', 'pi'])
    await repo.cli(['init', '--agent', 'claude-code'])
    repo.write('.pi/extensions/canon-guard.mjs', '// stale\n')
    repo.git('add', '.pi/extensions/canon-guard.mjs'); repo.git('commit', '-m', 'freeze pi only')
    const res = await repo.cli(['check'])
    expect(res.stdout).toContain('pi: payload')
    expect(res.stdout).not.toContain('payload: none installed here')
    expect(res.stdout).not.toContain('claude-code: payload')   // claude-code's set is current
  })
```

Add `import { NPX_LATEST } from '../src/version.js'` to the file's imports.

Leave `'flags a project-scope skills install as invisible from worktrees'`, `'stays quiet about a payload it just installed at the running version'` and `'warns when an installed payload pins an older CLI than the one running'` alone — all three still describe true behaviour. The last one now passes for a content reason rather than a pin reason, which is the point.

In `tests/harness.test.ts`, add beside the existing `skillsVisibility` cases (around line 119):

```typescript
  it('resolveSkills returns the directory it resolved, so the pin reader can find it', () => {
    const home = mkdtempSync(join(tmpdir(), 'skhome-'))
    const root = mkdtempSync(join(tmpdir(), 'skroot-'))
    for (const s of STAGE_SKILLS) {
      mkdirSync(join(root, '.pi', 'skills', s), { recursive: true })
      writeFileSync(join(root, '.pi', 'skills', s, 'SKILL.md'),
        '---\nname: x\n---\nWITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.1.0}"\n')
    }
    const r = resolveSkills({ HOME: home }, root, hx('pi'))
    expect(r.scope).toBe('project-only')
    expect(r.dir).toBe(join(root, '.pi', 'skills'))
    expect(skillPins(r.dir!)).toContainEqual({ skill: 'witness-plan', pin: '0.1.0' })
  })
```

Add `resolveSkills`, `skillPins` and `STAGE_SKILLS` to that file's `../src/harness.js` import, plus `mkdirSync`/`writeFileSync`/`mkdtempSync`, `join` and `tmpdir` if absent.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/check.test.ts tests/harness.test.ts --poolOptions.forks.maxForks=4`
Expected: the new/replaced tests FAIL — `resolveSkills` and `skillPins` do not exist, and `check` still prints `payload-not-installed`/`skills-not-installed` findings and audits only the resolved harness.

- [ ] **Step 3: Implement `resolveSkills` and `skillPins`**

In `src/harness.ts`, add `readFileSync` to the `node:fs` import, `pinIn` from `./version.js`, and replace `skillsVisibility` (lines 276-289, comment included) with:

```typescript
// Decision 14. Pi resolves project skills at resolve(cwd, '.pi', 'skills') with no
// upward walk, and implement runs with cwd inside .witness/worktrees/<plan-id> — an
// untracked directory the installer never touched. A project-scope install therefore
// loses every skill in the stage that does the most work.
//
// Row 103 needs the DIRECTORY, not just the verdict: with `latest` in hand, one pass
// reports both halves of the skew, and the skills half has to read the files it found.
export function resolveSkills(
  env: Record<string, string | undefined>, root: string, harness: Harness,
): { scope: 'global' | 'project-only' | 'absent'; dir?: string } {
  const home = env.HOME ?? env.USERPROFILE ?? ''
  const has = (dir: string): boolean =>
    STAGE_SKILLS.every((s) => existsSync(join(dir, s, 'SKILL.md')))
  const global = home === '' ? undefined : join(home, harness.skills.global)
  if (global !== undefined && has(global)) return { scope: 'global', dir: global }
  const project = join(root, harness.skills.project)
  if (has(project)) return { scope: 'project-only', dir: project }
  return { scope: 'absent' }
}

export function skillsVisibility(
  env: Record<string, string | undefined>, root: string, harness: Harness,
): 'global' | 'project-only' | 'absent' {
  return resolveSkills(env, root, harness).scope
}

// What pin does each installed skill carry? Nothing more — whether a pin is a PROBLEM
// takes the published `latest`, which is check's question and check's alone. A skill
// whose SKILL.md carries no pin is simply absent from the result: the pin is what makes
// a skill invoke a particular CLI, so one without it says nothing about skew.
export function skillPins(dir: string): Array<{ skill: string; pin: string }> {
  return STAGE_SKILLS.flatMap((skill) => {
    const p = join(dir, skill, 'SKILL.md')
    if (!existsSync(p)) return []
    const pin = pinIn(readFileSync(p, 'utf8'))
    return pin === undefined ? [] : [{ skill, pin }]
  })
}
```

- [ ] **Step 4: Restructure `check`'s harness block**

In `src/verbs/check.ts`, change the imports:

```typescript
import { HARNESSES, loadHarness, resolveHarness, resolveSkills } from '../harness.js'
import { packageRoot } from '../install.js'
import { NPX_LATEST } from '../version.js'
```

(`skillsVisibility` is no longer imported here; `skillPins` arrives in Task 6.)

Replace lines 207-260 — the whole `const hxR = resolveHarness(…)` block — with:

```typescript
  // Row 105 has NOT landed: the judgment lane still resolves detection-first. What row
  // 104 changed is that the audit below stopped asking this question at all. The probe
  // keeps it because it asks a genuinely different thing — whether THIS MACHINE can run
  // the repo's reviewers — as its own D88 comment already says.
  const hxR = resolveHarness(ctx.env, cfg.ok ? cfg.value.raw : {})
  if (!hxR.ok) {
    hxR.violations.forEach((x) => findings.push(f('error', 'harness', x.field, x.rule, x.got)))
  } else if (!probe(hxR.value.harness.launch, ['--version'], ctx.env)) {
    const launch = hxR.value.harness.launch
    findings.push(f('warn', 'probes', launch, 'missing',
      `the ${launch} CLI runs this harness's gate reviewers — install and authenticate it`))
  }

  // Row 104. `check` printed `0 errors` in a repo whose .pi/ payload was a release
  // behind, and `payload-stale` on the same repo in the same second under a different
  // agent's environment variable — because it reused row 90's SPAWN ladder to choose
  // what to AUDIT. The audit has no caller: every registry entry is reported over what
  // exists on disk, so a repo carrying both payload sets reads as the state it is.
  for (const name of HARNESSES) {
    const hx = loadHarness(name)
    if (!hx.ok) continue   // unreachable: HARNESSES is the registry's own key set
    const harness = hx.value
    const installed = harness.payload.filter((p) => existsSync(join(root, p.to)))
    if (installed.length === 0) {
      // `bundled` EXPLAINS the absence; it does not suppress the report of one, which
      // is what its comment in harness.ts always claimed it meant.
      payloadAbsent.push(`${name} — ${harness.bundled
        ? 'expected under the marketplace plugin'
        : `run ${NPX_LATEST} init --agent ${name}`}`)
    } else {
      // Row 102: content, not pins. THREE of the five payload files carry no pin at all
      // (canon-guard.mjs, guard-state.mjs, witness-pi.ts), so the pin probe left a guard
      // bugfix undeliverable AND undetectable — silent in both directions.
      //
      // A shipped file we cannot read is a PACKAGING failure, not repo staleness, and
      // "cannot compare" stays silent here: harness.ts:107 names the exact mode — drop
      // the dir from package.json `files` and the published package breaks while the
      // whole suite stays green, because vitest reads from the repo root. installPayload
      // is where that condition refuses (`source-missing`); a diagnostic verb must not
      // crash on it, and must not report the repo as stale for it either.
      const stale = installed.filter((p) => {
        const src = join(packageRoot(), p.from)
        if (!existsSync(src)) return false
        return readFileSync(join(root, p.to), 'utf8') !== readFileSync(src, 'utf8')
      })
      if (stale.length > 0) {
        findings.push(f('warn', 'harness', `${name}: payload`, 'payload-stale',
          `${stale.map((p) => p.to).join(' · ')} differ from what ${version()} ships — run ${NPX_LATEST} init --agent ${name}`))
      }
    }

    const skills = resolveSkills(ctx.env, root, harness)
    if (skills.scope === 'project-only') {
      // A content question, not an absence: the files ARE here, in a place the stage
      // that does the most work cannot see.
      findings.push(f('warn', 'harness', `${name}: skills`, 'skills-project-scope',
        `${harness.skills.project} is invisible from a worktree cwd — reinstall at global scope (${harness.skills.global} under $HOME)`))
    } else if (skills.scope === 'absent') {
      skillsAbsent.push(`${name} — ${harness.bundled
        ? 'expected under the marketplace plugin'
        : 'npx skills@latest add <witness tarball url> at global scope'}`)
    }
  }
```

Declare the two accumulators beside `findings` at line 43:

```typescript
  const findings: Finding[] = []
  // Absence keeps at most ONE answer for the whole repo, and it is a stated line rather
  // than a finding (row 104): a permanent warning row for every correctly-configured
  // plugin user costs attention on every run, and row 87's frequency argument holds.
  const payloadAbsent: string[] = []
  const skillsAbsent: string[] = []
```

Then, immediately before the `model-floor` block at line 266, emit the stated lines:

```typescript
  // Stated, never findings — they touch neither the findings table nor the exit code. The
  // line appears only when NO harness has one, because a repo driven by pi does not owe a
  // claude-code payload and naming its absence is the permanent noise row 87 refused.
  if (payloadAbsent.length === HARNESSES.length) {
    ctx.out(kv('payload', `none installed here (${payloadAbsent.join(' · ')})`))
  }
  if (skillsAbsent.length === HARNESSES.length) {
    ctx.out(kv('skills', `none visible here (${skillsAbsent.join(' · ')})`))
  }
```

Keep the `model-floor` block exactly as it is, `resolveHarness` and all — row 105 moves it in 0.8.0.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/check.test.ts tests/harness.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 6: Run the neighbours that read `check`'s output**

Run: `npx vitest run tests/dashboard.test.ts tests/regression-check.test.ts tests/cli.test.ts tests/verb-usage.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. If a dashboard test asserts on a `skills-not-installed`/`payload-not-installed` string, it was asserting `check`'s vocabulary from the wrong surface — fix the assertion to the stated line, do not re-add the finding.

- [ ] **Step 7: Typecheck**

Run: `pnpm run typecheck`
Expected: no output, exit 0.

---

### Task 6: One query, both halves of the skew

With `latest` in hand the same pass answers both questions a frozen repo cannot answer for itself: is the running CLI behind what is published, and is each visible `SKILL.md` pinning something older. It lives in `check`, the validator, and not in `next`, which runs every turn.

The residual is real and unavoidable by construction: repos already frozen at ≤0.6.0 never invoke a CLI carrying this code. Their one lever is the skills tarball, which Task 8 documents.

**Files:**
- Modify: `src/verbs/check.ts`
- Test: `tests/check.test.ts`

**Interfaces:**
- Consumes: `latestPublished(env)` from `src/registry.js` (Task 4); `compareTriple`, `NPX_LATEST` from `src/version.js` (Task 1); `skillPins(dir)` from `src/harness.js` (Task 5); `version()` from `src/cli.js`.
- Produces: two new finding rules — `cli-behind` (area `harness`, field `cli`) and `skills-behind` (area `harness`, field `<name>: skills`). Both `warn`. Neither touches the exit code.

- [ ] **Step 1: Write the failing tests**

Append to `tests/check.test.ts`, inside the `describe('witness check — harness findings', …)` block:

```typescript
  // Row 103. version() reads the RUNNING CLI's own package.json and every invocation
  // surface pins the CLI, so on a frozen repo every witness invocation IS the old CLI,
  // comparing the payload against itself and reporting clean. The freeze is
  // self-concealing; the registry is the one fact outside the loop.
  it('warns that the running CLI is behind the published latest', async () => {
    const repo = await seededRepo()
    const reg = await fakeRegistry('99.0.0')
    const res = await repo.cli(['check'], { env: { WITNESS_REGISTRY: reg.base } })
    expect(res.stdout).toContain('cli-behind')
    expect(res.stdout).toContain('99.0.0')
    expect(res.code).toBe(0)          // warn level only — the exit code is a contract
    reg.close()
  })

  it('says nothing when the running CLI is the published latest', async () => {
    const repo = await seededRepo()
    const reg = await fakeRegistry(version())
    const res = await repo.cli(['check'], { env: { WITNESS_REGISTRY: reg.base } })
    expect(res.stdout).not.toContain('cli-behind')
    reg.close()
  })

  // Silent on failure, and silence means SILENT: an offline machine reports nothing
  // rather than a finding about the network.
  it('reports nothing at all when the registry cannot be reached', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['check'], { env: { WITNESS_REGISTRY: 'http://127.0.0.1:1' } })
    expect(res.stdout).not.toContain('cli-behind')
    expect(res.stdout).not.toContain('skills-behind')
    expect(res.code).toBe(0)
  })

  // The other half of the SAME query. Pi's skills are version-pinned tarballs that do
  // not auto-update, and each pins the CLI it invokes — so stale skills keep running the
  // stale CLI, and dashboard.ts prints that version and sees nothing wrong.
  it('warns that visible skills pin an older CLI than the published latest', async () => {
    const repo = await seededRepo()
    const home = mkdtempSync(join(tmpdir(), 'ckhome-'))
    for (const s of STAGE_SKILLS) {
      mkdirSync(join(home, '.pi', 'agent', 'skills', s), { recursive: true })
      writeFileSync(join(home, '.pi', 'agent', 'skills', s, 'SKILL.md'),
        '---\nname: x\n---\nWITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.1.0}"\n')
    }
    const reg = await fakeRegistry('99.0.0')
    const res = await repo.cli(['check'], { env: { HOME: home, WITNESS_REGISTRY: reg.base } })
    expect(res.stdout).toContain('skills-behind')
    expect(res.stdout).toContain('witness-plan')
    expect(res.code).toBe(0)
    reg.close()
  })
```

Add this helper at the top of `tests/check.test.ts`, below the imports:

```typescript
// A local dist-tags endpoint. The suite pins WITNESS_REGISTRY off (helpers.ts); the
// skew tests are the only ones that turn it back on, and they point it here.
async function fakeRegistry(latest: string): Promise<{ base: string; close: () => void }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ latest }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() }
}
```

Add to the file's imports: `import { createServer } from 'node:http'`, `import { version } from '../src/cli.js'`, and `STAGE_SKILLS` from `../src/harness.js` if not already imported (it is, at line 6).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/check.test.ts --poolOptions.forks.maxForks=4`
Expected: the four new tests FAIL — no `cli-behind` or `skills-behind` is ever emitted.

- [ ] **Step 3: Write the implementation**

In `src/verbs/check.ts`, extend the imports:

```typescript
import { HARNESSES, loadHarness, resolveHarness, resolveSkills, skillPins } from '../harness.js'
import { latestPublished } from '../registry.js'
import { NPX_LATEST, compareTriple } from '../version.js'
```

Immediately after the judgment-lane probe block from Task 5 and **before** the `for (const name of HARNESSES)` loop, add:

```typescript
  // Row 103: ONE query, both halves of the skew. Best-effort and silent on every failure
  // — `undefined` means "we do not know", which is never a finding, because an
  // air-gapped machine must report nothing about the network rather than a complaint
  // about it. Warn level only: check's exit code is a contract about canon validity
  // (row 101), and nothing here may move it.
  const latest = await latestPublished(ctx.env)
  const behind = (pin: string): boolean =>
    latest !== undefined && (compareTriple(pin, latest) ?? 0) < 0
  if (latest !== undefined && behind(version())) {
    findings.push(f('warn', 'harness', 'cli', 'cli-behind',
      `running ${version()}, published latest is ${latest} — every invocation surface pins the CLI, so upgrade with ${NPX_LATEST} init --agent <name>`))
  }
```

Inside the per-harness loop, extend the skills branch — replace the `else if (skills.scope === 'absent')` tail with:

```typescript
    } else if (skills.scope === 'absent') {
      skillsAbsent.push(`${name} — ${harness.bundled
        ? 'expected under the marketplace plugin'
        : 'npx skills@latest add <witness tarball url> at global scope'}`)
    } else {
      // The second half of the same query. A tarball URL is version-pinned so `skills
      // update` cannot resolve forward, and each skill pins the CLI it invokes — stale
      // skills therefore keep running the stale CLI, which reports its own version and
      // sees nothing wrong. Skills first, then init --agent: the fresh pin is what
      // invokes a CLI new enough to restamp the payload.
      const stale = skillPins(skills.dir!).filter((s) => behind(s.pin))
      if (stale.length > 0) {
        findings.push(f('warn', 'harness', `${name}: skills`, 'skills-behind',
          `${stale.map((s) => `${s.skill}@${s.pin}`).join(' · ')} — published latest is ${latest}; re-add the skills tarball at ${latest}, then run ${NPX_LATEST} init --agent ${name}`))
      }
    }
```

`skills.dir` is non-null in this branch by `resolveSkills`'s contract (`dir` is set exactly when `scope !== 'absent'`), which is what the `!` records.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/check.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 5: Prove the suite still makes no network call**

Run: `rg -n "WITNESS_REGISTRY" tests/`
Expected: `tests/helpers.ts` pinning `'off'`, `tests/registry.test.ts`, and the skew tests in `tests/check.test.ts` — each pointing at `127.0.0.1`. No other file, and no test that omits the variable while exercising `check` on a real base URL.

- [ ] **Step 6: Typecheck**

Run: `pnpm run typecheck`
Expected: no output, exit 0.

---

### Task 7: The terminus is not a refusal

98d said the bound's language should stop implying malfunction, named no target and no test, and was carried as debt three times. The target is one false sentence: `renderRefusal` (`src/refusal.ts:24-28`) appends `help: fix each row and re-run — rows are structured for self-repair`, and at the bound there is nothing to fix while re-running is exactly what the bound forbids — `gate.ts` short-circuits before invoking. The code already knew: `decide.ts:160` reads *"at the bound 'run the gate' is a lie"*, and works around it by packing the exits list into a violation row's `want` column, so the human standing at the designed terminus is handed a violations table instructing them to self-repair.

`override-required` **stays** a refusal — the human asked for an approve they are not entitled to, and *fix the row and re-run* is true and useful there. `--override` keeps its name; renaming it would contradict row 93, which accepted exactly what it means. `next.ts:340,352,364` and `gate.ts:258` are deliberately left alone: they are already neutral and accurate, and `gate`'s `BLOCKED` versus `decide`'s `REFUSED` describe two genuinely different failures of one situation.

**Files:**
- Modify: `src/verbs/decide.ts` (lines 159-169 and 173-178)
- Test: `tests/decide.test.ts`

**Interfaces:**
- Consumes: `liveExits(gate, target, entries, stale)` from `src/gate.js` (already imported), `roundsSinceApprove` from `src/rounds.js` (already imported), `kv` from `src/toon.js` (already imported), `EXIT` from `src/cli.js` (already imported).
- Produces: a module-private `renderBound(ctx, gate, target, entries, stale, note?): number`. Exit codes are unchanged everywhere.

- [ ] **Step 1: Write the failing tests**

Append to `tests/decide.test.ts`, inside `describe('witness decide', …)`:

```typescript
  // Row 108 / 98d. The bound is the DESIGNED terminus: nothing malfunctioned, there is
  // no row to fix, and re-running is the one thing the bound forbids — gate.ts
  // short-circuits before invoking. renderRefusal's trailer says the opposite.
  it('at the bound, prints the terminus rather than a self-repair refusal', async () => {
    const repo = await boundRepo()
    await repo.cli(['decide', 'plan', 'auth-refresh', '--stop'])
    const r = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve'])
    expect(r.code).toBe(2)                                        // exit code unchanged
    const all = r.stdout + r.stderr
    expect(all).not.toContain('rows are structured for self-repair')
    expect(all).not.toContain('refused[')
    expect(all).toContain('bound reached')
    expect(all).toContain('exits: witness decide plan auth-refresh --approve --override')
  })

  it('at the bound, a plain revise names the exits without the self-repair trailer', async () => {
    const repo = await boundRepo()
    const r = await repo.cli(['decide', 'plan', 'auth-refresh', '--revise', '--note', 'x'])
    expect(r.code).toBe(2)
    const all = r.stdout + r.stderr
    expect(all).not.toContain('rows are structured for self-repair')
    expect(all).toContain('--revise --upstream')
    expect(all).toContain('upstream reopens the parent and resets the budget')
  })

  // override-required is GENUINELY a refusal: the human asked for an approve they are
  // not entitled to, and "fix the row and re-run" is true and useful there.
  it('keeps override-required a refusal, trailer and all', async () => {
    const repo = await boundRepo()
    const r = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve'])
    // pending at the bound: the anchor exists, so this is the override-required path
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('override-required')
    expect(r.stdout + r.stderr).toContain('rows are structured for self-repair')
  })
```

Note the ordering trap in the first and third tests: `boundRepo()` leaves round 3 **pending**, so a bare `--approve` reaches `override-required` (test three). The `--stop` in test one settles that round, which is what makes the `!anchor` branch reachable (test two exercises the second site directly, since a pending anchor exists there).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/decide.test.ts --poolOptions.forks.maxForks=4`
Expected: tests one and two FAIL on `not.toContain('rows are structured for self-repair')`; test three PASSES already and is the regression fence.

- [ ] **Step 3: Write the implementation**

In `src/verbs/decide.ts`, add above `export async function run`:

```typescript
// Row 108. The bound is the designed terminus, not a malfunction, and renderRefusal
// appends `help: fix each row and re-run — rows are structured for self-repair`, which is
// false here twice over: there is no row to fix, and re-running is exactly what the bound
// forbids (gate.ts short-circuits before invoking). The old code knew — it packed the
// exits list into a violation row's `want` column — so the human at the terminus was
// handed a violations table instructing them to self-repair. This prints `--show`'s
// surface instead: state, then the exits that actually work. The exit code is unchanged;
// the decision the human asked for still did not happen.
function renderBound(
  ctx: Ctx, gate: string, target: string, entries: Entry[], stale: boolean, note?: string,
): number {
  ctx.err(kv('gate', gate))
  ctx.err(kv('target', target))
  ctx.err(kv('state', `bound reached — ${roundsSinceApprove(entries, gate)} rounds; the gate will not run again`))
  if (note !== undefined) ctx.err(kv('note', note))
  ctx.err(kv('exits', liveExits(gate, target, entries, stale)))
  return EXIT.REFUSED
}
```

Replace the `if (!anchor)` block (lines 159-169):

```typescript
  const anchor = pending ?? ((boundEndgame || revisedAnchor) ? last : undefined)
  if (!anchor) {
    if (atBound && last) {
      // liveExits, not a hardcoded triple: it drops --approve --override when content
      // moved, which is the same set the stale-verdict refusal below names. A human
      // cannot honestly stamp bytes no battery read, at the bound or anywhere else.
      return renderBound(ctx, gate, target, entries, nowSha !== undefined && nowSha !== last.reviewed_sha)
    }
    renderRefusal([v('gate', 'nothing-pending', `${gate} ${target}`,
      `a stopped gate-run awaiting a decision — run: witness gate ${gate} ${target}`)])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
```

Replace the plain-revise-at-the-bound block (lines 173-178):

```typescript
  if (decision === 'revise' && atBound && upstream === undefined) {
    return renderBound(ctx, gate, target, entries,
      last !== undefined && nowSha !== undefined && nowSha !== last.reviewed_sha,
      'upstream reopens the parent and resets the budget')
  }
```

Both sites read `nowSha`, computed at line 154 above them — verify it is in scope before you edit (it is: `nowSha` and `unchanged` are declared just above `revisedAnchor`). `Entry` is already imported as a type from `../journal.js`, and `Ctx` from `../cli.js`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/decide.test.ts tests/decide-show.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. `'livelock regression: after a stop at the bound, every exit still works'` still passes — it asserts on `stdout + stderr` containing `--revise --upstream`, which `exits:` carries.

- [ ] **Step 5: Verify the trailer is untouched everywhere else**

Run: `npx vitest run tests/reopen.test.ts tests/policy-pins.test.ts tests/flows.test.ts tests/next.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. `renderRefusal` itself is unchanged — this task changed two call sites, not the renderer.

- [ ] **Step 6: Typecheck**

Run: `pnpm run typecheck`
Expected: no output, exit 0.

---

### Task 8: The documented upgrade order, and the version bump

Rows 102 and 103 both ship in a CLI that a frozen repo never invokes, so neither reaches the installed base on its own — the fix cannot deliver itself. The one lever that already exists is the skills tarball: re-adding skills installs fresh pins, those pins invoke the new CLI, and *that* CLI sees the outdated payload and restamps it. The documented order is therefore **skills first, then `init --agent <name>`**, and DESIGN.md records it as release-note and README work rather than code.

**Files:**
- Modify: `README.md` (the "Install per harness" section, after the tarball-pin paragraph around line 87)
- Modify: `package.json` (`version`)
- Modify: `plugin/**` (via `pnpm run sync-versions`)

**Interfaces:** none — documentation and a version stamp.

- [ ] **Step 1: Add the upgrade order to the README**

In `README.md`, replace:

```markdown
A tarball URL is version-pinned, so `skills update` cannot resolve forward: re-run `add`
with the new version URL to upgrade.
```

with:

```markdown
A tarball URL is version-pinned, so `skills update` cannot resolve forward: re-run `add`
with the new version URL to upgrade.

### Upgrading: skills first, then `init --agent`

Every surface that invokes witness pins the CLI — the engine prompt and all six skills
carry `npx -y @popovych.co/witness@<version>` — so a repo installed at an older release
only ever runs that release, which compares its payload against itself and reports clean.
The freeze is self-concealing, and a repo frozen at **0.6.0 or earlier cannot detect it**,
because the detection ships in a CLI that repo never invokes. Unstick it from outside, in
this order:

```bash
npx skills@latest add https://registry.npmjs.org/@popovych.co/witness/-/witness-<new-version>.tgz
npx -y @popovych.co/witness@latest init --agent <name>   # restamps the engine, guard and dashboard
```

Skills first: their fresh pins are what invoke a CLI new enough to see the outdated
payload. Claude Code users on the marketplace plugin get both halves from
`/plugin marketplace add` and need no second step.

From **0.7.0** onward the order stops mattering: `witness check` asks the registry what
the published `latest` is and reports both halves of the skew — a CLI behind `latest`
(`cli-behind`) and any visible skill pinning something older (`skills-behind`). The query
is best-effort and silent on failure, so an offline machine reports nothing rather than a
complaint about the network.

`witness init --agent <name>` overwrites payload files it did not write and names what it
replaced (`payload-overwritten`); the previous content is one `git revert` away, because
witness commits the payload. It refuses the whole run if a payload path carries an
uncommitted change (`payload-dirty`) or if the CLI you are running is older than the
payload already installed (`cli-behind-payload`).
```

- [ ] **Step 2: Bump the version and stamp every pin**

The bump and the stamp are one step: `tests/version-sync.test.ts` fails the build if any `plugin/**` pin disagrees with `package.json`.

```bash
npm pkg set version=0.7.0
pnpm run sync-versions
```

Expected: `@popovych.co/witness@0.7.0: 8 file(s) restamped` — `plugin/.claude-plugin/plugin.json`, `plugin/commands/witness.md`, `plugin/hooks/session-dashboard.sh` and the six `SKILL.md` files, minus any already at 0.7.0.

- [ ] **Step 3: Verify the stamp**

Run: `npx vitest run tests/version-sync.test.ts tests/skills.test.ts tests/prompts.test.ts`
Expected: PASS.

- [ ] **Step 4: Full suite**

```bash
rm -rf .witness/worktrees
npx vitest run --poolOptions.forks.maxForks=4 > /tmp/witness-070.txt 2>&1; tail -20 /tmp/witness-070.txt
```

Expected: **109 test files, ≥ 800 tests, 0 failed.** Baseline was 107 files / 790 tests; this plan adds `tests/version-compare.test.ts` (8) and `tests/registry.test.ts` (6), plus net new cases in `tests/init-agent.test.ts`, `tests/check.test.ts`, `tests/harness.test.ts` and `tests/decide.test.ts`. A *lower* count than 790 means a test was deleted without a replacement — find it before proceeding.

- [ ] **Step 5: Build**

Run: `pnpm run build`
Expected: exit 0, `dist/` refreshed.

- [ ] **Step 6: Report, do not commit**

Report to the human: the suite result, the file count, and the list of touched files. Do **not** commit — the standing preference is one conversation about commit granularity at the end, and `DESIGN.md`'s uncommitted rows 102–108 belong in that conversation too.

---

## Notes for whoever executes this

**What is deliberately NOT here.** Rows 105 (judgment vs session lane), 106 (`pin` on the gate-run entry) and 107 (fallback is budget-exempt) are 0.8.0. They change gate outcomes; everything above changes install, diagnostics and one block of text. If a task tempts you into `gate.ts`, `rounds.ts` or `resolveModel`, you have crossed the line.

**Sequencing is load-bearing.** No repo receives rows 102 or 103 until its engine pin moves, so the unfreezing mechanism must land and publish before anything that depends on repos being current. That is why 0.7.0 is the payload/diagnostics release and not a mixed one.

**One protocol constraint inherited from grill #13.** `appendKind` keys on harness while `roundsSinceApprove` counts every non-malformed run with no key reference, so **a harness flip spends a round**. If you run any manual gate measurement while executing this plan, drive it from ONE harness or the round counts are contaminated. Row 105 fixes the underlying split; this plan does not.

**Publishing is not in this plan.** `npm publish` needs `--otp` and a cold verification run from **outside** this repo (local-project resolution shadows the registry and produces a false "command not found"). Both plugin scopes need their cache updated afterwards. Ask before doing any of it.

---

## Self-review

**Spec coverage.**

| DESIGN row | Requirement | Task |
| --- | --- | --- |
| 102 | four-way → three-way; differing overwrites and reports `payload-overwritten` | 3 |
| 102 | `pinOnlyDifference` dies | 3 |
| 102 | `check`'s staleness becomes a content compare covering all five files | 5 |
| 102 | `preflightPayload` gains `payload-dirty` (`--untracked-files=all`, whole-run, pre-lock) | 2 |
| 102 | ordered write; `cli-behind-payload`; equal triples write; prerelease out of scope | 1, 2 |
| 102 | `harness.settings` outside the dirty guard | 2 |
| 102 | `SyncResult` → `written`/`overwritten`; no `--force` | 3 |
| 103 | registry query for `latest`, best-effort, silent, warn-only, exit code untouched | 4, 6 |
| 103 | lives in `check`, not `next` | 6 |
| 103 | one query reports payload skew and skills skew | 6 |
| 103 | remedies become version-explicit (`…@latest init --agent <name>`) | 1, 5, 6 |
| 103 | frozen-repo residual documented (skills first, then `init --agent`) | 8 |
| 104 | audit drops `resolveHarness`; per registry entry over what is on disk | 5 |
| 104 | absence is at most one stated line, never a finding | 5 |
| 104 | `bundled` explains rather than suppresses | 5 |
| 104 | skills half follows the same rule | 5 |
| 104 | CLI probe stays on the judgment lane | 5 |
| 108 | two bound sites stop rendering through `renderRefusal`; exits list in `--show`'s shape | 7 |
| 108 | exit codes unchanged; `override-required` stays a refusal; `--override` keeps its name | 7 |
| 108 | testable in one assertion — the self-repair trailer must not appear at the bound | 7 |

**Type consistency.** `SyncResult` is `{ written, overwritten }` in Task 3 and consumed under exactly those names in `init.ts`. `resolveSkills` returns `{ scope, dir? }` in Task 5 and is read as `skills.scope`/`skills.dir` in Tasks 5 and 6. `skillPins(dir)` returns `Array<{ skill, pin }>` in Task 5 and is destructured as `s.skill`/`s.pin` in Task 6. `compareTriple` returns `number | undefined` in Task 1 and every consumer applies `?? 0` before comparing. `latestPublished(env)` returns `Promise<string | undefined>` in Task 4 and Task 6 guards on `!== undefined` before every use. `NPX_LATEST` is the same constant in Tasks 1, 2, 5 and 6.

**Known deviation from the row text, stated deliberately.** Row 104 says `resolveHarness` leaves `check.ts:207` *entirely*. It leaves the **audit** entirely, and the CLI probe keeps it — because the probe belongs to row 105's judgment lane, and row 105 ships in 0.8.0. Moving the probe to a `harness:`-first ladder here would change which binary is probed based on committed config, which is a 0.8.0 behaviour change.

**Second stated reading, and how to flip it.** Row 104's absence line is emitted only when **no** harness has a payload (and likewise for skills), which is what "at most one answer for the whole repo" plus the row's own example string — naming both harnesses — describes. A repo carrying pi's payload and not claude-code's therefore hears nothing about claude-code, on row 87's frequency argument: a line printed on every run of a correctly-configured repo is the noise that argument refuses.

This is the weakest inference in the plan, and it is one condition. To flip it to *report every absent harness, whatever else is installed*, change both guards in Task 5 Step 4 from `=== HARNESSES.length` to `> 0` and reword the prefixes (`payload: not installed for …`, `skills: not visible for …`); the test `'reports both payload sets in a repo that carries both'` then asserts the line's presence instead of `not.toContain('payload: none installed here')`. Nothing else in the plan depends on the choice.

**One band-aid removed rather than documented.** An earlier draft justified `WITNESS_REGISTRY` as a user-facing escape hatch for air-gapped machines and proposed documenting it in the README. That would have contradicted the README's own doctrine — *"There are no `WITNESS_*` env vars for configuration"* — which row 90 established by killing `WITNESS_HARNESS`. The variable stays, as an undocumented test seam on `WITNESS_CRASH_AFTER`'s precedent; the air-gapped case is served by the 2s cap and the silent failure, and if it ever needs a real knob that knob belongs in `.witness/config.local.yaml`.
