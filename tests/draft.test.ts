import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ASK_STREAM } from '../src/ask.js'
import { readStream } from '../src/journal.js'
import { draftPath, draftSave as save, measuredEnv, seededRepo, writeSpec } from './helpers.js'

// Row 199. A conversation's local draft: saved after every settled answer, read back to resume.
const readBack = (stdout: string) => { const [head, ...rest] = stdout.split('\n'); return { head, json: JSON.parse(rest.join('\n')) } }

// The block `init` wrote before row 199: what fewhats and HYC carry today.
const OLD_GITIGNORE = `# witness local (never committed)
.witness/lock
.witness/runner.lock
.witness/drive.lock
.witness/drive.log
.witness/txn.json
.witness/allow.json
.witness/calibration.local.yaml
.witness/config.local.yaml
.witness/screens/
`

describe('witness draft (row 199)', () => {
  it('saves and reads back a grill draft keyed by its ask', async () => {
    const repo = await seededRepo({ noRecap: true })
    await repo.cli(['ask', 'add dark mode'])
    const d = {
      goals: [{ id: 'g1', text: 'Readers can switch to a dark theme' }],
      decisions: [{ id: 'd1', text: 'The theme follows the OS setting first' }],
      open: ['who sees it first'],
    }
    const s = await save(repo, 'ask-a1', d)
    expect(s.code).toBe(0)
    expect(s.stdout).toBe('draft: ask-a1 — saved · 2 items settled · 1 open')
    const r = await repo.cli(['draft', 'ask-a1'])
    expect(r.code).toBe(0)
    const { head, json } = readBack(r.stdout)
    expect(head).toBe('draft: ask-a1 · 2 items settled · 1 open')
    expect(json).toEqual(d)
  })

  it('a draft is never committed, never journaled, and dirties nothing', async () => {
    const repo = await seededRepo({ noRecap: true })
    await repo.cli(['ask', 'add dark mode'])
    const head = repo.git('rev-parse', 'HEAD')
    const asks = readStream(repo.root, ASK_STREAM).length
    expect((await save(repo, 'ask-a1', { goals: [{ id: 'g1', text: 'Dark theme' }] })).code).toBe(0)
    expect(repo.git('status', '--porcelain')).toBe('')
    expect(repo.git('rev-parse', 'HEAD')).toBe(head)
    expect(readStream(repo.root, ASK_STREAM).length).toBe(asks)
    const check = await repo.cli(['check'])
    expect(check.stdout).not.toContain('hand-edit-in-progress')
    expect(check.stdout).not.toContain('.witness/drafts')
    expect((await repo.cli(['ask', 'two'])).code).toBe(0)
  })

  it('a repo whose .gitignore predates drafts stays clean', async () => {
    const repo = await seededRepo({ noRecap: true })
    await repo.cli(['ask', 'add dark mode'])
    repo.write('.gitignore', OLD_GITIGNORE)
    repo.git('commit', '-qam', 'old gitignore')
    rmSync(join(repo.root, '.git', 'info', 'exclude'), { force: true })
    expect((await save(repo, 'ask-a1', { goals: [{ id: 'g1', text: 'Dark theme' }] })).code).toBe(0)
    expect(repo.git('status', '--porcelain')).toBe('')
    expect(readFileSync(join(repo.root, '.git', 'info', 'exclude'), 'utf8')).toContain('.witness/drafts/')
  })

  it('the shape is checked, not completeness', async () => {
    const repo = await seededRepo({ noRecap: true })
    await repo.cli(['ask', 'add dark mode'])
    const empty = await save(repo, 'ask-a1', {})
    expect(empty.code).toBe(0)
    expect(empty.stdout).toContain('0 items settled')
    const prefix = await save(repo, 'ask-a1', { goals: [{ id: 'x1', text: 'a' }] })
    expect(prefix.code).toBe(2)
    expect(prefix.stderr).toContain('id-prefix')
    const field = await save(repo, 'ask-a1', { colour: 'blue' })
    expect(field.code).toBe(2)
    expect(field.stderr).toContain('unknown-field')
    expect((await repo.cli(['recap', '--file', repo.writeRecap({})])).code).toBe(0)
    const mismatch = await save(repo, 'amend-auth-hardening', { effort: 'other' })
    expect(mismatch.code).toBe(2)
    expect(mismatch.stderr).toContain('effort-mismatch')
    expect((await writeSpec(repo, 'auth-refresh')).code).toBe(0)
    expect((await save(repo, 'design-auth-refresh', { direction: '' })).code).toBe(2)
  })

  it('the key names a live referent, as its recap would', async () => {
    const repo = await seededRepo({ noRecap: true })
    await repo.cli(['ask', 'add dark mode'])
    for (const [key, rule] of [['nope', 'bad-key'], ['ask-a9', 'unknown-ask'], ['amend-ghost', 'unknown-effort'], ['design-ghost', 'unknown-spec']]) {
      const r = await repo.cli(['draft', key!])
      expect(r.code, key).toBe(2)
      expect(r.stderr, key).toContain(`key,${rule}`)
    }
    expect((await save(repo, 'ask-a1', { goals: [{ id: 'g1', text: 'Dark theme' }] })).code).toBe(0)
    const aside = join(repo.root, '..', `${repo.root.split('/').pop()}-ask-a1.json`)
    copyFileSync(draftPath(repo, 'ask-a1'), aside)
    expect((await repo.cli(['recap', '--file', repo.writeRecap({}), '--ask', 'a1'])).code).toBe(0)
    copyFileSync(aside, draftPath(repo, 'ask-a1'))
    const r = await repo.cli(['draft', 'ask-a1'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('key,ask-answered')
    expect(existsSync(draftPath(repo, 'ask-a1'))).toBe(false)
  })

  it('a corrupt draft is named and can be saved over', async () => {
    const repo = await seededRepo({ noRecap: true })
    await repo.cli(['ask', 'add dark mode'])
    repo.write('.witness/drafts/ask-a1.json', '{"v":1,')
    const r = await repo.cli(['draft', 'ask-a1'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('draft-unreadable')
    expect(r.stderr).toContain('.witness/drafts/ask-a1.json')
    expect((await save(repo, 'ask-a1', { goals: [{ id: 'g1', text: 'Dark theme' }] })).code).toBe(0)
    const back = await repo.cli(['draft', 'ask-a1'])
    expect(back.code).toBe(0)
    expect(readBack(back.stdout).json).toEqual({ goals: [{ id: 'g1', text: 'Dark theme' }] })
  })

  it("a save never drops another session's answers", async () => {
    const repo = await seededRepo({ noRecap: true })
    await repo.cli(['ask', 'add dark mode'])
    const S1 = measuredEnv('S1', 10_000, 1_000_000)
    const S2 = measuredEnv('S2', 10_000, 1_000_000)
    const g1 = { id: 'g1', text: 'Dark theme' }
    const d1 = { id: 'd1', text: 'Follows the OS' }
    const d2 = { id: 'd2', text: 'A toggle in settings' }
    expect((await save(repo, 'ask-a1', { goals: [g1], decisions: [d1] }, S1)).code).toBe(0)
    const moved = await save(repo, 'ask-a1', { goals: [g1] }, S2)
    expect(moved.code).toBe(2)
    expect(moved.stderr).toContain('draft-moved')
    expect((await save(repo, 'ask-a1', { goals: [g1], decisions: [d1, d2] }, S2)).code).toBe(0)
    expect((await save(repo, 'ask-a1', { goals: [g1], decisions: [d2] }, S2)).code).toBe(0)

    expect((await repo.cli(['recap', '--file', repo.writeRecap({})])).code).toBe(0)
    expect((await writeSpec(repo, 'auth-refresh', { ui: true })).code).toBe(0)
    expect((await save(repo, 'design-auth-refresh', { answers: ['groups first', 'no icons'] }, S1)).code).toBe(0)
    const designMoved = await save(repo, 'design-auth-refresh', { answers: ['groups first'] }, S2)
    expect(designMoved.code).toBe(2)
    expect(designMoved.stderr).toContain('draft-moved')
  })

  it('the exemption alone keeps a visible draft from blocking state', async () => {
    const repo = await seededRepo({ noRecap: true })
    await repo.cli(['ask', 'add dark mode'])
    expect((await save(repo, 'ask-a1', { goals: [{ id: 'g1', text: 'Dark theme' }] })).code).toBe(0)
    const strip = (p: string) => writeFileSync(p, readFileSync(p, 'utf8').split('\n').filter((l) => l !== '.witness/drafts/').join('\n'))
    strip(join(repo.root, '.gitignore'))
    repo.git('commit', '-qam', 'gitignore without drafts')
    strip(join(repo.root, '.git', 'info', 'exclude'))
    expect(repo.git('status', '--porcelain')).toContain('.witness/drafts/')
    const check = await repo.cli(['check'])
    expect(check.stdout).not.toContain('hand-edit-in-progress')
    expect((await repo.cli(['ask', 'two'])).code).toBe(0)
  })

  it('an amendment starts from the latest recap', async () => {
    const repo = await seededRepo({ noRecap: true })
    expect((await repo.cli(['recap', '--file', repo.writeRecap({ slices: ['rotation'] })])).code).toBe(0)
    rmSync(join(repo.root, 'recap-amend.json'), { force: true })
    const r = await repo.cli(['draft', 'amend-auth-hardening'])
    expect(r.code).toBe(0)
    const { head, json } = readBack(r.stdout)
    expect(head).toBe('draft: amend-auth-hardening · seeded from the latest recap')
    expect(json.goals).toEqual([{ id: 'g1', text: 'Refresh tokens rotate before expiry' }])
    expect(json.slices).toEqual(['rotation'])
    expect(json).not.toHaveProperty('ask')
    expect(json).not.toHaveProperty('w')
    expect(json).not.toHaveProperty('ctx')
    expect(existsSync(draftPath(repo, 'amend-auth-hardening'))).toBe(false)
  })
})
