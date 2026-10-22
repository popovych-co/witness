import { describe, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { worktreePath } from '../src/worktree.js'
import { readStream } from '../src/journal.js'
import type { TestRepo } from './helpers.js'
import { approve as approveDoc, seededRepo as seeded, writePlan as plan, writeSpec as spec } from './helpers.js'
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

  // D148. The stash/checkout cycle above rewrote every non-test file on disk, so the
  // agent's prior reads are stale and witness is what made them stale. Say so.
  it('names the files it churned so the agent re-reads them', async () => {
    const repo = await tddRepo()
    repo.write('tests/token.test.ts', TOKEN_TESTS_TAGGED)
    repo.write('src/token.ts', TOKEN_FIXED)
    repo.git('add', '-A')
    repo.git('commit', '-m', 'implement rotation')

    const res = await repo.cli(['verify-red', 'auth-refresh-plan-1'], { env: fixtureEnv() })

    expect(res.code).toBe(0)
    expect(res.stdout).toMatch(/^stale-reads: .*src\/token\.ts/m)
    expect(res.stdout).toContain('changed on disk during red verification — re-read before editing')
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

  // Row 191 §4.3. A reconstructed cycle closes a plan step like a witnessed one, so both of
  // its entries name the step.
  it('carries the step on both entries', async () => {
    const repo = await tddRepo()
    repo.write('tests/token.test.ts', TOKEN_TESTS_TAGGED)
    repo.write('src/token.ts', TOKEN_FIXED)
    repo.git('add', '-A')
    repo.git('commit', '-m', 'implement rotation')
    const res = await repo.cli(['verify-red', 'auth-refresh-plan-1', '--step', 's1'], { env: fixtureEnv() })
    expect(res.code).toBe(0)
    expect(phases(repo)).toMatchObject([
      { phase: 'red', reconstructed: true, step: 's1' },
      { phase: 'green', reconstructed: true, step: 's1' },
    ])
  })

  // Refused before the stash/checkout cycle: a mistyped step must not churn the tree.
  it('refuses an unknown step before touching the tree', async () => {
    const repo = await tddRepo()
    repo.write('tests/token.test.ts', TOKEN_TESTS_TAGGED)
    repo.git('add', 'tests/token.test.ts')
    repo.git('commit', '-m', 'tagged tests')
    repo.write('src/token.ts', TOKEN_FIXED) // dirty, never committed
    const res = await repo.cli(['verify-red', 'auth-refresh-plan-1', '--step', 'nope'], { env: fixtureEnv() })
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('unknown-step')
    expect(res.stdout).not.toContain('stale-reads')
    expect(repo.read('src/token.ts')).toBe(TOKEN_FIXED)
    expect(phases(repo)).toEqual([])
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

// Final review F1. `refs/stash` is ONE stack for every worktree of a repo: A pushes, B pushes,
// A's pop takes B's work. B starts while A's red run holds the runner turn, so B's push lands
// between A's push and A's pop every time.
describe('verify-red in two worktrees at once (B3)', () => {
  const REPO = resolve(import.meta.dirname, '..')
  const child = (cwd: string, id: string): Promise<number | null> => new Promise((done) => {
    const c = spawn(join(REPO, 'node_modules', '.bin', 'tsx'), [join(REPO, 'src', 'bin.ts'), 'verify-red', id, '--base', 'HEAD'],
      { cwd, env: fixtureEnv() as NodeJS.ProcessEnv, stdio: 'ignore' })
    c.on('close', (code) => done(code))
  })
  it('each worktree keeps its own uncommitted implementation', async () => {
    const repo = await seeded()
    for (const s of ['a', 'b']) {
      await spec(repo, s, { criteria: [{ id: `ac-${s}`, test: `@spec:${s}` }] })
      approveDoc(repo, s)
      await plan(repo, `${s}-plan-1`, { parent: s, steps: [{ id: 's1', title: s, criteria: [`ac-${s}`] }] })
      approveDoc(repo, `${s}-plan-1`)
      await repo.cli(['start', `${s}-plan-1`])
    }
    const wts = ['a', 'b'].map((s) => worktreePath(repo.root, `${s}-plan-1`))
    for (const [i, wt] of wts.entries()) {
      const s = ['a', 'b'][i]!
      writeFileSync(join(wt, 'turn.sh'), 'sleep 2\nexit 1\n')
      writeFileSync(join(wt, 'witness.config.yaml'), "schema: 1\ncriteria:\n  runner: 'sh turn.sh {id}'\n")
      execFileSync('git', ['add', '-A'], { cwd: wt })
      execFileSync('git', ['commit', '-qm', 'runner'], { cwd: wt })
      mkdirSync(join(wt, 'tests'), { recursive: true })
      mkdirSync(join(wt, 'src'), { recursive: true })
      writeFileSync(join(wt, 'tests', `${s}.test.ts`), `// @spec:${s}\n`)
      writeFileSync(join(wt, 'src', `${s}-impl.ts`), `export const impl = '${s}'\n`)
    }
    const a = child(wts[0]!, 'a-plan-1')
    await new Promise((r) => setTimeout(r, 1_000))
    const b = child(wts[1]!, 'b-plan-1')
    await Promise.all([a, b])
    expect([existsSync(join(wts[0]!, 'src', 'a-impl.ts')), existsSync(join(wts[1]!, 'src', 'b-impl.ts'))]).toEqual([true, true])
    expect([existsSync(join(wts[0]!, 'src', 'b-impl.ts')), existsSync(join(wts[1]!, 'src', 'a-impl.ts'))]).toEqual([false, false])
    expect(execFileSync('git', ['stash', 'list'], { cwd: repo.root, encoding: 'utf8' })).toBe('')
  }, 90_000)
})
