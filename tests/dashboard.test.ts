import { describe, expect, it } from 'vitest'
import {
  SPEC_META, approve, fakeScenario, gateEnv, putVerdict, seededRepo, tmpRepo, writeDesign, writeSpec,
} from './helpers.js'

describe('specflow dashboard (no-arg)', () => {
  it('points a fresh repo at recap, then at write', async () => {
    const repo = tmpRepo()
    await repo.cli(['init'])
    const fresh = await repo.cli([])
    expect(fresh.code).toBe(0)
    expect(fresh.stdout).toContain('next: specflow recap --file')
    repo.write('recap.json', JSON.stringify({
      effort: 'auth-hardening', class: 'feature',
      goals: [{ id: 'g1', text: 'x' }], non_goals: [], constraints: [], slices: [],
    }))
    await repo.cli(['recap', '--file', 'recap.json'])
    const afterRecap = await repo.cli([])
    expect(afterRecap.stdout).toContain('efforts[1]{slug,class,specs,plans}:')
    expect(afterRecap.stdout).toContain('auth-hardening,feature,0,0')
    expect(afterRecap.stdout).toContain('next: specflow write <spec-id> --effort auth-hardening')
  })

  it('computes blockedness live from depends and needs', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    await writeSpec(repo, 'auth-login', {
      ...SPEC_META,
      criteria: [{ id: 'ac-login', test: '@spec:auth-login' }],
      depends: ['auth-refresh'],
      needs: [{ env: 'NOT_SET_VAR' }, { manual: 'dns cut over', satisfied: false }],
    })
    const res = await repo.cli([])
    expect(res.stdout).toContain('blocked[')
    expect(res.stdout).toContain('auth-refresh (draft)')
    expect(res.stdout).toContain('NOT_SET_VAR unset')
    expect(res.stdout).toContain('dns cut over')
    expect(res.stdout).toContain('auth-hardening,feature,2,0')
  })

  it('banners a pending transaction above everything', async () => {
    const repo = await seededRepo()
    repo.write('.specflow/txn.json', JSON.stringify({ op: 'write(x)', files: ['specs/x.md'] }))
    const res = await repo.cli([])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('pending-txn: write(x)')
    expect(res.stdout).toContain('next: specflow recover')
  })

  it('surfaces design-pending ui specs, then a pending design gate once one runs', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')

    let res = await repo.cli([])
    expect(res.stdout).toContain('design[1]{spec,why}:')
    expect(res.stdout).toContain('  booking-form,design owed')

    await writeDesign(repo, 'booking-form')
    res = await repo.cli([])
    expect(res.stdout).toContain('  booking-form,design gate pending')

    const scenario = fakeScenario()
    putVerdict(scenario, {
      coverage: [{ anchor: 'design#save-bar', note: 'r' }, { anchor: 'booking-form > ## Behavior', note: 'r' }],
      findings: [],
    })
    const g = await repo.cli(['gate', 'design', 'booking-form'], { env: gateEnv(scenario) })
    expect(g.code).toBe(1)                                    // always stops

    res = await repo.cli([])
    expect(res.stdout).toContain('gates[1]{gate,target,round,outcome}:')
    expect(res.stdout).toContain('  design,booking-form,1,stopped')
  })
})
