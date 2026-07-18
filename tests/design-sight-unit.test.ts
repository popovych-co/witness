import { describe, expect, it } from 'vitest'
import { designShown } from '../src/design.js'
import type { Entry } from '../src/journal.js'

const SHA = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

const shownEntry = (sha: string): Entry =>
  ({ v: 1, t: 'design-shown', artifact: 'booking-services', sha, opener: 'open' }) as unknown as Entry
const writeEntry = (sha: string): Entry =>
  ({ v: 1, t: 'design-write', artifact: 'booking-services', sha }) as unknown as Entry

describe('designShown', () => {
  it('is true when a design-shown entry matches the sha', () => {
    expect(designShown([shownEntry(SHA)], SHA)).toBe(true)
  })

  it('is false when sight was witnessed against a different sha — re-authoring invalidates it', () => {
    expect(designShown([shownEntry(OTHER)], SHA)).toBe(false)
  })

  it('is false when the artifact was written but never shown', () => {
    expect(designShown([writeEntry(SHA)], SHA)).toBe(false)
  })

  it('is false on an empty stream', () => {
    expect(designShown([], SHA)).toBe(false)
  })
})
