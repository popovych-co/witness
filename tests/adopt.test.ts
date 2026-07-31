import { describe, expect, it } from 'vitest'
import { serializeDoc, splitDoc } from '../src/fm.js'
import { readStream } from '../src/journal.js'
import type { TestRepo } from './helpers.js'
import {
  copyFixture, fixtureEnv, seededRepo, singleConfig, stampLive, writePlan, writeSpec,
} from './helpers.js'

async function liveRepo(): Promise<TestRepo> {
  const repo = await seededRepo()
  copyFixture(repo, 'vitest-single')
  repo.write('witness.config.yaml', singleConfig('filtered'))
  await writeSpec(repo, 'auth-refresh')
  stampLive(repo, 'auth-refresh')
  return repo
}

const SPEC = 'specs/auth-refresh.md'

function editDoc(repo: TestRepo, rel: string, fn: (meta: Record<string, unknown>, body: string) => { meta: Record<string, unknown>; body: string }): void {
  const doc = splitDoc(repo.read(rel))
  if (!doc.ok) throw new Error('unparseable doc')
  const next = fn({ ...doc.value.meta }, doc.value.body)
  repo.write(rel, serializeDoc(next))
}

const adoptEntries = (repo: TestRepo): Array<Record<string, unknown>> =>
  readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'adopt') as Array<Record<string, unknown>>

describe('witness adopt', () => {
  it('adopts a dirty prose edit on a live spec: re-verifies, stays live, flags unreviewed', async () => {
    const repo = await liveRepo()
    editDoc(repo, SPEC, (meta, body) => ({ meta, body: body.replace('Tokens leak.', 'Tokens leak. Hand-polished wording.') }))
    const pre = await repo.cli(['check'], { env: fixtureEnv() })
    expect(pre.stdout).toContain('hand-edit-in-progress')
    const res = await repo.cli(['adopt', SPEC], { env: fixtureEnv() })
    expect(res.code).toBe(0)
    const entry = adoptEntries(repo).at(-1)
    expect(entry).toMatchObject({ unreviewed_amendment: true })
    expect((entry?.reverify as { ok: boolean }).ok).toBe(true)
    const doc = splitDoc(repo.read(SPEC))
    expect(doc.ok && doc.value.meta.status).toBe('live')
    expect(doc.ok && doc.value.meta.drift).toBeUndefined()
    const post = await repo.cli(['check'], { env: fixtureEnv() })
    expect(post.stdout).not.toContain('hand-edit-in-progress')
  })

  it('absolves a committed untrailered hand-edit — check stops flagging exactly that commit', async () => {
    const repo = await liveRepo()
    editDoc(repo, SPEC, (meta, body) => ({ meta, body: `${body}\nExtra prose.\n` }))
    repo.git('add', SPEC)
    repo.git('commit', '-m', 'hand edit, no trailer')
    const sneaky = repo.git('rev-parse', 'HEAD').trim()
    const pre = await repo.cli(['check'], { env: fixtureEnv() })
    expect(pre.code).toBe(1)
    expect(pre.stdout).toContain('untrailered-commit')
    expect(pre.stdout).toContain('witness adopt')
    const res = await repo.cli(['adopt', SPEC], { env: fixtureEnv() })
    expect(res.code).toBe(0)
    expect((adoptEntries(repo).at(-1)?.commits as string[])).toContain(sneaky)
    const post = await repo.cli(['check'], { env: fixtureEnv() })
    expect(post.stdout).not.toContain('untrailered-commit')
  })

  it('stamps drift immediately (no debounce) when the edited criteria fail the lane', async () => {
    const repo = await liveRepo()
    editDoc(repo, SPEC, (meta, body) => ({
      meta: { ...meta, criteria: [...(meta.criteria as unknown[]), { id: 'ac-broken', cmd: 'false' }] },
      body,
    }))
    const res = await repo.cli(['adopt', SPEC], { env: fixtureEnv() })
    expect(res.code).toBe(1)
    const entry = adoptEntries(repo).at(-1)
    expect((entry?.reverify as { ok: boolean }).ok).toBe(false)
    expect(entry?.unreviewed_amendment).toBeUndefined()
    const doc = splitDoc(repo.read(SPEC))
    expect(doc.ok && (doc.value.meta.drift as { sha: string }).sha).toMatch(/^[0-9a-f]{64}$/)
    expect(doc.ok && doc.value.meta.status).toBe('live')
  })

  it('refuses an invalid hand-edit and points at revert', async () => {
    const repo = await liveRepo()
    editDoc(repo, SPEC, (meta, body) => ({ meta, body: body.replace('## Behavior', '## Behaviour') }))
    const res = await repo.cli(['adopt', SPEC], { env: fixtureEnv() })
    expect(res.code).toBe(2)
    expect(res.stdout + res.stderr).toContain('git checkout HEAD --')
    expect(readStream(repo.root, 'auth-refresh').some((e) => e.t === 'adopt')).toBe(false)
  })

  it('adopts a plan hand-edit without running any lane', async () => {
    const repo = await liveRepo()
    await writePlan(repo, 'auth-refresh-plan-1')
    editDoc(repo, 'plans/auth-refresh-plan-1.md', (meta, body) => ({ meta, body: `${body}\nClarified step notes.\n` }))
    const res = await repo.cli(['adopt', 'plans/auth-refresh-plan-1.md'], { env: fixtureEnv() })
    expect(res.code).toBe(0)
    const entry = readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'adopt').at(-1)
    expect(entry?.reverify).toBeUndefined()
  })

  it('is idempotent — nothing to adopt exits 0 without a commit', async () => {
    const repo = await liveRepo()
    const before = repo.git('rev-parse', 'HEAD').trim()
    const res = await repo.cli(['adopt', SPEC], { env: fixtureEnv() })
    expect(res.code).toBe(0)
    expect(repo.git('rev-parse', 'HEAD').trim()).toBe(before)
  })
})
