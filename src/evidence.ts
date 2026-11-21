import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { loadConfig } from './config.js'
import { entryLine, appendEntry, journalRel, readStream } from './journal.js'
import { mergeReports, reportFiles, type TestOutcome } from './junit.js'
import { extractCanonicalTags, matchesTag } from './matcher.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { runFiltered, runFullSuite, runnerConfig, untrustedOf } from './runner.js'
import { git, gitWith, stateCommit, tryGit } from './gitio.js'
import type { CanonDoc } from './scan.js'
import { kv } from './toon.js'
import { withTxn } from './txn.js'
import { acquireLock } from './lock.js'

export function isTestPath(rel: string): boolean {
  if (/\.(test|spec)\./.test(rel)) return true
  return rel.split('/').some((seg) => seg === 'test' || seg === 'tests' || seg === '__tests__')
}

export function screensDir(runRoot: string, planId: string): string {
  return join(runRoot, '.witness', 'screens', planId)
}

export interface Capture { name: string; sha: string }

export function collectCaptures(runRoot: string, planId: string): Capture[] {
  const dir = screensDir(runRoot, planId)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith('.png') && statSync(join(dir, n)).isFile())
    .sort()
    .map((name) => ({ name, sha: createHash('sha256').update(readFileSync(join(dir, name))).digest('hex') }))
}

export function checkoutRoot(cwd: string): Result<string> {
  const res = tryGit(cwd, 'rev-parse', '--show-toplevel')
  if (!res.ok) return refuse([v('cwd', 'not-a-repo', cwd, 'run inside a git checkout')])
  return ok(res.out.trim())
}

export interface SpecTestRun {
  runner: 'filtered' | 'full-suite'
  tests: Array<{ name: string; ok: boolean }>
  allOk: boolean
}

export async function runSpecTests(
  runRoot: string, ctx: Ctx, parentId: string, trustRoot: string,
  opts: { suite?: TestOutcome[] } = {},
): Promise<Result<SpecTestRun>> {
  const cfg = loadConfig(runRoot)
  if (!cfg.ok) return cfg
  const rcRes = runnerConfig(cfg.value)
  if (!rcRes.ok) return rcRes
  const rc = rcRes.value
  if (rc.mode === 'filtered') {
    if (rc.reportGlob !== undefined) {
      for (const f of reportFiles(runRoot, rc.reportGlob)) rmSync(join(runRoot, f))
    }
    const run = await runFiltered(runRoot, ctx, rc.template, parentId, trustRoot)
    if (!run.ok) return run
    if (rc.reportGlob === undefined) {
      const tests = [{ name: `@spec:${parentId}`, ok: run.value.exitZero }]
      return ok({ runner: 'filtered', tests, allOk: run.value.exitZero })
    }
    const merged = mergeReports(runRoot, rc.reportGlob)
    if (!merged.ok) return merged
    const tests = merged.value
      .filter((t) => matchesTag(t.name, parentId))
      .map((t) => ({ name: t.name, ok: t.status === 'passed' }))
    if (tests.length === 0) {
      return refuse([v('criteria.runner', 'filter-matched-nothing', `0 tests matched @spec:${parentId}`,
        'a runner whose filter reaches the tagged tests — check the template forwards the pattern')])
    }
    return ok({ runner: 'filtered', tests, allOk: tests.every((t) => t.ok) })
  }
  // A caller checking several specs at once runs the suite ONCE and hands it here. Without
  // this the regression lane executes the whole suite per spec, which is the redundancy
  // `runCriteria` already pays per CRITERION.
  let all: TestOutcome[]
  if (opts.suite !== undefined) {
    all = opts.suite
  } else {
    const suite = await runFullSuite(runRoot, ctx, rc, trustRoot)
    if (!suite.ok) return suite
    all = suite.value.tests
  }
  const tests = all
    .filter((t) => matchesTag(t.name, parentId))
    .map((t) => ({ name: t.name, ok: t.status === 'passed' }))
  if (tests.length === 0) {
    return refuse([v('criteria.report', 'filter-matched-nothing', `0 tests matched @spec:${parentId}`,
      'tagged tests present in the merged junit reports')])
  }
  return ok({ runner: 'full-suite', tests, allOk: tests.every((t) => t.ok) })
}

