import { describe, expect, it } from 'vitest'
import { serializeDoc, splitDoc } from '../src/fm.js'

const DOC = `---
id: auth-refresh
type: spec
status: draft
summary: Refresh tokens rotate before expiry
depends: []
needs: []
criteria:
  - id: ac-rotate
    test: "@spec:auth-refresh"
---

## Motivation
Because tokens leak.

## Behavior
Rotation happens before expiry.
`

describe('splitDoc', () => {
  it('parses meta and body', () => {
    const res = splitDoc(DOC)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.meta.id).toBe('auth-refresh')
    expect(res.value.body).toContain('## Behavior')
  })

  it('refuses a doc without a frontmatter block', () => {
    const res = splitDoc('# just markdown\n')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.violations[0]?.rule).toBe('missing')
  })

  it('refuses non-mapping frontmatter', () => {
    const res = splitDoc('---\n- a\n- b\n---\nbody\n')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.violations[0]?.rule).toBe('shape')
  })
})

describe('serializeDoc', () => {
  it('round-trips meta and body and is idempotent', () => {
    const first = splitDoc(DOC)
    if (!first.ok) throw new Error('parse failed')
    const out = serializeDoc(first.value)
    const second = splitDoc(out)
    if (!second.ok) throw new Error('reparse failed')
    expect(second.value.meta).toEqual(first.value.meta)
    expect(second.value.body.trim()).toBe(first.value.body.trim())
    expect(serializeDoc(second.value)).toBe(out)
  })

  it('orders id and type first regardless of input order', () => {
    const res = splitDoc('---\nstatus: draft\ntype: spec\nid: x\n---\nbody\n')
    if (!res.ok) throw new Error('parse failed')
    const out = serializeDoc(res.value)
    expect(out.indexOf('id: x')).toBeLessThan(out.indexOf('type: spec'))
    expect(out.indexOf('type: spec')).toBeLessThan(out.indexOf('status: draft'))
  })
})
