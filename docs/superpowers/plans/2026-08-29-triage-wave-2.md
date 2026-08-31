# Triage Wave 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the behavior half of the pi-sessions triage — rows D137, D138, D141, D142-diffbase, D143, D144, D151, D154 — the git-loop root fix, nod-selection, install-time allowlist, the #18 anchor fix, and trust-where-a-human-decides.

**Architecture:** The git loop closes in three layers that stay independently shippable inside this wave: prevention (worktrees cut from the fetched remote tip), healing (auto-sync at merge-stamp and start), and safety (cwd-safe removal, descendant diff base). Trust and nod-selection ride the existing decision-block and journal machinery; nothing new stores state outside `allow.json` and journal entries.

**Tech Stack:** TypeScript (Node), vitest in-process CLI against throwaway git repos with bare file remotes (`addOrigin` in `tests/helpers.ts`).

**Spec:** `docs/superpowers/specs/2026-08-29-pi-sessions-triage-design.md` (each task names its row — read the row before the task).

## Global Constraints

- Branch `d137-pi-sessions-triage` until wave 1 merges; then a fresh branch cut per D137's own rule once built (bootstrap irony accepted).
- **Wave-2 tasks may change gate outcomes** (that is the wave's definition) but each change must be exactly the spec'd one — nothing opportunistic.
- Wave 1 must be merged and released first (`0.14.0`); this wave releases as **`0.15.0`** (T10).
- `pnpm test && pnpm run typecheck && pnpm run build` green after every task.
- `Violation.remedy`, `divergence()`, `classifyPullFailure()` from wave 1 are available — reuse, never duplicate.
- Journal `EntryType` grows by `'sync'` and `'trust'` only (T3, T8); every new entry goes through `entryLine`/`appendEntry` so the `w:` version stamp holds.
- Commits: conventional, row in subject, e.g. `feat(start): cut worktrees from the fetched remote tip (D137)`.

---

### Task 1: D137 — worktrees are cut from the fetched remote tip

**Files:**
- Modify: `src/verbs/start.ts` (~line 36 and both `createWorktree` call sites at ~52 and ~88)
- Create: helper `resolveStartBase` in `src/gitio.ts`
- Test: `tests/start.test.ts` (extend — wave 1 created it)

**Interfaces:**
- Produces: `resolveStartBase(root: string, branch: string): Result<string>` in `src/gitio.ts` — returns `origin/<branch>` after a successful `git fetch origin <branch>`; returns the local `branch` when no remote is configured; **refuses** `fetch-failed` when a remote exists and the fetch fails (no silent local fallback — spec D137).
- Consumes: `tryGit`, `refuse`, `v`.

**Corrected while executing** (recorded not quietly fixed): the `fetch-failed` refusal carries a runnable remedy only when the fetch output says the ref is missing (`couldn't find remote ref` / `no such ref`). An unreachable host gets the `want` text and **no** `run:` line — `git push` fixes nothing there, and a rendered command that fixes nothing is the D129 defect D147's placeholder test exists to prevent. Also: the no-remote test must capture `main`'s tip **before** `start`, because `start`'s own status flip is a state commit and local main is one ahead of the cut point by the time the verb returns.

- [ ] **Step 1: Write the failing tests**

Append to `tests/start.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addOrigin } from './helpers.js'

describe('start cuts from the fetched remote tip (D137)', () => {
  it('new plan branch bases on origin/<branch>, not stale local main', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1', { parent: 'auth-refresh' })
    approve(repo, 'auth-refresh-plan-1')
    addOrigin(repo)
    // origin advances beyond local main
    const clone = mkdtempSync(join(tmpdir(), 'd137-'))
    execFileSync('git', ['clone', `${repo.root}-origin.git`, clone])
    execFileSync('git', ['-C', clone, 'commit', '--allow-empty', '-m', 'remote-ahead'], { stdio: 'ignore' })
    execFileSync('git', ['-C', clone, 'push', 'origin', 'main'], { stdio: 'ignore' })
    const res = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(res.code).toBe(0)
    const wt = `${repo.root}/.witness/worktrees/auth-refresh-plan-1`
    const tip = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const originTip = repo.git('rev-parse', 'origin/main')
    expect(tip).toBe(originTip)          // cut point is the REMOTE tip
    expect(tip).not.toBe(repo.git('rev-parse', 'main'))
  })
  it('refuses when a remote exists and the fetch fails', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1', { parent: 'auth-refresh' })
    approve(repo, 'auth-refresh-plan-1')
    repo.git('remote', 'add', 'origin', '/nonexistent/origin.git')
    const res = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('fetch-failed')
  })
  it('no remote → local cut stays legal', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1', { parent: 'auth-refresh' })
    approve(repo, 'auth-refresh-plan-1')
    const res = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(res.code).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/start.test.ts` → first case FAILS (tip equals local main).

- [ ] **Step 3: Implement**

`src/gitio.ts`:

```ts
// D137. The create path cuts new plan branches from the FETCHED remote tip, so a plan
// branch can never inherit unpushed state commits — the shape that made squash-merge
// unrecoverable (reproduced in the 2026-08-29 triage). No silent local fallback: that
// would quietly reintroduce the root. A repo with no remote keeps the local cut —
// divergence needs a remote to exist.
export function resolveStartBase(root: string, branch: string): Result<string> {
  if (!tryGit(root, 'remote', 'get-url', 'origin').ok) return ok(branch)
  const fetch = tryGit(root, 'fetch', '--quiet', 'origin', branch)
  if (!fetch.ok) {
    return refuse([v('remote', 'fetch-failed', fetch.out.trim().slice(0, 160),
      `origin/${branch} reachable — check the network, or git push -u origin ${branch} if the remote has no such branch`)])
  }
  return ok(`origin/${branch}`)
}
```

`src/verbs/start.ts`: after `const base = ship.branch ?? 'main'` insert:

```ts
  const baseRefR = resolveStartBase(root, base)
  if (!baseRefR.ok) { renderRefusal(baseRefR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const baseRef = baseRefR.value
```

and pass `baseRef` (not `base`) to both `createWorktree(root, planId, ...)` call sites. The re-attach arm inside `createWorktree` is untouched — an existing branch's base is history.

- [ ] **Step 4: Verify pass** — `pnpm vitest run tests/start.test.ts && pnpm vitest run` (full suite: no-remote repos everywhere must stay green).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(start): cut worktrees from the fetched remote tip (D137)"`

---

### Task 2: D142-diffbase — one diff base: the true cut point

**Files:**
- Modify: `src/evidence.ts:141-147` (`diffBase`)
- Test: `tests/evidence-for-diff.test.ts` (extend)

**Interfaces:**
- Produces: `diffBase` unchanged signature; resolution becomes the **descendant** of `merge-base(HEAD, <branch>)` and `merge-base(HEAD, origin/<branch>)`; local half alone when no remote; origin half on incomparable ancestries. All seven callers inherit it.

- [ ] **Step 1: Write the failing test**

Append to `tests/evidence-for-diff.test.ts` (mirror its worktree fixture style):

```ts
  it('legacy contaminated branch keeps the local cut point — state files never enter the diff (D142)', async () => {
    // Shape from the spec's E1 experiment: local main ahead by a state commit, branch cut
    // from local main, origin squash-merged the content.
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    addOrigin(repo)
    repo.git('commit', '--allow-empty', '-m', 'state-ahead')          // local main ahead
    repo.git('branch', 'witness/legacy-plan', 'main')                  // legacy cut
    const clone = mkdtempSync(join(tmpdir(), 'd142-'))
    execFileSync('git', ['clone', `${repo.root}-origin.git`, clone])
    execFileSync('git', ['-C', clone, 'commit', '--allow-empty', '-m', 'squash-stand-in'], { stdio: 'ignore' })
    execFileSync('git', ['-C', clone, 'push', 'origin', 'main'], { stdio: 'ignore' })
    repo.git('fetch', 'origin', 'main')
    // In a checkout of the legacy branch, diffBase must pick the LOCAL merge-base (descendant).
    const wt = mkdtempSync(join(tmpdir(), 'd142-wt-'))
    execFileSync('git', ['-C', repo.root, 'worktree', 'add', wt, 'witness/legacy-plan'])
    const { diffBase } = await import('../src/evidence.js')
    const { loadConfig } = await import('../src/config.js')
    const cfg = loadConfig(repo.root)
    if (!cfg.ok) throw new Error('cfg')
    const b = diffBase(wt, cfg.value)
    if (!b.ok) throw new Error('base')
    expect(b.value).toBe(repo.git('merge-base', 'witness/legacy-plan', 'main'))
    expect(b.value).not.toBe(repo.git('merge-base', 'witness/legacy-plan', 'origin/main'))
  })
```

- [ ] **Step 2: Verify failure** — `pnpm vitest run tests/evidence-for-diff.test.ts`.

- [ ] **Step 3: Implement**

Replace `diffBase`'s non-override body:

```ts
  const ship = (cfg.raw.ship ?? {}) as Record<string, unknown>
  const branch = typeof ship.branch === 'string' ? ship.branch : 'main'
  // D142. The true cut point is the DESCENDANT of the two merge-bases: exact for
  // legacy-contaminated branches (local later — origin-only would put inherited state
  // files into the reviewed diff, reproduced in the triage), for post-D137 clean cuts
  // (origin equal or later), and for a behind local. Incomparable → origin (the
  // post-D137 invariant). No remote → local alone.
  const local = tryGit(runRoot, 'merge-base', 'HEAD', branch)
  const remote = tryGit(runRoot, 'merge-base', 'HEAD', `origin/${branch}`)
  if (!local.ok && !remote.ok) {
    return refuse([v('ship.branch', 'no-base', branch, 'an existing base branch, or pass --base <ref>')])
  }
  if (local.ok !== remote.ok) return ok((local.ok ? local : remote).out.trim())
  const a = local.out.trim(), b = remote.out.trim()
  if (a === b) return ok(a)
  if (tryGit(runRoot, 'merge-base', '--is-ancestor', a, b).ok) return ok(b)
  if (tryGit(runRoot, 'merge-base', '--is-ancestor', b, a).ok) return ok(a)
  return ok(b)
```

- [ ] **Step 4: Verify pass** — `pnpm vitest run tests/evidence-for-diff.test.ts tests/evidence.test.ts tests/base-movement.test.ts && pnpm vitest run`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "fix(evidence): diff base is the descendant of both merge-bases — the true cut point (D142)"`

---

### Task 3: D138 — sync happens where origin moved

**Files:**
- Modify: `src/verbs/sync.ts` (extract core), `src/stamp.ts` (after the candidates loop), `src/verbs/start.ts` (preflight before `resolveStartBase`), `src/journal.ts` (EntryType `'sync'`)
- Test: `tests/sync.test.ts` (extend), `tests/start.test.ts` (extend)

**Interfaces:**
- Produces: `syncCore(root: string, ctx: Ctx): { result: 'ok' | 'dirty' | 'no-upstream' | 'conflict' | 'push-rejected' | 'other'; detail?: string }` exported from `src/verbs/sync.ts` — runs pre-check + lock + pull --rebase + push, classifying with wave 1's `classifyPullFailure`; push rejection whose output matches `/protected/i` becomes `push-rejected` with the protected-branch cause named. `autoSync(root, ctx, stream, trigger)` wrapper: calls `syncCore`, prints `sync-auto: <result> …` on non-ok (a finding line, never a throw), and best-effort appends `{t:'sync', trigger, result}` to `stream`'s journal (skip silently if the txn is blocked — `journalRefusal`'s precedent, `src/verbs/write.ts:249`).
- Consumes: wave 1 `classifyPullFailure`; `withTxn`/`appendEntry`.
**Corrected while executing** (recorded not quietly fixed), three things. (1) `syncCore(root)` takes no `ctx` — it renders nothing, which is the whole point of the extraction; the verb is the renderer. (2) The outcome union gained `'locked'` and `'no-remote'` so the verb keeps its exact pre-existing exit codes (`EXIT.BLOCKED` on a held lock) instead of folding them into `'other'`. (3) **A repo with no remote short-circuits before the pull.** Without it, every `start` in a remoteless repo journaled a `no-upstream` "failure" and made a state commit for it — the same silence rule D139 already uses, since divergence needs a remote to exist; the explicit verb still refuses, because someone typed it. And the sync journal entry is pushed on its own after being written, so an automatic sync does not leave the commit it just made unpushed and trip D139's own ahead/behind finding on witness's bookkeeping.

- Sequencing (spec D138): `autoSync` runs **outside** any held lock — in `stamp.ts` after the whole candidates loop and sweep, gated on `result.stamped.length > 0`; in `start.ts` as the first act of `run()` after config load, before `resolveStartBase` (its failure never blocks the cut — D137's decoupling clause).

- [ ] **Step 1: Failing tests**

`tests/sync.test.ts`:

```ts
describe('auto-sync (D138)', () => {
  it('merge stamp heals local main against origin', async () => {
    // Build a shippable repo with a merged PR the lazy stamp will discover (copy the
    // fixture from the nearest lazyStamp test: grep -rn "lazyStamp\|merge(" tests/ | head).
    // After `witness next` triggers the stamp, local main must not be ahead of origin.
    // Assert: repo.git('rev-list', '--count', 'origin/main..main') === '0'
    // and stdout of the triggering verb does NOT contain 'sync-auto:' (success is silent).
  })
  it('classifies a protected-branch push rejection', () => {
    // unit: feed syncCore's push-classification helper output containing 'protected branch hook declined'
    // expect result 'push-rejected' and detail naming branch protection
  })
})
```

`tests/start.test.ts`:

```ts
  it('start preflights sync but a dirty tree never blocks the cut (D138/D137)', async () => {
    // seeded repo + addOrigin + approved plan; dirty a tracked non-canon file;
    // start must exit 0, print 'sync-auto: dirty', and still create the worktree.
  })
```

(Fill the two scaffolds with the fixture code you copy from the named greps — the `expect` lines above are the contract; a scaffold left as comments is a plan failure, so write them out fully in the test file.)

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement** — extract `syncCore` from `run()` (the verb becomes a thin renderer over it); add `'sync'` to `EntryType` (`src/journal.ts:5-13`); wire the two call sites; push-classification:

```ts
const pushKind = (out: string): 'push-rejected' | 'other' => /protected|GH006/i.test(out) ? 'push-rejected' : 'other'
```

with `push-rejected` detail: `` `origin/${branch} rejects direct pushes (branch protection?) — witness state commits need push access; see DESIGN.md row 138` ``.

- [ ] **Step 4: Verify pass** — targeted files then full suite.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(sync): auto-sync at merge-stamp and start, push rejection named (D138)"`

---

### Task 4: D141 — worktree removal is cwd-safe

**Files:**
- Modify: `src/worktree.ts:192-196` (`removeWorktree`), callers: `src/stamp.ts:113,128`, `src/verbs/clean.ts:17-19`, `src/abandon.ts:130`
- Test: `tests/start.test.ts` or a new `tests/worktree-remove.test.ts` (unit-level)

**Corrected while executing:** the cwd test compares PATHS through `realpath`, not the plan's `relative()`-on-raw-strings — macOS `/tmp` and `/var` are symlinks (D134's trap), and `<worktree>-sibling` must not read as inside. `LazyResult` gained a `kept: string[]` so `next` and the dashboard can report what the sweep declined, beside the stale rows.