// Row 191 §4.3. `step` is the plan step this cycle closes; absent on a cycle that is no plan
// step's (a fix round after a gate).
export function journalEvidence(
  stateRoot: string, planId: string, phase: 'red' | 'green', run: SpecTestRun,
  extra: { reconstructed?: boolean; vacuous?: boolean; captures?: Capture[]; step?: string } = {},
): Result<{ sha: string }> {
  const entry = { t: 'test-evidence' as const, artifact: planId, phase, runner: run.runner, tests: run.tests, ...extra }
  const marker = {
    op: `test-evidence(${planId}): ${phase}`,
    files: [journalRel(planId)],
    journalMulti: [{ stream: planId, line: entryLine(entry) }],
  }
  // Row 181 · D76: the lock wraps the write window only. The suite ran before this call,
  // unlocked, in the plan's own worktree — under parallel flows a lock held across it would
  // make every other flow's write wait out a whole suite.
  const lock = acquireLock(stateRoot)
  if (!lock.ok) return lock
  try {
    return withTxn(stateRoot, marker, () => {
      appendEntry(stateRoot, planId, entry)
      return stateCommit(stateRoot, marker.files, marker.op)
    })
  } finally {
    lock.value()
  }
}

export async function recordEvidence(
  runRoot: string, stateRoot: string, ctx: Ctx, planId: string, parentId: string,
  phase: 'red' | 'green', extra: { reconstructed?: boolean; step?: string } = {},
): Promise<Result<SpecTestRun>> {
  // latest-cycle by construction: a fresh empty dir per cycle means captures can
  // only be this run's. Browser tests screenshot iff WITNESS_SCREENS_DIR is set,
  // so non-UI plans and the gate's own drift lane (which does not set it) write nothing.
  const dir = screensDir(runRoot, planId)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const runCtx: Ctx = { ...ctx, env: { ...ctx.env, WITNESS_SCREENS_DIR: dir } }
  const run = await runSpecTests(runRoot, runCtx, parentId, stateRoot)
  if (!run.ok) return run
  const vacuous = phase === 'red' && run.value.allOk ? { vacuous: true } : {}
  const captures = collectCaptures(runRoot, planId)
  const capExtra = captures.length ? { captures } : {}
  const committed = journalEvidence(stateRoot, planId, phase, run.value, { ...extra, ...vacuous, ...capExtra })
  if (!committed.ok) return committed
  return run
}

export function diffBase(runRoot: string, cfg: Config, override?: string): Result<string> {
  if (override) {
    const res = tryGit(runRoot, 'rev-parse', '--verify', `${override}^{commit}`)
    if (!res.ok) return refuse([v('--base', 'no-base', override, 'a resolvable commit-ish')])
    return ok(res.out.trim())
  }
  const branch = cfg.ship.branch
  // D142. The true cut point is the DESCENDANT of the two merge-bases. Exact in all three
  // shapes: a legacy branch cut from a state-carrying local main (local is later — origin
  // alone would put its inherited .witness/journal/* into the reviewed diff, reproduced by
  // experiment in the triage), a post-D137 clean cut (origin equal or later), and a behind
  // local. Incomparable ancestries → origin, the post-D137 invariant. No remote → local
  // alone, which is D137's no-remote legality. One home for all seven callers.
  const local = tryGit(runRoot, 'merge-base', 'HEAD', branch)
  const remote = tryGit(runRoot, 'merge-base', 'HEAD', `origin/${branch}`)
  if (!local.ok && !remote.ok) {
    return refuse([v('ship.branch', 'no-base', branch, 'an existing base branch, or pass --base <ref>')])
  }
  if (local.ok !== remote.ok) return ok((local.ok ? local : remote).out.trim())
  const a = local.out.trim()
  const b = remote.out.trim()
  if (a === b) return ok(a)
  if (tryGit(runRoot, 'merge-base', '--is-ancestor', a, b).ok) return ok(b)
  if (tryGit(runRoot, 'merge-base', '--is-ancestor', b, a).ok) return ok(a)
  return ok(b)
}

