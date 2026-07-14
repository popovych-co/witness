import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import type { GateRunEntry } from '../src/rounds.js'
import { findById, loadCanon } from '../src/scan.js'
import { fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, writeSpec, writePlan, approve } from './helpers.js'

const cover = (ids: string[]) => ({
  coverage: ids.map((id) => ({ anchor: `${id} > ## Behavior`, note: 'read' })),
  findings: [],
})
const runsOf = (repo: { root: string }, stream: string) =>
  readStream(repo.root, stream).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]

describe('decompose gate', () => {
  it('feature class: green evidence still stops for scope; approve stamps the set', async () => {
    const repo = await seededRepo()                       // seeds effort auth-hardening, class feature, goal g1
    await writeSpec(repo, 'auth-refresh')                 // covers g1
    const scenario = fakeScenario()
    putVerdict(scenario, cover(['auth-refresh']))
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    expect(await runGate(ctx, 'decompose', 'auth-hardening', { fresh: false, manual: false })).toBe(1)
    const [entry] = runsOf(repo, 'auth-hardening')
    expect(entry!.outcome).toBe('stopped')
    expect(entry!.standing).toContain('feature')
    expect(entry!.checks.every((c) => c.ok)).toBe(true)
    const d = await repo.cli(['decide', 'decompose', 'auth-hardening', '--approve'])
    expect(d.code).toBe(0)
    expect(findById(loadCanon(repo.root), 'auth-refresh')!.meta.status).toBe('approved')
  })

  it('goal-coverage totality fails deterministically in both directions', async () => {
    const repo = await seededRepo({ goals: [{ id: 'g1', text: 'rotate' }, { id: 'g2', text: 'revoke' }] })
    await writeSpec(repo, 'auth-refresh', { covers: ['g1'] })   // g2 uncovered
    const scenario = fakeScenario()
    putVerdict(scenario, cover(['auth-refresh']))
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    await runGate(ctx, 'decompose', 'auth-hardening', { fresh: false, manual: false })
    const [entry] = runsOf(repo, 'auth-hardening')
    const coverageCheck = entry!.checks.find((c) => c.name === 'goal-coverage')!
    expect(coverageCheck.ok).toBe(false)
    expect(coverageCheck.detail).toContain('g2')
  })

  it('fix class rides the green path amend-only, stops on a created spec', async () => {
    const fixRepo = await seededRepo({ class: 'fix', slug: 'quick-fix' })
    await writeSpec(fixRepo, 'auth-refresh')              // created under a fix → tripwire
    const scenario = fakeScenario()
    putVerdict(scenario, cover(['auth-refresh']))
    const ctx = fakeCtx(fixRepo.root, { env: gateEnv(scenario) })
    expect(await runGate(ctx, 'decompose', 'quick-fix', { fresh: false, manual: false })).toBe(1)
    expect(runsOf(fixRepo, 'quick-fix')[0]!.standing).toContain('misroute')

    const amendRepo = await seededRepo({ class: 'fix', slug: 'quick-amend', preexisting: ['auth-refresh'] })
    await writeSpec(amendRepo, 'auth-refresh')            // amendment of a pre-effort spec
    const scenario2 = fakeScenario()
    putVerdict(scenario2, cover(['auth-refresh']))
    const ctx2 = fakeCtx(amendRepo.root, { env: gateEnv(scenario2) })
    expect(await runGate(ctx2, 'decompose', 'quick-amend', { fresh: false, manual: false })).toBe(0)
    expect(findById(loadCanon(amendRepo.root), 'auth-refresh')!.meta.status).toBe('approved')
  })

  it('recap --amend re-arms the stop with a fresh round', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const scenario = fakeScenario()
    putVerdict(scenario, cover(['auth-refresh']))
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    await runGate(ctx, 'decompose', 'auth-hardening', { fresh: false, manual: false })
    await repo.cli(['decide', 'decompose', 'auth-hardening', '--approve'])
    await repo.cli(['recap', '--amend', '--file',
      repo.writeRecap({ goals: [{ id: 'g1', text: 'rotate' }, { id: 'g2', text: 'revoke sessions' }] })])
    await writeSpec(repo, 'auth-refresh', { covers: ['g1', 'g2'] })
    expect(await runGate(ctx, 'decompose', 'auth-hardening', { fresh: false, manual: false })).toBe(1)
    const all = runsOf(repo, 'auth-hardening')
    expect(all.length).toBe(2)
    expect(all[1]!.round).toBe(1)                          // approve reset the count
    expect(all[1]!.reviewed_sha).not.toBe(all[0]!.reviewed_sha)
  })

  it('an in-progress child under a re-amended spec demands the ack', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'in-progress') // seed helper: direct flip + plain commit
    await writeSpec(repo, 'auth-refresh', { summary: 'amended under an in-progress child' })
    const scenario = fakeScenario()
    putVerdict(scenario, cover(['auth-refresh']))
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    await runGate(ctx, 'decompose', 'auth-hardening', { fresh: false, manual: false })
    const entry = runsOf(repo, 'auth-hardening').at(-1)!
    const ack = entry.checks.find((c) => c.name === 'amendment-ack')!
    expect(ack.ok).toBe(false)
    expect(ack.detail).toContain('auth-refresh-plan-1')
  })
})