**Interfaces:**
- Produces: `removeWorktree(root: string, planId: string, cwd?: string): boolean` — returns `false` (and removes nothing) when `cwd` resolves inside the worktree path; callers pass `ctx.cwd` and print on `false`: `` ctx.out(kv('note', `worktree ${path} kept — this session stands in it; leave the directory and re-run`)) ``.

- [ ] **Step 1: Failing test**

```ts
import { createWorktree, removeWorktree, worktreePath } from '../src/worktree.js'

describe('removeWorktree cwd guard (D141)', () => {
  it('keeps the worktree the caller stands in, removes from elsewhere', async () => {
    const repo = await seededRepo()
    // create a worktree via the plumbing (no plan needed at unit level)
    const wt = createWorktree(repo.root, 'p1', 'main')
    if (!wt.ok) throw new Error('wt')
    expect(removeWorktree(repo.root, 'p1', join(wt.value.path, 'src'))).toBe(false)
    expect(existsSync(wt.value.path)).toBe(true)
    expect(removeWorktree(repo.root, 'p1', repo.root)).toBe(true)
    expect(existsSync(wt.value.path)).toBe(false)
  })
})
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement**

```ts
// D141. The lazy stamp fires from next/check/dashboard — including the SessionStart
// hook — so removal used to delete the directory the invoking session stood in (the ×3
// "Working directory does not exist" in the 2026-08-29 report). A DIFFERENT session's
// cwd is unknowable (accepted residual, spec D141); the self-deletion case is closed.
export function removeWorktree(root: string, planId: string, cwd?: string): boolean {
  const path = worktreePath(root, planId)
  if (cwd !== undefined) {
    const rel = relative(path, resolve(cwd))
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return false
  }
  if (existsSync(path)) tryGit(root, 'worktree', 'remove', '--force', path)
  tryGit(root, 'worktree', 'prune')
  return true
}
```

Thread `ctx.cwd` through all four callers; each prints the `note:` line on `false` (in `stamp.ts` the sweep loop prints once per kept worktree).

- [ ] **Step 4: Verify pass** — unit test + full suite (callers changed).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "fix(worktree): removal skips the caller's own cwd and says so (D141)"`