// `-z` on both: with core.quotePath on (git's default), a non-ASCII or special path is printed
// quoted, and a quoted name is no path — the edit was invisible to the reviewed identity, the
// snapshot and the delta view alike.
export function changedFiles(runRoot: string, base: string): string[] {
  const tracked = git(runRoot, 'diff', '--name-only', '-z', base).split('\0').filter(Boolean)
  const untracked = git(runRoot, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)
  return [...new Set([...tracked, ...untracked])].sort()
}

const inCommit = (runRoot: string, ref: string, rel: string): boolean =>
  tryGit(runRoot, 'cat-file', '-e', `${ref}:${rel}`).ok

// S1-C (row 243, #86; was final review F1). verify-red sets the plan's non-test work aside while the
// red runs, and nothing of it lands on git's shared stash list: `refs/stash` is ONE list for every
// worktree of the repo, and witness's repo lock serializes only witness, so a session's own `git
// stash push` or `pop` between witness's push and drop made witness drop that session's entry or
// hand one plan's work to another checkout. The work is held instead in a stash-shaped commit built
// through scratch indexes — the real index and `refs/stash` are never written — and kept at
// `refs/witness/verify-red/<plan>` until it is back:
//   - its index commit (second parent) is HEAD with each path as the index holds it, or without it;
//   - its tree is that with each path the index tracks as the worktree holds it, or without it;
//   - its third parent, when there is one, holds the untracked paths' bytes.
// `git stash show -p` and `git stash apply` read it as a stash entry, so after a crash a human finds
// the work there as before. Nothing differing from HEAD: no commit.
function holdWork(runRoot: string, planId: string, paths: readonly string[], untracked: ReadonlySet<string>): string | undefined {
  const head = git(runRoot, 'rev-parse', '--verify', 'HEAD^{commit}')
  const headTree = git(runRoot, 'rev-parse', '--verify', `${head}^{tree}`)
  const want = new Set(paths)
  // the index's own entries for the paths, read NUL-separated and matched exactly: a name is the
  // file's, never git's quoting of it nor a directory a pathspec would also match
  const staged = new Map<string, string>()
  for (const record of git(runRoot, '--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...paths).split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) 0\t([^]*)$/.exec(record)
    if (m !== null && want.has(m[3]!)) staged.set(m[3]!, `${m[1]},${m[2]},${m[3]}`)
  }
  const tracked = paths.filter((p) => staged.has(p))
  const others = paths.filter((p) => !staged.has(p) && untracked.has(p))
  // git stash names a fallback identity for its commits; so does this one, where none is set
  const ident: Record<string, string> = tryGit(runRoot, 'var', 'GIT_AUTHOR_IDENT').ok && tryGit(runRoot, 'var', 'GIT_COMMITTER_IDENT').ok ? {}
    : { GIT_AUTHOR_NAME: 'witness', GIT_AUTHOR_EMAIL: 'witness@verify-red', GIT_COMMITTER_NAME: 'witness', GIT_COMMITTER_EMAIL: 'witness@verify-red' }
  const commit = (tree: string, parents: string[], message: string): string =>
    gitWith(runRoot, ident, 'commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message)
  const dir = mkdtempSync(join(tmpdir(), 'witness-verify-red-'))
  try {
    const scratch = (name: string): Record<string, string> => ({ GIT_INDEX_FILE: join(dir, name) })
    gitWith(runRoot, scratch('index'), 'read-tree', head)
    const entries = paths.flatMap((p) => (staged.has(p) ? ['--cacheinfo', staged.get(p)!] : []))
    if (entries.length) gitWith(runRoot, scratch('index'), 'update-index', '--add', ...entries)
    const unstaged = paths.filter((p) => !staged.has(p))
    if (unstaged.length) gitWith(runRoot, scratch('index'), 'update-index', '--force-remove', '--', ...unstaged)
    const indexTree = gitWith(runRoot, scratch('index'), 'write-tree')
    gitWith(runRoot, scratch('work'), 'read-tree', indexTree)
    if (tracked.length) gitWith(runRoot, scratch('work'), 'update-index', '--add', '--remove', '--', ...tracked)
    const workTree = gitWith(runRoot, scratch('work'), 'write-tree')
    if (indexTree === headTree && workTree === headTree && others.length === 0) return undefined
    const on = `verify-red ${planId}: the plan's non-test work, held while the red runs`
    const parents = [head, commit(indexTree, [head], `index on ${on}`)]
    if (others.length) {
      gitWith(runRoot, scratch('others'), 'update-index', '--add', '--', ...others)
      parents.push(commit(gitWith(runRoot, scratch('others'), 'write-tree'), [], `untracked files on ${on}`))
    }
    return commit(workTree, parents, `WIP on ${on}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The paths as HEAD holds them, in the index and in the worktree — what `git stash push --
// <paths>` left: HEAD's version checked out, and a path HEAD lacks taken out of the index and off
// the disk. It clears the work once it is held, and, when nothing was held, the red run's tree.
function toHead(runRoot: string, paths: readonly string[]): void {
  const inHead = new Set(paths.filter((p) => inCommit(runRoot, 'HEAD', p)))
  const absent = paths.filter((p) => !inHead.has(p))
  if (inHead.size) git(runRoot, '--literal-pathspecs', 'checkout', 'HEAD', '--', ...inHead)
  if (absent.length) git(runRoot, 'update-index', '--force-remove', '--', ...absent)
  for (const p of absent) rmSync(join(runRoot, p), { force: true })
}

// The entries a tree holds at `paths`, matched exactly, each as `--cacheinfo` takes it.
function treeEntries(runRoot: string, rev: string, paths: ReadonlySet<string>): Map<string, string> {
  const found = new Map<string, string>()
  for (const record of git(runRoot, 'ls-tree', '-r', '-z', '--full-tree', rev).split('\0')) {
    const m = /^(\d+) \w+ ([0-9a-f]+)\t([^]*)$/.exec(record)
    if (m !== null && paths.has(m[3]!)) found.set(m[3]!, `${m[1]},${m[2]},${m[3]}`)
  }
  return found
}

// The held work back exactly, path by path, over whatever the red run left there: each path's
// worktree bytes from the held tree (an untracked one's from its third parent) written through a
// scratch index, a path held in neither taken off the disk, and each index entry set as the held
// index commit has it, or removed. No merge runs, so nothing else the index stages or the worktree
// holds is touched — `git stash apply --index` resets the whole index to HEAD part way, and refuses
// whenever another path is staged.
function restoreHeld(runRoot: string, held: string, paths: readonly string[]): void {
  const want = new Set(paths)
  const index = treeEntries(runRoot, `${held}^2`, want)
  const work = treeEntries(runRoot, held, want)
  const untracked = tryGit(runRoot, 'rev-parse', '--verify', '-q', `${held}^3`).ok
    ? treeEntries(runRoot, `${held}^3`, want) : new Map<string, string>()
  const dir = mkdtempSync(join(tmpdir(), 'witness-verify-red-'))
  try {
    for (const [name, rev, entries] of [['work', held, work], ['untracked', `${held}^3`, untracked]] as const) {
      if (entries.size === 0) continue
      const scratch = { GIT_INDEX_FILE: join(dir, name) }
      gitWith(runRoot, scratch, 'read-tree', rev)
      gitWith(runRoot, scratch, 'checkout-index', '-f', '--', ...entries.keys())
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  for (const p of paths) if (!work.has(p) && !untracked.has(p)) rmSync(join(runRoot, p), { force: true })
  const entries = paths.flatMap((p) => (index.has(p) ? ['--cacheinfo', index.get(p)!] : []))
  if (entries.length) git(runRoot, 'update-index', '--add', ...entries)
  const unstaged = paths.filter((p) => !index.has(p))
  if (unstaged.length) git(runRoot, 'update-index', '--force-remove', '--', ...unstaged)
  // the entries just set carry no stat data: refreshed, plumbing reads them as unchanged
  tryGit(runRoot, 'update-index', '-q', '--refresh')
}

export async function verifyRed(
  runRoot: string, stateRoot: string, ctx: Ctx, planId: string, parentId: string, base: string, step?: string,
): Promise<Result<{ redOk: boolean; greenOk: boolean; vacuous: boolean }>> {
  // Row 191 §4.3: a reconstructed cycle closes a plan step as a witnessed one does, so both of
  // its entries name the step.
  const extra = { reconstructed: true, ...(step !== undefined ? { step } : {}) }
  const files = changedFiles(runRoot, base)
  if (!files.some(isTestPath)) {
    return refuse([v('diff', 'no-test-changes', `${files.length} changed files, none are tests`, 'a diff that adds or modifies tagged tests')])
  }
  const nonTest = files.filter((f) => !isTestPath(f))
  const untracked = new Set(git(runRoot, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))
  const trackedNonTest = nonTest.filter((f) => !untracked.has(f))

  // S1-C. The work is held in a per-plan ref, off git's shared stash list (`holdWork`), until it is
  // put back (`restoreHeld`); the ref is what keeps it recoverable after a crash. The capture runs
  // under the repo lock, as the set-aside always has.
  const held = `refs/witness/verify-red/${planId}`
  let stashed = false
  if (nonTest.length) {
    const lock = acquireLock(stateRoot)
    if (!lock.ok) return lock
    try {
      const work = holdWork(runRoot, planId, nonTest, untracked)
      if (work !== undefined) {
        git(runRoot, 'update-ref', held, work)
        stashed = true
      }
    } finally {
      lock.value()
    }
  }
  let red: Result<SpecTestRun>
  try {
    if (stashed) toHead(runRoot, nonTest)
    for (const rel of trackedNonTest) {
      if (inCommit(runRoot, base, rel)) git(runRoot, 'checkout', base, '--', rel)
      else if (existsSync(join(runRoot, rel))) rmSync(join(runRoot, rel))
    }
    red = await recordEvidence(runRoot, stateRoot, ctx, planId, parentId, 'red', extra)
  } finally {
    if (stashed) {
      restoreHeld(runRoot, held, nonTest)
      git(runRoot, 'update-ref', '-d', held)
    } else {
      toHead(runRoot, nonTest)
    }
  }
  // D148. The set-aside/checkout cycle above rewrote every non-test file on disk — the agent's
  // prior reads are stale, and witness is what made them stale. Announced rather than left
  // to the harness's "file modified since read" refusal, which names witness nowhere.
  if (nonTest.length) {
    const shown = nonTest.slice(0, 12)
    const more = nonTest.length > shown.length ? ` (+${nonTest.length - shown.length} more)` : ''
    ctx.out(kv('stale-reads',
      `${shown.join(' · ')}${more} — changed on disk during red verification — re-read before editing`))
  }
  if (!red.ok) return red
  // Final review I3. A vacuous red is a finding, not a cycle: the green still runs, since it is
  // what confirms the restore, but journals nothing. Journaled, it read as an act of the session
  // and as drive's progress, so a session that opened over the limit and only re-ran this handed
  // over forever, and drive respawned it to its cap. A step an earlier genuine red opened is
  // closed by the green `next` routes for that open red, never by this reconstruction.
  const green = red.value.allOk
    ? await runSpecTests(runRoot, ctx, parentId, stateRoot)
    : await recordEvidence(runRoot, stateRoot, ctx, planId, parentId, 'green', extra)
  if (!green.ok) return green
  return ok({ redOk: !red.value.allOk, greenOk: green.value.allOk, vacuous: red.value.allOk })
}

export function diffTags(runRoot: string, base: string): string[] {
  const tags = new Set<string>()
  for (const rel of changedFiles(runRoot, base).filter(isTestPath)) {
    let added: string
    if (inCommit(runRoot, base, rel)) {
      added = git(runRoot, 'diff', base, '--', rel)
        .split('\n')
        .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
        .join('\n')
    } else {
      const abs = join(runRoot, rel)
      added = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
    }
    for (const tag of extractCanonicalTags(added)) tags.add(tag)
  }
  return [...tags].sort()
}

// Row 97. Editing someone else's tests creates a REGRESSION obligation — those tests still
// pass — never a red→green one: `red` means "I observed this behaviour missing before I
// built it", and producing a red on a spec you do not own means deliberately breaking it and
// journaling that as evidence. Detection reads the CURRENT CONTENT of every changed test
// file rather than added lines, because the case this exists for (a shared fixture grown
// from 3 to 24 respondents breaking a `@spec:report-view` e2e) touches no tagged line at all.
export function changedTestSpecs(runRoot: string, base: string, parentId: string): string[] {
  const tags = new Set<string>()
  for (const rel of changedFiles(runRoot, base).filter(isTestPath)) {
    const abs = join(runRoot, rel)
    if (!existsSync(abs)) continue                    // deleted: no content left to owe anything
    for (const tag of extractCanonicalTags(readFileSync(abs, 'utf8'))) tags.add(tag)
  }
  tags.delete(parentId)                               // the parent's obligation is red→green
  return [...tags].sort()
}

export interface RegressionOutcome {
  spec: string
  state: 'green' | 'red' | 'unknown' | 'unrunnable'
  detail: string
  // Row 171: the command trust kept from running, when that is why this spec was unrunnable.
  untrusted?: string
}

// Never a `Result` refusal: this runs inside a gate's resolve(), and a refusal there aborts
// the whole gate — a fresh unescapable dead end, the exact class row 97 removes. Every
// runner problem (filter-matched-nothing included) degrades to a failed check carrying its
// detail, the shape `runCriteria` has always had.
//
// Nothing here journals. `journalEvidence`/`recordEvidence` are what write `test-evidence`
// entries and neither is on this path — an entry under a tag this plan does not own is
// exactly the false claim row 97 refuses to let anyone make.
export async function runRegression(
  runRoot: string, ctx: Ctx, trustRoot: string, specIds: string[], known: (id: string) => boolean,
): Promise<RegressionOutcome[]> {
  const out: RegressionOutcome[] = []
  const memo = new Map<string, Result<SpecTestRun>>()
  const runnable = specIds.filter(known)
  let suite: TestOutcome[] | undefined
  const cfg = loadConfig(runRoot)
  const rc = cfg.ok ? runnerConfig(cfg.value) : undefined
  if (rc?.ok && rc.value.mode === 'full-suite' && runnable.length > 0) {
    const first = await runFullSuite(runRoot, ctx, rc.value, trustRoot)
    if (first.ok) suite = first.value.tests           // one suite run for every spec below
  }
  for (const id of specIds) {
    if (!known(id)) {
      out.push({ spec: id, state: 'unknown', detail: 'no such spec in canon — reported, not run' })
      continue
    }
    let run = memo.get(id)
    if (run === undefined) {
      run = await runSpecTests(runRoot, ctx, id, trustRoot, { suite })
      memo.set(id, run)
    }
    if (!run.ok) {
      const blocked = untrustedOf(run.violations)
      out.push({ spec: id, state: 'unrunnable', detail: run.violations.map((x) => x.rule).join(' · '),
        ...(blocked !== undefined ? { untrusted: blocked } : {}) })
      continue
    }
    const failed = run.value.tests.filter((t) => !t.ok).length
    out.push({
      spec: id, state: run.value.allOk ? 'green' : 'red',
      detail: `${run.value.tests.length} tagged · ${failed} failed`,
    })
  }
  return out
}

export interface EvidenceRequirement {
  tag: string
  red: boolean
  green: boolean
  vacuous: boolean
  // Row 241 (R10). The tag's latest red is an already-present one: verify-red set the plan's change
  // aside and the test still passed, so the behavior is on the base. It stands for the red once a
  // passing green follows it; `presentStep` is the step it named, when it named one.
  present?: true
  presentStep?: string
}

export interface EvidenceReport {
  plan: string
  base: string
  required: EvidenceRequirement[]
  satisfied: boolean
}

export function evidenceForDiff(runRoot: string, stateRoot: string, plan: CanonDoc, base: string): EvidenceReport {
  const planId = String(plan.meta.id)
  const parentId = String(plan.meta.parent)
  const entries = readStream(stateRoot, planId).filter((e) => e.t === 'test-evidence')
  const matching = (e: (typeof entries)[number], tag: string): Array<{ name: string; ok: boolean }> =>
    (Array.isArray(e.tests) ? (e.tests as Array<{ name: string; ok: boolean }>) : []).filter((t) => matchesTag(t.name, tag))
  // Row 97: red→green is a claim about the NEW BEHAVIOUR THIS PLAN BUILDS, so the only tag
  // it can be made for is the plan's own parent — `test-evidence` interpolates
  // `plan.meta.parent` and nothing else, which is why a foreign tag here was unsatisfiable
  // AND (before row 93) unwaivable. Every other spec the diff's tests touched is a
  // regression obligation, checked by `runRegression` at the gate.
  const required = diffTags(runRoot, base).filter((tag) => tag === parentId).map((tag) => {
    // latest-cycle semantics: the newest red matching the tag is the verdict on
    // "was failure observed"; a green only counts if it post-dates that red.
    // One early vacuous red must not poison the tag forever (append-only journal).
    let lastRedIdx = -1
    let lastGreenIdx = -1
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      if (matching(e, tag).length === 0) continue
      if (e.phase === 'red') lastRedIdx = i
      else if (e.phase === 'green') lastGreenIdx = i
    }
    const lastRed = lastRedIdx >= 0 ? entries[lastRedIdx]! : undefined
    const lastGreen = lastGreenIdx >= 0 ? entries[lastGreenIdx]! : undefined
    // Row 241 (R10): a reconstructed red that came back vacuous ran with the change set aside —
    // the behavior is already present — unlike a plain vacuous red, which cannot tell that from a
    // test that asserts nothing. The reviewers judge which it is (the gate's note).
    // Final review: it closes a step, so it names one — a fix round's reconstructed red names none.
    const present = lastRed?.vacuous === true && lastRed.reconstructed === true && typeof lastRed.step === 'string'
    return {
      tag,
      red: present || (lastRed !== undefined && matching(lastRed, tag).some((t) => !t.ok)),
      green: lastGreen !== undefined && lastGreenIdx > lastRedIdx &&
        matching(lastGreen, tag).every((t) => t.ok),
      vacuous: lastRed?.vacuous === true && !present,
      ...(present ? { present: true as const, ...(typeof lastRed.step === 'string' ? { presentStep: lastRed.step } : {}) } : {}),
    }
  })
  return {
    plan: planId,
    base,
    required,
    satisfied: required.every((r) => r.red && r.green && !r.vacuous),
  }
}
