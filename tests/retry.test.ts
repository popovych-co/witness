import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { type TestRepo, approve, seededRepo, writePlan, writeSpec } from './helpers.js'

async function startedPlan(): Promise<TestRepo> {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  approve(repo, 'auth-refresh-plan-1')
  await repo.cli(['start', 'auth-refresh-plan-1'])
  return repo
}

// Row 207. A fix that leaves no other record — code, a tool, an account — still has to move
// the target's key, or drive holds a stuck target forever. The human's retry is that record.
describe('witness retry (D207)', () => {
  it("journals a retry on the target's own stream and commits it", async () => {
    const repo = await startedPlan()
    const res = await repo.cli(['retry', 'auth-refresh-plan-1'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('retried: auth-refresh-plan-1')
    expect(readStream(repo.root, 'auth-refresh-plan-1').at(-1)?.t).toBe('retry')
    expect(repo.git('status', '--porcelain')).toBe('')
  })

  it('refuses inside a drive session and inside a reviewer', async () => {
    const repo = await startedPlan()
    for (const env of [{ WITNESS_DRIVE: 'auth-refresh-plan-1' }, { WITNESS_REVIEWER: '1' }]) {
      const res = await repo.cli(['retry', 'auth-refresh-plan-1'], { env })
      expect(res.code).toBe(2)
      expect(res.stderr).toContain('retry-in-session')
    }
    expect(readStream(repo.root, 'auth-refresh-plan-1').some((e) => e.t === 'retry')).toBe(false)
  })

  it('refuses a target that is not in canon, and a missing id', async () => {
    const repo = await startedPlan()
    const ghost = await repo.cli(['retry', 'ghost-plan-1'])
    expect(ghost.code).toBe(2)
    expect(ghost.stderr).toContain('unknown-doc')
    const bare = await repo.cli(['retry'])
    expect(bare.code).toBe(2)
    expect(bare.stderr).toContain('usage')
  })
})
