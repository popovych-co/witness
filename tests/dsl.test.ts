import { describe, expect, it } from 'vitest'
import { validateCriteria, validateNeeds } from '../src/dsl.js'

describe('validateCriteria', () => {
  it('accepts a valid test + cmd pair', () => {
    expect(validateCriteria([
      { id: 'ac-rotate', test: '@spec:auth-refresh' },
      { id: 'ac-smoke', cmd: 'npm run smoke:auth' },
    ], 'auth-refresh')).toEqual([])
  })

  it('requires at least one criterion', () => {
    expect(validateCriteria([], 'x')[0]?.rule).toBe('required')
    expect(validateCriteria(undefined, 'x')[0]?.rule).toBe('required')
  })

  it('refuses duplicate or malformed ids', () => {
    const dup = validateCriteria([
      { id: 'ac-a', cmd: 'true' },
      { id: 'ac-a', cmd: 'false' },
    ], 'x')
    expect(dup.map((x) => x.rule)).toContain('id-unique')
    expect(validateCriteria([{ id: 'AC_1', cmd: 'true' }], 'x')[0]?.rule).toBe('id-charset')
  })

  it('demands exactly one of test | cmd', () => {
    expect(validateCriteria([{ id: 'ac-a' }], 'x')[0]?.rule).toBe('kind')
    expect(validateCriteria([{ id: 'ac-a', test: '@spec:x', cmd: 'true' }], 'x')[0]?.rule).toBe('kind')
  })

  it('pins the test tag to the owning spec id', () => {
    const out = validateCriteria([{ id: 'ac-a', test: '@spec:other' }], 'auth-refresh')
    expect(out[0]?.rule).toBe('tag-format')
    expect(out[0]?.want).toBe('@spec:auth-refresh')
  })
})

describe('validateNeeds', () => {
  it('accepts the three kinds and absence', () => {
    expect(validateNeeds(undefined)).toEqual([])
    expect(validateNeeds([
      { env: 'STRIPE_API_KEY' },
      { cmd: 'npm ls stripe' },
      { manual: 'Stripe sandbox account created', satisfied: false },
    ])).toEqual([])
  })

  it('refuses mixed or empty kinds and manual without satisfied', () => {
    expect(validateNeeds([{ env: 'A', cmd: 'b' }])[0]?.rule).toBe('kind')
    expect(validateNeeds([{}])[0]?.rule).toBe('kind')
    expect(validateNeeds([{ manual: 'x' }])[0]?.rule).toBe('required')
  })
})
