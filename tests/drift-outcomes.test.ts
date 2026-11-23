import { describe, expect, it } from 'vitest'
import { outcomesOf } from '../src/criteria.js'
import { readStream } from '../src/journal.js'
import {
  breakSingleFixture, copyFixture, fixtureEnv, seededRepo, singleConfig, stampLive, writeSpec, type TestRepo,
} from './helpers.js'

// Row 251. A full-suite drift run journals its spec's testcase outcomes — the counts and the
// failing names — so the track record (row 254) can tell a named failure from a run that
// could not verify. Filtered mode has no per-case report to read, so it journals none.

async function liveRepo(mode: 'filtered' | 'full-suite'): Promise<TestRepo> {
  const repo = await seededRepo()
  copyFixture(repo, 'vitest-single')
  repo.write('witness.config.yaml', singleConfig(mode))
  await writeSpec(repo, 'auth-refresh')
  stampLive(repo, 'auth-refresh')
  return repo
}
const lastDrift = (repo: TestRepo) => readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'drift-check').at(-1)!

describe('drift outcomes (row 251)', () => {
  it("a full-suite drift run journals the spec's testcase outcomes", async () => {
    const repo = await liveRepo('full-suite')
    expect((await repo.cli(['check', '--drift'], { env: fixtureEnv() })).code).toBe(0)
    expect(lastDrift(repo).outcomes).toEqual({ passed: 2, skipped: 0, failed: 0, failing: [] })
  })

  it('names each failing tagged case', async () => {
    const repo = await liveRepo('full-suite')
    breakSingleFixture(repo)
    await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    expect(lastDrift(repo).outcomes).toEqual({ passed: 0, skipped: 0, failed: 2,
      failing: ['issues a fresh token on rotation @spec:auth-refresh', 'rotates token before expiry @spec:auth-refresh'] })
  })

  it('names at most 50 failing cases, sorted and unique, and counts them all', () => {
    const tests = [...Array.from({ length: 60 }, (_, i) => ({ name: `case ${String(i).padStart(2, '0')} @spec:a`, classname: 'x', status: 'failed' as const })),
      { name: 'case 00 @spec:a', classname: 'y', status: 'failed' as const },
      { name: 'untagged', classname: 'x', status: 'failed' as const },
      { name: 'ok @spec:a', classname: 'x', status: 'passed' as const },
      { name: 'skip @spec:a', classname: 'x', status: 'skipped' as const }]
    const o = outcomesOf(tests, 'a')
    expect(o.failed).toBe(61)
    expect(o.passed).toBe(1)
    expect(o.skipped).toBe(1)
    expect(o.failing).toHaveLength(50)
    expect(o.failing[0]).toBe('case 00 @spec:a')
    expect(o.failing.at(-1)).toBe('case 49 @spec:a')
    expect(new Set(o.failing).size).toBe(50)
  })

  it('a full-suite run whose suite did not run journals zeros', async () => {
    const repo = await liveRepo('full-suite')            // no grant in .witness/allow.json
    await repo.cli(['check', '--drift'], { env: fixtureEnv({ WITNESS_TRUST_CMDS: '0' }) })
    const entry = lastDrift(repo)
    expect(entry.ok).toBe(false)
    expect(entry.outcomes).toEqual({ passed: 0, skipped: 0, failed: 0, failing: [] })
  })

  it('a filtered drift run journals no outcomes', async () => {
    const repo = await liveRepo('filtered')
    expect((await repo.cli(['check', '--drift'], { env: fixtureEnv() })).code).toBe(0)
    expect('outcomes' in lastDrift(repo)).toBe(false)
  })
})
