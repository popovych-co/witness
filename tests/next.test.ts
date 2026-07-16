import { describe, expect, it } from 'vitest'
import { approve, fakeScenario, gateEnv, putVerdict, seededRepo, shippableRepo, writeSpec, writePlan } from './helpers.js'

async function nextLine(repo: { cli: (a: string[], o?: object) => Promise<{ code: number; stdout: string }> }, env?: object) {
  const r = await repo.cli(['next'], env ? { env } : undefined)
  expect(r.code).toBe(0)
  return r.stdout
}

describe('specflow next — the ladder', () => {
  it('walks recap → write → gate decompose → decide → plan-stage', async () => {
    const repo = await seededRepo({ noRecap: true })
    expect(await nextLine(repo)).toContain('specflow recap')

    await repo.cli(['recap', '--file', repo.writeRecap({})])
    expect(await nextLine(repo)).toContain('--effort auth-hardening')

    await writeSpec(repo, 'auth-refresh')
    expect(await nextLine(repo)).toContain('gate decompose --effort auth-hardening')

    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [] })
    await repo.cli(['gate', 'decompose', 'auth-hardening'], { env: gateEnv(scenario) })  // feature → stop
    expect(await nextLine(repo)).toContain('decide decompose auth-hardening --show')

    await repo.cli(['decide', 'decompose', 'auth-hardening', '--approve'])
    const out = await nextLine(repo)
    expect(out).toContain('stage: plan')
    expect(out).toContain('auth-refresh')
  })

  it('walks plan gate → start → implement stage → implement gate → ship', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    expect(await nextLine(repo)).toContain('gate plan auth-refresh-plan-1')

    repo.flipStatus('auth-refresh-plan-1', 'approved')
    expect(await nextLine(repo)).toContain('start auth-refresh-plan-1')

    await repo.cli(['start', 'auth-refresh-plan-1'])
    const out = await nextLine(repo)                       // no evidence yet
    expect(out).toContain('stage: implement')
  })

  it('gates every draft plan before any approved plan starts (plans-first)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-mfa')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-mfa-plan-1', {
      parent: 'auth-mfa',
      steps: [{ id: 's1', title: 'mfa step', criteria: ['ac-mfa'] }],
    })
    await writePlan(repo, 'auth-refresh-plan-1')
    // the alphabetically-first plan is already approved; its sibling is still draft —
    // stage-major order gates the draft before anything starts
    repo.flipStatus('auth-mfa-plan-1', 'approved')
    const out = await nextLine(repo)
    expect(out).toContain('gate plan auth-refresh-plan-1')
    expect(out).not.toContain('start')
  })

  it('after evidence: implement gate; after implement passes: ship', async () => {
    const { repo, planId } = await shippableRepo()
    expect(await nextLine(repo)).toContain(`gate implement ${planId}`)
    const scenario = fakeScenario()
    // vitest-single fixture lands 4 changed files — coverage-minimum needs an anchor per each
    putVerdict(scenario, {
      coverage: [
        { anchor: '.gitignore', note: 'read' },
        { anchor: 'package.json', note: 'read' },
        { anchor: 'src/token.ts', note: 'read' },
        { anchor: 'tests/token.test.ts', note: 'read' },
      ],
      findings: [],
    })
    await repo.cli(['gate', 'implement', planId], { env: gateEnv(scenario) })
    expect(await nextLine(repo)).toContain(`ship ${planId}`)
  })
})