---

### Task 5: D151 — canon anchors resolve at the primary root (closes #18)

**Files:**
- Modify: `src/verdict.ts:118-129` (`resolveCodeAnchor`) and its call site at `:180`; thread `primaryRoot` + canon dir names from the caller (the gate battery already holds both — find the `resolveAnchors`/verdict-parse entry in `src/gate.ts` and pass them down)
- Test: `tests/design-verdict.test.ts` or the verdict unit test file (grep `resolveCodeAnchor\|anchor-unresolvable` in tests/ and extend where the tree-kind anchors are covered)

**Interfaces:**
- Produces: `resolveCodeAnchor(anchor, reviewedRoot, opts: { primaryRoot: string; canonDirs: string[] })` — a `file` whose path sits under any canon dir resolves against `primaryRoot` (existence + symbol grep both); all other paths keep `reviewedRoot`.

- [ ] **Step 1: Failing test**

```ts
  it('a reviewer citing the plan under judgment resolves in a sparse worktree (D151, #18)', () => {
    // fixture: primary root with docs/plans/p1.md committed; worktree with sparse
    // exclusion (undoCanonExclusion NOT called); anchor 'docs/plans/p1.md#Step'
    // → resolveCodeAnchor returns undefined (resolves), not 'no file … in the reviewed tree'
  })
```

