import { describe, expect, it } from 'vitest'
import { extractCanonicalTags, matchesTag, normalizeName } from '../src/matcher.js'

describe('normalizeName', () => {
  it('lowercases and maps underscores to hyphens', () => {
    expect(normalizeName('Test_Rotates_Token__SPEC_Auth_Refresh')).toBe('test-rotates-token--spec-auth-refresh')
  })
})

describe('matchesTag', () => {
  it('matches the canonical form anywhere in the name', () => {
    expect(matchesTag('rotates token before expiry @spec:auth-refresh', 'auth-refresh')).toBe(true)
    expect(matchesTag('@spec:auth-refresh comes first', 'auth-refresh')).toBe(true)
  })

  it('matches name-hostile underscore names via normalization', () => {
    expect(matchesTag('test_rotates_token__spec_auth_refresh', 'auth-refresh')).toBe(true)
    expect(matchesTag('TEST_ROTATES__SPEC_AUTH_REFRESH', 'auth-refresh')).toBe(true)
  })

  it('never matches an id prefix of a longer tag', () => {
    expect(matchesTag('rotates @spec:auth-refresh', 'auth')).toBe(false)
    expect(matchesTag('test__spec_auth_refresh', 'auth')).toBe(false)
  })

  it('never matches a tag embedded in a longer word', () => {
    expect(matchesTag('respec-auth-refresh test', 'auth-refresh')).toBe(false)
    expect(matchesTag('inspects auth-refresh', 'auth-refresh')).toBe(false)
  })

  it('accepts a boundary after the id (space, paren, end)', () => {
    expect(matchesTag('x @spec:auth-refresh (slow)', 'auth-refresh')).toBe(true)
    expect(matchesTag('x __spec_auth_refresh done', 'auth-refresh')).toBe(true)
  })

  it('rejects when the tag continues into more charset characters', () => {
    expect(matchesTag('x @spec:auth-refresh-extra', 'auth-refresh')).toBe(false)
  })
})

describe('extractCanonicalTags', () => {
  it('extracts every canonical tag, charset-bounded', () => {
    expect(extractCanonicalTags('a @spec:auth-refresh b @spec:quota) c')).toEqual(['auth-refresh', 'quota'])
  })

  it('finds nothing in underscore-form text (canonical only — resolution 3)', () => {
    expect(extractCanonicalTags('test__spec_auth_refresh')).toEqual([])
  })
})
