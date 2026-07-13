import { describe, expect, it } from 'vitest'
import { diffTags, evidenceForDiff } from '../src/evidence.js'
import { findById, loadCanon } from '../src/scan.js'
import type { TestRepo } from './helpers.js'
import {
  TOKEN_BROKEN, TOKEN_FIXED, TOKEN_TESTS_TAGGED, TOKEN_TESTS_UNTAGGED,
  copyFixture, fixtureEnv, seededRepo, singleConfig, stampLive, writePlan, writeSpec,
} from './helpers.js'

async function tddRepo(): Promise<{ repo: TestRepo; base: string }> {
  const repo = await seededRepo()
  copyFixture(repo, 'vitest-single')
  repo.write('specflow.config.yaml', singleConfig('filtered'))
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
