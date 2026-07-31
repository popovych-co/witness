import { describe, expect, it } from 'vitest'
import { runCriteria, type CriteriaResult } from '../src/criteria.js'
import { findById, loadCanon } from '../src/scan.js'
import type { TestRepo } from './helpers.js'
import {
  SPEC_META, copyFixture, fakeCtx, fixtureEnv, seededRepo, stampLive, workspaceConfig, writeSpec,
} from './helpers.js'

async function workspaceRepo(): Promise<TestRepo> {
  const repo = await seededRepo()
  copyFixture(repo, 'workspace')
  await writeSpec(repo, 'rate-limit', { ...SPEC_META, summary: 'rate limiting', criteria: [{ id: 'ac-rate', test: '@spec:rate-limit' }] })
  await writeSpec(repo, 'quota', { ...SPEC_META, summary: 'quota tracking', criteria: [{ id: 'ac-quota', test: '@spec:quota' }] })
  stampLive(repo, 'rate-limit')
  stampLive(repo, 'quota')
  return repo
}

async function sweep(repo: TestRepo, mode: 'filtered' | 'full-suite'): Promise<Array<Pick<CriteriaResult, 'spec' | 'ok' | 'tagCount'>>> {
  repo.write('witness.config.yaml', workspaceConfig(mode))
  const canon = loadCanon(repo.root)
  const ctx = fakeCtx(repo.root, { env: fixtureEnv() })
  const out = []
  for (const id of ['rate-limit', 'quota']) {
    const doc = findById(canon, id)
    if (!doc) throw new Error(`${id} missing`)
    const res = await runCriteria(repo.root, ctx, doc)
    if (!res.ok) throw new Error(`lane refused: ${JSON.stringify(res.violations)}`)
    out.push({ spec: res.value.spec, ok: res.value.ok, tagCount: res.value.tagCount })
  }
  return out
}

describe('runner-mode parity on the workspace fixture', () => {
  it('filtered and full-suite agree per spec — ok and tag counts', async () => {
    const repo = await workspaceRepo()
    const filtered = await sweep(repo, 'filtered')
    const full = await sweep(repo, 'full-suite')
    expect(filtered).toEqual(full)
    expect(filtered).toEqual([
      { spec: 'rate-limit', ok: true, tagCount: 2 },
      { spec: 'quota', ok: true, tagCount: 1 },
    ])
  })
})
