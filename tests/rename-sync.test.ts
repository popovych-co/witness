import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findById, loadCanon } from '../src/scan.js'
import { readStream, streamExists } from '../src/journal.js'
import { addOrigin, fakeScenario, gateEnv, putVerdict, seededRepo, writeSpec } from './helpers.js'

describe('witness rename', () => {
  it('rewrites the id, references, own tag criteria; moves the journal; warns on source tags', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }], depends: ['auth-refresh'] })
    // decompose-approve both specs for real, so auth-refresh picks up its own journal
    // stream (via writeStamp) — nothing else in this setup ever targets it directly,
    // and the "moves the journal" assertions below need that stream to exist first.
    const scenario = fakeScenario()
    putVerdict(scenario, {
      coverage: [
        { anchor: 'auth-refresh > ## Behavior', note: 'read' },
        { anchor: 'auth-mfa > ## Behavior', note: 'read' },
      ],
      findings: [],
    })
    await repo.cli(['gate', 'decompose', 'auth-hardening'], { env: gateEnv(scenario) })
    await repo.cli(['decide', 'decompose', 'auth-hardening', '--approve'])

    repo.write('src/rotate.test.ts', `it('rotates @spec:auth-refresh', () => {})\n`)
    repo.git('add', '-A'); repo.git('commit', '-m', 'a tagged test')

    const r = await repo.cli(['rename', 'auth-refresh', 'token-rotation'])
    expect(r.code).toBe(0)
    const canon = loadCanon(repo.root)
    expect(findById(canon, 'auth-refresh')).toBeUndefined()
    const renamed = findById(canon, 'token-rotation')!
    expect(JSON.stringify(renamed.meta.criteria)).toContain('@spec:token-rotation')
    expect((findById(canon, 'auth-mfa')!.meta.depends as string[])).toEqual(['token-rotation'])
    expect(streamExists(repo.root, 'token-rotation')).toBe(true)
    expect(streamExists(repo.root, 'auth-refresh')).toBe(false)
    expect(readStream(repo.root, 'token-rotation').length).toBeGreaterThan(0)   // history traveled
    expect(r.stdout).toContain('1 source tag')                                  // tests are not rewritten
    expect(repo.git('log', '-1', '--format=%B')).toContain('rename(auth-refresh → token-rotation)')
  })

  it('refuses collisions and bad charsets', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
    expect((await repo.cli(['rename', 'auth-refresh', 'auth-mfa'])).code).toBe(2)
    expect((await repo.cli(['rename', 'auth-refresh', 'Bad_Id'])).code).toBe(2)
    expect((await repo.cli(['rename', 'ghost', 'x'])).code).toBe(2)
  })
})

describe('witness sync', () => {
  it('pushes accumulated state commits; refuses without an upstream', async () => {
    const repo = await seededRepo()
    const noRemote = await repo.cli(['sync'])
    expect(noRemote.code).toBe(2)
    expect(noRemote.stdout + noRemote.stderr).toContain('no-upstream')

    addOrigin(repo)
    await writeSpec(repo, 'auth-refresh')                  // a local state commit
    const r = await repo.cli(['sync'])
    expect(r.code).toBe(0)
    expect(repo.git('rev-list', '--count', 'origin/main..main').trim()).toBe('0')
  })
})
