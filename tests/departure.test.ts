import { describe, expect, it } from 'vitest'
import { canonExit } from '../src/departure.js'
import type { Entry } from '../src/journal.js'

describe('canonExit (D166)', () => {
  const status = (to: string, extra: Record<string, unknown> = {}): Entry =>
    ({ v: 1, t: 'status', artifact: 'a', from: 'approved', to, cause: 'gate-approve', ...extra })

  it('is the status entry with which an artifact left canon', () => {
    expect(canonExit([status('approved'), status('superseded', { cause: 'supersede', by: 'b' })]))
      .toMatchObject({ to: 'superseded', by: 'b' })
    expect(canonExit([status('live'), status('removed', { cause: 'abandon' })]))
      .toMatchObject({ to: 'removed', cause: 'abandon' })
  })

  it('is nothing for a stream that never left, or that a later status brought back', () => {
    expect(canonExit([])).toBeUndefined()
    expect(canonExit([status('approved')])).toBeUndefined()
    expect(canonExit([status('removed'), status('approved')])).toBeUndefined()
    expect(canonExit([status('superseded'), status('live', { from: 'superseded', cause: 'abandon' })])).toBeUndefined()
  })

  it('reads status entries only', () => {
    expect(canonExit([status('superseded'), { v: 1, t: 'drift-check', artifact: 'a' }]))
      .toMatchObject({ to: 'superseded' })
  })
})
