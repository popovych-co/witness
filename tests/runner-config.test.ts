import { describe, expect, it } from 'vitest'
import { resolveSettings, type Config } from '../src/config.js'
import { migrateValues } from '../src/migration.js'
import { criteriaExcludes, runnerConfig } from '../src/runner.js'

// A schema-1 file's values as loadConfig reads them (row 193): the in-memory upgrade, then the
// lenient resolver. A value's own shape — {id}, junit: — refuses there, at load.
const resolved = (raw: Record<string, unknown>) => {
  const m = migrateValues({ schema: 1, ...raw }, 1, { mode: 'memory' })
  return m.ok ? resolveSettings(m.value.raw, 'lenient') : m
}
const cfg = (raw: Record<string, unknown>): Config => {
  const r = resolved(raw)
  if (!r.ok) throw new Error(JSON.stringify(r.violations))
  return { schema: 1, ...r.value }
}

describe('runnerConfig', () => {
  it('parses a filtered template containing {id}', () => {
    const res = runnerConfig(cfg({ criteria: { runner: 'npm test -- -t "@spec:{id}"' } }))
    expect(res.ok && res.value).toEqual({ mode: 'filtered', template: 'npm test -- -t "@spec:{id}"' })
  })

  it('refuses a template without the {id} placeholder, at load', () => {
    const res = resolved({ criteria: { runner: 'npm test' } })
    expect(!res.ok && res.violations[0]?.rule).toBe('no-id-placeholder')
  })

  it('parses full-suite with junit report glob and ship.test', () => {
    const res = runnerConfig(cfg({
      criteria: { runner: 'full-suite', report: 'junit:**/reports/junit.xml' },
      ship: { test: 'npm test' },
    }))
    expect(res.ok && res.value).toEqual({ mode: 'full-suite', reportGlob: '**/reports/junit.xml', suiteCmd: 'npm test' })
  })

  it('refuses full-suite without a junit report glob', () => {
    const missing = runnerConfig(cfg({ criteria: { runner: 'full-suite' }, ship: { test: 'npm test' } }))
    expect(!missing.ok && missing.violations[0]?.field).toBe('criteria.report')
    const wrongFormat = resolved({ criteria: { runner: 'full-suite', report: 'tap:out.tap' }, ship: { test: 'npm test' } })
    expect(!wrongFormat.ok && wrongFormat.violations[0]?.rule).toBe('report-format')
  })

  it('refuses full-suite without ship.test — the command that produces reports (resolution 1)', () => {
    const res = runnerConfig(cfg({ criteria: { runner: 'full-suite', report: 'junit:**/junit.xml' } }))
    expect(!res.ok && res.violations[0]?.field).toBe('ship.test')
  })

  it('filtered mode accepts an optional junit report', () => {
    const r = runnerConfig(cfg({ criteria: { runner: 'run {id}', report: 'junit:**/junit.xml' } }))
    expect(r.ok && r.value).toEqual({ mode: 'filtered', template: 'run {id}', reportGlob: '**/junit.xml' })
  })

  it('filtered mode refuses a non-junit report', () => {
    const r = resolved({ criteria: { runner: 'run {id}', report: 'tap:foo' } })
    expect(!r.ok && r.violations[0]?.rule).toBe('report-format')
  })

  it('refuses a missing runner', () => {
    const res = runnerConfig(cfg({}))
    expect(!res.ok && res.violations[0]?.field).toBe('criteria.runner')
    expect(!res.ok && res.violations[0]?.rule).toBe('required')
  })
})

describe('criteriaExcludes', () => {
  it('always excludes state dirs and appends config globs', () => {
    const out = criteriaExcludes(cfg({ criteria: { exclude: ['fixtures/**'] } }))
    expect(out).toEqual(['specs/**', 'plans/**', '.witness/**', 'fixtures/**'])
  })

  it('defaults to state dirs only', () => {
    expect(criteriaExcludes(cfg({}))).toEqual(['specs/**', 'plans/**', '.witness/**'])
  })
})
