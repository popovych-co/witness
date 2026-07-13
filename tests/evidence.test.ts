import { describe, expect, it } from 'vitest'
import { main } from '../src/cli.js'
import { isTestPath } from '../src/evidence.js'
import { readStream } from '../src/journal.js'
import type { TestRepo } from './helpers.js'
import {
  breakSingleFixture, copyFixture, fakeCtx, fixSingleFixture, fixtureEnv, seededRepo,
  singleConfig, stampLive, writePlan, writeSpec,
} from './helpers.js'

async function planRepo(): Promise<TestRepo> {
  const repo = await seededRepo()
  copyFixture(repo, 'vitest-single')
  repo.write('specflow.config.yaml', singleConfig('filtered'))
  await writeSpec(repo, 'auth-refresh')
  stampLive(repo, 'auth-refresh')
  const res = await writePlan(repo, 'auth-refresh-plan-1')
  if (res.code !== 0) throw new Error(`plan write failed: ${res.stderr}`)
  return repo
}

describe('isTestPath', () => {
  it('classifies by .test./.spec. and test-dir segments', () => {
    expect(isTestPath('src/token.test.ts')).toBe(true)
    expect(isTestPath('src/token.spec.js')).toBe(true)
    expect(isTestPath('tests/token.ts')).toBe(true)
    expect(isTestPath('pkg/__tests__/x.py')).toBe(true)
    expect(isTestPath('src/token.ts')).toBe(false)
    expect(isTestPath('contest/entry.ts')).toBe(false)
  })
})

describe('specflow test-evidence', () => {
  it('records a red/green pair across the TDD loop', async () => {
    const repo = await planRepo()
    breakSingleFixture(repo)
    const red = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red'], { env: fixtureEnv() })
    expect(red.code).toBe(0)
    fixSingleFixture(repo)
    const green = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'green'], { env: fixtureEnv() })
    expect(green.code).toBe(0)
    const entries = readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'test-evidence')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ phase: 'red', runner: 'filtered' })
    expect((entries[0]?.tests as Array<{ ok: boolean }>)[0]?.ok).toBe(false)
    expect((entries[1]?.tests as Array<{ ok: boolean }>)[0]?.ok).toBe(true)
  })

  it('flags a passing red phase as vacuous and exits 1', async () => {
    const repo = await planRepo()
    const res = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red'], { env: fixtureEnv() })
    expect(res.code).toBe(1)
    const entry = readStream(repo.root, 'auth-refresh-plan-1').at(-1)
    expect(entry).toMatchObject({ phase: 'red', vacuous: true })
  })

  it('exits 1 when the green phase is not green — evidence still recorded', async () => {
    const repo = await planRepo()
    breakSingleFixture(repo)
    const res = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'green'], { env: fixtureEnv() })
    expect(res.code).toBe(1)
    expect(readStream(repo.root, 'auth-refresh-plan-1').at(-1)?.phase).toBe('green')
  })

  it('refuses an unknown plan or a bad phase', async () => {
    const repo = await planRepo()
    expect((await repo.cli(['test-evidence', 'nope', '--phase', 'red'], { env: fixtureEnv() })).code).toBe(2)
    expect((await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'purple'], { env: fixtureEnv() })).code).toBe(2)
  })

  it('routes the journal append main-side when run from a linked worktree', async () => {
    const repo = await planRepo()
    breakSingleFixture(repo)
    const wt = `${repo.root}-wt`
    repo.git('worktree', 'add', wt, '-b', 'wt-evidence')
    const code = await main(fakeCtx(wt, { env: fixtureEnv() }), ['test-evidence', 'auth-refresh-plan-1', '--phase', 'red'])
    expect(code).toBe(0)
    const entries = readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'test-evidence')
    expect(entries).toHaveLength(1)
    repo.git('worktree', 'remove', '--force', wt)
  })
})