Write it against the real fixture the existing verdict tests use (they build `reviewed: {kind:'tree', root}` inputs — mirror one and point `primaryRoot` at the repo root). The two assertions: canon-path anchor resolves; a genuinely missing code path still returns the `no file` message.

- [ ] **Step 2: Verify failure** — the canon-path case returns `no file docs/plans/p1.md in the reviewed tree`.

- [ ] **Step 3: Implement** — prefix test:

```ts
function resolveCodeAnchor(anchor: string, root: string, opts?: { primaryRoot: string; canonDirs: string[] }): string | undefined {
  if (/[:#]L?\d+$/.test(anchor)) return 'line numbers refused — they drift across revisions; use file#symbol'
  const [file = '', symbol] = anchor.split('#', 2)
  if (!safeRel(file)) return `path escapes the reviewed tree: ${file}`
  // D151 (issue #18). D132 sparse-excludes canon from worktrees; a reviewer citing the
  // spec or plan it judges must resolve where canon lives — the primary root, the read
  // route D132 itself established. Code paths keep the reviewed tree.
  const isCanon = opts !== undefined && opts.canonDirs.some((d) => file === d || file.startsWith(d + '/'))
  const home = isCanon ? opts.primaryRoot : root
  const abs = join(home, file)
  if (!existsSync(abs) || !statSync(abs).isFile()) return `no file ${file} in the reviewed tree`
  if (symbol !== undefined) {
    const re = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    if (!re.test(readFileSync(abs, 'utf8'))) return `symbol "${symbol}" not found in ${file}`
  }
  return undefined
}
```

