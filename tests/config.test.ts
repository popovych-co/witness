import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { tmpRepo } from './helpers.js'

describe('loadConfig', () => {
  it('refuses when the config is missing', () => {
    const repo = tmpRepo()
    const res = loadConfig(repo.root)
    expect(!res.ok && res.violations[0]?.rule).toBe('missing')
  })

  it('loads schema 1 and preserves unknown keys', () => {
    const repo = tmpRepo()
    repo.write('specflow.config.yaml', 'schema: 1\nship: { test: "npm test" }\n')
    const res = loadConfig(repo.root)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.schema).toBe(1)
    expect((res.value.raw.ship as Record<string, unknown>).test).toBe('npm test')
    expect(res.value.warning).toBeUndefined()
  })

  it('refuses a newer schema and warns on an older one', () => {
    const repo = tmpRepo()
    repo.write('specflow.config.yaml', 'schema: 2\n')
    const newer = loadConfig(repo.root)
    expect(!newer.ok && newer.violations[0]?.rule).toBe('newer-than-cli')
    expect(!newer.ok && newer.violations[0]?.want).toContain('upgrade specflow')
    repo.write('specflow.config.yaml', 'schema: 0\n')
    const older = loadConfig(repo.root)
    expect(older.ok && older.value.warning).toContain('specflow migrate')
  })

  it('refuses yaml errors and a missing schema key', () => {
    const repo = tmpRepo()
    repo.write('specflow.config.yaml', 'schema: [unclosed\n')
    expect(loadConfig(repo.root).ok).toBe(false)
    repo.write('specflow.config.yaml', 'ship: {}\n')
    const res = loadConfig(repo.root)
    expect(!res.ok && res.violations[0]?.rule).toBe('required')
  })
})

describe('resolveDocs (docs registry)', () => {
  it('absent docs key → empty registry', () => {
    const repo = tmpRepo()
    repo.write('specflow.config.yaml', 'schema: 1\n')
    const res = loadConfig(repo.root)
    expect(res.ok && res.value.docs).toEqual({})
  })

  it('accepts enumerated keys and exposes them on Config', () => {
    const repo = tmpRepo()
    repo.write('specflow.config.yaml', 'schema: 1\ndocs:\n  conventions: [docs/code/architecture.md, CLAUDE.md]\n')
    const res = loadConfig(repo.root)
    expect(res.ok && res.value.docs.conventions).toEqual(['docs/code/architecture.md', 'CLAUDE.md'])
  })

  it('refuses a key with no shipped consumer', () => {
    const repo = tmpRepo()
    repo.write('specflow.config.yaml', 'schema: 1\ndocs:\n  security: [docs/threat-model.md]\n')
    const res = loadConfig(repo.root)
    expect(!res.ok && res.violations[0]?.rule).toBe('unknown-doc-key')
    expect(!res.ok && res.violations[0]?.want).toContain('conventions')
  })

  it('refuses empty lists, non-lists, traversal and .specflow paths', () => {
    const repo = tmpRepo()
    repo.write('specflow.config.yaml', 'schema: 1\ndocs:\n  conventions: []\n')
    expect(loadConfig(repo.root).ok).toBe(false)
    repo.write('specflow.config.yaml', 'schema: 1\ndocs:\n  conventions: CLAUDE.md\n')
    expect(loadConfig(repo.root).ok).toBe(false)
    repo.write('specflow.config.yaml', 'schema: 1\ndocs:\n  conventions: [../escape.md]\n')
    expect(loadConfig(repo.root).ok).toBe(false)
    repo.write('specflow.config.yaml', 'schema: 1\ndocs:\n  conventions: [.specflow/journal/x.md]\n')
    const res = loadConfig(repo.root)
    expect(!res.ok && res.violations[0]?.rule).toBe('reserved')
  })
})

describe('paths.designs (design stage)', () => {
  it('defaults designs to "designs"', () => {
    const repo = tmpRepo()
    repo.write('specflow.config.yaml', 'schema: 1\n')
    const res = loadConfig(repo.root)
    expect(res.ok && res.value.paths.designs).toBe('designs')
  })

  it('accepts a custom designs dir', () => {
    const repo = tmpRepo()
    repo.write('specflow.config.yaml', 'schema: 1\npaths:\n  designs: docs/designs\n')
    const res = loadConfig(repo.root)
    expect(res.ok && res.value.paths.designs).toBe('docs/designs')
  })

  it('refuses designs overlapping or nested with specs/plans', () => {
    const repo = tmpRepo()
    repo.write('specflow.config.yaml', 'schema: 1\npaths:\n  specs: designs\n  designs: designs\n')
    expect(loadConfig(repo.root).ok).toBe(false)
    repo.write('specflow.config.yaml', 'schema: 1\npaths:\n  designs: specs/looks\n')
    const res = loadConfig(repo.root)
    expect(!res.ok && res.violations[0]?.rule).toBe('nested')
  })

  it('refuses .specflow and traversal for designs', () => {
    const repo = tmpRepo()
    repo.write('specflow.config.yaml', 'schema: 1\npaths:\n  designs: .specflow/looks\n')
    expect(!loadConfig(repo.root).ok).toBe(true)
  })
})

describe('DOC_KEYS (design consumer shipped)', () => {
  it('accepts the design key now that the design gate consumes it', () => {
    const repo = tmpRepo()
    repo.write('specflow.config.yaml', 'schema: 1\ndocs:\n  design: [docs/ui/design-language.md]\n')
    const res = loadConfig(repo.root)
    expect(res.ok && res.value.docs.design).toEqual(['docs/ui/design-language.md'])
  })
})

describe('resolveImplement (implement.stepsPerDispatch)', () => {
  it('defaults to 3 when the key or section is absent', () => {
    const repo = tmpRepo()
    repo.write('specflow.config.yaml', 'schema: 1\n')
    const res = loadConfig(repo.root)
    expect(res.ok && res.value.implement.stepsPerDispatch).toBe(3)
  })

  it('accepts a valid integer override', () => {
    const repo = tmpRepo()
    repo.write('specflow.config.yaml', 'schema: 1\nimplement:\n  stepsPerDispatch: 5\n')
    const res = loadConfig(repo.root)
    expect(res.ok && res.value.implement.stepsPerDispatch).toBe(5)
  })

  it('refuses zero, negatives, non-integers and strings', () => {
    for (const bad of ['0', '-2', '2.5', '"three"']) {
      const repo = tmpRepo()
      repo.write('specflow.config.yaml', `schema: 1\nimplement:\n  stepsPerDispatch: ${bad}\n`)
      const res = loadConfig(repo.root)
      expect(res.ok, `expected refusal for ${bad}`).toBe(false)
      expect(!res.ok && res.violations[0]?.field).toBe('implement.stepsPerDispatch')
      expect(!res.ok && res.violations[0]?.want).toContain('integer >= 1')
    }
  })

  it('refuses a non-map implement section', () => {
    const repo = tmpRepo()
    repo.write('specflow.config.yaml', 'schema: 1\nimplement: nope\n')
    const res = loadConfig(repo.root)
    expect(!res.ok && res.violations[0]?.field).toBe('implement')
  })
})
