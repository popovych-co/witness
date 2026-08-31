import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { loadConfig } from './config.js'
import { entryLine, appendEntry, journalRel, readStream } from './journal.js'
import { mergeReports, reportFiles, type TestOutcome } from './junit.js'
import { extractCanonicalTags, matchesTag } from './matcher.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { runFiltered, runFullSuite, runnerConfig } from './runner.js'
import { git, stateCommit, tryGit } from './gitio.js'
import type { CanonDoc } from './scan.js'
import { kv } from './toon.js'
import { withTxn } from './txn.js'

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

export function journalEvidence(
  stateRoot: string, planId: string, phase: 'red' | 'green', run: SpecTestRun,
  extra: { reconstructed?: boolean; vacuous?: boolean; captures?: Capture[] } = {},
): Result<{ sha: string }> {
  const entry = { t: 'test-evidence' as const, artifact: planId, phase, runner: run.runner, tests: run.tests, ...extra }
  const marker = {
    op: `test-evidence(${planId}): ${phase}`,
    files: [journalRel(planId)],
    journalMulti: [{ stream: planId, line: entryLine(entry) }],
  }
  return withTxn(stateRoot, marker, () => {
    appendEntry(stateRoot, planId, entry)
    return stateCommit(stateRoot, marker.files, marker.op)
  })
}

export async function recordEvidence(
  runRoot: string, stateRoot: string, ctx: Ctx, planId: string, parentId: string,
  phase: 'red' | 'green', extra: { reconstructed?: boolean } = {},
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
  const ship = (cfg.raw.ship ?? {}) as Record<string, unknown>
  const branch = typeof ship.branch === 'string' ? ship.branch : 'main'
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

export function changedFiles(runRoot: string, base: string): string[] {
  const tracked = git(runRoot, 'diff', '--name-only', base).split('\n').filter(Boolean)
  const untracked = git(runRoot, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean)
  return [...new Set([...tracked, ...untracked])].sort()
}

const inCommit = (runRoot: string, ref: string, rel: string): boolean =>
  tryGit(runRoot, 'cat-file', '-e', `${ref}:${rel}`).ok

export async function verifyRed(
  runRoot: string, stateRoot: string, ctx: Ctx, planId: string, parentId: string, base: string,
): Promise<Result<{ redOk: boolean; greenOk: boolean; vacuous: boolean }>> {
  const files = changedFiles(runRoot, base)
  if (!files.some(isTestPath)) {
    return refuse([v('diff', 'no-test-changes', `${files.length} changed files, none are tests`, 'a diff that adds or modifies tagged tests')])
  }
  const nonTest = files.filter((f) => !isTestPath(f))
  const untracked = new Set(git(runRoot, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean))
  const trackedNonTest = nonTest.filter((f) => !untracked.has(f))

  let stashed = false
  if (nonTest.length) {
    const before = git(runRoot, 'stash', 'list').split('\n').filter(Boolean).length
    git(runRoot, 'stash', 'push', '--include-untracked', '--', ...nonTest)
    stashed = git(runRoot, 'stash', 'list').split('\n').filter(Boolean).length > before
  }
  let red: Result<SpecTestRun>
  try {
    for (const rel of trackedNonTest) {
      if (inCommit(runRoot, base, rel)) git(runRoot, 'checkout', base, '--', rel)
      else if (existsSync(join(runRoot, rel))) rmSync(join(runRoot, rel))
    }
    red = await recordEvidence(runRoot, stateRoot, ctx, planId, parentId, 'red', { reconstructed: true })
  } finally {
    for (const rel of trackedNonTest) {
      if (inCommit(runRoot, 'HEAD', rel)) git(runRoot, 'checkout', 'HEAD', '--', rel)
    }
    if (stashed) git(runRoot, 'stash', 'pop')
  }
  // D148. The stash/checkout cycle above rewrote every non-test file on disk — the agent's
  // prior reads are stale, and witness is what made them stale. Announced rather than left
  // to the harness's "file modified since read" refusal, which names witness nowhere.
  if (nonTest.length) {
    const shown = nonTest.slice(0, 12)
    const more = nonTest.length > shown.length ? ` (+${nonTest.length - shown.length} more)` : ''
    ctx.out(kv('stale-reads',
      `${shown.join(' · ')}${more} — changed on disk during red verification — re-read before editing`))
  }
  if (!red.ok) return red
  const green = await recordEvidence(runRoot, stateRoot, ctx, planId, parentId, 'green', { reconstructed: true })
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
      out.push({ spec: id, state: 'unrunnable', detail: run.violations.map((x) => x.rule).join(' · ') })
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
    return {
      tag,
      red: lastRed !== undefined && matching(lastRed, tag).some((t) => !t.ok),
      green: lastGreen !== undefined && lastGreenIdx > lastRedIdx &&
        matching(lastGreen, tag).every((t) => t.ok),
      vacuous: lastRed?.vacuous === true,
    }
  })
  return {
    plan: planId,
    base,
    required,
    satisfied: required.every((r) => r.red && r.green && !r.vacuous),
  }
}
