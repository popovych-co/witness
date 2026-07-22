import { describe, expect, it } from 'vitest'
import { appendEntry } from '../src/journal.js'
import { approve, fakeScenario, gateEnv, nextLine, putVerdict, seededRepo, shippableRepo, witnessDesign, writeDesign, writeSpec, writePlan } from './helpers.js'

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
    expect(out).toContain(`home: ${repo.root}/.specflow/worktrees/auth-refresh-plan-1`)
  })

  it('implement and ship rows carry home: and run: for the session handoff', async () => {
    const { repo, planId } = await shippableRepo()
    // implement-gate row: belongs in the worktree
    const out = await nextLine(repo)
    expect(out).toContain(`gate implement ${planId}`)
    expect(out).toContain(`home: ${repo.root}/.specflow/worktrees/${planId}`)
    expect(out).toContain(`run: cd '${repo.root}/.specflow/worktrees/${planId}' && claude '/specflow'`)
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

  it('a bound-stuck gate with no pending decision surfaces as the next action', async () => {
    const { repo, planId } = await shippableRepo()
    for (const round of [1, 2, 3]) {
      appendEntry(repo.root, planId, {
        v: 1, t: 'gate-run', gate: 'implement', artifact: planId, round,
        run_id: `r-${round}`, reviewed_sha: `sha-${round}`, prompts_sha: 'p', specflow: '0',
        model: 'm', calibration: 'none', checks: [], verdicts: [], outcome: 'stopped',
      })
      appendEntry(repo.root, planId, {
        v: 1, t: 'human-decision', gate: 'implement', artifact: planId, round,
        decision: round < 3 ? 'revise' : 'stop',
      })
    }
    const out = await nextLine(repo)
    expect(out).toContain(`decide implement ${planId}`)
    expect(out).toContain('bound')
    expect(out).not.toContain('test-evidence')
  })
})

describe('design stage routing', () => {
  it('routes an approved ui spec to the design stage before planning', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')
    const res = await repo.cli(['next'])
    expect(res.stdout).toContain('specflow design booking-form')
    expect(res.stdout).toContain('stage: design')
  })

  it('routes to the design gate once an artifact exists', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')
    await writeDesign(repo, 'booking-form')
    await witnessDesign(repo, 'booking-form')          // registered AND shown → the gate is next
    const res = await repo.cli(['next'])
    expect(res.stdout).toContain('specflow gate design booking-form')
  })

  it('a non-ui approved spec still routes straight to plan', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    const res = await repo.cli(['next'])
    expect(res.stdout).toContain('write auth-refresh-plan-1')
  })
})
