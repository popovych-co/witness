import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import type { TestRepo } from './helpers.js'
import {
  TOKEN_BROKEN, TOKEN_FIXED, TOKEN_TESTS_TAGGED, TOKEN_TESTS_UNTAGGED,
  copyFixture, fixtureEnv, seededRepo, singleConfig, stampLive, writePlan, writeSpec,
} from './helpers.js'

// base commit: broken behavior, no tagged tests; branch: tagged tests + fix — the TDD diff
async function tddRepo(): Promise<TestRepo> {
  const repo = await seededRepo()
  copyFixture(repo, 'vitest-single')
  repo.write('witness.config.yaml', singleConfig('filtered'))
  await writeSpec(repo, 'auth-refresh')
  stampLive(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  repo.write('src/token.ts', TOKEN_BROKEN)
  repo.write('tests/token.test.ts', TOKEN_TESTS_UNTAGGED)
  repo.git('add', '-A')
  repo.git('commit', '-m', 'base: rotation not built yet')
  repo.git('checkout', '-b', 'plan-wt')
  repo.git('branch', '-f', 'main')
  return repo
}

const phases = (repo: TestRepo): Array<Record<string, unknown>> =>
  readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'test-evidence') as Array<Record<string, unknown>>

describe('witness verify-red', () => {
  it('reconstructs red from committed work, restores, and confirms green', async () => {
    const repo = await tddRepo()
    repo.write('tests/token.test.ts', TOKEN_TESTS_TAGGED)
    repo.write('src/token.ts', TOKEN_FIXED)
    repo.git('add', '-A')
    repo.git('commit', '-m', 'implement rotation')
    const res = await repo.cli(['verify-red', 'auth-refresh-plan-1'], { env: fixtureEnv() })
    expect(res.code).toBe(0)
    const entries = phases(repo)
    expect(entries.map((e) => e.phase)).toEqual(['red', 'green'])
    expect(entries.every((e) => e.reconstructed === true)).toBe(true)
    expect((entries[0]?.tests as Array<{ ok: boolean }>)[0]?.ok).toBe(false)
    expect((entries[1]?.tests as Array<{ ok: boolean }>)[0]?.ok).toBe(true)
    expect(repo.read('src/token.ts')).toBe(TOKEN_FIXED)
    expect(repo.git('status', '--porcelain').trim()).toBe('')
  })

  it('restores uncommitted implementation work via stash', async () => {
    const repo = await tddRepo()
    repo.write('tests/token.test.ts', TOKEN_TESTS_TAGGED)
    repo.git('add', 'tests/token.test.ts')
    repo.git('commit', '-m', 'tagged tests')
    repo.write('src/token.ts', TOKEN_FIXED) // dirty, never committed
    const res = await repo.cli(['verify-red', 'auth-refresh-plan-1'], { env: fixtureEnv() })
    expect(res.code).toBe(0)
    expect(repo.read('src/token.ts')).toBe(TOKEN_FIXED)
    expect(phases(repo).map((e) => e.phase)).toEqual(['red', 'green'])
  })

  it('stops on a vacuous test — green against base', async () => {
    const repo = await tddRepo()
    repo.write('src/token.ts', TOKEN_FIXED)
    repo.git('add', 'src/token.ts')
    repo.git('commit', '-m', 'behavior already exists on this branch')
    repo.git('branch', '-f', 'main') // base now includes the behavior
    repo.write('tests/token.test.ts', TOKEN_TESTS_TAGGED)
    repo.git('add', 'tests/token.test.ts')
    repo.git('commit', '-m', 'test asserting existing behavior')
    const res = await repo.cli(['verify-red', 'auth-refresh-plan-1'], { env: fixtureEnv() })
    expect(res.code).toBe(1)
    const red = phases(repo).find((e) => e.phase === 'red')
    expect(red?.vacuous).toBe(true)
  })

  it('refuses when the diff touches no test files', async () => {
    const repo = await tddRepo()
    repo.write('src/token.ts', TOKEN_FIXED)
    repo.git('add', '-A')
    repo.git('commit', '-m', 'impl only')
    const res = await repo.cli(['verify-red', 'auth-refresh-plan-1'], { env: fixtureEnv() })
    expect(res.code).toBe(2)
  })

  it('honors --base over ship.branch', async () => {
    const repo = await tddRepo()
    const base = repo.git('rev-parse', 'HEAD').trim()
    repo.write('tests/token.test.ts', TOKEN_TESTS_TAGGED)
    repo.write('src/token.ts', TOKEN_FIXED)
    repo.git('add', '-A')
    repo.git('commit', '-m', 'implement rotation')
    const res = await repo.cli(['verify-red', 'auth-refresh-plan-1', '--base', base], { env: fixtureEnv() })
    expect(res.code).toBe(0)
  })
})
