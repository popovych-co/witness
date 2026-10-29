import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseJUnit } from '../src/junit.js'
import { breakSingleFixture, copyFixture, fixtureEnv, spawnAsync, tmpRepo, vitestBin } from './helpers.js'

// Each fixture run is a nested suite, awaited rather than execSync'd (helpers.ts spawnAsync).
const run = async (cwd: string, cmd: string): Promise<number> =>
  ((await spawnAsync('sh', ['-c', cmd], { cwd, env: fixtureEnv() })).code === 0 ? 0 : 1)

describe('fixture: vitest-single', () => {
  it('runs green, then red after breakSingleFixture', async () => {
    const repo = tmpRepo()
    copyFixture(repo, 'vitest-single')
    expect(await run(repo.root, `node "${vitestBin()}" run`)).toBe(0)
    breakSingleFixture(repo)
    expect(await run(repo.root, `node "${vitestBin()}" run`)).toBe(1)
  })
})

describe('fixture: workspace', () => {
  it('run-all.sh writes one junit report per package', async () => {
    const repo = tmpRepo()
    copyFixture(repo, 'workspace')
    expect(await run(repo.root, 'sh run-all.sh')).toBe(0)
    const a = join(repo.root, 'packages/pkg-a/reports/junit.xml')
    const b = join(repo.root, 'packages/pkg-b/reports/junit.xml')
    expect(existsSync(a) && existsSync(b)).toBe(true)
    const names = [a, b].flatMap((p) => parseJUnit(readFileSync(p, 'utf8'))).map((t) => t.name)
    expect(names.some((n) => n.includes('@spec:rate-limit'))).toBe(true)
    expect(names.some((n) => n.includes('@spec:quota'))).toBe(true)
  })

  it('run-filtered.sh forwards the filter and passes with zero matches', async () => {
    const repo = tmpRepo()
    copyFixture(repo, 'workspace')
    expect(await run(repo.root, 'sh run-filtered.sh rate-limit')).toBe(0)
    expect(await run(repo.root, 'sh run-filtered.sh no-such-spec')).toBe(0)
  })
})
