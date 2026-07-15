import { describe, expect, it } from 'vitest'
import { canonPaths, loadConfig, resolvePaths } from '../src/config.js'
import { dirtyStatePaths, stateCommit } from '../src/gitio.js'
import { criteriaExcludes } from '../src/runner.js'
import { loadCanon } from '../src/scan.js'
import { tmpRepo, type TestRepo } from './helpers.js'

const DOCS_PATHS = 'schema: 1\npaths: { specs: docs/specs, plans: docs/plans }\n'

const doc = (id: string, type: 'spec' | 'plan') => [
  '---', `id: ${id}`, `type: ${type}`, 'status: draft', 'depends: []', 'needs: []', '---', '', `# ${id}`, '',
].join('\n')

function docsRepo(): TestRepo {
  const repo = tmpRepo()
  repo.write('specflow.config.yaml', DOCS_PATHS)
  repo.git('add', 'specflow.config.yaml')
  repo.git('commit', '-m', 'seed')
  return repo
}

describe('resolvePaths', () => {
  it('defaults when the paths key is absent and normalizes trailing slashes', () => {
    const absent = resolvePaths({})
    expect(absent.ok && absent.value).toEqual({ specs: 'specs', plans: 'plans' })
    const slashed = resolvePaths({ paths: { specs: 'docs/specs/', plans: 'docs/plans' } })
    expect(slashed.ok && slashed.value).toEqual({ specs: 'docs/specs', plans: 'docs/plans' })
  })

  it('refuses absolute, dot-segment, and reserved directories', () => {
    for (const [specs, rule] of [
      ['/abs/specs', 'invalid'], ['../up', 'invalid'], ['a/./b', 'invalid'], ['.specflow/specs', 'reserved'],
    ] as const) {
      const res = resolvePaths({ paths: { specs } })
      expect(!res.ok && res.violations[0]?.rule).toBe(rule)
    }
  })

  it('refuses equal or nested specs/plans directories', () => {
    const equal = resolvePaths({ paths: { specs: 'docs', plans: 'docs' } })
    expect(!equal.ok && equal.violations[0]?.rule).toBe('overlap')
    const nested = resolvePaths({ paths: { specs: 'docs', plans: 'docs/plans' } })
    expect(!nested.ok && nested.violations[0]?.rule).toBe('nested')
  })
})

describe('canon paths threading', () => {
  it('loadConfig refuses invalid paths; canonPaths falls back to defaults', () => {
    const repo = tmpRepo()
    repo.write('specflow.config.yaml', 'schema: 1\npaths: { specs: ../escape }\n')
    const cfg = loadConfig(repo.root)
    expect(!cfg.ok && cfg.violations[0]?.field).toBe('paths.specs')
    expect(canonPaths(repo.root)).toEqual({ specs: 'specs', plans: 'plans' })
  })

  it('loadCanon scans the configured directories and exposes them', () => {
    const repo = docsRepo()
    repo.write('docs/specs/auth.md', doc('auth', 'spec'))
    repo.write('docs/plans/auth-plan-1.md', doc('auth-plan-1', 'plan'))
    repo.write('specs/stray.md', doc('stray', 'spec'))
    const canon = loadCanon(repo.root)
    expect(canon.paths).toEqual({ specs: 'docs/specs', plans: 'docs/plans' })
    expect(canon.docs.map((d) => d.rel).sort()).toEqual(['docs/plans/auth-plan-1.md', 'docs/specs/auth.md'])
  })

  it('state commits follow the configured roots and refuse the old ones', () => {
    const repo = docsRepo()
    repo.write('docs/specs/auth.md', doc('auth', 'spec'))
    expect(dirtyStatePaths(repo.root)).toEqual(['docs/specs/auth.md'])
    const ok = stateCommit(repo.root, ['docs/specs/auth.md'], 'write(auth): create spec')
    expect(ok.ok).toBe(true)
    const bad = stateCommit(repo.root, ['specs/old.md'], 'write(old): create spec')
    expect(!bad.ok && bad.violations[0]?.rule).toBe('out-of-scope')
    expect(!bad.ok && bad.violations[0]?.want).toContain('docs/specs/')
  })

  it('criteria excludes protect the configured roots', () => {
    const repo = docsRepo()
    const cfg = loadConfig(repo.root)
    expect(cfg.ok).toBe(true)
    if (!cfg.ok) return
    expect(criteriaExcludes(cfg.value)).toEqual(['docs/specs/**', 'docs/plans/**', '.specflow/**'])
  })
})
