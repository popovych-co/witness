import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readStream } from '../../src/journal.js'
import type { TestRepo } from '../helpers.js'
import {
  breakSingleFixture, copyFixture, fixtureEnv, seededRepo, singleConfig, stampLive, writeSpec,
} from '../helpers.js'

const BIN = fileURLToPath(new URL('../../dist/bin.js', import.meta.url))

function spawnCli(repo: TestRepo, args: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
  const res = spawnSync('node', [BIN, ...args], { cwd: repo.root, env: { ...fixtureEnv(), ...env }, encoding: 'utf8' })
  return { status: res.status, out: `${res.stdout}${res.stderr}` }
}

async function liveRepo(): Promise<TestRepo> {
  const repo = await seededRepo()
  copyFixture(repo, 'vitest-single')
  repo.write('witness.config.yaml', singleConfig('filtered'))
  await writeSpec(repo, 'auth-refresh')
  stampLive(repo, 'auth-refresh')
  return repo
}

describe('crash/resume — drift + adopt write paths', () => {
  it('drift crash between append and commit: recover --complete lands the entry exactly once', async () => {
    const repo = await liveRepo()
    breakSingleFixture(repo)
    const crashed = spawnCli(repo, ['check', '--drift'], { WITNESS_CRASH_AFTER: 'drift-journal' })
    expect(crashed.status).toBe(9)
    const pending = await repo.cli(['check'], { env: fixtureEnv() })
    expect(pending.code).toBe(1)
    expect(pending.stdout).toContain('pending-txn')
    expect(spawnCli(repo, ['recover', '--complete']).status).toBe(0)
    expect(readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'drift-check')).toHaveLength(1)
    expect(spawnCli(repo, ['check', '--drift']).status).toBe(1)
    expect(readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'drift-check')).toHaveLength(2)
  })

  it('adopt crash: recover --complete finishes the adoption', async () => {
    const repo = await liveRepo()
    repo.write('specs/auth-refresh.md', repo.read('specs/auth-refresh.md').replace('Tokens leak.', 'Tokens leak everywhere.'))
    const crashed = spawnCli(repo, ['adopt', 'specs/auth-refresh.md'], { WITNESS_CRASH_AFTER: 'adopt-journal' })
    expect(crashed.status).toBe(9)
    expect(spawnCli(repo, ['recover', '--complete']).status).toBe(0)
    expect(readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'adopt')).toHaveLength(1)
  })

  it('adopt crash: recover --rollback reverts the hand-edit — the "offers revert" path', async () => {
    const repo = await liveRepo()
    const original = repo.read('specs/auth-refresh.md')
    repo.write('specs/auth-refresh.md', original.replace('Tokens leak.', 'Tokens leak everywhere.'))
    const crashed = spawnCli(repo, ['adopt', 'specs/auth-refresh.md'], { WITNESS_CRASH_AFTER: 'adopt-journal' })
    expect(crashed.status).toBe(9)
    expect(spawnCli(repo, ['recover', '--rollback']).status).toBe(0)
    expect(readStream(repo.root, 'auth-refresh').some((e) => e.t === 'adopt')).toBe(false)
    expect(repo.read('specs/auth-refresh.md')).toBe(original)
  })
})
