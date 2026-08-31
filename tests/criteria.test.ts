import { describe, expect, it } from 'vitest'
import { runCriteria } from '../src/criteria.js'
import { findById, loadCanon } from '../src/scan.js'
import type { TestRepo } from './helpers.js'
import {
  SPEC_META, breakSingleFixture, copyFixture, fakeCtx, fixtureEnv, seededRepo,
  singleConfig, stampLive, workspaceConfig, writeSpec,
} from './helpers.js'

async function singleRepo(extraCriteria: Array<Record<string, string>> = []): Promise<{ repo: TestRepo; doc: NonNullable<ReturnType<typeof findById>> }> {
  const repo = await seededRepo()
  copyFixture(repo, 'vitest-single')
  repo.write('witness.config.yaml', singleConfig('filtered'))
  await writeSpec(repo, 'auth-refresh', {
    ...SPEC_META,
    criteria: [{ id: 'ac-rotate', test: '@spec:auth-refresh' }, ...extraCriteria],
  })
  stampLive(repo, 'auth-refresh')
  const doc = findById(loadCanon(repo.root), 'auth-refresh')
  if (!doc) throw new Error('spec missing')
  return { repo, doc }
}

// D154. The headless block now names the verb that unblocks it — D147's runnability
// contract, applied where the refusal is a detail string rather than a Violation.
describe('an untrusted command names its remedy (D154)', () => {
  it('points at witness trust <id>, keeping the env escape hatch', async () => {
    const { repo, doc } = await singleRepo([{ id: 'ac-smoke', cmd: 'echo hi' }])
    const env = { ...fixtureEnv(), WITNESS_TRUST_CMDS: '' }

    const res = await runCriteria(repo.root, fakeCtx(repo.root, { env }), doc)

    expect(res.ok).toBe(true)
    if (!res.ok) return
    const smoke = res.value.criteria.find((c) => c.id === 'ac-smoke')!
    expect(smoke.ok).toBe(false)
    expect(smoke.detail).toContain('run: witness trust auth-refresh')
    expect(smoke.detail).toContain('WITNESS_TRUST_CMDS=1')
  })
})

describe('runCriteria — filtered mode', () => {
  it('passes a green tagged spec and counts source tags', async () => {
    const { repo, doc } = await singleRepo()
    const res = await runCriteria(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), doc)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.ok).toBe(true)
    expect(res.value.mode).toBe('filtered')
    expect(res.value.tagCount).toBe(2)
    expect(res.value.criteria[0]).toMatchObject({ id: 'ac-rotate', kind: 'test', ok: true })
  })

  it('fails after the fixture breaks', async () => {
    const { repo, doc } = await singleRepo()
    breakSingleFixture(repo)
    const res = await runCriteria(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), doc)
    expect(res.ok && res.value.ok).toBe(false)
  })

  it('fails a spec with zero tagged tests even though the filtered run exits 0', async () => {
    const repo = await seededRepo()
    copyFixture(repo, 'vitest-single')
    repo.write('witness.config.yaml', singleConfig('filtered'))
    await writeSpec(repo, 'ghost', { ...SPEC_META, summary: 'ghost slice', criteria: [{ id: 'ac-g', test: '@spec:ghost' }] })
    stampLive(repo, 'ghost')
    const doc = findById(loadCanon(repo.root), 'ghost')
    if (!doc) throw new Error('spec missing')
    const res = await runCriteria(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), doc)
    expect(res.ok && res.value.ok).toBe(false)
    if (!res.ok) return
    expect(res.value.tagCount).toBe(0)
    expect(res.value.criteria[0]?.detail).toContain('no tagged test')
  })

  it('runs cmd criteria through the allowlist and the exit code', async () => {
    const { repo, doc } = await singleRepo([{ id: 'ac-smoke', cmd: 'true' }, { id: 'ac-broken', cmd: 'false' }])
    const res = await runCriteria(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), doc)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.criteria.map((c) => c.ok)).toEqual([true, true, false])
    expect(res.value.ok).toBe(false)
  })

  it('fails closed when commands are untrusted in non-TTY — and never executes them', async () => {
    const { repo, doc } = await singleRepo()
    const res = await runCriteria(repo.root, fakeCtx(repo.root, { tty: false, env: { PATH: process.env.PATH ?? '' } }), doc)
    expect(res.ok && res.value.ok).toBe(false)
    if (!res.ok) return
    expect(res.value.criteria[0]?.detail).toContain('untrusted-blocked')
  })
})

describe('runCriteria — full-suite mode', () => {
  it('maps one workspace suite run onto each spec by tag', async () => {
    const repo = await seededRepo()
    copyFixture(repo, 'workspace')
    repo.write('witness.config.yaml', workspaceConfig('full-suite'))
    await writeSpec(repo, 'rate-limit', { ...SPEC_META, summary: 'rate limiting', criteria: [{ id: 'ac-rate', test: '@spec:rate-limit' }] })
    await writeSpec(repo, 'quota', { ...SPEC_META, summary: 'quota tracking', criteria: [{ id: 'ac-quota', test: '@spec:quota' }] })
    stampLive(repo, 'rate-limit')
    stampLive(repo, 'quota')
    const canon = loadCanon(repo.root)
    const ctx = fakeCtx(repo.root, { env: fixtureEnv() })
    const rate = await runCriteria(repo.root, ctx, findById(canon, 'rate-limit')!)
    const quota = await runCriteria(repo.root, ctx, findById(canon, 'quota')!)
    expect(rate.ok && rate.value.ok && rate.value.tagCount === 2).toBe(true)
    expect(quota.ok && quota.value.ok && quota.value.tagCount === 1).toBe(true)
  })

  it('reuses an injected suite instead of re-running it', async () => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', 'schema: 1\ncriteria:\n  runner: full-suite\n  report: junit:**/junit.xml\nship:\n  test: "exit 1"\n')
    await writeSpec(repo, 'rate-limit', { ...SPEC_META, summary: 'rate limiting', criteria: [{ id: 'ac-rate', test: '@spec:rate-limit' }] })
    const doc = findById(loadCanon(repo.root), 'rate-limit')
    if (!doc) throw new Error('spec missing')
    const res = await runCriteria(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), doc, {
      suite: [{ name: 'injected @spec:rate-limit', classname: 'x', status: 'passed' }],
    })
    expect(res.ok && res.value.ok).toBe(true)
    expect(res.ok && res.value.tagCount).toBe(1)
  })

  it('refuses on runner misconfiguration', async () => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', 'schema: 1\ncriteria:\n  runner: full-suite\n')
    await writeSpec(repo, 'rate-limit', { ...SPEC_META, summary: 'rate limiting', criteria: [{ id: 'ac-rate', test: '@spec:rate-limit' }] })
    const doc = findById(loadCanon(repo.root), 'rate-limit')
    if (!doc) throw new Error('spec missing')
    const res = await runCriteria(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), doc)
    expect(res.ok).toBe(false)
  })
})
