import { describe, expect, it, vi } from 'vitest'
import { capHit, parkAtCap } from '../src/caps.js'
import { loadConfig } from '../src/config.js'
import { gateSpec } from '../src/gate.js'
import '../src/gates/index.js'
import { appendEntry, readStream, type Entry } from '../src/journal.js'
import { openReopen, type DecisionEntry } from '../src/rounds.js'
import { loadCanon } from '../src/scan.js'
import type { DecisionAct } from '../src/verbs/decide.js'
import { fakeCtx, plannedRepo } from './helpers.js'

// P7: a hook between a cap park's read and its act, where another decision lands.
const door = vi.hoisted(() => ({ beforePark: undefined as undefined | (() => Promise<void>) }))
vi.mock('../src/verbs/decide.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/verbs/decide.js')>()
  return {
    ...real,
    applyDecision: async (ctx: Parameters<typeof real.applyDecision>[0], act: DecisionAct) => {
      if (act.park === true && door.beforePark !== undefined) { const h = door.beforePark; door.beforePark = undefined; await h() }
      return real.applyDecision(ctx, act)
    },
  }
})

const run = (gate: string, round: number, extra: Record<string, unknown> = {}) => ({
  v: 1, t: 'gate-run', gate, artifact: 'p1', round, run_id: `r-${gate}-${round}`, reviewed_sha: 's',
  prompts_sha: 'p', witness: '0', model: 'm', pin: 'm', checks: [], outcome: 'stopped', ...extra,
})
const decide = (gate: string, decision: string, extra: Record<string, unknown> = {}) =>
  ({ v: 1, t: 'human-decision', gate, artifact: 'p1', round: 1, decision, ...extra })
const CAPS = { rounds: 4, upstream: 2, spawns: 3, wallClockMs: 1_000 }
const none = { spawns: 0, ms: 0 }
const hit = (entries: unknown[], use = none) => capHit(entries as Entry[], use, CAPS)

describe('capHit (B5)', () => {
  it('counts rounds across budget resets', () => {
    expect(hit([run('implement', 1), decide('implement', 'revise-upstream'), run('implement', 1),
      run('implement', 2), decide('implement', 'revise'), run('implement', 3)]))
      .toEqual({ cap: 'rounds', gate: 'implement', note: 'drive cap: implement ran 4 rounds across budget resets · drive.caps.rounds 4' })
  })
  it('malformed and fallen-back rounds spend nothing', () => {
    expect(hit([run('implement', 1), run('implement', 2), run('implement', 3),
      run('implement', 3, { outcome: 'malformed' }), run('implement', 3, { model: 'other' })])).toBeUndefined()
  })
  it('a gate that converged is not capped', () => {
    expect(hit([run('implement', 1), run('implement', 2), run('implement', 3), run('implement', 4, { outcome: 'passed' })])).toBeUndefined()
  })
  it('counts upstream resets', () => {
    expect(hit([run('implement', 1), decide('implement', 'revise-upstream'), run('implement', 1), decide('implement', 'revise-upstream')]))
      .toEqual({ cap: 'upstream', note: 'drive cap: 2 upstream resets · drive.caps.upstream 2' })
  })
  it('counts this run\'s sessions and session time', () => {
    expect(hit([], { spawns: 3, ms: 0 })).toMatchObject({ cap: 'spawns', note: 'drive cap: 3 session(s) this run · drive.caps.spawns 3' })
    expect(hit([], { spawns: 0, ms: 1_000 })).toMatchObject({ cap: 'wall-clock' })
  })
  it('a cap park starts the count again', () => {
    const four = [1, 2, 3, 4].map((r) => run('implement', r))
    expect(hit([...four, decide('implement', 'stop', { selected: 'policy', rule: 'cap-rounds' }), run('implement', 5)])).toBeUndefined()
  })
  it('rounds outrank the run-scoped caps', () => {
    expect(hit([1, 2, 3, 4].map((r) => run('implement', r)), { spawns: 9, ms: 9_000 })?.cap).toBe('rounds')
  })
})

// Final review F7. A cap parks a flow that will not converge — never one whose gates settled.
describe('caps spare a converged flow (B5)', () => {
  it('upstream resets behind a gate that since converged trip nothing', () => {
    const resets = [1, 2, 3, 4, 5, 6].flatMap(() => [run('implement', 1), decide('implement', 'revise-upstream')])
    expect(hit([...resets, run('implement', 1, { outcome: 'passed' })])).toBeUndefined()
  })
})

// Row 240 (design §4.1.3, R3; P7 inverted). A cap park carries a token from its own read, so one
// read before a human's revise-upstream refuses instead of parking on top of it.
describe('a cap park lands only on what it read (row 240)', () => {
  const PLAN = 'auth-refresh-plan-1'
  async function boundStop() {
    const repo = await plannedRepo()
    const cfg = loadConfig(repo.root)
    if (!cfg.ok) throw new Error('cfg')
    const sha = gateSpec('plan')!.currentSha!(repo.root, loadCanon(repo.root), cfg.value, PLAN)
    for (let round = 1; round <= 3; round++) {
      appendEntry(repo.root, PLAN, {
        v: 1, t: 'gate-run', gate: 'plan', artifact: PLAN, round, run_id: `r-${round}`, reviewed_sha: sha,
        prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped',
        verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [{ blocking: true, anchor: `${PLAN} > ## Step: s1`, claim: 'x' }] }],
      } as never)
    }
    return repo
  }
  const decisions = (root: string) => (readStream(root, PLAN).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[])
    .filter((d) => d.gate === 'plan').map((d) => `${d.decision} · ${d.selected ?? 'human'}`)

  it('a cap park from a read taken before a revise-upstream refuses settled-since (P7)', async () => {
    const repo = await boundStop()
    const { applyDecision } = await import('../src/verbs/decide.js')
    door.beforePark = async () => {
      expect(await applyDecision(fakeCtx(repo.root), { gate: 'plan', target: PLAN, decision: 'revise', upstream: 'auth-refresh' })).toBe(0)
    }
    const hit = { cap: 'rounds' as const, gate: 'plan', note: 'drive cap: plan ran 3 rounds' }
    expect(await parkAtCap(fakeCtx(repo.root), repo.root, PLAN, hit)).toEqual({ parked: false, why: 'the policy could not park it (settled-since)' })
    expect(decisions(repo.root)).toEqual(['revise-upstream · human'])
    expect(openReopen(readStream(repo.root, 'auth-hardening'), 'decompose')).toBeDefined()
  })

  it('a cap park on the stop as it read it still parks', async () => {
    const repo = await boundStop()
    const hit = { cap: 'rounds' as const, gate: 'plan', note: 'drive cap: plan ran 3 rounds' }
    expect(await parkAtCap(fakeCtx(repo.root), repo.root, PLAN, hit)).toEqual({ parked: true })
    expect(decisions(repo.root)).toEqual(['stop · policy'])
  })
})
