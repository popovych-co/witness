import { describe, expect, it } from 'vitest'
import { serializeDoc, splitDoc } from '../src/fm.js'
import { appendEntry, journalRel, readStream } from '../src/journal.js'
import { findById, loadCanon } from '../src/scan.js'
import { canonicalSha } from '../src/sha.js'
import type { TestRepo } from './helpers.js'
import {
  approve, copyFixture, fixtureEnv, plantHolder, recapEffort, renamedAndResliced, seededRepo, singleConfig, stampLive, writePlan, writeSpec,
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

// D167. Only a new artifact is held off a path another id was last witnessed at: a doc already
// witnessed stays adoptable wherever it sits.
describe('a new artifact keeps off a held path (D167)', () => {
  it('refuses a hand-made doc on the path a superseded spec comes back to', async () => {
    const { repo, shipped } = await renamedAndResliced()
    repo.write('specs/auth-refresh.md', shipped.replace('id: token-refresh', 'id: auth-new').replace('@spec:token-refresh', '@spec:auth-new'))
    const r = await repo.cli(['adopt', 'specs/auth-refresh.md'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('is where token-refresh comes back')
  })

  it('refuses an in-place id change — witness rename is how an id changes', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh'); approve(repo, 'auth-refresh')
    repo.write(SPEC, repo.read(SPEC).replace('id: auth-refresh', 'id: auth-other').replace('@spec:auth-refresh', '@spec:auth-other'))
    const r = await repo.cli(['adopt', SPEC])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('path-taken')
    expect(r.stderr).toContain('held auth-refresh')
    expect(r.stderr).toContain(`git checkout HEAD -- ${SPEC}`)               // the existing revert help is the way back
  })

  it('still adopts an amendment of a doc a pre-167 write left on such a path', async () => {
    const { repo, shipped } = await renamedAndResliced()
    await recapEffort(repo, 'other')
    const planted = plantHolder(repo, shipped, 'other')
    repo.write('specs/auth-refresh.md', planted.replace('Rotate before expiry.', 'Rotate well before expiry.'))
    expect((await repo.cli(['adopt', 'specs/auth-refresh.md'])).code).toBe(0)
  })

  it('refuses an in-place id change onto an id with history — a spec its abandon unwound', async () => {
    const repo = await seededRepo()
    await recapEffort(repo, 'tmp')
    expect((await writeSpec(repo, 'gone', { criteria: [{ id: 'ac-gone', test: '@spec:gone' }] }, undefined, 'tmp')).code).toBe(0)
    expect((await repo.cli(['abandon', 'tmp'])).code).toBe(0)
    await writeSpec(repo, 'auth-refresh'); approve(repo, 'auth-refresh')
    repo.write(SPEC, repo.read(SPEC).replace('id: auth-refresh', 'id: gone').replace('@spec:auth-refresh', '@spec:gone'))
    const r = await repo.cli(['adopt', SPEC])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('held auth-refresh')
  })

  it('refuses a hand-made doc on such a path whose id has a stray stream', async () => {
    const { repo, shipped } = await renamedAndResliced()
    appendEntry(repo.root, 'auth-new', { t: 'status', artifact: 'auth-new', from: 'draft', to: 'approved', cause: 'gate-approve' })
    repo.git('add', journalRel('auth-new')); repo.git('commit', '-q', '-m', 'a stray stream', '-m', 'Witness-State: 1')
    repo.write('specs/auth-refresh.md', shipped.replace('id: token-refresh', 'id: auth-new').replace('@spec:token-refresh', '@spec:auth-new'))
    const r = await repo.cli(['adopt', 'specs/auth-refresh.md'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('is where token-refresh comes back')
  })

  it('still adopts an amendment of a doc a pre-167 adopt absolved on such a path', async () => {
    const { repo, shipped } = await renamedAndResliced()
    const rel = 'specs/auth-refresh.md'
    const doc = shipped.replace('id: token-refresh', 'id: auth-new').replace('@spec:token-refresh', '@spec:auth-new').replace('status: live', 'status: approved')
    repo.write(rel, doc)
    repo.git('add', rel); repo.git('commit', '-q', '-m', 'a hand-made doc')
    const hand = repo.git('rev-parse', 'HEAD')
    // what a pre-167 adopt of a committed hand-made doc left: a journal-only state commit absolving it
    const d = findById(loadCanon(repo.root), 'auth-new')!
    appendEntry(repo.root, 'auth-new', { t: 'adopt', artifact: 'auth-new', sha: canonicalSha(d.meta, d.body), commits: [hand] })
    repo.git('add', journalRel('auth-new')); repo.git('commit', '-q', '-m', 'adopt(auth-new)', '-m', 'Witness-State: 1')
    repo.write(rel, doc.replace('Rotate before expiry.', 'Rotate well before expiry.'))
    expect((await repo.cli(['adopt', rel])).code).toBe(0)
  })
})

describe('witness adopt — held criteria (A10)', () => {
  it('a green re-verify counts what it held (A10)', async () => {
    const repo = await seededRepo()
    copyFixture(repo, 'vitest-single')
    repo.write('witness.config.yaml', singleConfig('filtered'))
    await writeSpec(repo, 'auth-refresh', {
      needs: [{ id: 'prod', manual: 'production access granted', satisfied: false, holds: ['ac-prod'] }],
      criteria: [{ id: 'ac-rotate', test: '@spec:auth-refresh' }, { id: 'ac-prod', cmd: 'false' }],
    })
    stampLive(repo, 'auth-refresh')
    editDoc(repo, SPEC, (meta, body) => ({ meta, body: body.replace('Tokens leak.', 'Tokens leak. Polished.') }))
    const res = await repo.cli(['adopt', SPEC], { env: fixtureEnv() })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('reverify: lane green · 1 held — stays live')
  })
})

// Row 218 (#65). Frontmatter's position — status, drift, pr, design — is written by the CLI's
// own transitions alone. The content sha leaves it out, so a hand edit of position alone read
// as "unchanged" and adopt absolved it: a draft forged live with a fabricated design stamp.
describe('adopt refuses a moved position (#65)', () => {
  const UI = 'specs/sp1.md'
  async function draftUiSpec(): Promise<TestRepo> {
    const repo = await seededRepo()
    expect((await writeSpec(repo, 'sp1', { ui: true, criteria: [{ id: 'ac-sp1', test: '@spec:sp1' }] })).code).toBe(0)
    return repo
  }
  const handCommit = (repo: TestRepo, rel: string, fn: Parameters<typeof editDoc>[2]): void => {
    editDoc(repo, rel, fn)
    repo.git('add', rel)
    repo.git('commit', '-q', '-m', 'hand edit')
  }

  it('refuses a draft forged live with a design stamp, naming each moved field; check still flags the commit', async () => {
    const repo = await draftUiSpec()
    handCommit(repo, UI, (meta, body) => ({ meta: { ...meta, status: 'live', design: { sha: 'a'.repeat(64), spec: 'b'.repeat(64) } }, body }))
    const r = await repo.cli(['adopt', UI])
    expect(r.code).toBe(2)
    const rows = r.stderr.split('\n').filter((l) => l.includes('position-moved'))
    expect(rows.map((l) => l.trim().split(',')[0])).toEqual(['status', 'design'])
    expect(rows[0]).toContain('draft → live')
    expect(readStream(repo.root, 'sp1').some((e) => e.t === 'adopt')).toBe(false)
    expect((await repo.cli(['check'])).stdout).toContain('untrailered-commit')
  })

  it('refuses a hand edit that moves only drift, or only pr', async () => {
    const repo = await liveRepo()
    handCommit(repo, SPEC, (meta, body) => ({ meta: { ...meta, drift: { sha: 'c'.repeat(64) } }, body }))
    const drift = await repo.cli(['adopt', SPEC], { env: fixtureEnv() })
    expect(drift.code).toBe(2)
    expect(drift.stderr).toMatch(/^\s*drift,position-moved,/m)
    repo.git('reset', '-q', '--hard', 'HEAD~1')
    handCommit(repo, SPEC, (meta, body) => ({ meta: { ...meta, pr: 42 }, body }))
    const pr = await repo.cli(['adopt', SPEC], { env: fixtureEnv() })
    expect(pr.code).toBe(2)
    expect(pr.stderr).toMatch(/^\s*pr,position-moved,/m)
  })

  it('still adopts a body-only hand edit of the draft', async () => {
    const repo = await draftUiSpec()
    handCommit(repo, UI, (meta, body) => ({ meta, body: `${body}\nHand-polished.\n` }))
    const r = await repo.cli(['adopt', UI])
    expect(r.code, r.stderr).toBe(0)
  })

  it('a hand-made doc adopt has never seen is born draft, with no position stamps', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const made = repo.read(SPEC).replace('id: auth-refresh', 'id: auth-made').replace('@spec:auth-refresh', '@spec:auth-made')
      .replace('status: draft', 'status: approved')
    repo.write('specs/auth-made.md', made)
    const r = await repo.cli(['adopt', 'specs/auth-made.md'])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/^\s*status,position-moved,draft → approved,/m)
  })

  // Final review F1. An adopt absolves a commit for the doc it adopted. One hand commit that
  // forges sp1's position and edits sp2's body: adopting sp2 must not launder sp1's move.
  it('adopting a sibling the same commit touched launders nothing', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'sp1', { criteria: [{ id: 'ac-sp1', test: '@spec:sp1' }] })
    await writeSpec(repo, 'sp2', { criteria: [{ id: 'ac-sp2', test: '@spec:sp2' }] })
    editDoc(repo, 'specs/sp1.md', (meta, body) => ({ meta: { ...meta, status: 'approved' }, body }))
    editDoc(repo, 'specs/sp2.md', (meta, body) => ({ meta, body: `${body}\nMore.\n` }))
    repo.git('add', 'specs/sp1.md', 'specs/sp2.md')
    repo.git('commit', '-q', '-m', 'hand edit: two docs')
    expect((await repo.cli(['adopt', 'specs/sp1.md'])).code).toBe(2)
    expect((await repo.cli(['adopt', 'specs/sp2.md'])).code).toBe(0)
    const again = await repo.cli(['adopt', 'specs/sp1.md'])
    expect(again.code).toBe(2)
    expect(again.stderr).toMatch(/^\s*status,position-moved,draft → approved,/m)
    expect((await repo.cli(['check'])).stdout).toContain('untrailered-commit')
  })

  // Security review. Adopting a doc clears a commit only when every state path it changed is a
  // doc some adopt took in: a hand-forged journal line, a design edit or another doc's deletion
  // riding the same commit keeps it reported.
  it('a commit that also forged a journal line or deleted a doc stays reported', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'sp1', { criteria: [{ id: 'ac-sp1', test: '@spec:sp1' }] })
    await writeSpec(repo, 'sp2', { criteria: [{ id: 'ac-sp2', test: '@spec:sp2' }] })
    editDoc(repo, 'specs/sp2.md', (meta, body) => ({ meta, body: `${body}\nMore.\n` }))
    appendEntry(repo.root, 'sp1', { t: 'status', artifact: 'sp1', from: 'draft', to: 'approved', cause: 'gate-approve' })
    repo.git('add', 'specs/sp2.md', journalRel('sp1'))
    repo.git('commit', '-q', '-m', 'hand edit: a body and a forged journal line')
    expect((await repo.cli(['adopt', 'specs/sp2.md'])).code).toBe(0)
    const forged = await repo.cli(['check'])
    expect(forged.stdout).toContain('untrailered-commit')
    expect(forged.stdout).toContain(journalRel('sp1'))

    editDoc(repo, 'specs/sp2.md', (meta, body) => ({ meta, body: `${body}\nEven more.\n` }))
    repo.git('rm', '-q', 'specs/sp1.md')
    repo.git('add', 'specs/sp2.md')
    repo.git('commit', '-q', '-m', 'hand edit: a body and a deleted doc')
    expect((await repo.cli(['adopt', 'specs/sp2.md'])).code).toBe(0)
    expect((await repo.cli(['check'])).stdout).toContain('specs/sp1.md')
  })
})
