import { describe, expect, it } from 'vitest'
import { splitDoc } from '../src/fm.js'
import { canonicalSha } from '../src/sha.js'
import type { TestRepo } from './helpers.js'
import {
  breakSingleFixture, copyFixture, fixSingleFixture, fixtureEnv, seededRepo, singleConfig, stampLive, writeSpec,
} from './helpers.js'

async function liveSingleRepo(): Promise<TestRepo> {
  const repo = await seededRepo()
  copyFixture(repo, 'vitest-single')
  repo.write('specflow.config.yaml', singleConfig('filtered'))
  await writeSpec(repo, 'auth-refresh')
  stampLive(repo, 'auth-refresh')
  return repo
}

const drift = (repo: TestRepo): unknown => {
  const doc = splitDoc(repo.read('specs/auth-refresh.md'))
  if (!doc.ok) throw new Error('unparseable spec')
  return doc.value.meta.drift
}

const status = (repo: TestRepo): unknown => {
  const doc = splitDoc(repo.read('specs/auth-refresh.md'))
  if (!doc.ok) throw new Error('unparseable spec')
  return doc.value.meta.status
}

describe('drift flag debounce', () => {
  it('one red run surfaces nothing on disk; the second stamps drift', async () => {
    const repo = await liveSingleRepo()
    breakSingleFixture(repo)
    await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    expect(drift(repo)).toBeUndefined()
    await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    const flag = drift(repo) as { sha: string; at: string }
    expect(flag.sha).toMatch(/^[0-9a-f]{64}$/)
    expect(flag.at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(status(repo)).toBe('live')
  })

  it('stamping never changes the canonical sha (drift is volatile)', async () => {
    const repo = await liveSingleRepo()
    const before = (() => {
      const d = splitDoc(repo.read('specs/auth-refresh.md'))
      if (!d.ok) throw new Error('bad doc')
      return canonicalSha(d.value.meta, d.value.body)
    })()
    breakSingleFixture(repo)
    await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    const after = (() => {
      const d = splitDoc(repo.read('specs/auth-refresh.md'))
      if (!d.ok) throw new Error('bad doc')
      return canonicalSha(d.value.meta, d.value.body)
    })()
    expect(after).toBe(before)
  })

  it('clears the flag on the next passing run', async () => {
    const repo = await liveSingleRepo()
    breakSingleFixture(repo)
    await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    expect(drift(repo)).toBeDefined()
    fixSingleFixture(repo)
    const res = await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    expect(res.code).toBe(0)
    expect(drift(repo)).toBeUndefined()
  })

  it('red-green-red flapping never stamps (no two consecutive reds)', async () => {
    const repo = await liveSingleRepo()
    breakSingleFixture(repo)
    await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    fixSingleFixture(repo)
    await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    breakSingleFixture(repo)
    await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    expect(drift(repo)).toBeUndefined()
  })
})
