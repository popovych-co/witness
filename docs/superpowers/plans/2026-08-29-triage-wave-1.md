# Triage Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the statement-honesty half of the pi-sessions triage — rows D139, D140, D142-prose, D146–D150, D152, D153, D155, D156 — with zero gate-outcome changes.

**Architecture:** Every task adds or corrects *what witness says* (findings, refusal remedies, prose, dashboard lines), never what gates decide. One shared helper (`divergence`) feeds two renderers; the `Violation` type gains an optional `remedy` consumed by one renderer; payload prose changes ride the skills' existing shared-contract test loop.

**Tech Stack:** TypeScript (Node), vitest (in-process CLI against throwaway git repos — `tests/helpers.ts`), plain-mjs guard hook, Markdown payload.

**Spec:** `docs/superpowers/specs/2026-08-29-pi-sessions-triage-design.md` (read it first; each task names its row).

## Global Constraints

- Branch: all work on `d137-pi-sessions-triage` (already checked out; spec committed there).
- **Wave-1 invariant: no gate-outcome changes.** Do not touch the outcome ladder (`src/gate.ts:445-449`), stamps, round accounting, or verdict semantics. New check findings must be `warn` level (only `error` changes `check`'s exit).
- `pnpm test`, `pnpm run typecheck`, `pnpm run build` green after every task.
- Output goes through `kv()`/`rows()` from `src/toon.ts`, matching surrounding style.
- `Violation` gains only an **optional** field — every existing `v(...)` call site must compile unchanged.
- Commits: conventional style with the row in the subject, e.g. `fix(sync): classify pull failures honestly (D140)`.
- Test helpers you will reuse: `seededRepo()`, `writeSpec()`, `writePlan()`, `approve()`, `addOrigin()` (bare file-remote at `${repo.root}-origin.git`), `repo.cli([...])`, `repo.git(...)` — all in `tests/helpers.ts`. Read that file before writing any test.

---

### Task 1: D140 — `sync` stops lying about why it failed

**Files:**
- Modify: `src/verbs/sync.ts:35-46`
- Test: `tests/sync.test.ts` (create)

**Interfaces:**
- Consumes: `tryGit` from `src/gitio.ts` (existing).
- Produces: exported pure `classifyPullFailure(out: string): 'no-upstream' | 'conflict' | 'other'` in `src/verbs/sync.ts` (tests import it).

**Corrected while executing** (recorded not quietly fixed): the planned assertion `toContain('sync: rebase conflict')` cannot match. `kv()` TOON-escapes any value containing a comma (`toon.ts:3`) and `resolve manually, then re-run` has one, so the line renders **quoted** — as the old catch-all already did. The test asserts the real rendering: `/^sync: "rebase conflict in \.witness\/journal\/\S+ — resolve manually, then re-run witness sync"$/m`, plus the absence of the `detail:` line.

- [ ] **Step 1: Write the failing tests**

Create `tests/sync.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyPullFailure } from '../src/verbs/sync.js'
import { addOrigin, seededRepo, writeSpec } from './helpers.js'

describe('classifyPullFailure', () => {
  it('names the three shapes', () => {
    expect(classifyPullFailure('There is no tracking information for the current branch.')).toBe('no-upstream')
    expect(classifyPullFailure('CONFLICT (content): Merge conflict in .witness/journal/x.jsonl\nerror: could not apply cc31971')).toBe('conflict')
    expect(classifyPullFailure('fatal: Not possible to fast-forward, aborting.')).toBe('other')
  })
})

describe('witness sync', () => {
  it('renders a real rebase conflict as conflict with the conflicted paths, not the catch-all', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    addOrigin(repo)
    // Diverge with a content conflict: clone the bare, edit the same journal line, push.
    const clone = mkdtempSync(join(tmpdir(), 'sync-clone-'))
    execFileSync('git', ['clone', `${repo.root}-origin.git`, clone])
    execFileSync('git', ['-C', clone, 'commit', '--allow-empty', '-m', 'seed'], { stdio: 'ignore' })
    const journal = join(clone, '.witness', 'journal', `${repo.effort}.jsonl`)
    execFileSync('bash', ['-c', `echo '{"v":1,"t":"conflict-bait"}' >> '${journal}'`])
    execFileSync('git', ['-C', clone, 'add', '-A'])
    execFileSync('git', ['-C', clone, 'commit', '-m', 'remote edit'], { stdio: 'ignore' })
    execFileSync('git', ['-C', clone, 'push', 'origin', 'main'], { stdio: 'ignore' })
    // Local: conflicting append to the same file tail.
    repo.write(`.witness/journal/${repo.effort}.jsonl`,
      repo.read(`.witness/journal/${repo.effort}.jsonl`) + '{"v":1,"t":"local-bait"}\n')
    repo.git('add', '-A'); repo.git('commit', '-m', 'local edit')
    const res = await repo.cli(['sync'])
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('sync: rebase conflict')
    expect(res.stdout).toContain('.witness/journal')          // the conflicted path is named
    expect(res.stdout).not.toContain('resolve manually, then re-run witness sync\ndetail: fatal')
  })

  it('renders a non-conflict failure verbatim, never as a rebase conflict', async () => {
    // Pure-function coverage above pins the classifier; this pins the render wiring:
    // feed classifyPullFailure('other') output shape through the verb by asserting the
    // string the catch-all used to print is gone from the source.
    const src = (await import('node:fs')).readFileSync('src/verbs/sync.ts', 'utf8')
    expect(src).not.toMatch(/rebase conflict — resolve manually.*\n.*detail/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/sync.test.ts`
Expected: FAIL — `classifyPullFailure` is not exported.

- [ ] **Step 3: Implement**

In `src/verbs/sync.ts`, replace lines 35-46 (`const pull = ...` through the catch-all `return EXIT.FINDINGS`) with:

```ts
    const pull = tryGit(root, 'pull', '--rebase')
    if (!pull.ok) {
      const kind = classifyPullFailure(pull.out)
      if (kind === 'no-upstream') {
        renderRefusal([v('remote', 'no-upstream', pull.out.trim().slice(0, 120),
          'an upstream — git push -u origin main once, then witness sync')]).forEach((l) => ctx.err(l))
        return EXIT.REFUSED
      }
      if (kind === 'conflict') {
        // Capture BEFORE the abort erases the conflict state.
        const conflicted = tryGit(root, 'diff', '--name-only', '--diff-filter=U')
        tryGit(root, 'rebase', '--abort')
        ctx.out(kv('sync', `rebase conflict in ${conflicted.ok && conflicted.out ? conflicted.out.split('\n').join(' · ') : 'unknown files'} — resolve manually, then re-run witness sync`))
        return EXIT.FINDINGS
      }
      // 'other': not a conflict — say what git said, never "rebase conflict".
      tryGit(root, 'rebase', '--abort')
      ctx.out(kv('sync', `git pull --rebase failed — ${pull.out.trim().slice(-200)}`))
      return EXIT.FINDINGS
    }
```

And add above `export async function run`:

```ts
// D140. Row 114 fixed one branch of this function and left the other: every non-upstream
// failure rendered as "rebase conflict — resolve manually", which misnames both a real
// conflict (no files) and a non-conflict fatal (not a conflict at all).
export function classifyPullFailure(out: string): 'no-upstream' | 'conflict' | 'other' {
  if (/no tracking information|no such ref|does not appear to be a git repository/i.test(out)) return 'no-upstream'
  if (/CONFLICT|could not apply/i.test(out)) return 'conflict'
  return 'other'
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/sync.test.ts`
Expected: PASS. Then `pnpm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/sync.ts tests/sync.test.ts
git commit -m "fix(sync): classify pull failures — conflict names its files, other stays verbatim (D140)"
```

---

### Task 2: D139 — divergence is visible state

**Files:**
- Modify: `src/gitio.ts` (new helper at end of file), `src/verbs/check.ts` (~line 74, after the local-config block), `src/verbs/dashboard.ts` (~line 141, after `pending-txn`)
- Test: `tests/sync.test.ts` (extend), `tests/dashboard.test.ts` (extend)

**Interfaces:**
- Produces: `divergence(root: string, branch: string): { ahead: number; behind: number } | undefined` in `src/gitio.ts`. `undefined` = no remote / fetch failed / no such ref — callers print nothing (best-effort, silent offline; D103 precedent).
- Consumes: `cfg.raw.ship.branch ?? 'main'` (same resolution `src/ship.ts:192-193` uses).

- [ ] **Step 1: Write the failing tests**

Append to `tests/sync.test.ts`:

```ts
describe('divergence visibility (D139)', () => {
  it('check warns when local is ahead, silent when clean or remoteless', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const before = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(before.stdout).not.toContain('diverged')   // no remote → silent
    addOrigin(repo)
    const clean = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(clean.stdout).not.toContain('behind origin')
    repo.git('commit', '--allow-empty', '-m', 'local only')
    const res = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.code).toBe(0)                          // warn, never error — wave-1 invariant
    expect(res.stdout).toMatch(/1 ahead · 0 behind origin\/main — witness sync/)
  })
})
```

Append to `tests/dashboard.test.ts` (match its local describe/imports style; it already imports from `./helpers.js`):

```ts
  it('prints the divergence line when local main is ahead (D139)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    addOrigin(repo)
    repo.git('commit', '--allow-empty', '-m', 'local only')
    const res = await repo.cli([])
    expect(res.stdout).toMatch(/sync: local main 1 ahead · 0 behind origin\/main — witness sync/)
  })
```

(Add `addOrigin` to that file's helpers import.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/sync.test.ts tests/dashboard.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

`src/gitio.ts`, end of file:

```ts
// D139. One computation, two renderers (check finding, dashboard line — the D101
// boundary). Best-effort and silent when the network or remote is absent (D103):
// an offline machine reports nothing rather than a complaint.
export function divergence(root: string, branch: string): { ahead: number; behind: number } | undefined {
  if (!tryGit(root, 'fetch', '--quiet', 'origin', branch).ok) return undefined
  const counts = tryGit(root, 'rev-list', '--left-right', '--count', `origin/${branch}...${branch}`)
  if (!counts.ok) return undefined
  const [behind = '0', ahead = '0'] = counts.out.trim().split(/\s+/)
  return { ahead: Number(ahead), behind: Number(behind) }
}
```

`src/verbs/check.ts` — import `divergence` from `../gitio.js`; after the local-config-unignored block (~line 73), insert:

```ts
  // D139. Invisible drift is what let a downstream repo reach 165 unpushed commits.
  if (cfg.ok) {
    const shipBranch = String(((cfg.value.raw.ship ?? {}) as Record<string, unknown>).branch ?? 'main')
    const div = divergence(root, shipBranch)
    if (div && (div.ahead > 0 || div.behind > 0)) {
      findings.push(f('warn', 'git', shipBranch, div.ahead > 0 && div.behind > 0 ? 'diverged' : div.ahead > 0 ? 'ahead' : 'behind',
        `${div.ahead} ahead · ${div.behind} behind origin/${shipBranch} — witness sync`))
    }
  }
```

`src/verbs/dashboard.ts` — import `divergence` from `../gitio.js`; after the `pending-txn` line (~141), insert:

```ts
  if (cfg.ok) {
    const shipBranch = String(((cfg.value.raw.ship ?? {}) as Record<string, unknown>).branch ?? 'main')
    const div = divergence(root, shipBranch)
    if (div && (div.ahead > 0 || div.behind > 0)) {
      ctx.out(kv('sync', `local ${shipBranch} ${div.ahead} ahead · ${div.behind} behind origin/${shipBranch} — witness sync`))
    }
  }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/sync.test.ts tests/dashboard.test.ts tests/check.test.ts`
Expected: PASS (check.test.ts guards against regressions in existing findings).

- [ ] **Step 5: Commit**

```bash
git add src/gitio.ts src/verbs/check.ts src/verbs/dashboard.ts tests/sync.test.ts tests/dashboard.test.ts
git commit -m "feat(check): divergence vs origin is a stated fact with witness sync as remedy (D139)"
```

---

### Task 3: D147 — CLI refusals carry a runnable remedy

**Files:**
- Modify: `src/refusal.ts`, `src/gates/plan.ts:30`, `src/gates/implement.ts:90,106-107`, `src/gates/ship.ts:44`, `src/gate.ts:106`
- Test: `tests/refusal.test.ts` (create)

**Interfaces:**
- Produces: `Violation.remedy?: string`; `v(field, rule, got, want, remedy?)`; `renderRefusal` appends deduped `run: <remedy>` lines for remedies passing the no-placeholder test `!/<[^>]+>/` (`src/recommend.ts:70` is the precedent).
- Consumes: nothing new. **Every existing `v(...)` call compiles unchanged** (remedy optional, trailing).

- [ ] **Step 1: Write the failing tests**

Create `tests/refusal.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { renderRefusal, v } from '../src/refusal.js'

describe('renderRefusal remedies (D147)', () => {
  it('appends a run: line for a runnable remedy, dedupes, and skips placeholders', () => {
    const out = renderRefusal([
      v('parent', 'unknown-parent', 'ghost', 'an existing canon doc', 'witness index'),
      v('parent2', 'unknown-parent', 'ghost2', 'an existing canon doc', 'witness index'),
      v('plan', 'not-started', 'draft', 'an in-progress plan', 'witness start <plan-id>'),
    ])
    expect(out.filter((l) => l === 'run: witness index')).toHaveLength(1)
    expect(out.join('\n')).not.toContain('run: witness start <plan-id>')
    expect(out.at(-1)).toContain('help: fix each row')
  })
  it('renders exactly as before when no remedy is present', () => {
    const out = renderRefusal([v('a', 'b', 'c', 'd')])
    expect(out.some((l) => l.startsWith('run:'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/refusal.test.ts`
Expected: FAIL — `v` takes 4 args, no run lines.

- [ ] **Step 3: Implement**

`src/refusal.ts` becomes:

```ts
import { rows } from './toon.js'

export interface Violation {
  field: string
  rule: string
  got: string
  want: string
  // D147. A runnable next command; rendered as run: only when it passes the same
  // no-placeholder test the decision block uses (recommend.ts) — a run: that needs
  // editing is the promise broken.
  remedy?: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; violations: Violation[] }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function refuse<T>(violations: Violation[]): Result<T> {
  return { ok: false, violations }
}

export function v(field: string, rule: string, got: string, want: string, remedy?: string): Violation {
  return remedy === undefined ? { field, rule, got, want } : { field, rule, got, want, remedy }
}

export function renderRefusal(violations: Violation[]): string[] {
  const runnable = [...new Set(
    violations.map((x) => x.remedy).filter((r): r is string => r !== undefined && !/<[^>]+>/.test(r)),
  )]
  return [
    ...rows('refused', ['field', 'rule', 'got', 'want'],
      violations.map(({ remedy: _remedy, ...rest }) => rest) as unknown as Array<Record<string, unknown>>),
    ...runnable.map((r) => `run: ${r}`),
    'help: fix each row and re-run — rows are structured for self-repair',
  ]
}
```

(The destructure keeps `remedy` out of the TOON columns so row shape is unchanged.)

Then fill the four descriptive-only sites:

- `src/gates/plan.ts:30`, `src/gates/implement.ts:90`, `src/gates/ship.ts:44` — the three identical `unknown-parent` refusals gain the remedy argument:
  ```ts
  return refuse([v('parent', 'unknown-parent', String(plan.meta.parent), 'an existing canon doc', 'witness index')])
  ```
- `src/gate.ts:105-107` (`battery-shape`) — enrich `want` (no runnable remedy exists; a config edit is not a verb):
  ```ts
  return refuse([v(`gates.${gate}.reviewers`, 'battery-shape', JSON.stringify(raw),
    `a reviewer list or a per-class map of lists in witness.config.yaml — e.g. reviewers: [code-reviewer]`)])
  ```
- `src/gates/implement.ts:106-107` (`design-artifact-missing`) — the committed artifact is one checkout away:
  ```ts
  return refuse([v('design', 'design-artifact-missing', artRel,
    'the approved living design the plan pins — restore it or re-run the design stage', `git checkout -- ${artRel}`)])
  ```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/refusal.test.ts && pnpm run typecheck && pnpm vitest run`
Expected: all green — the full suite proves no existing refusal output changed shape.

- [ ] **Step 5: Commit**

```bash
git add src/refusal.ts src/gates/plan.ts src/gates/implement.ts src/gates/ship.ts src/gate.ts tests/refusal.test.ts
git commit -m "feat(refusal): violations carry a runnable remedy, rendered under the no-placeholder test (D147)"
```

---

### Task 4: D146 — the guard refusal names the way back in

**Files:**
- Modify: `plugin/hooks/canon-guard.mjs` (`reasonFor`, ~line 205, and its two call sites at 232 and 253)
- Test: `tests/canon-guard.test.ts` (extend — read its existing cases first; it calls `canonGuard({tool, input, cwd})` directly)

**Interfaces:**
- Consumes: `canonDirs(root)` already in the file (returns `[specs, plans, designs]` resolved from config).
- Produces: refusal reason ending in a per-kind remedy line. specs/plans: the `witness write` shape plus a fully-runnable `witness adopt <rel>` for an already-made edit. designs: the `witness design` shape.

- [ ] **Step 1: Write the failing tests**

Append to `tests/canon-guard.test.ts` inside its describe (mirror existing setup — the file builds a temp root with `witness.config.yaml`; reuse its fixture helper):

```ts
  it('a blocked spec edit names the write shape and a runnable adopt (D146)', () => {
    const r = canonGuard({ tool: 'Edit', input: { file_path: join(root, 'specs/auth-refresh.md') }, cwd: root })
    expect(r?.block).toBe(true)
    expect(r?.reason).toContain('witness write auth-refresh --effort')
    expect(r?.reason).toContain('witness adopt specs/auth-refresh.md')
  })
  it('a blocked design edit names the design verb (D146)', () => {
    const r = canonGuard({ tool: 'Write', input: { file_path: join(root, 'designs/report-view.html') }, cwd: root })
    expect(r?.reason).toContain('witness design report-view')
  })
```

(Adjust `root` to the test file's existing fixture variable; if its config relocates canon dirs, use those paths.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/canon-guard.test.ts`
Expected: FAIL — reason has no remedy text.

- [ ] **Step 3: Implement**

In `plugin/hooks/canon-guard.mjs`, replace `reasonFor` and thread `root`/`dirs` through:

```js
// D146. D133 made the reason name the path and what writes it; this completes it to the
// remedy contract gate stops already honor (D121): a shape for authoring, and a fully
// runnable adopt for an edit already made. No effort slug is knowable here, so the write
// line stays a labelled shape, never a run:.
function remedyFor(rel, root) {
  const [specs, plans, designs] = canonDirs(root)
  const base = rel.split('/').pop() ?? rel
  if (rel === designs || rel.startsWith(designs + '/')) {
    const id = base.replace(/\.html$/, '')
    return `remedy: witness design ${id} --file <your.html> (author in $(mktemp -d); --open shows the current one)`
  }
  const id = base.replace(/\.md$/, '')
  const kind = rel.startsWith(plans + '/') ? plans : specs
  return `remedy: witness write ${id} --effort <effort> --meta m.json --body b.md (author in $(mktemp -d), never in ${kind}/) · already hand-edited? run: witness adopt ${rel}`
}

function reasonFor(what, rel, root) {
  return (
    `witness: ${what} is CLI-written state — use the witness CLI (write / design / adopt), ` +
    'never a direct edit. Direct edits are refused; the Witness-State trailer audit catches end-runs. ' +
    remedyFor(rel, root)
  );
}
```

Call sites: line 232 becomes `return { block: true, reason: reasonFor(rel.split('\\').join('/'), rel.split('\\').join('/'), root) }`; line 253 becomes `return { block: true, reason: reasonFor(`${rel} (${how})`, rel, root) }`.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/canon-guard.test.ts`
Expected: PASS, including all pre-existing guard cases (the reason prefix is unchanged — only appended to).

- [ ] **Step 5: Commit**

```bash
git add plugin/hooks/canon-guard.mjs tests/canon-guard.test.ts
git commit -m "feat(guard): a blocked edit names its remedy — write shape, design verb, runnable adopt (D146)"
```

---

### Task 5: D148 — stale reads are announced where witness churns the tree

**Files:**
- Modify: `src/evidence.ts` (inside `verifyRed`, after the `finally` block, ~line 188), `src/verbs/start.ts` (re-attach arm, ~line 54)
- Test: `tests/evidence.test.ts` (extend), `tests/start.test.ts` (create)

**Interfaces:**
- Consumes: `verifyRed`'s existing `ctx` param and `nonTest` list; `start`'s existing re-attach branch (`already in-progress — worktree present`).
- Produces: a `stale-reads:` kv line from `verify-red`; a `note:` line from `start` re-attach. Output only — no return-type changes (sole verb caller: `src/verbs/evidence.ts:85`; the gates never call `verifyRed`).

- [ ] **Step 1: Write the failing tests**

In `tests/evidence.test.ts`, find the existing `verify-red` happy-path case (grep `verify-red`), and add beside it:

```ts
  it('names the files it churned so the agent re-reads them (D148)', async () => {
    // Reuse the same setup as the passing verify-red case above this one (worktree with
    // a test change AND a non-test change), then:
    const res = await repo.cli(['verify-red', planId], { env: gateEnv(scenario) })
    expect(res.stdout).toMatch(/stale-reads: .*src\//)
    expect(res.stdout).toContain('changed on disk during red verification — re-read before editing')
  })
```

Create `tests/start.test.ts` (find a working `['start', ...]` invocation to copy setup from: `grep -rn "'start'" tests/ | head`):

```ts
import { describe, expect, it } from 'vitest'
import { approve, seededRepo, writePlan, writeSpec } from './helpers.js'

describe('witness start re-attach (D148)', () => {
  it('warns that re-attach refreshed the tree', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1', { parent: 'auth-refresh' })
    approve(repo, 'auth-refresh-plan-1')
    await repo.cli(['start', 'auth-refresh-plan-1'])
    const again = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('worktree present')
    expect(again.stdout).toContain('re-read files you read before this run')
  })
})
```

(If `approve()`'s signature differs, mirror how the nearest existing start/gate test seeds an approved plan.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/evidence.test.ts tests/start.test.ts`
Expected: FAIL on the two new cases.

- [ ] **Step 3: Implement**

`src/evidence.ts`, in `verifyRed` immediately after the `finally { ... }` block closes (before `if (!red.ok) return red`):

```ts
  // D148. The stash/checkout cycle above rewrote every non-test file on disk — the
  // agent's prior reads are stale, and witness caused it. Say so (the 8× "file modified
  // since read" cluster in the 2026-08-29 field report).
  if (nonTest.length) {
    const shown = nonTest.slice(0, 12)
    ctx.out(`stale-reads: ${shown.join(' · ')}${nonTest.length > shown.length ? ` (+${nonTest.length - shown.length} more)` : ''} — changed on disk during red verification — re-read before editing`)
  }
```

`src/verbs/start.ts`, inside the `status === 'in-progress'` arm after the `worktree` line (~line 56):

```ts
    if (had) ctx.out(kv('note', 'worktree re-attach refreshed canon exclusions — re-read files you read before this run'))
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/evidence.test.ts tests/start.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evidence.ts src/verbs/start.ts tests/evidence.test.ts tests/start.test.ts
git commit -m "feat(evidence): verify-red and start name the files they churned (D148)"
```

---

### Task 6: D150 — the write-path metric D64 promised

**Files:**
- Modify: `src/verbs/dashboard.ts` (new exported fn beside `recommenderRows`, render line after the `recommender` rows, ~line 180)
- Test: `tests/dashboard.test.ts` (extend)

**Interfaces:**
- Consumes: `effortStreams`, `readStream` (already imported); `write` entries carry `artifact`, `write-refused` entries carry `artifact` (`src/verbs/write.ts:249-253`).
- Produces: `writePathStats(root: string): { firstTry: number; artifacts: number; refused: number }` — per artifact, "first-try" means its first write-path entry is a `write`, not a `write-refused`.

**Corrected while executing** (recorded not quietly fixed): the planned fixture forces its refusal with an invalid id, which refuses at `ID_RE` (`verbs/write.ts:90`) **before** `journalRefusal` runs — no `write-refused` entry exists to count, so `1/1 · 1 refusal` is unreachable that way. The test uses a schema-failing manifest (over-long `summary`, the `write-spec.test.ts` shape) across three artifacts — one clean, one refused-only, one refused-then-written — and asserts the honest `1/3 artifacts first-try · 2 refusal(s)`. A second trap the metric itself caught: `SPEC_META`'s criterion is tagged `@spec:auth-refresh`, so a spec written under any other id is refused; each manifest is now built per id.

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard.test.ts`:

```ts
  it('trends the write path — first-try rate and refusal count (D150)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'clean-spec')                                  // first-try
    const bad = await writeSpec(repo, 'bad spec id!')                    // refused: invalid id
    expect(bad.code).toBe(2)
    const res = await repo.cli([])
    expect(res.stdout).toMatch(/write-path: 1\/1 artifacts first-try · 1 refusal/)
  })
```

(If `writeSpec` pre-validates ids, force the refusal instead with a raw `repo.cli(['write', ...])` carrying a meta file that fails schema — copy the shape from the nearest `write-refused` case: `grep -rn "write-refused" tests/`.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/dashboard.test.ts`
Expected: FAIL — no `write-path:` line.

- [ ] **Step 3: Implement**

`src/verbs/dashboard.ts`:

```ts
// D150. Row 64 promised this trend and never built it — the 2026-08-29 field report had
// to count refusals by hand. Subject is the WRITE PATH, not the author (D130's framing):
// a low first-try rate means the manifest contract is hard to hit, not that anyone erred.
export function writePathStats(root: string): { firstTry: number; artifacts: number; refused: number } {
  const first = new Map<string, 'write' | 'write-refused'>()
  let refused = 0
  for (const slug of effortStreams(root)) {
    for (const e of readStream(root, slug)) {
      if (e.t !== 'write' && e.t !== 'write-refused') continue
      if (e.t === 'write-refused') refused += 1
      const a = String(e.artifact ?? '')
      if (a && !first.has(a)) first.set(a, e.t)
    }
  }
  const written = [...first.entries()]
  return {
    artifacts: written.length,
    firstTry: written.filter(([, t]) => t === 'write').length,
    refused,
  }
}
```

Render after the `recommender` block (~line 180):

```ts
  const wp = writePathStats(root)
  if (wp.artifacts > 0 || wp.refused > 0) {
    ctx.out(kv('write-path', `${wp.firstTry}/${wp.artifacts} artifacts first-try · ${wp.refused} refusal(s)`))
  }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/dashboard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/dashboard.ts tests/dashboard.test.ts
git commit -m "feat(dashboard): write-path first-try trend — the reader row 64 promised (D150)"
```

---

### Task 7: D152 — the malformed-rerun recommendation runs (closes #17)

**Files:**
- Modify: `src/recommend.ts:138-141`
- Test: `tests/recommend.test.ts` (extend — grep `malformed-rerun` in tests/ first; extend the existing case if one exists, else add to recommend.test.ts using its local entry-builder helpers)

**Interfaces:**
- Consumes: `last.malformed?: Array<{ reviewer: string; violations: Violation[] }>` (`src/rounds.ts:55`) — `reviewer` values are `PROMPT_NAMES` members by construction.
- Produces: option 2 of `malformed-rerun` is always accepted by `witness calibrate` — `--only <reviewer>` when the entry names one, `--suite reviewers` otherwise.

- [ ] **Step 1: Write the failing test**

In `tests/recommend.test.ts`, using the file's existing entry-construction pattern (it builds `GateRunEntry`-shaped objects — copy the nearest malformed fixture):

```ts
  it('malformed-rerun emits a calibrate invocation the verb accepts (D152)', () => {
    const withLens = decisionFor({ ...gateCtx, entries: [runEntry({ outcome: 'malformed', model: 'claude-x', malformed: [{ reviewer: 'code-reviewer', violations: [] }] })] })
    expect(withLens.options[1]!.command).toBe('witness calibrate claude-x --only code-reviewer')
    const without = decisionFor({ ...gateCtx, entries: [runEntry({ outcome: 'malformed', model: 'claude-x' })] })
    expect(without.options[1]!.command).toBe('witness calibrate claude-x --suite reviewers')
  })
```

(`decisionFor`/`runEntry` stand for whatever builders the file actually uses — mirror the adjacent tests exactly; the two `expect` lines are the contract.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/recommend.test.ts`
Expected: FAIL — command is `witness calibrate claude-x --only <gate>`.

- [ ] **Step 3: Implement**

`src/recommend.ts`, replace the `opt(`witness calibrate ${last.model} --only ${gate}`, ...)` option with:

```ts
        opt(((): string => {
          // D152 (issue #17). `--only` takes lens/skill names, never gate names — the old
          // line violated D129's "a rendered command runs" in the recommender itself. The
          // malformed rows name the lens that failed to parse; use it when present.
          const lens = last.malformed?.[0]?.reviewer
          return lens
            ? `witness calibrate ${last.model} --only ${lens}`
            : `witness calibrate ${last.model} --suite reviewers`
        })(), 'root', {
          when: 'the battery has malformed more than once — the lens or the model is at fault, not the artifact',
          tradeoff: 'spends a calibration run; nothing about this artifact changes',
        }),
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/recommend.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recommend.ts tests/recommend.test.ts
git commit -m "fix(recommend): malformed-rerun names a lens calibrate accepts, closes #17 (D152)"
```

---

### Task 8: D153 — ambient flow-scoping prints its reason

**Files:**
- Modify: `src/verbs/next.ts` (~lines 768-786)
- Test: `tests/next-home.test.ts` (extend — it already runs `next` from worktree cwds; copy its cwd-passing pattern)

**Interfaces:**
- Consumes: the existing `inferred`/`scoped` locals in `run()`.
- Produces: a `flow: <plan-id> — inferred from cwd` line, printed **before `next:`** (beside the stale rows — the `next:/stage:/target:/note:/home:/run:/relay:` lines are a contiguous unit the stage skills read verbatim, per the comment above the stale-rows render; nothing may split it), only on the ambient-inference path (never for explicit `--flow`, never at the primary root). **Corrected while executing** (house practice, recorded not quietly fixed): the plan originally said "after `target:`", which would have split the unit — carry this correction into T10's row 153 as one sentence.

- [ ] **Step 1: Write the failing test**

In `tests/next-home.test.ts`, beside the existing worktree-cwd case:

```ts
  it('says when a worktree cwd scoped the answer (D153)', async () => {
    // reuse the file's existing started-plan fixture; run next from inside the worktree
    const res = await repo.cli(['next'], { cwd: wt })
    expect(res.stdout).toMatch(/flow: .+ — inferred from cwd/)
    const atRoot = await repo.cli(['next'])
    expect(atRoot.stdout).not.toContain('inferred from cwd')
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/next-home.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/verbs/next.ts` `run()`: hoist the inference result so the render block can see it —

```ts
  let ambientFlow: string | undefined
  // (inside the else branch, after `scoped` is computed:)
    if (scoped) ambientFlow = inferred
```

and after the `target:` line (`if (action.target) ...`, ~line 784):

and print it **with the pre-block context rows, immediately after the stale rows and before `next:`**:

```ts
  // D153. The scoping was deliberate (ambient context, not a claim) but unprinted —
  // the residual of the 2026-08-01 "wtf i was redirected" report. Behavior unchanged.
  // Printed BEFORE next:, like the stale rows: the next:/stage:/target:/note:/home:/
  // run:/relay: lines are a contiguous unit the stage skills read verbatim.
  if (ambientFlow) ctx.out(kv('flow', `${ambientFlow} — inferred from cwd`))
```

(This requires computing the inference before the render section — hoist as described, and emit the line where the stale rows are emitted, not inside the action render block.)

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/next-home.test.ts tests/next.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/next.ts tests/next-home.test.ts
git commit -m "fix(next): ambient flow-scoping states itself (D153)"
```

---

### Task 9: D149 + D142-prose + D156 — the payload prose pack

**Files:**
- Modify: `plugin/skills/witness-brainstorm/SKILL.md`, `witness-decompose/SKILL.md`, `witness-plan/SKILL.md`, `witness-implement/SKILL.md`, `witness-ship/SKILL.md` (ground rules ×5 + ship recipe), `witness-design/SKILL.md` (one new bullet only)
- Modify: `tests/helpers.ts` (`SKILL_GROUND_RULES`)
- Test: `tests/skills.test.ts` (shared-contract loop — read it first; it asserts per-file strings at ~line 180)

**Interfaces:** none — prose plus contract asserts.

- [ ] **Step 1: Write the failing contract asserts**

In `tests/helpers.ts`, append to `SKILL_GROUND_RULES`:

```ts
  'designs/**',
  'Read a file before your first edit',
```

If `skills.test.ts`'s loop doesn't consume `SKILL_GROUND_RULES` for all six files, add explicit asserts in its shared loop:

```ts
      expect(body, name).toContain('designs/**')
      expect(body, name).toContain('Read a file before your first edit')
```

And two one-off asserts in the same file:

```ts
  it('ship recipe rebases the remote tip (D142)', () => {
    const body = readFileSync(skillPath('witness-ship'), 'utf8')
    expect(body).toContain('git rebase origin/<ship-branch>')
    expect(body).not.toMatch(/^git rebase <ship-branch>/m)
  })
  it('brainstorm names the interview floor (D156)', () => {
    const body = readFileSync(skillPath('witness-brainstorm'), 'utf8')
    expect(body).toContain('the floor, not the count')
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/skills.test.ts`
Expected: FAIL on the new asserts.

- [ ] **Step 3: Edit the payload**

1. In brainstorm:23, decompose:18, plan:23, implement:23, ship:23 — the never-edit bullet's opening becomes:
   `- **Never edit \`specs/**\`, \`plans/**\`, or \`designs/**\`** (the canon dirs — ...` (rest of each bullet unchanged; design:24 already names all three).
2. In all six skills, insert directly after the "Read canon with `witness read <id>`" bullet:
   ```
   - **Read a file before your first edit of it in this session.** Relay boundaries, `verify-red`'s stash cycle, and worktree re-attach all change files under you — an edit against a remembered copy is how "modified since read" and partial applies happen. The CLI now prints `stale-reads:` when it churns the tree; treat that list as unread.
   ```
3. `witness-ship/SKILL.md:52-53` — the recipe's first lines become:
   ```
   git fetch origin <ship-branch>
   git rebase origin/<ship-branch>   # the REMOTE tip — the CLI refused a stale local base; rebasing the local ref recreates it (D142)
   ```
4. `witness-brainstorm/SKILL.md` — at the end of the Interview-protocol intro paragraph (after "walk in dependency order:"), append:
   ```
   The five fields are the floor, not the count — keep interviewing while material scope uncertainty remains; a recap that would surprise its reviewer is under-asked.
   ```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/skills.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/skills tests/helpers.ts tests/skills.test.ts
git commit -m "docs(skills): designs/** in every ground rule, read-before-edit, origin rebase recipe, interview floor (D149, D142, D156)"
```

---

### Task 10: DESIGN.md rows D137–D156

**Files:**
- Modify: `DESIGN.md` (amendment block in the Status paragraph at line 5; twenty rows appended after row 136, ~line 448)

**Interfaces:** none — documentation of decisions already approved in the spec.

**Corrected while executing** (recorded not quietly fixed): the premise that `**2026-08-15 amendment (⊖)…**` is the previous Status block is false — rows 132–136 (⊘, ⊖) received **no** Status-paragraph block at all, only a sentence in the `## Decision log` legend paragraph (DESIGN.md:308). The last Status block is `2026-08-10 (⊗)`. Both were written: the block as planned (this triage is grill-#12/#13 scale), plus the legend sentence, without which `⟡` is undecodable.

- [ ] **Step 1: Write the amendment block**

Append to the Status paragraph (line 5), following the house pattern (`**2026-08-15 amendment (⊖)…**` is the previous one; pick the unused marker `⟡`): a **2026-08-29 amendment (⟡), pi-sessions field-report triage (rows 137–156; amends 82, 127; fixes 132's counterexample)** block of 8–12 sentences summarizing: third field report, first measuring economics ($2,223 / 84.6h / 989 turns / 90% human latency); every claim probed or reproduced before a row (two probe readings refuted by experiment — `pull.ff=only` does not break `sync`, and the contaminated squash-merge shape does); the two roots (invisible manual reconciliation + state commits leaking into PR branches; the human conscripted as process scheduler); the release line (0.14.0 statement honesty = rows 139/140/142-prose/146–150/152/153/155/156; behavior wave = 137/138/141/142-diffbase/143/144/151/154; drive = 145, own effort). Source the numbers and phrasing from the spec — do not invent new claims.

- [ ] **Step 2: Write the twenty rows**

After row 136 (~line 448), append `| 137 ⟡ | <title> | <choice> | <why> |` … `| 156 ⟡ | … |`. For each row, the **Choice** column is the spec's decision paragraph (condensed, keeping file:line refs and named amendments) and the **Why** column is the matching evidence from the spec's E1–E5 (verbatim numbers: 165 commits, 989 turns, ×8 fatals, 103×/40×/8× clusters, the reproduced conflict experiment). Titles:

137 Worktrees are cut from the fetched remote tip · 138 Sync happens where origin moved · 139 Divergence is visible state · 140 `sync` names its failure · 141 Worktree removal is cwd-safe · 142 One diff base: the true cut point · 143 A bare affirmation selects the CLI's recommendation · 144 Install writes the harness allowlist · 145 `witness drive`: the CLI is the scheduler · 146 The guard refusal names the way back in · 147 Refusals carry a runnable remedy · 148 Stale reads are announced · 149 Ground rules cover designs and first reads · 150 The write path trends on the dashboard · 151 Canon anchors resolve at the primary root · 152 The malformed-rerun recommendation runs · 153 Ambient flow-scoping states itself · 154 Trust is granted where a human decides · 155 Design churn is deferred with cause · 156 The interview floor is a floor.

Mark rows 137/138/141/142(diffbase half)/143/144/151/154 with a trailing sentence: **decided here, ships in the behavior wave (not yet built)** — and 145 with **own effort; not yet planned**. This is the house convention: rows record decisions when made; "Built and shipped as X" annotations land with their releases.

- [ ] **Step 3: Verify**

Run: `pnpm vitest run tests/` (nothing reads DESIGN.md at test time, but the full suite guards accidental file damage) and `grep -c '^| 1[45][0-9] ⟡' DESIGN.md` → expect 17 (rows 140–156) plus rows 137–139 via `grep -c '^| 13[789] ⟡' DESIGN.md` → 3.

- [ ] **Step 4: Commit**

```bash
git add DESIGN.md
git commit -m "docs(design): pi-sessions triage — rows D137–D156 (amends D82, D127; fixes D132 counterexample)"
```

---

### Task 11: Ship wave 1

- [ ] **Step 1: Full verification**

Run: `pnpm test && pnpm run typecheck && pnpm run build`
Expected: all green. Fix anything red before proceeding (superpowers:verification-before-completion).

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin d137-pi-sessions-triage
gh pr create --title "Triage wave 1: statement honesty (D137–D156 rows; builds D139/D140/D142p/D146–D150/D152/D153/D155/D156)" --body "Implements the wave-1 rows of docs/superpowers/specs/2026-08-29-pi-sessions-triage-design.md. No gate-outcome changes. Closes #17."
```

- [ ] **Step 3: After the human merges — release (human-gated)**

Per `docs/RELEASING.md`, from a clean main. Wave 1 is additive surface (remedy field, dashboard lines) → **minor**:

```bash
git checkout main && git pull
node scripts/release.mjs minor        # 0.14.0
git push origin main
git push origin v0.14.0               # the tag push publishes
```

Stop before this step and hand the merge + release decision to the human — merging is the human's act.

---

## Self-review notes (already applied)

- Spec coverage: every wave-1 row has a task (D139→T2, D140→T1, D142p→T9, D146→T4, D147→T3, D148→T5, D149→T9, D150→T6, D152→T7, D153→T8, D155→T10 row, D156→T9); D137/D138/D141/D142-diffbase/D143/D144/D151/D154/D145 are wave 2/3 and appear only as DESIGN.md rows (T10).
- Type consistency: `divergence` (T2) and `classifyPullFailure` (T1) names match between impl and tests; `Violation.remedy` optional-only.
- Known soft spots for executors: exact insertion lines drift — anchor on the quoted neighboring code, not line numbers; test-builder helper names in T7/T8 must be mirrored from the target files, the `expect` strings are the contract.
