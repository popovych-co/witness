import { describe, expect, it } from 'vitest'
import { anchorMenu, parseVerdict, resolveAnchor, verdictViolations, type Reviewed } from '../src/verdict.js'

const reviewed: Reviewed = {
  kind: 'design',
  artifact: { ids: ['hero', 'save-bar'] },
  spec: { id: 'booking-form', body: '## Motivation\nwhy\n\n## Behavior\nwhat\n' },
}

describe('design reviewed-kind', () => {
  it('anchorMenu lists element ids and spec headings', () => {
    const menu = anchorMenu(reviewed)
    expect(menu).toContain('- design#hero')
    expect(menu).toContain('- design#save-bar')
    expect(menu).toContain('- booking-form > ## Behavior')
  })

  it('resolves element-id and spec-heading anchors; rejects unknown', () => {
    expect(resolveAnchor('design#hero', reviewed)).toBeUndefined()
    expect(resolveAnchor('booking-form > ## Behavior', reviewed)).toBeUndefined()
    expect(resolveAnchor('design#ghost', reviewed)).toMatch(/no element id/)
    expect(resolveAnchor('booking-form > ## Nope', reviewed)).toMatch(/no heading/)
  })

  it('resolves omission scopes against artifact or spec', () => {
    expect(resolveAnchor({ kind: 'omission', scope: 'design#save-bar' }, reviewed)).toBeUndefined()
    expect(resolveAnchor({ kind: 'omission', scope: 'booking-form > ## Behavior' }, reviewed)).toBeUndefined()
    expect(resolveAnchor({ kind: 'omission', scope: 'design#ghost' }, reviewed)).toMatch(/resolves to no/)
  })

  it('coverage must prove both artifact and spec were read', () => {
    const both = { coverage: [
      { anchor: 'design#hero', note: 'read' },
      { anchor: 'booking-form > ## Behavior', note: 'read' },
    ], findings: [] as never[] }
    expect(verdictViolations(both as never, reviewed)).toEqual([])

    const artifactOnly = { coverage: [{ anchor: 'design#hero', note: 'r' }], findings: [] as never[] }
    const v1 = verdictViolations(artifactOnly as never, reviewed)
    expect(v1.some((x) => x.rule === 'coverage-minimum' && x.want.includes('spec'))).toBe(true)

    const specOnly = { coverage: [{ anchor: 'booking-form > ## Behavior', note: 'r' }], findings: [] as never[] }
    const v2 = verdictViolations(specOnly as never, reviewed)
    expect(v2.some((x) => x.rule === 'coverage-minimum' && x.want.includes('artifact'))).toBe(true)
  })

  it('rejects an unresolvable finding anchor (fail-closed)', () => {
    const bad = parseVerdict({
      coverage: [{ anchor: 'design#hero', note: 'r' }, { anchor: 'booking-form > ## Behavior', note: 'r' }],
      findings: [{ blocking: true, anchor: 'design#ghost', claim: 'x' }],
    })
    expect(bad.ok).toBe(true)
    if (bad.ok) expect(verdictViolations(bad.value, reviewed).some((x) => x.rule === 'anchor-unresolvable')).toBe(true)
  })
})
