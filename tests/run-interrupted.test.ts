import { describe, expect, it } from 'vitest'
import { standingHeld } from '../src/held.js'
import { readStream } from '../src/journal.js'
import { fixtureEnv, heldWorktree, startedThreeStepPlan, worktreeState } from './helpers.js'

describe('a killed test run is no outcome (row 247)', () => {
  it.each([['kill -TERM $$ # {id}', 'SIGTERM'], ['exit 143 # {id}', 'SIGTERM'], ['exit 130 # {id}', 'SIGINT']])(
    'a filtered runner `%s` refuses run-interrupted and journals nothing', async (runner, signal) => {
      const { repo, wt, planId } = await startedThreeStepPlan({ criteria: { runner } })
      const res = await repo.cli(['test-evidence', planId, '--phase', 'red', '--step', 's1'], { cwd: wt, env: fixtureEnv() })
      expect(res.code).toBe(2)
      expect(res.stderr).toContain('run-interrupted')
      expect(res.stderr).toContain(signal)
      expect(readStream(repo.root, planId).filter((e) => e.t === 'test-evidence')).toEqual([])
    })

  it('a full-suite run ended by a signal refuses run-interrupted before any report is read', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan({
      criteria: { runner: 'full-suite', report: 'junit:**/reports/junit.xml' }, ship: { test: 'kill -TERM $$' },
    })
    const res = await repo.cli(['test-evidence', planId, '--phase', 'red', '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('run-interrupted')
    expect(readStream(repo.root, planId).filter((e) => e.t === 'test-evidence')).toEqual([])
  })

  it('verify-red whose red run is killed puts the work back and journals nothing', async () => {
    const { repo, wt, planId, before } = await heldWorktree('stepped', { crash: false, config: { criteria: { runner: 'kill -TERM $$ # {id}' } } })
    const res = await repo.cli(['verify-red', planId, '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('run-interrupted')
    expect(worktreeState(repo, wt, ['src/token.ts', 'src/extra.ts'])).toEqual(before)
    expect(standingHeld(repo.root, planId)).toBeUndefined()
    expect(readStream(repo.root, planId).filter((e) => e.t === 'test-evidence')).toEqual([])
  })
})
