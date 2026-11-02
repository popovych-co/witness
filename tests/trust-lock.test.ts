import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readStream } from '../src/journal.js'
import {
  SPEC_META, approve, fakeScenario, gateEnv, hermeticEnv, putVerdict, seededRepo, spawnAsync, stampLive, type TestRepo,
  writePlan, writeSpec,
} from './helpers.js'

// The lock tests pass a short wait to acquireLock directly; a verb takes the default, so
// this file shortens it for every acquireLock the in-process CLI makes. The wait is
// synchronous (it blocks the worker), so it stays well under a second.
vi.mock('../src/lock.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lock.js')>()
  return { ...real, acquireLock: (root: string, pid = process.pid, waitMs = 300) => real.acquireLock(root, pid, waitMs) }
})

const BLOCKING = {
  coverage: [
    { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
    { anchor: 'auth-refresh > ## Behavior', note: 'read' },
  ],
  findings: [{ blocking: true, anchor: 'auth-refresh-plan-1 > ## Step: s1', claim: 'step is untestable' }],
}

async function cmdSpec(): Promise<TestRepo> {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh', { ...SPEC_META, criteria: [{ id: 'ac-smoke', cmd: 'echo ok' }] })
  stampLive(repo, 'auth-refresh')
  return repo
}

// A live process that is not this one: the lock is another writer's.
const holdForeign = (repo: TestRepo): void => {
  mkdirSync(join(repo.root, '.witness'), { recursive: true })
  writeFileSync(join(repo.root, '.witness', 'lock'), JSON.stringify({ pid: process.ppid }))
}
const allowed = (repo: TestRepo): string[] =>
  existsSync(join(repo.root, '.witness', 'allow.json'))
    ? (JSON.parse(repo.read('.witness/allow.json')) as { commands: string[] }).commands : []
const trustEntries = (repo: TestRepo): number => readStream(repo.root, repo.effort).filter((e) => e.t === 'trust').length

// Row 220 (#67). A grant writes allow.json and journals its `trust` entry under the repo lock,
// like every other state write: a concurrent reader never sees an unlocked transaction marker
// (read as a crash), and two grants at once never lose one.
describe('trust grants take the repo lock (#67)', () => {
  it('the trust verb waits for the lock and refuses locked, granting nothing', async () => {
    const repo = await cmdSpec()
    holdForeign(repo)
    const res = await repo.cli(['trust', 'auth-refresh', '--cmd', 'echo ok'])
    expect(res.code).toBe(3)
    expect(res.stderr).toContain('locked')
    expect(allowed(repo)).not.toContain('echo ok')
    expect(trustEntries(repo)).toBe(0)
  })

  it('a refused commit refuses the grant and leaves allow.json unchanged', async () => {
    const repo = await cmdSpec()
    repo.write('specs/stray.md', 'a hand-written file on a state path\n')
    const res = await repo.cli(['trust', 'auth-refresh', '--cmd', 'echo ok'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('unrelated-dirty')
    expect(allowed(repo)).not.toContain('echo ok')
    expect(trustEntries(repo)).toBe(0)
  })

  // decide takes its own lock first, so contention refuses the decision itself; what the fix
  // changes is the grant after it. A crash between the grant's journal append and its commit
  // shows it goes through the one locked transaction: the marker is left for recover, and
  // allow.json holds nothing the journal has not durably recorded.
  it('decide --trust-cmds grants through the same locked transaction', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ...SPEC_META, criteria: [...SPEC_META.criteria, { id: 'ac-smoke', cmd: 'echo ok' }] })
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1', { steps: [{ id: 's1', title: 'rotate', criteria: ['ac-rotate', 'ac-smoke'] }] })
    const scenario = fakeScenario()
    putVerdict(scenario, BLOCKING)
    expect((await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })).code).toBe(1)
    const here = resolve(import.meta.dirname, '..')
    const res = await spawnAsync(join(here, 'node_modules', '.bin', 'tsx'),
      [join(here, 'src', 'bin.ts'), 'decide', 'plan', 'auth-refresh-plan-1', '--approve', '--trust-cmds'],
      { cwd: repo.root, env: hermeticEnv({ WITNESS_CRASH_AFTER: 'trust-journal' }) })
    expect(res.code, res.stderr).toBe(9)
    expect(allowed(repo)).not.toContain('echo ok')
    expect(JSON.parse(repo.read('.witness/txn.json')).op).toBe('trust(auth-refresh-plan-1)')
  })
})
