import { describe, expect, it } from 'vitest'
import { movesFlow } from '../src/progress.js'

// Row 206. Drive's no-progress check and its take-back key read the same table: an entry that
// moves no flow — bookkeeping — never counts, so a session that only syncs or reports a
// dispatch is caught after one spawn instead of looping to the cap (issue #56).
describe('movesFlow (D206)', () => {
  it('classifies bookkeeping as no motion', () => {
    for (const t of ['sync', 'dispatch', 'write-refused', 'drift-check', 'policy-pin'] as const)
      expect(movesFlow({ v: 1, t })).toBe(false)
    expect(movesFlow({ v: 1, t: 'test-evidence', phase: 'red', vacuous: true })).toBe(false)
    expect(movesFlow({ v: 1, t: 'test-evidence', phase: 'red', tests: [{ name: 'x', ok: false }] })).toBe(true)
    expect(movesFlow({ v: 1, t: 'retry', artifact: 'p' })).toBe(true)
  })

  it('reads an unknown kind from a hand-edited journal as no motion', () => {
    expect(movesFlow({ v: 1, t: 'made-up' as never })).toBe(false)
  })
})
