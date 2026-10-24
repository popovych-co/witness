import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { askQueue } from '../src/ask.js'
import { appendEntry, latestRecap, readStream } from '../src/journal.js'
import { autonomyOn, seededRepo, tmpRepo, type TestRepo } from './helpers.js'

const RECAP = {
  effort: 'auth-hardening',
  class: 'feature',
  goals: [{ id: 'g1', text: 'Refresh tokens rotate before expiry' }],
  non_goals: [{ id: 'n1', text: 'No SSO provider changes' }],
  constraints: [],
  slices: ['token rotation'],
}

async function initialized(): Promise<TestRepo> {
  const repo = tmpRepo()
  await repo.cli(['init'])
  return repo
}

function withRecap(repo: TestRepo, recap: unknown, name = 'recap.json'): string {
  repo.write(name, JSON.stringify(recap))
  return name
}

describe('witness recap', () => {
  it('births the effort journal with a recap entry in a trailer commit', async () => {
    const repo = await initialized()
    const res = await repo.cli(['recap', '--file', withRecap(repo, RECAP)])
    expect(res.code).toBe(0)
    const entries = readStream(repo.root, 'auth-hardening')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ v: 1, t: 'recap', effort: 'auth-hardening', class: 'feature' })
    expect(repo.git('log', '-1', '--format=%s')).toBe('recap(auth-hardening): feature')
    expect(repo.git('log', '-1', '--format=%(trailers:key=Witness-State,valueonly=true)')).toBe('1')
    expect(res.stdout).toContain('next: witness write --effort auth-hardening')
  })

  it('honors an absolute --file path outside the repo', async () => {
    const repo = await initialized()
    const dir = mkdtempSync(join(tmpdir(), 'witness-recap-abs-'))
    const abs = join(dir, 'recap.json')
    writeFileSync(abs, JSON.stringify(RECAP))
    try {
      const res = await repo.cli(['recap', '--file', abs])
      expect(res.code).toBe(0)
      expect(readStream(repo.root, 'auth-hardening')).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses schema violations with structured rows', async () => {
    const repo = await initialized()
    const bad = await repo.cli(['recap', '--file', withRecap(repo, { ...RECAP, class: 'epic' })])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('class,enum,epic,feature | fix | chore')
    const noGoals = await repo.cli(['recap', '--file', withRecap(repo, { ...RECAP, goals: [] })])
    expect(noGoals.code).toBe(2)
    const dupIds = await repo.cli(['recap', '--file', withRecap(repo, { ...RECAP, goals: [{ id: 'g1', text: 'a' }, { id: 'g1', text: 'b' }] })])
    expect(dupIds.stderr).toContain('id-unique')
    const wrongPrefix = await repo.cli(['recap', '--file', withRecap(repo, { ...RECAP, non_goals: [{ id: 'g2', text: 'x' }] })])
    expect(wrongPrefix.stderr).toContain('id-prefix')
  })

  it('refuses slug reuse and unknown --amend targets', async () => {
    const repo = await initialized()
    await repo.cli(['recap', '--file', withRecap(repo, RECAP)])
    const reuse = await repo.cli(['recap', '--file', withRecap(repo, RECAP)])
    expect(reuse.code).toBe(2)
    expect(reuse.stderr).toContain('slug-reuse')
    const amendUnknown = await repo.cli(['recap', '--amend', '--file', withRecap(repo, { ...RECAP, effort: 'ghost' })])
    expect(amendUnknown.code).toBe(2)
    expect(amendUnknown.stderr).toContain('unknown-effort')
  })

  it('--amend appends a superseding recap; latest wins', async () => {
    const repo = await initialized()
    await repo.cli(['recap', '--file', withRecap(repo, RECAP)])
    const amended = { ...RECAP, goals: [...RECAP.goals, { id: 'g2', text: 'Sessions revoke on rotation' }] }
    const res = await repo.cli(['recap', '--amend', '--file', withRecap(repo, amended)])
    expect(res.code).toBe(0)
    expect(readStream(repo.root, 'auth-hardening')).toHaveLength(2)
    expect(latestRecap(repo.root, 'auth-hardening')?.goals).toHaveLength(2)
  })
})

