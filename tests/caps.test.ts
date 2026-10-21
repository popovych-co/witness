import { describe, expect, it } from 'vitest'
import { capHit } from '../src/caps.js'
import type { Entry } from '../src/journal.js'

const run = (gate: string, round: number, extra: Record<string, unknown> = {}) => ({
  v: 1, t: 'gate-run', gate, artifact: 'p1', round, run_id: `r-${gate}-${round}`, reviewed_sha: 's',
  prompts_sha: 'p', witness: '0', model: 'm', pin: 'm', calibration: 'none', checks: [], outcome: 'stopped', ...extra,
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
