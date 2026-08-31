import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffBase, diffTags, evidenceForDiff } from '../src/evidence.js'
import { loadConfig } from '../src/config.js'
import { findById, loadCanon } from '../src/scan.js'
import type { TestRepo } from './helpers.js'
import {
  TOKEN_BROKEN, TOKEN_FIXED, TOKEN_TESTS_TAGGED, TOKEN_TESTS_UNTAGGED,
  addOrigin, copyFixture, fixtureEnv, seededRepo, singleConfig, stampLive, writePlan, writeSpec,
} from './helpers.js'

async function tddRepo(): Promise<{ repo: TestRepo; base: string }> {
  const repo = await seededRepo()
  copyFixture(repo, 'vitest-single')
  repo.write('witness.config.yaml', singleConfig('filtered'))
  await writeSpec(repo, 'auth-refresh')
  stampLive(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  repo.write('src/token.ts', TOKEN_BROKEN)
  repo.write('tests/token.test.ts', TOKEN_TESTS_UNTAGGED)
  repo.git('add', '-A')
  repo.git('commit', '-m', 'base')
  const base = repo.git('rev-parse', 'HEAD').trim()
  return { repo, base }
}

const plan = (repo: TestRepo) => {
  const doc = findById(loadCanon(repo.root), 'auth-refresh-plan-1')
  if (!doc) throw new Error('plan missing')
  return doc
}

describe('diffTags', () => {
  it('extracts tags from added lines in committed and untracked test files', async () => {
    const { repo, base } = await tddRepo()
    repo.write('tests/token.test.ts', TOKEN_TESTS_TAGGED)
    repo.git('add', 'tests/token.test.ts')
    repo.git('commit', '-m', 'tagged tests')
    repo.write('tests/extra.test.ts', 'it("edge case @spec:quota", () => {})\n')
    expect(diffTags(repo.root, base).sort()).toEqual(['auth-refresh', 'quota'])
  })

  it('ignores tags in non-test files and in unchanged tests', async () => {
    const { repo, base } = await tddRepo()
    repo.write('src/notes.ts', '// @spec:auth-refresh mentioned in impl comment\n')
    repo.git('add', 'src/notes.ts')
    repo.git('commit', '-m', 'impl comment')
    expect(diffTags(repo.root, base)).toEqual([])
  })
})

describe('evidenceForDiff', () => {
  it('is satisfied by a recorded red/green pair', async () => {
    const { repo, base } = await tddRepo()
    repo.write('tests/token.test.ts', TOKEN_TESTS_TAGGED)
    repo.git('add', '-A')
    repo.git('commit', '-m', 'tagged tests (impl still broken)')
    await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red'], { env: fixtureEnv() })
    repo.write('src/token.ts', TOKEN_FIXED)
    repo.git('add', 'src/token.ts')
    repo.git('commit', '-m', 'implement')
    await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'green'], { env: fixtureEnv() })
    const report = evidenceForDiff(repo.root, repo.root, plan(repo), base)
    expect(report.required).toEqual([{ tag: 'auth-refresh', red: true, green: true, vacuous: false }])
    expect(report.satisfied).toBe(true)
  })

  it('is unsatisfied while the green half is missing', async () => {
    const { repo, base } = await tddRepo()
    repo.write('tests/token.test.ts', TOKEN_TESTS_TAGGED)
    repo.git('add', '-A')
    repo.git('commit', '-m', 'tagged tests')
    await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red'], { env: fixtureEnv() })
    const report = evidenceForDiff(repo.root, repo.root, plan(repo), base)
    expect(report.satisfied).toBe(false)
    expect(report.required[0]).toMatchObject({ red: true, green: false })
  })

  it('a vacuous red poisons the requirement even with green present', async () => {
    const { repo, base } = await tddRepo()
    repo.write('src/token.ts', TOKEN_FIXED)
    repo.write('tests/token.test.ts', TOKEN_TESTS_TAGGED)
    repo.git('add', '-A')
    repo.git('commit', '-m', 'both at once — no honest red possible')
    await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red'], { env: fixtureEnv() })
    await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'green'], { env: fixtureEnv() })
    const report = evidenceForDiff(repo.root, repo.root, plan(repo), base)
    expect(report.required[0]).toMatchObject({ vacuous: true })
    expect(report.satisfied).toBe(false)
  })

  it('a later genuine red supersedes an earlier vacuous one', async () => {
    const { repo, base } = await tddRepo()
    // vacuous first: impl + tagged tests land together, red run passes
    repo.write('src/token.ts', TOKEN_FIXED)
    repo.write('tests/token.test.ts', TOKEN_TESTS_TAGGED)
    repo.git('add', '-A')
    repo.git('commit', '-m', 'both at once')
    await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red'], { env: fixtureEnv() })
    // then an honest cycle: break impl, observe red, fix, observe green
    repo.write('src/token.ts', TOKEN_BROKEN)
    repo.git('add', 'src/token.ts')
    repo.git('commit', '-m', 'break')
    await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red'], { env: fixtureEnv() })
    repo.write('src/token.ts', TOKEN_FIXED)
    repo.git('add', 'src/token.ts')
    repo.git('commit', '-m', 'fix')
    await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'green'], { env: fixtureEnv() })
    const report = evidenceForDiff(repo.root, repo.root, plan(repo), base)
    expect(report.required).toEqual([{ tag: 'auth-refresh', red: true, green: true, vacuous: false }])
    expect(report.satisfied).toBe(true)
  })

  it('green recorded before the latest red does not satisfy', async () => {
    const { repo, base } = await tddRepo()
    repo.write('tests/token.test.ts', TOKEN_TESTS_TAGGED)
    repo.write('src/token.ts', TOKEN_FIXED)
    repo.git('add', '-A')
    repo.git('commit', '-m', 'tagged tests + impl')
    await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'green'], { env: fixtureEnv() })
    repo.write('src/token.ts', TOKEN_BROKEN)
    repo.git('add', 'src/token.ts')
    repo.git('commit', '-m', 'break')
    await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red'], { env: fixtureEnv() })
    const report = evidenceForDiff(repo.root, repo.root, plan(repo), base)
    expect(report.satisfied).toBe(false)
    expect(report.required[0]).toMatchObject({ red: true, green: false })
  })

  // Row 97: a foreign tag's obligation is the OPPOSITE claim — those tests still pass — and
  // it lives in the gate's `regression` check. `test-evidence` structurally cannot record a
  // red→green pair for it: it interpolates `plan.meta.parent` and nothing else.
  it('ignores a foreign tag — the parent pair is the only red→green obligation', async () => {
    const { repo, base } = await tddRepo()
    repo.write('tests/token.test.ts', TOKEN_TESTS_TAGGED)
    // a REAL vitest file: the bare-`it` form used in the diffTags tests above never runs,
    // but this one does — it would fail collection and take the green phase down with it
    repo.write('tests/extra.test.ts',
      "import { expect, it } from 'vitest'\n\nit('edge case @spec:quota', () => { expect(1).toBe(1) })\n")
    repo.git('add', '-A')
    repo.git('commit', '-m', 'tagged tests + a foreign tag')
    await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red'], { env: fixtureEnv() })
    repo.write('src/token.ts', TOKEN_FIXED)
    repo.git('add', 'src/token.ts')
    repo.git('commit', '-m', 'implement')
    await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'green'], { env: fixtureEnv() })

    expect(diffTags(repo.root, base).sort()).toEqual(['auth-refresh', 'quota'])   // detection unchanged
    const report = evidenceForDiff(repo.root, repo.root, plan(repo), base)
    expect(report.required.map((r) => r.tag)).toEqual(['auth-refresh'])
    expect(report.satisfied).toBe(true)
  })

  it('an untouched-tests diff needs no evidence — trivially satisfied', async () => {
    const { repo, base } = await tddRepo()
    repo.write('src/token.ts', TOKEN_FIXED)
    repo.git('add', 'src/token.ts')
    repo.git('commit', '-m', 'impl-only refactor')
    const report = evidenceForDiff(repo.root, repo.root, plan(repo), base)
    expect(report.required).toEqual([])
    expect(report.satisfied).toBe(true)
  })
})