describe('recap --ask (A9)', () => {
  it('under autonomy a recap with no ask is born · --manual is gone', async () => {
    const repo = await initialized()
    autonomyOn(repo)
    const born = await repo.cli(['recap', '--file', repo.writeRecap({ effort: 'e1' })])
    expect(born.code).toBe(0)
    expect(born.stdout).toContain('effort: e1')
    const manual = await repo.cli(['recap', '--file', repo.writeRecap({ effort: 'e2' }), '--manual'])
    expect(manual.code).toBe(2)
    expect(manual.stderr).toContain('bad-arguments')
    expect(manual.stderr).toContain("Unknown option '--manual'")
  })

  it('records the ask a recap answers', async () => {
    const repo = await initialized()
    await repo.cli(['ask', 'Refresh tokens rotate before expiry'])
    const res = await repo.cli(['recap', '--file', withRecap(repo, RECAP), '--ask', 'a1'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('ask: a1 — answered')
    expect(latestRecap(repo.root, 'auth-hardening')?.ask).toBe('a1')
    expect(askQueue(repo.root)[0]).toMatchObject({ id: 'a1', state: 'answered', effort: 'auth-hardening' })
    expect(repo.git('log', '-1', '--format=%s')).toBe('recap(auth-hardening): feature · ask a1')
  })

  it('refuses an unknown answered or withdrawn ask and --ask with --amend', async () => {
    const repo = await initialized()
    await repo.cli(['ask', 'one'])
    await repo.cli(['ask', 'two'])
    expect((await repo.cli(['recap', '--file', withRecap(repo, RECAP), '--ask', 'a9'])).stderr).toContain('unknown-ask')
    await repo.cli(['recap', '--file', withRecap(repo, RECAP), '--ask', 'a1'])
    const twice = await repo.cli(['recap', '--file', withRecap(repo, { ...RECAP, effort: 'other' }), '--ask', 'a1'])
    expect(twice.code).toBe(2)
    expect(twice.stderr).toContain('ask-answered')
    expect(twice.stderr).toContain('auth-hardening')
    await repo.cli(['ask', '--withdraw', 'a2'])
    expect((await repo.cli(['recap', '--file', withRecap(repo, { ...RECAP, effort: 'other' }), '--ask', 'a2'])).stderr)
      .toContain('ask-withdrawn')
    expect((await repo.cli(['recap', '--amend', '--file', withRecap(repo, RECAP), '--ask', 'a2'])).stderr).toContain('ask-amend')
  })

  it('an answered ask cannot be withdrawn and stays answered when its effort is abandoned', async () => {
    const repo = await initialized()
    await repo.cli(['ask', 'one'])
    await repo.cli(['recap', '--file', withRecap(repo, RECAP), '--ask', 'a1'])
    const w = await repo.cli(['ask', '--withdraw', 'a1'])
    expect(w.code).toBe(2)
    expect(w.stderr).toContain('ask-answered')
    expect(w.stderr).toContain('witness abandon auth-hardening')
    appendEntry(repo.root, 'auth-hardening', {
      v: 1, t: 'human-decision', gate: 'effort', artifact: 'auth-hardening', round: 0, decision: 'abandon-effort',
    })
    expect(askQueue(repo.root)[0]!.state).toBe('answered')
  })
})

const D = [{ id: 'd1', text: 'Rotation is server-side' }, { id: 'd2', text: 'Rotate at 80% of the TTL' }]

describe('witness recap — numbered decisions (row 198)', () => {
  it('decisions are numbered like goals and journaled only when present', async () => {
    const repo = await seededRepo({ noRecap: true })
    const r = await repo.cli(['recap', '--file', repo.writeRecap({ decisions: D })])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('decisions: 2')
    expect(latestRecap(repo.root, 'auth-hardening')?.decisions).toEqual(D)
    for (const [bad, rule] of [[[{ id: 'x1', text: 'a' }], 'id-prefix'], [[D[0], D[0]], 'id-unique'], [[{ id: 'd1', text: ' ' }], 'required']] as const) {
      const res = await repo.cli(['recap', '--amend', '--file', repo.writeRecap({ decisions: bad })])
      expect(res.code).toBe(2); expect(res.stderr).toContain(rule)
    }
    const bare = await seededRepo({ noRecap: true })
    await bare.cli(['recap', '--file', bare.writeRecap({ decisions: [] })])
    expect('decisions' in latestRecap(bare.root, 'auth-hardening')!).toBe(false)
  })
})
