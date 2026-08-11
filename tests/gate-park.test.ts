import { describe, expect, it } from 'vitest'
import { approve, fakeScenario, gateEnv, putVerdict, seededRepo, writePlan, writeSpec } from './helpers.js'

export const BLOCKING = {
  coverage: [
    { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
    { anchor: 'auth-refresh > ## Behavior', note: 'read' },
  ],
  findings: [{ blocking: true, anchor: 'auth-refresh-plan-1 > ## Step: s1', claim: 'step is untestable' }],
}

export async function stoppedPlanGate() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  const scenario = fakeScenario()
  putVerdict(scenario, BLOCKING)
  await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
  return repo
}

describe('a stop parks the flow', () => {
  it('next stops offering a stopped gate', async () => {
    const repo = await stoppedPlanGate()
    const before = await repo.cli(['next'])
    expect(before.stdout).toContain('witness decide plan auth-refresh-plan-1 --show')

    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])

    const after = await repo.cli(['next'])
    expect(after.stdout).not.toContain('witness gate plan auth-refresh-plan-1')
    expect(after.stdout).not.toContain('witness decide plan auth-refresh-plan-1')
  })
})