// D142. The true cut point is the DESCENDANT of merge-base(HEAD, <branch>) and
// merge-base(HEAD, origin/<branch>) — one rule for all seven callers. Origin alone was
// refuted by experiment in the triage: a legacy branch cut from a state-carrying local
// main would diff its inherited .witness/journal/* against the origin merge-base, so
// reviewers would judge state files as the plan's change.
describe('diffBase resolves the true cut point (D142)', () => {
  const cfgOf = (root: string) => {
    const c = loadConfig(root)
    if (!c.ok) throw new Error('config unreadable')
    return c.value
  }

  it('a legacy contaminated branch keeps the LOCAL cut point, so state files stay out of the diff', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    addOrigin(repo)
    repo.git('commit', '--allow-empty', '-m', 'state-ahead')       // local main ahead of origin
    repo.git('branch', 'witness/legacy-plan', 'main')              // legacy cut, carries the state commit

    // origin advances independently (stand-in for the squash-merge of the same content)
    const clone = mkdtempSync(join(tmpdir(), 'd142-'))
    execFileSync('git', ['clone', `${repo.root}-origin.git`, clone], { stdio: 'ignore' })
    for (const [k, v] of [['user.name', 'test'], ['user.email', 't@e.c'], ['commit.gpgsign', 'false']]) {
      execFileSync('git', ['-C', clone, 'config', k!, v!])
    }
    execFileSync('git', ['-C', clone, 'commit', '--allow-empty', '-m', 'squash-stand-in'], { stdio: 'ignore' })
    execFileSync('git', ['-C', clone, 'push', 'origin', 'main'], { stdio: 'ignore' })
    repo.git('fetch', 'origin', 'main')

    const wt = join(mkdtempSync(join(tmpdir(), 'd142-wt-')), 'legacy')
    repo.git('worktree', 'add', wt, 'witness/legacy-plan')

    const b = diffBase(wt, cfgOf(repo.root))

    expect(b.ok).toBe(true)
    if (!b.ok) throw new Error('no base')
    expect(b.value).toBe(repo.git('merge-base', 'witness/legacy-plan', 'main'))
    expect(b.value).not.toBe(repo.git('merge-base', 'witness/legacy-plan', 'origin/main'))
    repo.git('worktree', 'remove', '--force', wt)
  })

  it('a post-D137 clean cut takes the origin base, which is the later of the two', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    addOrigin(repo)
    const clone = mkdtempSync(join(tmpdir(), 'd142b-'))
    execFileSync('git', ['clone', `${repo.root}-origin.git`, clone], { stdio: 'ignore' })
    for (const [k, v] of [['user.name', 'test'], ['user.email', 't@e.c'], ['commit.gpgsign', 'false']]) {
      execFileSync('git', ['-C', clone, 'config', k!, v!])
    }
    execFileSync('git', ['-C', clone, 'commit', '--allow-empty', '-m', 'origin-ahead'], { stdio: 'ignore' })
    execFileSync('git', ['-C', clone, 'push', 'origin', 'main'], { stdio: 'ignore' })
    repo.git('fetch', 'origin', 'main')
    repo.git('branch', 'witness/clean-plan', 'origin/main')        // D137's cut

    const wt = join(mkdtempSync(join(tmpdir(), 'd142b-wt-')), 'clean')
    repo.git('worktree', 'add', wt, 'witness/clean-plan')

    const b = diffBase(wt, cfgOf(repo.root))

    expect(b.ok).toBe(true)
    if (!b.ok) throw new Error('no base')
    expect(b.value).toBe(repo.git('rev-parse', 'origin/main'))
    repo.git('worktree', 'remove', '--force', wt)
  })

  it('falls back to the local half alone when no remote exists', async () => {
    const { repo } = await tddRepo()

    const b = diffBase(repo.root, cfgOf(repo.root))

    expect(b.ok).toBe(true)
    if (!b.ok) throw new Error('no base')
    expect(b.value).toBe(repo.git('merge-base', 'HEAD', 'main'))
  })
})
