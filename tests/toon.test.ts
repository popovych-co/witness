import { describe, expect, it } from 'vitest'
import { kv, list, rows } from '../src/toon.js'
import { renderRefusal, v } from '../src/refusal.js'

describe('toon', () => {
  it('renders scalars, lists and tabular rows', () => {
    expect(kv('schema', 1)).toBe('schema: 1')
    expect(list('depends', ['auth-login', 'db'])).toBe('depends[2]: auth-login,db')
    expect(rows('efforts', ['slug', 'class'], [{ slug: 'auth-hardening', class: 'feature' }])).toEqual([
      'efforts[1]{slug,class}:',
      '  auth-hardening,feature',
    ])
  })

  it('escapes values containing commas, quotes or edge whitespace', () => {
    expect(kv('summary', 'a, b')).toBe('summary: "a, b"')
    expect(kv('note', 'say "hi"')).toBe('note: "say ""hi"""')
    expect(kv('pad', ' x')).toBe('pad: " x"')
  })
})

describe('refusal', () => {
  it('renders violations as a refused table plus help line', () => {
    const out = renderRefusal([v('summary', 'max-length', '141 chars', '<=120 chars')])
    expect(out[0]).toBe('refused[1]{field,rule,got,want}:')
    expect(out[1]).toBe('  summary,max-length,141 chars,<=120 chars')
    expect(out[2]).toMatch(/^help: /)
  })
})
