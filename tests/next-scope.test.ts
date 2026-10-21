import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { appendEntry, readStream } from '../src/journal.js'
import { loadCanon } from '../src/scan.js'
import { computeNext, NOTHING_OWED } from '../src/verbs/next.js'
import {
  approve, autonomyOn, fakeCtx, fakeScenario, gateEnv, ghState, nextLine, PLAN_BLOCKING, plannedRepo, putVerdict,
  seededRepo, writePlan, writeSpec, type TestRepo,
} from './helpers.js'

// a flow at ship (in progress · pr set) beside a draft plan of another spec awaiting its gate.
// The fake gh answers the lazy stamp's PR query, so `next` never reaches a real gh.
async function flowAndDraft(): Promise<TestRepo & { env: Record<string, string> }> {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  approve(repo, 'auth-refresh-plan-1')
  await repo.cli(['start', 'auth-refresh-plan-1'])
  repo.setMeta('auth-refresh-plan-1', { pr: 7 })
  await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
  approve(repo, 'auth-mfa')
  await writePlan(repo, 'auth-mfa-plan-1', { parent: 'auth-mfa', steps: [{ id: 's1', title: 'mfa', criteria: ['ac-mfa'] }] })
  const scenario = fakeScenario()
  ghState(scenario, 7, 'OPEN')
  return Object.assign(repo, { env: gateEnv(scenario) })
}
const derive = (repo: TestRepo, scope?: (t: string | undefined) => boolean) => {
  const cfg = loadConfig(repo.root)
  if (!cfg.ok) throw new Error('config')
  return computeNext(repo.root, fakeCtx(repo.root), loadCanon(repo.root), cfg.value, { scope })
}

describe('computeNext scope (B3)', () => {
  it('admits everything by default — the ladder is unchanged', async () => {
    expect(derive(await flowAndDraft()).line).toBe('witness ship auth-refresh-plan-1')
  })

  it('keeps every rung to the targets it admits', async () => {
    const repo = await flowAndDraft()
    expect(derive(repo, (t) => t !== 'auth-refresh-plan-1').line).toBe('witness gate plan auth-mfa-plan-1')
    expect(derive(repo, (t) => t === 'auth-mfa-plan-1').line).toBe('witness gate plan auth-mfa-plan-1')
    expect(derive(repo, (t) => t === undefined)).toMatchObject({ line: 'witness check', note: NOTHING_OWED })
  })

  it('scopes tier 2 to its own decision', async () => {
    const repo = await flowAndDraft()
    appendEntry(repo.root, 'auth-mfa-plan-1', {
      v: 1, t: 'gate-run', gate: 'plan', artifact: 'auth-mfa-plan-1', round: 1, run_id: 'r1',
      reviewed_sha: 's', prompts_sha: 'p', witness: '0', model: 'm', calibration: 'none', checks: [], outcome: 'stopped',
    })
    expect(derive(repo).line).toBe('witness ship auth-refresh-plan-1')
    expect(derive(repo, (t) => t === 'auth-mfa-plan-1').line).toBe('witness decide plan auth-mfa-plan-1 --show')
  })

  it('a marked session settles only its own target\'s stop (Review Focus 2)', async () => {
    const repo = await plannedRepo({ autonomy: false })                 // A1: the stop waits while autonomy is off
    const scenario = fakeScenario()
    putVerdict(scenario, PLAN_BLOCKING)
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
    autonomyOn(repo)
    const decisions = () => readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'human-decision')
    await repo.cli(['next'], { env: { ...gateEnv(scenario), WITNESS_DRIVE: repo.effort } })
    expect(decisions()).toEqual([])
    await repo.cli(['next'], { env: { ...gateEnv(scenario), WITNESS_DRIVE: 'auth-refresh-plan-1' } })
    expect(decisions().at(-1)).toMatchObject({ decision: 'revise', selected: 'policy' })
  })

  it('a marked session answers for its target alone and says so (Review Focus 2)', async () => {
    const repo = await flowAndDraft()
    const out = await nextLine(repo, { env: { ...repo.env, WITNESS_DRIVE: 'auth-mfa-plan-1' } })
    expect(out).toContain('drive: auth-mfa-plan-1 — assigned by witness drive')
    expect(out).toContain('next: witness gate plan auth-mfa-plan-1')
    expect(out).not.toContain('witness ship')
  })

  it('a marked session whose target needs nothing more is told so', async () => {
    const repo = await flowAndDraft()
    const out = await nextLine(repo, { env: { ...repo.env, WITNESS_DRIVE: 'auth-refresh' } })
    expect(out).toContain('drive: done — nothing more is owed for auth-refresh')
  })
})
