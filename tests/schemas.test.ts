import { describe, expect, it } from 'vitest'
import { validateDoc } from '../src/schemas.js'

const SPEC_BODY = '## Motivation\nwhy\n\n## Behavior\nwhat\n'

function specMeta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'auth-refresh',
    type: 'spec',
    status: 'draft',
    summary: 'Refresh tokens rotate before expiry',
    depends: [],
    needs: [],
    criteria: [{ id: 'ac-rotate', test: '@spec:auth-refresh' }],
    ...over,
  }
}

function planMeta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'auth-refresh-plan-1',
    type: 'plan',
    status: 'draft',
    parent: 'auth-refresh',
    'derives-from': 'a'.repeat(64),
    depends: [],
    needs: [],
    steps: [{ id: 's1', title: 'rotate tokens', criteria: ['ac-rotate'] }],
    ...over,
  }
}

describe('validateDoc: spec', () => {
  it('accepts a valid spec', () => {
    expect(validateDoc(specMeta(), SPEC_BODY)).toEqual([])
  })

  it('enforces id charset and the reserved principles id', () => {
    expect(validateDoc(specMeta({ id: 'Bad_Id' }), SPEC_BODY).map((x) => x.rule)).toContain('id-charset')
    expect(validateDoc(specMeta({ id: 'principles' }), SPEC_BODY).map((x) => x.rule)).toContain('reserved')
  })

  it('enforces status enum, summary presence and length', () => {
    expect(validateDoc(specMeta({ status: 'done' }), SPEC_BODY).map((x) => x.rule)).toContain('enum')
    expect(validateDoc(specMeta({ summary: undefined }), SPEC_BODY).map((x) => x.rule)).toContain('required')
    expect(validateDoc(specMeta({ summary: 'x'.repeat(121) }), SPEC_BODY).map((x) => x.rule)).toContain('max-length')
  })

  it('requires the Motivation and Behavior template headings', () => {
    const out = validateDoc(specMeta(), '## Motivation\nonly\n')
    expect(out.some((x) => x.rule === 'template' && x.got.includes('## Behavior'))).toBe(true)
  })
})

describe('validateDoc: plan', () => {
  it('accepts a valid plan whose body elaborates every step', () => {
    expect(validateDoc(planMeta(), '## Step: s1\ndo it\n')).toEqual([])
  })

  it('requires parent and a 64-hex derives-from', () => {
    expect(validateDoc(planMeta({ parent: undefined }), '## Step: s1\nx\n').map((x) => x.rule)).toContain('required')
    expect(validateDoc(planMeta({ 'derives-from': 'abc' }), '## Step: s1\nx\n').map((x) => x.rule)).toContain('shape')
  })

  it('demands criteria XOR scaffolding per step', () => {
    const both = planMeta({ steps: [{ id: 's1', title: 't', criteria: ['ac-a'], scaffolding: true }] })
    expect(validateDoc(both, '## Step: s1\nx\n').map((x) => x.rule)).toContain('mapping')
    const neither = planMeta({ steps: [{ id: 's1', title: 't' }] })
    expect(validateDoc(neither, '## Step: s1\nx\n').map((x) => x.rule)).toContain('mapping')
  })

  it('enforces step-to-body-section totality both ways', () => {
    const missing = validateDoc(planMeta(), 'no sections\n')
    expect(missing.some((x) => x.rule === 'step-section-missing')).toBe(true)
    const orphan = validateDoc(planMeta(), '## Step: s1\nx\n## Step: ghost\ny\n')
    expect(orphan.some((x) => x.rule === 'step-section-orphan')).toBe(true)
  })
})

describe('ui flag', () => {
  it('accepts ui: true on a spec', () => {
    expect(validateDoc(specMeta({ ui: true }), SPEC_BODY).some((x) => x.field === 'ui')).toBe(false)
  })
  it('rejects a non-true ui value', () => {
    expect(validateDoc(specMeta({ ui: 'yes' }), SPEC_BODY).some((x) => x.field === 'ui' && x.rule === 'shape')).toBe(true)
  })
  it('rejects ui on a non-spec', () => {
    expect(validateDoc(planMeta({ ui: true }), '## Step: s1\nx\n').some((x) => x.field === 'ui' && x.rule === 'forbidden')).toBe(true)
  })
})

describe('design stamp shape', () => {
  it('accepts a well-formed stamp', () => {
    const meta = specMeta({ design: { sha: 'a'.repeat(64), spec: 'b'.repeat(64) } })
    expect(validateDoc(meta, SPEC_BODY).some((x) => x.field === 'design')).toBe(false)
  })
  it('refuses a malformed stamp', () => {
    const meta = specMeta({ design: { sha: 'nope', spec: 42 } })
    expect(validateDoc(meta, SPEC_BODY).some((x) => x.field === 'design' && x.rule === 'shape')).toBe(true)
  })
  it('refuses design on a non-spec', () => {
    const meta = planMeta({ design: { sha: 'a'.repeat(64), spec: 'b'.repeat(64) } })
    expect(validateDoc(meta, '## Step: s1\nx\n').some((x) => x.field === 'design' && x.rule === 'forbidden')).toBe(true)
  })
})

describe('validateDoc: principles', () => {
  it('accepts the principles doc and forbids criteria on it', () => {
    const meta = { id: 'principles', type: 'principles', status: 'draft', depends: [], needs: [] }
    expect(validateDoc(meta, '# Principles\n')).toEqual([])
    expect(validateDoc({ ...meta, criteria: [] }, '# Principles\n').map((x) => x.rule)).toContain('forbidden')
  })
})
