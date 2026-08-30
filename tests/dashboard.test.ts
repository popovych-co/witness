import { describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import {
  SPEC_META, addOrigin, approve, fakeScenario, gateEnv, putVerdict, seededRepo, tmpRepo, witnessDesign, writeDesign, writePlan, writeSpec,
} from './helpers.js'
import { worktreePath } from '../src/worktree.js'

describe('witness dashboard (no-arg)', () => {
  it('points a fresh repo at recap, then at write', async () => {
    const repo = tmpRepo()
    await repo.cli(['init'])
    const fresh = await repo.cli([])
    expect(fresh.code).toBe(0)
    expect(fresh.stdout).toContain('next: witness recap --file')
    repo.write('recap.json', JSON.stringify({
      effort: 'auth-hardening', class: 'feature',
      goals: [{ id: 'g1', text: 'x' }], non_goals: [], constraints: [], slices: [],
    }))
    await repo.cli(['recap', '--file', 'recap.json'])
    const afterRecap = await repo.cli([])
    expect(afterRecap.stdout).toContain('efforts[1]{slug,class,specs,plans}:')
    expect(afterRecap.stdout).toContain('auth-hardening,feature,0,0')
    expect(afterRecap.stdout).toContain('next: witness write <spec-id> --effort auth-hardening')
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
    repo.write('.witness/txn.json', JSON.stringify({ op: 'write(x)', files: ['specs/x.md'] }))
    const res = await repo.cli([])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('pending-txn: write(x)')
    expect(res.stdout).toContain('next: witness recover')
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
    await witnessDesign(repo, 'booking-form')
    const g = await repo.cli(['gate', 'design', 'booking-form'], { env: gateEnv(scenario) })
    expect(g.code).toBe(1)                                    // always stops

    res = await repo.cli([])
    expect(res.stdout).toContain('gates[1]{gate,target,round,outcome}:')
    expect(res.stdout).toContain('  design,booking-form,1,stopped')
  })
})

describe('in-flight flows', () => {
  it('lists in-flight flows and flags a missing worktree', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    await repo.cli(['start', 'auth-refresh-plan-1'])

    rmSync(worktreePath(repo.root, 'auth-refresh-plan-1'), { recursive: true, force: true })

    const res = await repo.cli([])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('flows[1]')
    expect(res.stdout).toContain('auth-refresh-plan-1')
    expect(res.stdout).toContain('missing')

    await repo.cli(['clean'])
  })
})

// D101: commands/witness.md tells the operator to read "the dashboard" and nothing
// named it — bare `witness` is unreachable from usage(), --help, or prose.
describe('witness status', () => {
  it('renders the same dashboard as the bare verb', async () => {
    const repo = await seededRepo()
    const bare = await repo.cli([])
    const named = await repo.cli(['status'])
    expect(named.code).toBe(0)
    expect(named.stdout).toBe(bare.stdout)
    expect(named.stdout).toContain('canon:')
  })

  it('is listed among the verbs so it can be discovered', async () => {
    const repo = await seededRepo()
    const help = await repo.cli(['help'])
    expect(help.stdout).toContain('status')
  })

  // One fact, one wording, both orientation surfaces — modelFloorLines' own precedent,
  // which row 105 cites by name.
  it('prints the judge with its provenance, as check does', async () => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', `${repo.read('witness.config.yaml')}harness: pi\n`)
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'declare the judge')
    const status = await repo.cli(['status'], { env: { CLAUDECODE: '1' } })
    const check = await repo.cli(['check'], { env: { CLAUDECODE: '1' } })
    expect(status.stdout).toContain('judge: pi (declared in witness.config.yaml)')
    expect(check.stdout).toContain('judge: pi (declared in witness.config.yaml)')
  })

  // D139. The same computation `check` renders as a finding, rendered here as one line —
  // the D101 boundary: one fact, two surfaces, never two derivations.
  it('prints the divergence line when local main is ahead (D139)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    addOrigin(repo)
    repo.git('commit', '--allow-empty', '-m', 'local only')

    const res = await repo.cli([])

    expect(res.stdout).toMatch(/^sync: local main 1 ahead · 0 behind origin\/main — witness sync$/m)
  })
})
