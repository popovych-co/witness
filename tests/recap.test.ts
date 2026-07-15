import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { latestRecap, readStream } from '../src/journal.js'
import { tmpRepo, type TestRepo } from './helpers.js'

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

describe('specflow recap', () => {
  it('births the effort journal with a recap entry in a trailer commit', async () => {
    const repo = await initialized()
    const res = await repo.cli(['recap', '--file', withRecap(repo, RECAP)])
    expect(res.code).toBe(0)
    const entries = readStream(repo.root, 'auth-hardening')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ v: 1, t: 'recap', effort: 'auth-hardening', class: 'feature' })
    expect(repo.git('log', '-1', '--format=%s')).toBe('recap(auth-hardening): feature')
    expect(repo.git('log', '-1', '--format=%(trailers:key=Specflow-State,valueonly=true)')).toBe('1')
    expect(res.stdout).toContain('next: specflow write --effort auth-hardening')
  })

  it('honors an absolute --file path outside the repo', async () => {
    const repo = await initialized()
    const dir = mkdtempSync(join(tmpdir(), 'specflow-recap-abs-'))
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
