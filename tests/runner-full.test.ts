import { describe, expect, it } from 'vitest'
import type { RunnerConfig } from '../src/runner.js'
import { runFullSuite } from '../src/runner.js'
import { copyFixture, fakeCtx, fixtureEnv, tmpRepo } from './helpers.js'

const RC: Extract<RunnerConfig, { mode: 'full-suite' }> = {
  mode: 'full-suite',
  reportGlob: 'packages/*/reports/junit.xml',
  suiteCmd: 'sh run-all.sh',
}

describe('runFullSuite', () => {
  it('runs the workspace suite and merges per-package reports', async () => {
    const repo = tmpRepo()
    copyFixture(repo, 'workspace')
    const res = await runFullSuite(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), RC)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.run.exitZero).toBe(true)
    expect(res.value.tests).toHaveLength(3)
    expect(res.value.tests.every((t) => t.status === 'passed')).toBe(true)
  })

  it('deletes stale reports before running — a phantom never survives', async () => {
    const repo = tmpRepo()
    copyFixture(repo, 'workspace')
    repo.write('packages/pkg-a/reports/junit.xml', '<testsuite><testcase name="phantom @spec:ghost" classname="x"/></testsuite>')
    const res = await runFullSuite(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), RC)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.tests.some((t) => t.name.includes('phantom'))).toBe(false)
  })

  it('refuses no-reports when the suite command produces nothing — fail-closed', async () => {
    const repo = tmpRepo()
    copyFixture(repo, 'workspace')
    const res = await runFullSuite(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), { ...RC, suiteCmd: 'true' })
    expect(!res.ok && res.violations[0]?.rule).toBe('no-reports')
  })

  it('blocks an untrusted suite command in non-TTY', async () => {
    const repo = tmpRepo()
    copyFixture(repo, 'workspace')
    const res = await runFullSuite(repo.root, fakeCtx(repo.root, { tty: false }), RC)
    expect(!res.ok && res.violations[0]?.rule).toBe('untrusted-blocked')
  })
})
