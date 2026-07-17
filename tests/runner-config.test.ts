import { describe, expect, it } from 'vitest'
import { DEFAULT_PATHS, type Config } from '../src/config.js'
import { criteriaExcludes, runnerConfig } from '../src/runner.js'

const cfg = (raw: Record<string, unknown>): Config => ({ schema: 1, raw, paths: DEFAULT_PATHS })

describe('runnerConfig', () => {
  it('parses a filtered template containing {id}', () => {
    const res = runnerConfig(cfg({ criteria: { runner: 'npm test -- -t "@spec:{id}"' } }))
    expect(res.ok && res.value).toEqual({ mode: 'filtered', template: 'npm test -- -t "@spec:{id}"' })
  })

  it('refuses a template without the {id} placeholder', () => {
    const res = runnerConfig(cfg({ criteria: { runner: 'npm test' } }))
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
    const wrongFormat = runnerConfig(cfg({ criteria: { runner: 'full-suite', report: 'tap:out.tap' }, ship: { test: 'npm test' } }))
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
    const r = runnerConfig(cfg({ criteria: { runner: 'run {id}', report: 'tap:foo' } }))
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
    expect(out).toEqual(['specs/**', 'plans/**', '.specflow/**', 'fixtures/**'])
  })

  it('defaults to state dirs only', () => {
    expect(criteriaExcludes(cfg({}))).toEqual(['specs/**', 'plans/**', '.specflow/**'])
  })
})
