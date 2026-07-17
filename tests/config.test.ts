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
    repo.write('specflow.config.yaml', 'schema: 1\ndocs:\n  design: [docs/ui/design-language.md]\n')
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
