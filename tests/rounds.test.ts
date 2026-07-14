import { describe, expect, it } from 'vitest'
import type { Entry } from '../src/journal.js'
import {
  appendKind, boundReached, keyOf, pendingDecision, roundsSinceApprove, type GateRunEntry,
} from '../src/rounds.js'

const KEY = { gate: 'plan', prompts_sha: 'p1', model: 'm1', specflow: '0.1.0' }

function run(sha: string, outcome: 'passed' | 'stopped' | 'malformed', round: number, extra: Partial<GateRunEntry> = {}): GateRunEntry {
  return {
    v: 1, t: 'gate-run', gate: 'plan', artifact: 'auth-refresh-plan-1', round,
    run_id: `r-${round}`, reviewed_sha: sha, prompts_sha: KEY.prompts_sha,
    specflow: KEY.specflow, model: KEY.model, calibration: 'none',
    checks: [], verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [] }],
    outcome, ...extra,
  }
}
const revise = (round: number): Entry => ({
  v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh-plan-1', round, decision: 'revise',
} as Entry)
const approve = (round: number): Entry => ({
  v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh-plan-1', round, decision: 'approve',
} as Entry)
const key = (sha: string) => ({ reviewed_sha: sha, ...KEY })

describe('roundsSinceApprove', () => {
  it('counts gate-run entries, resetting at approve decisions and passed outcomes', () => {
    expect(roundsSinceApprove([run('a', 'stopped', 1), run('b', 'stopped', 2)], 'plan')).toBe(2)
    expect(roundsSinceApprove([run('a', 'stopped', 1), approve(1), run('b', 'stopped', 1)], 'plan')).toBe(1)
    expect(roundsSinceApprove([run('a', 'passed', 1)], 'plan')).toBe(0)
    expect(roundsSinceApprove([run('a', 'stopped', 1)], 'ship')).toBe(0)
  })
})

describe('appendKind', () => {
  it('same sha, no intervening revise → resume', () => {
    const entries = [run('a', 'stopped', 1)]
    expect(appendKind(entries, 'plan', key('a')).kind).toBe('resume')
  })

  it('same sha after a revise → changed-nothing (the explicit stop)', () => {
    const entries = [run('a', 'stopped', 1), revise(1)]
    expect(appendKind(entries, 'plan', key('a')).kind).toBe('changed-nothing')
  })

  it('previously seen sha → cached append; A↔B oscillation therefore counts', () => {
    const entries = [run('a', 'stopped', 1), revise(1), run('b', 'stopped', 2), revise(2)]
    const k = appendKind(entries, 'plan', key('a'))
    expect(k.kind).toBe('cached')
    if (k.kind === 'cached') expect(k.from.reviewed_sha).toBe('a')
  })

  it('malformed runs never serve the cache', () => {
    const entries = [run('a', 'malformed', 1, { verdicts: undefined }), revise(1), run('b', 'stopped', 2), revise(2)]
    expect(appendKind(entries, 'plan', key('a')).kind).toBe('fresh')
  })

  it('any key component differing → fresh (edited lens, new model, new version)', () => {
    const entries = [run('a', 'stopped', 1), revise(1)]
    expect(appendKind(entries, 'plan', { ...key('a'), prompts_sha: 'p2' }).kind).toBe('fresh')
    expect(appendKind(entries, 'plan', { ...key('a'), model: 'm2' }).kind).toBe('fresh')
  })
})

describe('pendingDecision + bound', () => {
  it('a stop without a later decision is pending; three rounds reach the bound', () => {
    const stopped = [run('a', 'stopped', 1)]
    expect(pendingDecision(stopped, 'plan')?.reviewed_sha).toBe('a')
    expect(pendingDecision([...stopped, revise(1)], 'plan')).toBeUndefined()
    const three = [run('a', 'stopped', 1), revise(1), run('b', 'stopped', 2), revise(2), run('c', 'stopped', 3)]
    expect(boundReached(three, 'plan')).toBe(true)
    expect(boundReached(three.slice(0, 3), 'plan')).toBe(false)
  })
})

describe('keyOf', () => {
  it('extracts exactly the five key components', () => {
    expect(keyOf(run('a', 'stopped', 1))).toEqual({
      reviewed_sha: 'a', gate: 'plan', prompts_sha: 'p1', model: 'm1', specflow: '0.1.0',
    })
  })
})
