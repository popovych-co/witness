import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseJUnit } from '../src/junit.js'
import { breakSingleFixture, copyFixture, fixtureEnv, tmpRepo, vitestBin } from './helpers.js'

const run = (cwd: string, cmd: string): number => {
  try {
    execSync(cmd, { cwd, env: fixtureEnv(), stdio: 'pipe' })
    return 0
  } catch {
    return 1
  }
}

describe('fixture: vitest-single', () => {
  it('runs green, then red after breakSingleFixture', () => {
    const repo = tmpRepo()
    copyFixture(repo, 'vitest-single')
    expect(run(repo.root, `node "${vitestBin()}" run`)).toBe(0)
    breakSingleFixture(repo)
    expect(run(repo.root, `node "${vitestBin()}" run`)).toBe(1)
  })
})

describe('fixture: workspace', () => {
  it('run-all.sh writes one junit report per package', () => {
    const repo = tmpRepo()
    copyFixture(repo, 'workspace')
    expect(run(repo.root, 'sh run-all.sh')).toBe(0)
    const a = join(repo.root, 'packages/pkg-a/reports/junit.xml')
    const b = join(repo.root, 'packages/pkg-b/reports/junit.xml')
    expect(existsSync(a) && existsSync(b)).toBe(true)
    const names = [a, b].flatMap((p) => parseJUnit(readFileSync(p, 'utf8'))).map((t) => t.name)
    expect(names.some((n) => n.includes('@spec:rate-limit'))).toBe(true)
    expect(names.some((n) => n.includes('@spec:quota'))).toBe(true)
  })

  it('run-filtered.sh forwards the filter and passes with zero matches', () => {
    const repo = tmpRepo()
    copyFixture(repo, 'workspace')
    expect(run(repo.root, 'sh run-filtered.sh rate-limit')).toBe(0)
    expect(run(repo.root, 'sh run-filtered.sh no-such-spec')).toBe(0)
  })
})
