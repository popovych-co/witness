import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import {
  FIRST_LINE, GROUP_HEADINGS, RETIRED, SCHEMA_COMMENT, SCHEMA_FINGERPRINTS, SECTION_ORDER, SETTINGS,
  defaultAt, defaultValues, fingerprint, knownAt, settingAt, withValues,
} from '../src/settings.js'

const fixture = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', 'configs', name), 'utf8')

describe('the settings list (row 193)', () => {
  it('holds 36 settings, each path once, each section in SECTION_ORDER', () => {
    expect(SETTINGS).toHaveLength(36)
    expect(new Set(SETTINGS.map((s) => s.path)).size).toBe(36)
    for (const s of SETTINGS) expect(SECTION_ORDER, s.path).toContain(s.path.split('.')[0])
    // the list is the file's order: sections appear in SECTION_ORDER, never interleaved
    const sections = SETTINGS.map((s) => s.path.split('.')[0]!).filter((x, i, a) => a[i - 1] !== x)
    expect(sections).toEqual([...SECTION_ORDER])
  })

  it('marks exactly the settings the hooks read', () => {
    expect(new Set(SETTINGS.filter((s) => s.hookRead).map((s) => s.path)))
      .toEqual(new Set(['paths.specs', 'paths.plans', 'paths.designs', 'autonomy', 'session.contextLimit']))
  })

  it('no comment names a key the hook readers match', () => {
    const texts = [...SETTINGS.map((s) => s.comment), FIRST_LINE, SCHEMA_COMMENT, ...Object.values(GROUP_HEADINGS)]
    for (const t of texts) expect(t).not.toMatch(/\b(specs|plans|designs|contextLimit):/)
  })

  it('knows gates.model at schema 1 and arbiter.model only from 2', () => {
    expect(knownAt(1).has('gates.model')).toBe(true)
    expect(knownAt(1).has('arbiter.model')).toBe(false)
    expect(knownAt(2).has('arbiter.model')).toBe(true)
    expect(knownAt(2).has('gates.model')).toBe(false)
    expect(RETIRED.map((r) => r.path)).toEqual(['gates.model'])
  })

  it('gives the defaults of §4.5', () => {
    expect(defaultValues({ harness: 'claude-code' })).toEqual(parse(fixture('default.yaml')))
    const pin = settingAt('gates.plan.model')!
    expect(defaultAt(pin, 1)).toBeUndefined()
    expect(defaultAt(pin, 2)).toBe('claude-opus-5-5')
    expect(defaultAt(settingAt('arbiter.model')!, 1)).toBeUndefined()
    expect(defaultValues({ schema: 1 })).not.toHaveProperty('arbiter')
    expect(defaultValues({ harness: 'pi' }).harness).toBe('pi')
  })

  it('withValues merges maps, replaces lists, deletes on undefined', () => {
    const base = { a: { b: 1, c: [1, 2], d: { e: 1 } }, f: 'x' }
    const out = withValues(base, { a: { b: undefined, c: [3], d: { g: 2 } }, h: true })
    expect(out).toEqual({ a: { c: [3], d: { e: 1, g: 2 } }, f: 'x', h: true })
    expect(base).toEqual({ a: { b: 1, c: [1, 2], d: { e: 1 } }, f: 'x' })   // never mutates
  })

  it('pins every schema fingerprint', () => {
    for (const [s, want] of Object.entries(SCHEMA_FINGERPRINTS)) {
      expect(fingerprint(Number(s)),
        `schema ${s}'s settings changed (${fingerprint(Number(s))}): a change to a path, shape or default needs a new `
        + 'schema step — add the default under the next schema number, raise SCHEMA_VERSION and pin its fingerprint')
        .toBe(want)
    }
    expect(Object.keys(SCHEMA_FINGERPRINTS).map(Number).sort()).toEqual([1, 2])
  })

  it('a comment-only change raises no schema step', () => {
    const edited = SETTINGS.map((s) => (s.path === 'session.contextLimit' ? { ...s, comment: 'changed words' } : s))
    expect(fingerprint(2, edited)).toBe(fingerprint(2))
    const moved = SETTINGS.map((s) => (s.path === 'session.contextLimit' ? { ...s, defaults: { 1: 25 } } : s))
    expect(fingerprint(2, moved)).not.toBe(fingerprint(2))
  })
})
