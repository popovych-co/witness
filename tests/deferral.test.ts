import { describe, expect, it } from 'vitest'
import { deferralsBlock, newDeferralId, openDeferrals, type DeferralEntry } from '../src/deferral.js'
import type { Entry } from '../src/journal.js'

const mint = (id: string, over: Partial<DeferralEntry> = {}): Entry => ({
  v: 1, t: 'deferral', id, artifact: 'p1', gate: 'implement', round: 3,
  anchor: 'src/token.ts#rotate', kind: 'artifact-debt', caused_by_run: 'r-1', ...over,
} as unknown as Entry)

describe('newDeferralId', () => {
  it('mints the d-<8hex> shape and does not repeat', () => {
    const a = newDeferralId()
    expect(a).toMatch(/^d-[0-9a-f]{8}$/)
    expect(a).not.toBe(newDeferralId())
  })
})

describe('openDeferrals folds the entry family', () => {
  it('returns a minted obligation', () => {
    expect(openDeferrals([mint('d-1')]).map((d) => d.id)).toEqual(['d-1'])
  })

  it('drops one discharged by evidence', () => {
    const e = [mint('d-1'), { v: 1, t: 'deferral-discharged', id: 'd-1' } as unknown as Entry]
    expect(openDeferrals(e)).toEqual([])
  })

  it('drops one dismissed', () => {
    const e = [mint('d-1'), { v: 1, t: 'deferral-dismissed', id: 'd-1', cause: 'lens-retired', note: 'x' } as unknown as Entry]
    expect(openDeferrals(e)).toEqual([])
  })

  it('drops one that moved away from this stream', () => {
    const e = [mint('d-1'), { v: 1, t: 'deferral-moved', id: 'd-1', to: 'auth-refresh' } as unknown as Entry]
    expect(openDeferrals(e)).toEqual([])
  })

  it('honors a retype', () => {
    const e = [mint('d-1', { kind: 'lens-suspicion' }),
      { v: 1, t: 'deferral-retyped', id: 'd-1', kind: 'artifact-debt' } as unknown as Entry]
    expect(openDeferrals(e)[0]!.kind).toBe('artifact-debt')
  })

  it('keeps two obligations on the same anchor distinct', () => {
    expect(openDeferrals([mint('d-1'), mint('d-2')]).length).toBe(2)
  })
})

describe('deferralsBlock is the inverse of a pin', () => {
  it('solicits findings rather than suppressing them', () => {
    const text = deferralsBlock([mint('d-1') as unknown as DeferralEntry])
    expect(text).toContain('src/token.ts#rotate')
    expect(text).toMatch(/report/i)
    expect(text).toMatch(/silence/i)
    expect(text).not.toMatch(/do not re-litigate/i)
  })

  it('is empty for no obligations', () => {
    expect(deferralsBlock([])).toBe('')
  })
})
