import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { loadConfig } from './config.js'
import { entryLine, appendEntry, journalRel, readStream } from './journal.js'
import { extractCanonicalTags, matchesTag } from './matcher.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { runFiltered, runFullSuite, runnerConfig } from './runner.js'
import { git, stateCommit, tryGit } from './gitio.js'
import type { CanonDoc } from './scan.js'
import { withTxn } from './txn.js'

export function isTestPath(rel: string): boolean {
  if (/\.(test|spec)\./.test(rel)) return true
  return rel.split('/').some((seg) => seg === 'test' || seg === 'tests' || seg === '__tests__')
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
): Promise<Result<SpecTestRun>> {
  const cfg = loadConfig(runRoot)
  if (!cfg.ok) return cfg
  const rcRes = runnerConfig(cfg.value)
  if (!rcRes.ok) return rcRes
  const rc = rcRes.value
  if (rc.mode === 'filtered') {
    const run = await runFiltered(runRoot, ctx, rc.template, parentId, trustRoot)
    if (!run.ok) return run
    const tests = [{ name: `@spec:${parentId}`, ok: run.value.exitZero }]
    return ok({ runner: 'filtered', tests, allOk: run.value.exitZero })
  }
  const suite = await runFullSuite(runRoot, ctx, rc, trustRoot)
  if (!suite.ok) return suite
  const tests = suite.value.tests
    .filter((t) => matchesTag(t.name, parentId))
    .map((t) => ({ name: t.name, ok: t.status === 'passed' }))
  return ok({ runner: 'full-suite', tests, allOk: tests.length > 0 && tests.every((t) => t.ok) })
}

export function journalEvidence(
  stateRoot: string, planId: string, phase: 'red' | 'green', run: SpecTestRun,
  extra: { reconstructed?: boolean; vacuous?: boolean } = {},
): Result<{ sha: string }> {
  const entry = { t: 'test-evidence' as const, artifact: planId, phase, runner: run.runner, tests: run.tests, ...extra }
  const marker = {
    op: `test-evidence(${planId}): ${phase}`,
    files: [journalRel(planId)],
    journalMulti: [{ stream: journalRel(planId), line: entryLine(entry) }],
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
  const run = await runSpecTests(runRoot, ctx, parentId, stateRoot)
  if (!run.ok) return run
  const vacuous = phase === 'red' && run.value.allOk ? { vacuous: true } : {}
  const committed = journalEvidence(stateRoot, planId, phase, run.value, { ...extra, ...vacuous })
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
  const res = tryGit(runRoot, 'merge-base', 'HEAD', branch)
  if (!res.ok) return refuse([v('ship.branch', 'no-base', branch, 'an existing base branch, or pass --base <ref>')])
  return ok(res.out.trim())
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
  const entries = readStream(stateRoot, planId).filter((e) => e.t === 'test-evidence')
  const matching = (e: (typeof entries)[number], tag: string): Array<{ name: string; ok: boolean }> =>
    (Array.isArray(e.tests) ? (e.tests as Array<{ name: string; ok: boolean }>) : []).filter((t) => matchesTag(t.name, tag))
  const required = diffTags(runRoot, base).map((tag) => ({
    tag,
    red: entries.some((e) => e.phase === 'red' && matching(e, tag).some((t) => !t.ok)),
    green: entries.some((e) => e.phase === 'green' && matching(e, tag).some((t) => t.ok)),
    vacuous: entries.some((e) => e.phase === 'red' && e.vacuous === true && matching(e, tag).length > 0),
  }))
  return {
    plan: planId,
    base,
    required,
    satisfied: required.every((r) => r.red && r.green && !r.vacuous),
  }
}
