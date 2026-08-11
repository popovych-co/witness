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

describe('status reports a parked flow', () => {
  it('names the gate, round, anchor and the reopen command', async () => {
    const repo = await stoppedPlanGate()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])
    const s = await repo.cli(['status'])
    expect(s.stdout).toContain('parked')
    expect(s.stdout).toContain('auth-refresh-plan-1')
    expect(s.stdout).toContain('## Step: s1')
    expect(s.stdout).toContain('witness gate plan auth-refresh-plan-1 --fresh')
  })

  // The parked row is a NEW command-rendering surface, and it goes through `rows()`, whose
  // `esc` quotes on `,` or `"` — the exact escape that mangled the exits line (D120). At the
  // bound `reopen` becomes the endgame set rather than `--fresh`, so that is the branch worth
  // pinning: it must arrive pasteable, with a resolved upstream and no doubled quotes.
  it('renders the endgame set pasteable when the parked gate sits at the bound', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    const scenario = fakeScenario()
    putVerdict(scenario, BLOCKING)
    for (let i = 1; i <= 3; i++) {
      await writePlan(repo, 'auth-refresh-plan-1', BOUND_STEPS, `## Step: s1\nAttempt ${i}.\n`)
      await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
    }
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])
    const row = (await repo.cli(['status'])).stdout.split('\n')
      .find((l) => l.includes('witness decide plan auth-refresh-plan-1'))!
    expect(row).not.toContain('""')
    expect(row).toContain('--revise --upstream auth-refresh')
    expect(row).toContain('--revise --repair')
    expect(row).not.toContain('<id>')
  })
})

const BOUND_STEPS = { steps: [{ id: 's1', title: 'rotate', criteria: ['ac-rotate'] }] }
