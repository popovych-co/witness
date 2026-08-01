import { describe, expect, it } from 'vitest'
import { trailingFails } from '../src/drift.js'
import { readStream, type Entry } from '../src/journal.js'
import type { TestRepo } from './helpers.js'
import {
  SPEC_META, breakSingleFixture, copyFixture, fixtureEnv, seededRepo, singleConfig, stampLive, writeSpec,
} from './helpers.js'

async function liveSingleRepo(): Promise<TestRepo> {
  const repo = await seededRepo()
  copyFixture(repo, 'vitest-single')
  repo.write('witness.config.yaml', singleConfig('filtered'))
  await writeSpec(repo, 'auth-refresh')
  stampLive(repo, 'auth-refresh')
  return repo
}

const trailerCount = (repo: TestRepo): number =>
  repo.git('log', '--format=%B').split('\n').filter((l) => l.trim() === 'Witness-State: 1').length

describe('witness check --drift (local)', () => {
  it('journals a drift-check entry per live spec in one state commit', async () => {
    const repo = await liveSingleRepo()
    const before = trailerCount(repo)
    const res = await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    expect(res.code).toBe(0)
    const entries = readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'drift-check')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ v: 1, artifact: 'auth-refresh', ok: true, tags: 2 })
    expect(String(entries[0]?.run_id)).toMatch(/^r-[0-9a-f]{8}$/)
    expect(entries[0]?.at).toBeUndefined()
    expect(trailerCount(repo)).toBe(before + 1)
  })

  it('exits 1 and journals ok:false when the lane is red', async () => {
    const repo = await liveSingleRepo()
    breakSingleFixture(repo)
    const res = await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    expect(res.code).toBe(1)
    const entry = readStream(repo.root, 'auth-refresh').at(-1)
    expect(entry?.ok).toBe(false)
  })

  it('sweeps only live specs and shares one run_id across entries', async () => {
    const repo = await liveSingleRepo()
    await writeSpec(repo, 'ghost', { ...SPEC_META, summary: 'ghost slice', criteria: [{ id: 'ac-g', test: '@spec:ghost' }] })
    stampLive(repo, 'ghost')
    await writeSpec(repo, 'draft-only', { ...SPEC_META, summary: 'never swept', criteria: [{ id: 'ac-d', test: '@spec:draft-only' }] })
    await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    const auth = readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'drift-check')
    const ghost = readStream(repo.root, 'ghost').filter((e) => e.t === 'drift-check')
    expect(auth).toHaveLength(1)
    expect(ghost).toHaveLength(1)
    expect(ghost[0]?.ok).toBe(false)
    expect(auth[0]?.run_id).toBe(ghost[0]?.run_id)
    expect(readStream(repo.root, 'draft-only').some((e) => e.t === 'drift-check')).toBe(false)
  })

  it('refuses --deep as reserved', async () => {
    const repo = await liveSingleRepo()
    const res = await repo.cli(['check', '--drift', '--deep'], { env: fixtureEnv() })
    expect(res.code).toBe(2)
  })

  // A repo with no live specs sweeps nothing: no journal entries, no drift stamps, so
  // the state commit's path set is empty. That used to reach `git commit --only ... --`
  // with an empty pathspec, which git rejects fatally — surfacing as an
  // `unexpected-error` telling the human to report a bug, on a perfectly clean repo.
  it('exits 0 without committing when there is nothing to sweep', async () => {
    const repo = await seededRepo()
    const before = trailerCount(repo)
    const res = await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    expect(res.stderr).not.toContain('unexpected-error')
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('drift-summary: 0/0 failing')
    expect(trailerCount(repo)).toBe(before)
  })
})

describe('witness check --drift (CI read-only)', () => {
  it('reports and exits nonzero without writing anything', async () => {
    const repo = await liveSingleRepo()
    breakSingleFixture(repo)
    const before = trailerCount(repo)
    const res = await repo.cli(['check', '--drift'], { env: { ...fixtureEnv(), CI: 'true' } })
    expect(res.code).toBe(1)
    expect(readStream(repo.root, 'auth-refresh').some((e) => e.t === 'drift-check')).toBe(false)
    expect(trailerCount(repo)).toBe(before)
  })

  it('--ci forces read-only even without the env var', async () => {
    const repo = await liveSingleRepo()
    const res = await repo.cli(['check', '--drift', '--ci'], { env: fixtureEnv() })
    expect(res.code).toBe(0)
    expect(readStream(repo.root, 'auth-refresh').some((e) => e.t === 'drift-check')).toBe(false)
  })
})

describe('trailingFails', () => {
  const d = (ok: boolean): Entry => ({ v: 1, t: 'drift-check', ok })
  it('counts the trailing failing run of drift-check entries only', () => {
    expect(trailingFails([d(false), d(true), d(false), d(false)])).toBe(2)
    expect(trailingFails([d(false), d(true)])).toBe(0)
    expect(trailingFails([])).toBe(0)
  })
  it('ignores interleaved non-drift entries (they do not break the chain)', () => {
    const other: Entry = { v: 1, t: 'adopt', artifact: 'x' }
    expect(trailingFails([d(false), other, d(false)])).toBe(2)
  })
})
