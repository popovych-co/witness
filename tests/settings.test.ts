import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import {
  FIRST_LINE, GROUP_HEADINGS, RETIRED, SCHEMA_COMMENT, SCHEMA_FINGERPRINTS, SECTION_ORDER, SETTINGS,
  READER_TOOLS, defaultAt, defaultValues, fingerprint, knownAt, settingAt, shapeAt, withValues,
} from '../src/settings.js'
import { SCHEMA_VERSION } from '../src/config.js'
import { RELEASED_COMMENTS } from '../src/released-comments.js'

const fixture = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', 'configs', name), 'utf8')

describe('the settings list (row 193)', () => {
  it('holds 42 settings, each path once, each section in SECTION_ORDER', () => {
    expect(SETTINGS).toHaveLength(42)
    expect(new Set(SETTINGS.map((s) => s.path)).size).toBe(42)
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
    expect(Object.keys(SCHEMA_FINGERPRINTS).map(Number).sort()).toEqual([1, 2, 3, 4])
  })

  it('a comment-only change raises no schema step', () => {
    const edited = SETTINGS.map((s) => (s.path === 'session.contextLimit' ? { ...s, comment: 'changed words' } : s))
    expect(fingerprint(2, edited)).toBe(fingerprint(2))
    const moved = SETTINGS.map((s) => (s.path === 'session.contextLimit' ? { ...s, defaults: { 1: 25 } } : s))
    expect(fingerprint(2, moved)).not.toBe(fingerprint(2))
  })
})

describe('scratch.prepare (row 259)', () => {
  it('schema 3 adds scratch.prepare: setup, ambient, a shell command or none (row 259)', () => {
    expect(settingAt('scratch.prepare')).toMatchObject({ shape: { kind: 'text' }, since: 3, defaults: { 3: 'none' }, ambient: true, group: 'setup' })
    expect(SCHEMA_VERSION).toBe(4)
    expect(defaultValues({ harness: 'claude-code' })).toMatchObject({ schema: 4, scratch: { prepare: 'none' } })
    expect(defaultValues({ detected: { 'scratch.prepare': 'npm ci' } }).scratch).toEqual({ prepare: 'npm ci' })
    expect(defaultValues({ schema: 2 })).not.toHaveProperty('scratch')
  })
})

describe('ship.lint parts (row 261)', () => {
  it('ship.lint takes named parts from schema 3; schemas 1–2 keep text (row 261)', () => {
    const s = settingAt('ship.lint')!
    expect(s).toMatchObject({ shape: { kind: 'parts' }, older: { until: 2, shape: { kind: 'text' } }, since: 1, defaults: { 1: 'npm run lint' } })
    expect(shapeAt(s, 2)).toEqual({ kind: 'text' })
    expect(shapeAt(s, 3)).toEqual({ kind: 'parts' })
  })
})

describe('ship.lint\'s comment (row 265)', () => {
  it('ship.lint\'s comment says both code gates run it (row 265)', () => {
    const comment = 'the lint the implement and ship gates run · one command, or name: command parts, each run on its own · a part named biome, eslint, clippy or tsc is read per diagnostic'
    expect(settingAt('ship.lint')!.comment).toBe(comment)
    expect(RELEASED_COMMENTS.has(comment)).toBe(true)
    expect(RELEASED_COMMENTS.has('the lint command ship runs')).toBe(true)     // 0.30's text stays
  })
})

describe('readers (row 262)', () => {
  it('schema 3 adds a reader per tool, none by default, right after ship (row 262)', () => {
    for (const t of READER_TOOLS) {
      expect(settingAt(`readers.${t}`)).toMatchObject({ shape: { kind: 'text' }, since: 3, defaults: { 3: 'none' }, group: 'setup' })
      expect(settingAt(`readers.${t}`)!.ambient).toBeUndefined()
    }
    expect(defaultValues({}).readers).toEqual({ biome: 'none', eslint: 'none', clippy: 'none', tsc: 'none' })
    expect(defaultValues({ schema: 2 })).not.toHaveProperty('readers')
    expect(SECTION_ORDER.indexOf('readers')).toBe(SECTION_ORDER.indexOf('ship') + 1)
  })

  it('a reader is told to report every error, never stopping at the first failure (slice 2 review I1)', () => {
    for (const t of READER_TOOLS) {
      const s = settingAt(`readers.${t}`)!
      expect(s.comment).toContain('every error')
      expect(s.want).toContain('never stopping at the first failure')
    }
  })
})

describe('checks.switchOffs (row 273)', () => {
  it('schema 4 adds checks.switchOffs, [] by default, and pins its fingerprint; the older ones hold (row 273)', () => {
    expect(SCHEMA_FINGERPRINTS[4]).toBe(fingerprint(4))
    expect([1, 2, 3].map((n) => fingerprint(n))).toEqual([1, 2, 3].map((n) => SCHEMA_FINGERPRINTS[n]))
    expect(settingAt('checks.switchOffs')).toMatchObject({ since: 4, shape: { kind: 'tokens' }, defaults: { 4: [] }, group: 'setup' })
    expect(settingAt('checks.switchOffs')!.ambient).toBeUndefined()
    expect(defaultValues({ harness: 'claude-code' })).toMatchObject({ schema: 4, checks: { switchOffs: [] } })
    expect(defaultValues({ schema: 3 })).not.toHaveProperty('checks')
    expect(SECTION_ORDER.indexOf('checks')).toBe(SECTION_ORDER.indexOf('readers') + 1)
  })
})
