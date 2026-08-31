# Canon Has One Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A canon artifact exists in exactly one place. The worktree stops carrying a second copy that can silently disagree with the copy every gate judges, and sessions read canon through `witness read` instead of by path.

**Architecture:** Four independent edits plus prose. `worktree.ts` excludes `stateDirs()` from every managed worktree via git sparse-checkout, applied and *verified* inside `createWorktree` so both callers inherit it. A new `witness read` verb becomes the read route, with `--outline`/`--lines` replacing the grep-then-offset move the implement skill mandates for fat artifacts. `check.ts` grows `canon-in-worktree` so a pre-upgrade worktree is discoverable without running the verb that fixes it. `canon-guard.mjs` narrows from *a state path co-occurs with a writeish token* to *a state path is a mutation target*, restoring the fail-open bias its own header claims.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, biome. Hook stays dependency-free JS. No new dependencies.

**Reported by:** [popovych-co/witness#14](https://github.com/popovych-co/witness/issues/14)

---

## Why this is a class, not a papercut

Two individually correct decisions combine into the failure:

- **D4** — state writes go main-side, PR branches carry code only. So canon moves on `main` while the worktree branch does not.
- **Row 96b** (`stateOnlyAdvance`, `src/gitio.ts:58`) — an advance made *only* of `Witness-State` commits is bookkeeping, so ship's `baseMoved`/`rebaseIfMoved` deliberately decline to rebase on it. A plan amend is exactly such an advance.

Each holds alone. Together they *guarantee* the worktree's canon copy can never catch up: the one mechanism that could refresh it is contractually forbidden from doing so. Nothing else ever writes to that copy.

The reported failure signature is what makes it expensive. The implementer reads the worktree copy; the implement gate serializes the plan from canon at the root (`src/gates/implement.ts:167-168`). When they disagree, reviewers quote plan sentences that `grep` cannot find in the implementer's file — which reads as **reviewer hallucination**, and points the human at `--approve --override` against a *correct* blocking finding.

**Decision:** delete the second copy rather than keep it fresh. Refreshing (rebase-on-start, or checking canon out into the worktree) leaves two locations and makes correctness depend on a sync step running; deleting makes the divergence unrepresentable.

## Measured evidence

git 2.50.1, linked worktree, sparse-checkout applied via the low-level mechanism (patterns file + worktree config + `read-tree -mu HEAD`):

| Probe | Result |
|---|---|
| `sparse-checkout` in a linked worktree | per-worktree; primary checkout unaffected; auto-enables `extensions.worktreeConfig` |
| partial exclusion (`docs/` kept, `docs/plans/` + `docs/specs/` gone) | works in non-cone mode |
| `changedFiles()` = `git diff --name-only <base>` | excluded paths **absent** — no phantom deletions |
| `git status --porcelain`, `ls-files --others` | clean |
| ship's `git add -A` + commit | does not delete them; `git diff main --stat` stays code-only |
| `git rebase main` | succeeds; updates the branch **tree** to current canon without materializing a file |
| exclusion applied over a **dirty** canon file | **fails open** — warning, exit 0, file kept, and it then enters `changedFiles()` |
| verification predicate | `git ls-files -t` tags excluded paths `S` (skip-worktree), materialized ones `H` |

Canon-guard probed against the reporter's own commands (current `plugin/hooks/canon-guard.mjs`, `paths: { specs: docs/specs, plans: docs/plans, designs: docs/designs }`):

```
allow  "wc -l docs/plans/p1.md"                             ← the issue's example does NOT reproduce
BLOCK  "grep \"Do not touch\" docs/plans/p1.md"             ← \btouch\b matched inside the SEARCH STRING
BLOCK  "cat > /tmp/issue.md <<'EOF'\nsee docs/plans/p1.md"  ← mutation target is /tmp
BLOCK  "grep -n foo docs/plans/p1.md > /tmp/out.txt"        ← mutation target is /tmp
allow  "git log --oneline -- docs/plans/p1.md"
BLOCK  "echo hi > docs/plans/p1.md"                         ← correct
BLOCK  "sed -i '' s/a/b/ docs/plans/p1.md"                  ← correct
BLOCK  "cp /tmp/x.md docs/plans/p1.md"                      ← correct
```

`WRITEISH` (`canon-guard.mjs:57`) scans the whole command line, quoted literals included. The reported plan's own bolded instruction — *"Do not touch `<Component>` in this slice"* — became an unquotable search string in that repo. The diagnosis was blocked by the words being searched **for**.

## What the CLI already gets right

Every verb splits `runRoot` (the worktree — code, tests, diff) from `stateRoot` (`primaryRoot` — canon, journal): `src/verbs/evidence.ts:18-24` is the canonical example. **No CLI code path reads the worktree's canon copy.** The only consumer is the model's eyes. That is what makes deletion nearly free, and it is the load-bearing fact behind this plan.

## Global Constraints

- The exclusion set is **`stateDirs(root)`** (`src/gitio.ts:37`) — the same predicate `isStatePath` and `stateCommit` already use. Never a second list; a divergence between "what the CLI refuses to let you edit" and "what the worktree hides" is the split-brain rows 93/95/96 are all about.
- **Do not use the `sparse-checkout` porcelain.** Its flags moved across git 2.25–2.37 (`init --no-cone`, `set --no-cone`). `primaryRoot` already binds the floor at git ≥2.31 via `rev-parse --path-format`; the low-level mechanism (patterns file + `core.sparseCheckout` + `read-tree -mu HEAD`) is stable across that whole range and is what the evidence table measured.
- **`extensions.worktreeConfig` has a documented caveat**: enabling it makes `core.bare` and `core.worktree` per-worktree. If either is set in the shared config, refuse rather than enable — witness must not silently relocate a setting the user made.
- `witness.config.yaml` stays **worktree-read** (`src/evidence.ts:52`, `src/criteria.ts:31`). It is source, it lives on the code branch, and a plan whose slice changes the test runner must be able to test its own change. This is a deliberate boundary, recorded as a residual — not an oversight.
- The guard stays **dependency-free** (D13 — it runs from `${CLAUDE_PLUGIN_ROOT}` with no `node_modules`) and **fail-open** (D31 — friction, not the guarantee; the trailer audit is the guarantee).
- Commit style: conventional commits with the decision id, e.g. `feat(worktree): canon has one home (D132)`.
- Test command: `npx vitest run <file>`; full suite `npm test`; types `npm run typecheck`; lint `npx biome check .`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/worktree.ts` | Worktree lifecycle | Canon exclusion: patterns, apply, verify; `createWorktree` refuses on residue |
| `src/verbs/read.ts` | **new** — the canon read route | `witness read <id> [--design] [--outline] [--lines a-b]` |
| `src/cli.ts` | Verb table + usage | Register `read`; usage string |
| `src/verbs/index-verb.ts` | Canon listing | *(optional task)* plans table so `ls plans/` has a CLI route |
| `src/verbs/check.ts` | Repo audit | `canon-in-worktree` — warn when clean, error when dirty |
| `plugin/hooks/canon-guard.mjs` | Write guard | Strip quotes/heredocs; block only mutation targets |
| `plugin/skills/witness-*/SKILL.md` | Stage skills (×6) | Read rule beside the existing write rule |
| `tests/worktree.test.ts` | start + worktree | Exclusion applied, verified, survives rebase; residue refusal |
| `tests/read.test.ts` | **new** | The read verb's surface |
| `tests/check.test.ts` | Audit findings | `canon-in-worktree` both severities |
| `tests/canon-guard.test.ts` | Guard unit | The four false positives; every true positive still blocks |
| `tests/skills.test.ts` | Skill prose invariants | Read rule present; no bare `cat <canon-path>` |
| `DESIGN.md` | Decision record | Rows 132 + 133, three open residuals |

---

### Task 1: Canon is excluded from every managed worktree

**Files:**
- Modify: `src/worktree.ts`
- Test: `tests/worktree.test.ts`

**Interfaces:**
- Consumes: `stateDirs(root)`, `git`/`tryGit` from `./gitio.js`; `ok`/`refuse`/`v` from `./refusal.js`. Tests: `TestRepo.git` is root-bound (`tests/helpers.ts:24`), so `tests/worktree.test.ts` adds the local `gitIn` helper shown below — `tests/helpers.ts` itself does not change.
- Produces:
  - `canonPatterns(root: string): string[]` — `['/*', ...stateDirs(root).map(d => \`!/${d}/\`)]`
  - `materializedCanon(root: string, wtPath: string): string[]` — tracked paths under a state dir **not** tagged `S` by `git ls-files -t`; **plus** `S`-tagged paths that nonetheless exist on disk (hand-planted over the sparse rule — skip-worktree keeps `git status` silent about them, so nothing else can see them); plus untracked ones from `ls-files --others --exclude-standard` (`.witness/screens/` and `.witness/worktrees/` are already filtered by `ensureExcluded`'s `info/exclude` entries).
  - `excludeCanon(root: string, wtPath: string): Result<void>` — writes patterns, sets config, `read-tree -mu HEAD`, then verifies.

- [ ] **Step 1: Write the failing tests**

New imports in `tests/worktree.test.ts`: `execFileSync` from `node:child_process`, `writeFileSync` from `node:fs`, `writePlan`/`writeSpec` are already imported. Shared setup for this describe block:

```ts
// TestRepo.git is root-bound; worktree assertions need a wt-cwd git
const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

const PLAN_REL = 'plans/auth-refresh-plan-1.md'

async function excludedRepo() {
  const repo = await approvedPlanRepo()
  await repo.cli(['start', 'auth-refresh-plan-1'])
  return { repo, wt: worktreePath(repo.root, 'auth-refresh-plan-1') }
}

// A worktree created before the exclusion existed: sparse off, canon re-materialized
// (tagged H) — exactly the state a 0.11.x-created worktree is in after upgrade.
function undoExclusion(wt: string) {
  gitIn(wt, 'config', '--worktree', 'core.sparseCheckout', 'false')
  gitIn(wt, 'read-tree', '-mu', 'HEAD')
}
```

```ts
it('excludes canon from a fresh worktree and marks it skip-worktree', async () => {
  const { wt } = await excludedRepo()
  expect(existsSync(join(wt, 'specs'))).toBe(false)
  expect(existsSync(join(wt, 'plans'))).toBe(false)
  // the branch still CARRIES it — only the checkout hides it, so the PR stays code-only
  expect(gitIn(wt, 'ls-files', '-t', '--', 'plans')).toMatch(/^S /m)
  expect(gitIn(wt, 'status', '--porcelain')).toBe('')
})

it('keeps non-canon siblings of a relocated canon dir', async () => {
  const repo = await seededRepo()
  repo.write('witness.config.yaml', 'schema: 1\npaths: { specs: docs/specs, plans: docs/plans }\n')
  repo.write('docs/RELEASING.md', '# how to release\n')
  repo.git('add', 'witness.config.yaml', 'docs/RELEASING.md')
  repo.git('commit', '-m', 'relocate canon under docs/')       // source paths — no trailer
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  repo.flipStatus('auth-refresh-plan-1', 'approved')
  await repo.cli(['start', 'auth-refresh-plan-1'])
  const wt = worktreePath(repo.root, 'auth-refresh-plan-1')
  expect(existsSync(join(wt, 'docs', 'RELEASING.md'))).toBe(true)   // sibling kept
  expect(existsSync(join(wt, 'docs', 'plans'))).toBe(false)         // canon gone
})

it('an amended plan reaches the branch tree without materializing a file', async () => {
  const { repo, wt } = await excludedRepo()
  // amend canon on main the way stateCommit does — content + trailer
  repo.write(PLAN_REL, repo.read(PLAN_REL).replace('Implement rotation', 'Implement rotation AND REVOCATION'))
  repo.git('add', PLAN_REL)
  repo.git('commit', '-m', 'plan(auth-refresh-plan-1): amend', '-m', 'Witness-State: 1')
  gitIn(wt, 'rebase', 'main')
  expect(gitIn(wt, 'show', `HEAD:${PLAN_REL}`)).toContain('AND REVOCATION')  // tree is v2
  expect(existsSync(join(wt, PLAN_REL))).toBe(false)                         // disk still empty
})

it('re-attach applies the exclusion to a worktree created before the exclusion existed', async () => {
  const { repo, wt } = await excludedRepo()
  undoExclusion(wt)
  expect(existsSync(join(wt, PLAN_REL))).toBe(true)   // the pre-upgrade state, reproduced
  const r = await repo.cli(['start', 'auth-refresh-plan-1'])
  expect(r.code).toBe(0)
  expect(existsSync(join(wt, PLAN_REL))).toBe(false)
})

it('refuses when a DIRTY canon file blocks the exclusion', async () => {
  const { repo, wt } = await excludedRepo()
  undoExclusion(wt)
  writeFileSync(join(wt, PLAN_REL), repo.read(PLAN_REL) + '\nhand edit\n')
  const r = await repo.cli(['start', 'auth-refresh-plan-1'])
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('canon-in-worktree')
  expect(r.stderr).toContain(PLAN_REL)
})

it('refuses to enable extensions.worktreeConfig when core.worktree is set', async () => {
  const repo = await approvedPlanRepo()
  repo.git('config', 'core.worktree', repo.root)   // harmless value, shared-config scope
  const r = await repo.cli(['start', 'auth-refresh-plan-1'])
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('worktree-config-unsafe')
})
```

- [ ] **Step 2: Implement `canonPatterns` / `materializedCanon` / `excludeCanon`**

```ts
export function canonPatterns(root: string): string[] {
  return ['/*', ...stateDirs(root).map((d) => `!/${d}/`)]
}

export function excludeCanon(root: string, wtPath: string): Result<void> {
  // git's own caveat: enabling worktreeConfig relocates these two to per-worktree scope.
  for (const key of ['core.bare', 'core.worktree']) {
    // --local: the shared .git/config is the scope worktreeConfig relocates from;
    // merged scope would refuse over a harmless global/system setting
    const cur = tryGit(root, 'config', '--local', '--get', key)
    if (cur.ok && cur.out.trim() !== '' && cur.out.trim() !== 'false') {
      return refuse([v('git', 'worktree-config-unsafe', `${key}=${cur.out.trim()}`,
        `${key} unset — enabling extensions.worktreeConfig would move it to per-worktree scope`)])
    }
  }
  const gitDir = git(wtPath, 'rev-parse', '--path-format=absolute', '--git-dir')
  mkdirSync(join(gitDir, 'info'), { recursive: true })
  writeFileSync(join(gitDir, 'info', 'sparse-checkout'), `${canonPatterns(root).join('\n')}\n`)
  git(root, 'config', 'extensions.worktreeConfig', 'true')
  git(wtPath, 'config', '--worktree', 'core.sparseCheckout', 'true')
  git(wtPath, 'config', '--worktree', 'core.sparseCheckoutCone', 'false')
  tryGit(wtPath, 'read-tree', '-mu', 'HEAD')     // declines on dirty paths — verified below
  const residue = materializedCanon(root, wtPath)
  if (residue.length) {
    return refuse(residue.map((p) => v(p, 'canon-in-worktree', 'canon materialized in a worktree',
      'canon read at the primary root (witness read <id>) — revert or `witness adopt` the edit, then re-run')))
  }
  return ok(undefined)
}
```

- [ ] **Step 3: Wire into `createWorktree` — both arms**

`createWorktree` early-returns when the directory exists (`src/worktree.ts:55`). That return is the **re-attach** path and the incident path, so it must apply the exclusion too, not just the create path. Apply after `worktree add` succeeds and before every `ok(...)`.

- [ ] **Step 4: Verify** — `npx vitest run tests/worktree.test.ts`, then `npm test` (ship/evidence/gate suites all exercise worktrees; a phantom-deletion regression surfaces there).

---

### Task 2: `witness read` — the canon read route

**Files:**
- Create: `src/verbs/read.ts`
- Modify: `src/cli.ts` (VERBS table + usage)
- Test: `tests/read.test.ts`

**Interfaces:**
- Consumes: `primaryRoot`, `loadCanon`/`findById`, `serializeDoc`, `designRel`, `elementIds`, `rows`/`kv`.
- Surface:
  - `witness read <id>` — spec or plan, serialized whole (frontmatter + body), raw to stdout like `witness diff`.
  - `witness read <spec-id> --design` — the design HTML.
  - `witness read <id> --outline` — anchors with line ranges: element ids for HTML (`elementIds`, which `validateDesignArtifact` already guarantees ≥2 of and requires unique), headings for markdown.
  - `witness read <id> --lines <a>-<b>` — 1-indexed inclusive slice of any artifact.
- Refusals: `unknown-id`; `no-design` (spec has no design artifact); `bad-range` (unparseable or inverted).

**Design note.** `--outline` + `--lines` was chosen over `--section <anchor>` deliberately. The implement skill's fat-artifact rule is *grep for the anchors, then read those offsets* — two moves, and deleting the file breaks both, so the verb must replace both. A `--section` extractor would need a hand-written tag-depth scanner over HTML with no parser dependency, whose failure mode is a **silent mis-slice**. Line ranges cannot mis-slice.

- [ ] **Step 1: Write the failing tests**

`tests/read.test.ts` inlines its own setup (tasks are read in isolation — do not reach into `tests/worktree.test.ts`): `planRepo` mirrors that file's `approvedPlanRepo`, `uiRepo` mirrors `tests/design-verb.test.ts`'s setup. Fixture facts used below: `PLAN_BODY` contains `Implement rotation with TDD.`; `DESIGN_HTML` carries ids `eyebrow`/`essentials`/`save-bar` (`tests/helpers.ts`).

```ts
import { describe, expect, it } from 'vitest'
import { approve, seededRepo, writeDesign, writePlan, writeSpec } from './helpers.js'
import { worktreePath } from '../src/worktree.js'

const PLAN_REL = 'plans/auth-refresh-plan-1.md'

async function planRepo() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  repo.flipStatus('auth-refresh-plan-1', 'approved')
  return repo
}

async function uiRepo() {
  const repo = await seededRepo()
  await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
  approve(repo, 'booking-form')
  await writeDesign(repo, 'booking-form')
  return repo
}

it('prints a plan whole from inside the worktree — current canon, not a copy', async () => {
  const repo = await planRepo()
  await repo.cli(['start', 'auth-refresh-plan-1'])
  const wt = worktreePath(repo.root, 'auth-refresh-plan-1')
  // amend on main AFTER start — the read must see v2 though the wt carries no file
  repo.write(PLAN_REL, repo.read(PLAN_REL).replace('Implement rotation', 'Implement rotation AND REVOCATION'))
  repo.git('add', PLAN_REL)
  repo.git('commit', '-m', 'amend', '-m', 'Witness-State: 1')
  const r = await repo.cli(['read', 'auth-refresh-plan-1'], { cwd: wt })
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('AND REVOCATION')
})

it('reads the design artifact for a ui spec', async () => {
  const repo = await uiRepo()
  const r = await repo.cli(['read', 'booking-form', '--design'])
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('id="save-bar"')
})

it('outlines a design by element id with line ranges', async () => {
  const repo = await uiRepo()
  const r = await repo.cli(['read', 'booking-form', '--design', '--outline'])
  expect(r.code).toBe(0)
  expect(r.stdout).toMatch(/id\s+lines/)
  expect(r.stdout).toContain('save-bar')
  expect(r.stdout).toMatch(/\d+-\d+/)
})

it('slices by line range', async () => {
  const repo = await planRepo()
  const r = await repo.cli(['read', 'auth-refresh-plan-1', '--lines', '1-3'])
  expect(r.code).toBe(0)
  expect(r.stdout.trimEnd().split('\n')).toHaveLength(3)
  expect(r.stdout.startsWith('---')).toBe(true)   // serialized doc opens with frontmatter
})

it('refuses an unknown id, a spec with no design, and a bad range', async () => {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  const unknown = await repo.cli(['read', 'nope'])
  expect(unknown.code).toBe(2)
  expect(unknown.stderr).toContain('unknown-id')
  const noDesign = await repo.cli(['read', 'auth-refresh', '--design'])
  expect(noDesign.code).toBe(2)
  expect(noDesign.stderr).toContain('no-design')
  const bad = await repo.cli(['read', 'auth-refresh', '--lines', '9-3'])
  expect(bad.code).toBe(2)
  expect(bad.stderr).toContain('bad-range')
})
```

- [ ] **Step 2: Implement the verb.** Read from canon at the root — never from `ctx.cwd`.

- [ ] **Step 3: Register in `src/cli.ts`** VERBS (`read: () => import('./verbs/read.js')`) **and** a `VERB_USAGE` entry: `read: 'witness read <id> [--design] [--outline] [--lines <a>-<b>]'`. The verb's own usage refusal must print the **same string** — `tests/verb-usage.test.ts` asserts `--help` agrees with what the verb prints for itself.

- [ ] **Step 4: Verify** — `npx vitest run tests/read.test.ts`.

---

### Task 2b (optional — scope flagged): `witness index` lists plans

**Cut this task freely; nothing else depends on it.**

`witness-plan/SKILL.md:36` does `ls plans/ && cat plans/<spec-id>-plan-*.md`. Task 2 replaces the `cat`. Nothing replaces the `ls` — `index` lists **specs only** (`src/verbs/index-verb.ts:12`), so "the prior plans for this spec" has no CLI route and the one-rule-everywhere decision has a hole at exactly one place.

- [ ] **Step 1:** In `tests/index.test.ts`: test that `witness index` emits a plans table (`id`, `parent`, `status`) after the specs tables.
- [ ] **Step 2:** Implement — `canon.docs.filter(type === 'plan')`, grouped by parent, sorted by id.
- [ ] **Step 3:** Update the `help:` footer to name `witness read <id>`.

---

### Task 3: `check` finds canon left in a worktree

**Files:**
- Modify: `src/verbs/check.ts`
- Test: `tests/check.test.ts`

**Interfaces:** consumes `listWorktrees`, `worktreePath`, `materializedCanon` (Task 1).

Severity splits by cause, because the causes are different events. `materializedCanon` returns bare paths; **classify in `check`, not in `worktree.ts`**: a residue path is *dirty* iff it appears in `tryGit(wtPath, 'status', '--porcelain', '--untracked-files=all', '--', ...stateDirs(root))` — a pre-upgrade worktree's clean canon is status-silent, a hand edit or a hand-planted untracked file is not — **or** it is `S`-tagged yet present on disk (status-silent too, but sparse never leaves an `S` file on disk, so it is a hand event by definition).

| Residue | Level | Shape | Meaning | Remedy |
|---|---|---|---|---|
| clean | `warn` | **one finding per worktree** — path count + first path as sample | a worktree predating the exclusion | `witness start <id>` (idempotent; removes it) |
| dirty | `error` | one finding **per path** | a hand edit of canon inside a worktree | revert, or `witness adopt <path>` at the root |

One-per-worktree for clean matters: a pre-upgrade worktree materializes **every** canon doc, and a row per path is dozens of identical warns for one event. The dirty case matches what `check` already rates `error` at the root — `hand-edit-in-progress` (`src/verbs/check.ts:170`). The clean case is upgrade noise that expires the first time each flow is touched.

- [ ] **Step 1:** Failing tests for both severities: clean → exactly **one** `warn` naming the worktree and the path count; dirty → an `error` naming the worktree **and** the path.
- [ ] **Step 2:** Implement inside the existing `listWorktrees(root)` loop that already emits `stray-worktree` (`check.ts:144`).
- [ ] **Step 3:** Verify — `npx vitest run tests/check.test.ts`.

---

### Task 4: The guard blocks mutations, not mentions

**Files:**
- Modify: `plugin/hooks/canon-guard.mjs`
- Test: `tests/canon-guard.test.ts`

The current Bash branch blocks when a state path and a writeish token **co-occur anywhere** in the command string. That biases toward false positives — fails *closed* on ambiguity — while the file's own header states the opposite contract: *"Friction, not the guarantee… Anything unparseable falls open."* This is the implementation disagreeing with its documented stance, not a tuning nit.

**New shape, in order:**

1. **Blank quoted regions and heredoc bodies** before any *structural* matching. Single-quoted, double-quoted, and `<<'EOF'`/`<<EOF` … `EOF` bodies become spaces, **offset-preserving**. This alone kills `grep "Do not touch" <plan>` and the issue-report case.
2. **Split into segments** on `;`, `|`, `&&`, `||`, newline — found in the blanked text, so quoted separators cannot split.
3. **Detect structure on the blanked text; resolve targets from the original.** Redirect operators (`>`, `>>`, `N>`/`N>>`, `&>` forms) and mutator command words (`mv cp rm tee touch truncate dd`, or `sed` with `-i`) are located in the **blanked** text, so a quoted `>` or a quoted `touch` cannot trip them. Every candidate **target token** — the token after a redirect operator, an argument of a mutator segment — is then sliced from the **original** command at the same offsets (this is what offset preservation is *for*), and stripped of its surrounding quotes before the state-path test. Matching targets against the blanked text instead would let `echo hi > "docs/plans/p1.md"` fall open — quoted paths are how agents usually spell paths, a false-negative regression the old co-occurrence guard did not have.
4. **Block a segment only when a resolved target token is a state path.**
5. Anything unparseable → **fall open**, as today.

The Write/Edit branch is untouched — it already keys on `file_path` and has no false-positive surface.

- [ ] **Step 1: Write the failing tests** — the four measured false positives must allow; every measured true positive must still block. Add: **quoted mutation targets still block** — `echo hi > "docs/plans/p1.md"`, `sed -i '' 's/a/b/' "docs/plans/p1.md"`, `tee 'docs/plans/p1.md'` (the regression the blank-then-match shape invites); `sed -i` with a separate-argument suffix; `mv <plan> /tmp/x`; and a fall-open case (`$(printf '>') docs/plans/p.md` may allow — assert it does not throw).
- [ ] **Step 2: Implement** — pure functions, no new imports, everything inside the existing `try`.
- [ ] **Step 3: Verify** — `npx vitest run tests/canon-guard.test.ts tests/hooks-guard.test.ts`.

**Residual, to be stated in the decision row:** quote-stripping is not shell parsing. `eval`, command substitution producing a redirect, and `$VAR`-indirected paths all still evade it. That is acceptable *by construction* — the guard is friction, the trailer audit is the guarantee (D31).

---

### Task 5: Skill prose — the read rule beside the write rule

**Files:**
- Modify: `plugin/skills/witness-{brainstorm,decompose,design,implement,plan,ship}/SKILL.md`
- Test: `tests/skills.test.ts`

Each skill carries a ground rule that today has only a write half (`witness-implement/SKILL.md:23` and siblings). It gains a read half:

> **Read canon with `witness read <id>`, never by path.** Canon lives at the primary root; inside a worktree the files are **absent by design**, so a path read finds nothing and a stale copy cannot be mistaken for the contract. Fat artifacts: `witness read <spec-id> --design --outline`, then `--lines <a>-<b>`.

Specific edits — this list is the sweep, and it is **exhaustive on purpose**: a per-task implementer sees only this task, and the negative test below catches only the `cat` shape, not prose references.
- `witness-implement:59` — "Never touch `specs/` or `plans/`" gains *"— they are not in your worktree; `witness read` is the route"*.
- `witness-implement:51` (fat-artifact rule) — grep-then-offset becomes `--outline` then `--lines`.
- `witness-implement:90` — *"the living `designs/<spec>.html` is the approved direction to fix toward"* names a file that is **no longer in the worktree**; becomes *"`witness read <spec-id> --design` is the approved direction to fix toward"*.
- `witness-implement` Start section — `start` prints the worktree path; note canon is deliberately absent from it.
- `witness-plan:35` — `cat specs/<spec-id>.md` becomes `$WITNESS read <spec-id>`.
- `witness-plan:36-37` — `ls plans/ && cat plans/…` becomes `witness index` + `witness read <plan-id>`, deleting the hardcoded default-layout paths and the parenthetical apologising for them. *(Depends on Task 2b; if cut, keep the `ls` and change only the `cat`.)*
- `witness-plan:49` — *"Read `designs/<spec-id>.html`"* becomes *"`$WITNESS read <spec-id> --design` (`--outline` then `--lines` when it is fat)"*.
- `witness-design:40` and `:42` — the inputs block's `cat specs/<spec-id>.md` becomes `$WITNESS read <spec-id>`; `cat designs/<spec-id>.html 2>/dev/null` becomes `$WITNESS read <spec-id> --design` — its `no-design` refusal **is** the "new screen" signal, so the `2>/dev/null` trick goes too.
- `witness-decompose:37` — the tie-break *"grep `specs/`"* **stays**, amended to *"grep the specs dir read-only at the primary root"*. Search across canon is not an artifact read and no search verb exists; the read rule governs reading an **identified** artifact.

- [ ] **Step 1:** Extend `tests/skills.test.ts`'s shared-contract block: every skill body contains the read rule; **negative** assertion (in the style of row 128's) that no skill body contains a bare `cat <canon-dir>/` read. The pattern is deliberately just the `cat` shape: `designs/` also appears legitimately as a **write destination** (the design skill's output contract), so a broader path-mention ban would false-positive — prose references are closed by the exhaustive edit list above instead.
- [ ] **Step 2:** Edit the six files.
- [ ] **Step 3:** Verify — `npx vitest run tests/skills.test.ts`.

**Release cost, stated deliberately.** Row 128 aimed for 0.11.0 to be the *last* payload change the block needs, because the payload is committed and branch-scoped (row 87), every home must be upgraded (row 117), and the floor binds the repository (row 116). This spends that budget. It is justified — a new read invariant is not a format detail — and the decision row must say so rather than let the cost pass unremarked. Note the floor itself needs **no manual bump**: it is *derived* from the `w` stamps in the journal (`src/floor.ts:19-43`), so it rises on its own the first time a 0.12.0 CLI writes state. The real downstream cost is a skills re-add plus `init --agent <name>`, which `check` already detects (row 103).

---

### Task 6: The decision record

**Files:** `DESIGN.md`

- [ ] **Row 132 — "A plan has one home."** The worktree stops carrying canon; `stateDirs()` is sparse-excluded from every managed worktree, applied and verified in `createWorktree`; `witness read` is the read route; `check` reports residue. *Why*: cite the two-decision interaction (D4 × row 96b) that makes the copy unable to catch up; the reviewer-hallucination signature and the `--approve --override` trap it baits; the fact that no CLI path reads the copy (`src/verbs/evidence.ts:18-24`), so only the model's eyes were relying on it; and the measured probe table. State the rejected alternative — refresh-on-start — and *why*: it keeps two locations and makes correctness depend on a sync step running, where deletion makes divergence unrepresentable.
- [ ] **Row 133 — "The guard blocks mutations, not mentions."** Quote-blanking for structure, mutation-target detection for judgment — with targets resolved from the **original** text through preserved offsets, so quoting neither hides a mutation (`> "docs/plans/p1.md"`) nor manufactures one (`grep '>' <plan>`). *Why*: the measured probe table, and the header's own fail-open contract that co-occurrence testing inverts. Record that the issue's `wc -l` example does **not** reproduce and the real cause was `\btouch\b` matching inside a search string — the failure was invisible because the block message names a path and never the token that tripped it.
- [ ] Add a preamble sentence naming rows 132–133 as grill #16, 2026-08-12, with a fresh mark symbol.
- [ ] **Open / deferred** — three residuals:
  - `witness.config.yaml` is still worktree-read (`src/evidence.ts:52`, `src/criteria.ts:31`) — the same staleness class, accepted deliberately so a plan that changes the test runner can test its own change.
  - Sparse-checkout is a *checkout policy*, not an invariant: a hand-planted canon file in a worktree is **caught** by `check`, not prevented. The guarantee covers staleness, not forgery — which is the same division of labour D31 draws between the guard and the trailer audit.
  - The guard remains heuristic; quote-stripping is not shell parsing.

---

## Verification

- [ ] `npm test` green
- [ ] `npm run typecheck` clean
- [ ] `npx biome check .` clean
- [ ] Manual: create a worktree, amend its plan on `main`, confirm the worktree has no plan file and `witness read <plan-id>` returns the amended text
- [ ] Manual: `witness check` on a repo with a pre-upgrade worktree warns once, and `witness start <id>` clears it
