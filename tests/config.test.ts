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
