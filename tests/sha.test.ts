import { describe, expect, it } from 'vitest'
import { canonicalSha, short } from '../src/sha.js'

const meta = {
  id: 'auth-refresh',
  type: 'spec',
  status: 'draft',
  summary: 'Refresh tokens rotate before expiry',
  criteria: [{ id: 'ac-rotate', test: '@spec:auth-refresh' }],
}
const body = '## Motivation\nwhy\n\n## Behavior\nwhat\n'

describe('canonicalSha', () => {
  it('is a 64-hex digest', () => {
    expect(canonicalSha(meta, body)).toMatch(/^[0-9a-f]{64}$/)
    expect(short(canonicalSha(meta, body))).toHaveLength(7)
  })

  it('ignores the volatile fields: status, drift, pr', () => {
    const base = canonicalSha(meta, body)
    expect(canonicalSha({ ...meta, status: 'live' }, body)).toBe(base)
    expect(canonicalSha({ ...meta, drift: { sha: 'x', at: 'y' } }, body)).toBe(base)
    expect(canonicalSha({ ...meta, pr: 42 }, body)).toBe(base)
  })

  it('changes when semantic content changes', () => {
    const base = canonicalSha(meta, body)
    expect(canonicalSha({ ...meta, summary: 'different' }, body)).not.toBe(base)
    expect(canonicalSha(meta, body + 'more\n')).not.toBe(base)
  })

  it('is independent of frontmatter key order and trailing whitespace', () => {
    const reordered = { summary: meta.summary, criteria: meta.criteria, type: meta.type, id: meta.id }
    expect(canonicalSha(reordered, body)).toBe(canonicalSha(meta, body))
    expect(canonicalSha(meta, body + '\n\n')).toBe(canonicalSha(meta, body))
  })
})

describe('design stamp is volatile', () => {
  it('stamping design leaves the canonical sha unchanged', () => {
    const before = canonicalSha(meta, body)
    const after = canonicalSha({ ...meta, design: { sha: 'a'.repeat(64), spec: before } }, body)
    expect(after).toBe(before)
  })
})