At the `:180` call site pass `{ primaryRoot, canonDirs }` from the gate's context (the gate loads config — `canonPaths` gives `[specs, plans, designs]` rels). Update the anchor-menu text only if it names roots (check `buildAnchorMenu` above line 100 — leave wording unless it contradicts).

- [ ] **Step 4: Verify pass** — verdict tests + `pnpm vitest run` (implement/ship gate integration tests exercise the path).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "fix(verdict): canon anchors resolve at the primary root, closes #18 (D151)"`

---

### Task 6: D143 — a bare affirmation selects the CLI's recommendation

**Files:**
- Modify: `src/verbs/decide.ts` (accept `--via affirmation`, journal `selected: 'affirmation'`, refuse the exclusions), `plugin/commands/witness.md:41`, all six `plugin/skills/*/SKILL.md` ground rules, `tests/helpers.ts` (`SKILL_GROUND_RULES`)
- Test: `tests/decide.test.ts`, `tests/skills.test.ts`, `tests/command.test.ts`

**Corrected while executing**, caught by two repo invariants the plan did not anticipate. `tests/dead-fields.test.ts` requires every field on a `*Entry` interface to have a production reader: `selected` had none, and a field nothing reads cannot make anything "measurable rather than arguable" as D143 claims — it now feeds D130's recommender audit as a `nodded` column, subject still the rule and never the human. `tests/verb-usage.test.ts` requires `--help` and the verb's own usage string to agree, so `cli.ts`'s decide entry needed the same `[--via affirmation]`.

**Interfaces:**
- Produces: `witness decide <gate> <target> <exit> --via affirmation` → the `human-decision` entry gains `selected: 'affirmation'`. CLI-enforced exclusions (spec D143): `--via affirmation` combined with `--override`, `--stop`, `--trust-cmds` (T8), or on `witness abandon`, refuses `nod-cannot` — "this act requires naming the option".
- Prose rule (all six skills + engine — **authorship split**, spec D143): a bare affirmation selects the **recommended option of a CLI-rendered decision block** and the agent appends `--via affirmation` to the printed command; for **agent-authored** questions (the brainstorm interview, the design converge step) an affirmation is plain conversational acceptance — no selection semantics, no flag; blocks without a recommendation, and the excluded acts, still require naming.

- [ ] **Step 1: Failing tests**

`tests/decide.test.ts` (mirror its stop fixture):

```ts
  it('records an affirmation selection distinguishably (D143)', async () => {
    // seed a stopped gate (copy the file's existing stopped-gate fixture), then:
    const res = await repo.cli(['decide', 'plan', planId, '--approve', '--via', 'affirmation'])
    expect(res.code).toBe(0)
    const entry = readStream(repo.root, planId).findLast((e) => e.t === 'human-decision')
    expect(entry?.selected).toBe('affirmation')
  })
  it('a nod cannot take an excluded act (D143)', async () => {
    const res = await repo.cli(['decide', 'plan', planId, '--approve', '--override', '--via', 'affirmation'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('nod-cannot')
  })
```

`tests/helpers.ts`: replace the `SKILL_GROUND_RULES` entry asserting the old rule (`'A bare affirmation ("ok", "sounds good") is not a selection'` — grep the exact current string) with two entries: `'selects the recommended option'` and `'--via affirmation'`. `tests/command.test.ts`: add `expect(cmd).toContain('--via affirmation')`.

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement** — `decide.ts`: parse `--via <word>` (only `affirmation` accepted); merge into the entry the same way `rule`/`recommended` land; the exclusion refusal fires before any journal write:

```ts
  // T8 extends this condition with `|| flags.trustCmds` when that flag exists.
  if (via === 'affirmation' && (flags.override || flags.stop)) {
    renderRefusal([v('--via', 'nod-cannot', 'affirmation',
      'a named option — overrides, stops/parks, and trust grants are never taken on a nod (D143)')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
```

Skills prose — replace the shared "The human decides; you may type it" bullet in all six files with:

```
- **The human decides; you may type it.** Run a decision only when the human names an option — its number or its verb — or gives a bare affirmation ("y", "ok", "go") while a **CLI-rendered decision block with a recommended option** is on screen: the affirmation selects the recommended option, and you append `--via affirmation` to the printed command (otherwise byte-for-byte, never recomposed). A nod never takes `--approve --override`, `--stop`, a trust grant, or `witness abandon` — those require naming. Questions you authored yourself (the brainstorm interview, design converge) are conversation: an affirmation there accepts your stated recommendation as an answer, and no flag is involved. A selection does not survive session death: killed and re-run, render the block again and ask again.
```

Engine `witness.md:41` gains the same affirmation clause (keep END-YOUR-TURN sentences intact — `tests/command.test.ts:28,49` still assert them).

- [ ] **Step 4: Verify pass** — decide/skills/command tests, then full suite.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(decide): a bare affirmation selects the CLI's recommendation, journaled and bounded (D143, amends D127)"`

---

### Task 7: D144 — install writes the harness allowlist

**Files:**
- Modify: `src/install.ts` (`mergeSettings`, ~lines 178-207)
- Test: extend the install/payload test (grep `mergeSettings\|settings.json` in tests/ — likely `tests/install.test.ts` or `tests/check.test.ts`'s payload block)

**Interfaces:**
- Produces: `init --agent claude-code` merges into `.claude/settings.json`: `permissions.allow` gains `"Bash(npx -y @popovych.co/witness*)"` and `"Bash(witness *)"` — append-what's-missing, exactly the hooks' merge discipline; user-held entries untouched; idempotent.
**Resolved while executing:** the pi half is **skipped with cause**. `settings` is declared only on the claude-code harness (`harness.ts` REGISTRY), so pi exposes no allowlist surface in witness's model; recorded in the DESIGN.md row rather than invented.

- Pi half: **investigate first** — read `src/harness.ts`'s pi install block and pi's docs for a permission/allowlist surface. If pi has one, mirror the two entries; if not, add one sentence to the DESIGN.md row-144 annotation ("pi exposes no allowlist surface as of pi 0.83.0 — claude-code only") and skip. Do not invent a pi config shape.

- [ ] **Step 1: Failing test**

```ts
  it('init writes the witness allowlist and stays idempotent (D144)', async () => {
    const repo = await seededRepo()
    await repo.cli(['init', '--agent', 'claude-code'])
    const s1 = JSON.parse(repo.read('.claude/settings.json'))
    expect(s1.permissions.allow).toContain('Bash(npx -y @popovych.co/witness*)')
    expect(s1.permissions.allow).toContain('Bash(witness *)')
    await repo.cli(['init', '--agent', 'claude-code'])
    const s2 = JSON.parse(repo.read('.claude/settings.json'))
    expect(s2.permissions.allow.filter((x: string) => x.includes('witness'))).toHaveLength(2)
  })
```

- [ ] **Step 2: Verify failure.** — [ ] **Step 3: Implement** in `mergeSettings` beside the hook merge:

```ts
  // D144. Witness never allowlisted itself, so every distinct command shape raised a
  // harness dialog — "1" turns that were not even witness stops (2026-08-29 report).
  // Scope: the witness CLI only, never a blanket Bash grant.
  const allow = ['Bash(npx -y @popovych.co/witness*)', 'Bash(witness *)']
  const perms = (settings.permissions ??= {}) as Record<string, unknown>
  const list = Array.isArray(perms.allow) ? (perms.allow as string[]) : (perms.allow = [] as string[], perms.allow as string[])
  for (const a of allow) if (!list.includes(a)) list.push(a)
```

(Adapt to `mergeSettings`' actual mutation style — it already deep-merges hooks; follow its idiom.)

- [ ] **Step 4: Verify pass.** — [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(install): witness allowlists its own binary in harness settings (D144)"`

---

### Task 8: D154 — trust is granted where a human decides

**Files:**
- Modify: `src/recommend.ts` (approve-variant rendering from caller-passed context), `src/gate.ts` (compute untrusted cmd list, pass into the decision context), `src/verbs/decide.ts` (`--trust-cmds` executes grants), `src/allowlist.ts` (exported `grantCommands(root, cmds)`), `src/criteria.ts:81-83` area (refusal remedy names `witness trust <id>`; `loadConfig(runRoot)` → `loadConfig(trustRoot)`), `src/cli.ts` (register verb), create `src/verbs/trust.ts`, `src/journal.ts` (EntryType `'trust'`)
- Test: `tests/decide.test.ts`, `tests/criteria.test.ts`, create `tests/trust.test.ts`

**Interfaces:**
- Produces:
  - `grantCommands(root: string, cmds: string[]): void` in `src/allowlist.ts` (append-dedupe into `allow.json`).
  - `GateContext` (in `src/recommend.ts:55-61`) gains `untrustedCmds?: string[]` — recommend stays pure: the **caller** (gate.ts) computes it by running the artifact's `cmd:` criteria list against `allow.json` membership. When non-empty and an approve option is offered, the block lists the commands verbatim (one `note:` line) and renders **both** `--approve` (tradeoff: `the listed commands stay blocked at headless gates`) and `--approve --trust-cmds` options — plain approve first, so trust is never the toll (spec D154).
  - `decide ... --approve --trust-cmds` → `grantCommands` + a `{t:'trust', cmds, via:'decide'}` journal entry on the target's stream. Refuses with `nod-cannot` under `--via affirmation` (T6 wiring).
  - `witness trust <id> [--yes]`: lists the artifact's `cmd:` criteria with trust status; TTY prompts per command (`ctx.ask`, allowlist.ts's own idiom); non-TTY without `--yes` lists only (exit 1 findings); `--yes` grants all listed, journals `{t:'trust', cmds, via:'verb'}`.
  - `src/criteria.ts`: the `untrusted-blocked` refusal gains remedy `` `witness trust ${docId}` `` (runnable — D147 field), keeps `WITNESS_TRUST_CMDS=1` in the want text; and `loadConfig(runRoot)` becomes `loadConfig(opts.trustRoot ?? runRoot)` — **root unification** (trust list and runner config both read the primary root; D132 doctrine).

**Corrected while executing:** the two approve forms are applied **once over the finished option list** (`withTrustVariants`, wrapping a renamed `recommendCore`) rather than at each of the five rules that offer an approve. `recommend` stays pure — the caller computes `untrustedCmds`. Two helpers were needed that the plan did not name: `criteriaOwner(canon, id)` in `scan.ts` (a plan gate judges a plan, but criteria live on its parent spec, so a trust surface keyed on the gate target alone lists nothing at exactly the gates that need it), and a `trustFor(ctx, target)` in `decide.ts` mirroring gate.ts's `renderChoices` — both render without a `root` in scope.

- [ ] **Step 1: Failing tests** — three files:

`tests/trust.test.ts`:

```ts
describe('witness trust (D154)', () => {
  it('lists untrusted criteria commands and grants with --yes', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { criteria: [{ id: 'ac-1', kind: 'cmd', cmd: 'echo ok' }] })
    const list = await repo.cli(['trust', 'auth-refresh'])
    expect(list.stdout).toContain('echo ok')
    expect(list.code).toBe(1)                       // non-TTY, nothing granted
    const grant = await repo.cli(['trust', 'auth-refresh', '--yes'])
    expect(grant.code).toBe(0)
    const allow = JSON.parse(repo.read('.witness/allow.json'))
    expect(allow.commands).toContain('echo ok')
    const entry = readStream(repo.root, 'auth-refresh').findLast((e) => e.t === 'trust')
    expect(entry?.via).toBe('verb')
  })
})
```

(If `writeSpec`'s criteria opts differ, copy the exact criteria-manifest shape from `tests/criteria.test.ts`.)

`tests/decide.test.ts`: a stopped gate whose parent spec carries an untrusted `cmd:` criterion → `decide --show` output contains both `--approve` and `--approve --trust-cmds` and the command text; running the trusting form writes `allow.json` and the `trust` entry.

`tests/criteria.test.ts`: the blocked refusal now contains `run: witness trust auth-refresh`.

- [ ] **Step 2: Verify failure.** — [ ] **Step 3: Implement** per the Interfaces block, in this order: `grantCommands` → `trust` verb → criteria remedy + root unification → gate context plumbing → recommend rendering → decide `--trust-cmds`. Keep recommend pure (it receives the list, never reads disk — its module contract at `src/recommend.ts:8-10`).

- [ ] **Step 4: Verify pass** — the three test files, then the full suite (criteria root unification touches gate integration tests; any failure there means a worktree config was load-bearing — stop and reread the spec's D154 paragraph before "fixing").

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(trust): granted where a human decides, consumed where absent (D154)"`

---

### Task 9: DESIGN.md — annotate the built rows

**Files:** Modify `DESIGN.md` (rows 137, 138, 141, 142, 143, 144, 151, 154 from wave 1's T10).

**Corrected while executing:** the annotation reads **Built on `d137-triage-wave-2`, not yet released** — 0.14.0 was never released and this branch is not merged, so "shipped as 0.15.0" would be a false statement in the design record, in a triage whose whole subject is statement honesty. The version lands with the release commit, which is the convention the wave-1 rows already follow.

- [ ] **Step 1:** Update each row's trailing sentence from **decided here, ships in the behavior wave (not yet built)** to **Built and shipped as 0.15.0** plus one sentence per row for anything a probe corrected while building (the house convention — "recorded here rather than quietly fixed"). If nothing was corrected, say nothing extra.
- [ ] **Step 2:** `pnpm vitest run` (guard against file damage).
- [ ] **Step 3:** Commit — `git add DESIGN.md && git commit -m "docs(design): wave-2 rows built (D137-D138, D141-D144, D151, D154)"`

---

### Task 10: Ship wave 2

- [ ] **Step 1:** `pnpm test && pnpm run typecheck && pnpm run build` — all green (superpowers:verification-before-completion).
- [ ] **Step 2:** Push branch, `gh pr create --title "Triage wave 2: behavior (D137-D138, D141-D144, D151, D154)" --body "Implements the behavior wave of docs/superpowers/specs/2026-08-29-pi-sessions-triage-design.md. Changes gate outcomes per spec. Closes #18."`
- [ ] **Step 3 (human-gated):** after merge, per `docs/RELEASING.md`: `git checkout main && git pull && node scripts/release.mjs minor && git push origin main && git push origin v0.15.0`. Stop and hand the merge + release to the human.

---

## Self-review notes

- Coverage: D137→T1, D142-diffbase→T2, D138→T3, D141→T4, D151→T5, D143→T6, D144→T7, D154→T8; annotations T9, release T10.
- Order is dependency-true: T1 before T3 (preflight calls into the same start path), T3 uses wave-1 `classifyPullFailure`, T6 before T8 (`--via affirmation` exclusion covers `--trust-cmds`).
- Two scaffolded test bodies in T3 name their fixture-source greps and their contracts — executors must write them out fully; leaving comments is a plan failure.
- Wave-2-changes-outcomes is by definition; T5 and T8 are the two that alter what gates accept — their integration-suite runs are the regression net.
