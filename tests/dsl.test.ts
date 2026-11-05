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

// Row 239 (the plan's B14). A criterion's and a need's id are printed into commands witness offers,
// where a word that starts with `-` is read as a flag.
describe('ids (row 239)', () => {
  it('a criterion or need id may not start with - (row 239)', () => {
    expect(validateCriteria([{ id: '-x', cmd: 'true' }], 'x'))
      .toEqual([{ field: 'criteria[0].id', rule: 'id-charset', got: '-x', want: '[a-z0-9][a-z0-9-]*' }])
    expect(validateNeeds([{ id: '-n', manual: 'x', satisfied: false }]))
      .toEqual([{ field: 'needs[0].id', rule: 'id-charset', got: '-n', want: '[a-z0-9][a-z0-9-]*' }])
  })
})
