import { describe, expect, it } from 'vitest'
import { openReopen } from '../src/rounds.js'
import { gateSettled } from '../src/verbs/next.js'
import type { Entry } from '../src/journal.js'

const run = (gate: string, outcome: 'passed' | 'stopped' = 'stopped', sha = 'sha-1') => ({
  v: 1, t: 'gate-run', gate, artifact: 'eff', round: 1, run_id: 'r1',
  reviewed_sha: sha, prompts_sha: 'p', specflow: '0', model: 'm',
  calibration: 'none', checks: [], verdicts: [], outcome,
}) as unknown as Entry

const decide = (gate: string, decision: string, causedBy?: unknown) => ({
  v: 1, t: 'human-decision', gate, artifact: 'eff', round: 1, decision,
  ...(causedBy ? { caused_by: causedBy } : {}),
}) as unknown as Entry

const REOPEN = { artifact: 'account-deletion', gate: 'design', round: 1 }

describe('openReopen', () => {
  it('finds an undischarged reopen after an approve (the entry-52/53 shape)', () => {
    const entries = [run('decompose'), decide('decompose', 'approve'), decide('decompose', 'revise', REOPEN)]
    expect(openReopen(entries, 'decompose')?.caused_by).toEqual(REOPEN)
  })

  it('is discharged by a later gate-run', () => {
    const entries = [
      run('decompose'), decide('decompose', 'approve'), decide('decompose', 'revise', REOPEN),
      run('decompose', 'stopped', 'sha-2'),
    ]
    expect(openReopen(entries, 'decompose')).toBeUndefined()
  })

  it('is discharged by a later human-decision — approve answers a reopen', () => {
    const entries = [
      run('decompose'), decide('decompose', 'approve'), decide('decompose', 'revise', REOPEN),
      decide('decompose', 'approve'),
    ]
    expect(openReopen(entries, 'decompose')).toBeUndefined()
  })

  it('ignores reopens belonging to another gate', () => {
    const entries = [run('decompose'), decide('plan', 'revise', REOPEN)]
    expect(openReopen(entries, 'decompose')).toBeUndefined()
  })

  it('ignores an ordinary revise — no caused_by is not a reopen', () => {
    const entries = [run('decompose'), decide('decompose', 'revise')]
    expect(openReopen(entries, 'decompose')).toBeUndefined()
  })
})

describe('gateSettled with an open reopen', () => {
  it('a passed run followed by a reopen is NOT settled', () => {
    const entries = [run('decompose', 'passed'), decide('decompose', 'revise', REOPEN)]
    expect(gateSettled(entries, 'decompose')).toBe(false)
  })

  it('an approved run followed by a reopen is NOT settled', () => {
    const entries = [run('decompose'), decide('decompose', 'approve'), decide('decompose', 'revise', REOPEN)]
    expect(gateSettled(entries, 'decompose')).toBe(false)
  })

  it('a discharged reopen restores settled', () => {
    const entries = [
      run('decompose'), decide('decompose', 'approve'), decide('decompose', 'revise', REOPEN),
      run('decompose', 'passed', 'sha-2'),
    ]
    expect(gateSettled(entries, 'decompose')).toBe(true)
  })

  it('the sha lapse still wins independently of reopens', () => {
    const entries = [run('decompose', 'passed', 'sha-1')]
    expect(gateSettled(entries, 'decompose', 'sha-2')).toBe(false)
    expect(gateSettled(entries, 'decompose', 'sha-1')).toBe(true)
  })
})
