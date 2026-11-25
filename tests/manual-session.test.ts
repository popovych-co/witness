// Row 271 (the trust design §3.9). `gate --manual` keeps a stop for the human; a session drive started
// is no human, so it refuses there before anything is read or journaled.
import { describe, expect, it } from 'vitest'
import { acquireDriveLock, driveHolder } from '../src/drive-presence.js'
import { readStream } from '../src/journal.js'
import { autonomyOn, fakeScenario, gateEnv, putVerdict, shippableRepo } from './helpers.js'

const CLEAN = {
  coverage: [
    { anchor: '.gitignore', note: 'read' },
    { anchor: 'package.json', note: 'read' },
    { anchor: 'src/token.ts', note: 'read' },
    { anchor: 'tests/token.test.ts', note: 'read' },
  ],
  findings: [],
}

async function bench() {
  const { repo, planId } = await shippableRepo()
  const scenario = fakeScenario()
  putVerdict(scenario, CLEAN)
  return { repo, planId, env: gateEnv(scenario) }
}

describe('gate --manual inside a drive session (row 271)', () => {
  it('refuses, and nothing is journaled (Done-when)', async () => {
    const { repo, planId, env } = await bench()
    const before = readStream(repo.root, planId).length
    const r = await repo.cli(['gate', 'ship', planId, '--manual'], { env: { ...env, WITNESS_DRIVE: planId } })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('manual-in-session')
    expect(r.stderr).toContain(`witness gate ship ${planId} --manual`)
    expect(readStream(repo.root, planId)).toHaveLength(before)
  }, 120_000)

  it('--unchanged --manual refuses the same way; a plain gate in a drive session runs', async () => {
    const { repo, planId, env } = await bench()
    const before = readStream(repo.root, planId).length
    const both = await repo.cli(['gate', 'ship', planId, '--unchanged', '--manual'], { env: { ...env, WITNESS_DRIVE: planId } })
    expect([both.code, both.stderr]).toEqual([2, expect.stringContaining('manual-in-session')])
    expect(readStream(repo.root, planId)).toHaveLength(before)
    await repo.cli(['gate', 'ship', planId], { env: { ...env, WITNESS_DRIVE: planId } })
    expect(readStream(repo.root, planId).filter((e) => e.t === 'gate-run' && e.gate === 'ship')).toHaveLength(1)
  }, 120_000)

  it('outside a session --manual still keeps the stop for the human (row 173)', async () => {
    const { repo, planId, env } = await bench()
    autonomyOn(repo)
    const r = await repo.cli(['gate', 'ship', planId, '--manual'], { env })
    expect(r.code).toBe(1)
    const entries = readStream(repo.root, planId)
    const run = entries.findLastIndex((e) => e.t === 'gate-run' && e.gate === 'ship')
    expect(run).toBeGreaterThanOrEqual(0)
    expect(entries.slice(run + 1).filter((e) => e.t === 'human-decision')).toEqual([])
  }, 120_000)
})

describe('gate --manual inside a job drive started (row 271, security review)', () => {
  it('a drive job is no human either: --manual refuses under WITNESS_JOB, naming the marker', async () => {
    const { repo, planId, env } = await bench()
    const before = readStream(repo.root, planId).length
    const r = await repo.cli(['gate', 'ship', planId, '--manual'], { env: { ...env, WITNESS_JOB: 'base-lint' } })
    expect([r.code, r.stderr]).toEqual([2, expect.stringContaining('manual-in-session')])
    expect(r.stderr).toContain('WITNESS_JOB')
    expect(readStream(repo.root, planId)).toHaveLength(before)
  }, 120_000)
})

// Whole-branch review C1. `witness drive --manual` spawns `/witness --manual` sessions, which append
// `--manual` to every gate: the human asked for every stop, so a session of a manual drive keeps it.
describe('gate --manual in a drive --manual run (row 271, whole-branch review)', () => {
  const held = (root: string, manual: boolean) => {
    const lock = acquireDriveLock(root, manual ? { manual: true } : {})
    if (!lock.ok) throw new Error('drive lock')
    return lock.value
  }
  it('the drive lock says a run is manual', async () => {
    const { repo } = await bench()
    const release = held(repo.root, true)
    try { expect(driveHolder(repo.root)).toMatchObject({ pid: process.pid, manual: true }) } finally { release() }
    const plain = held(repo.root, false)
    try { expect(driveHolder(repo.root)!.manual).toBeUndefined() } finally { plain() }
  }, 120_000)
  it('a session of a drive --manual run keeps its --manual: the gate runs and leaves the stop to the human', async () => {
    const { repo, planId, env } = await bench()
    const release = held(repo.root, true)
    try {
      const r = await repo.cli(['gate', 'ship', planId, '--manual'], { env: { ...env, WITNESS_DRIVE: planId } })
      expect(r.stderr).not.toContain('manual-in-session')
      expect(r.code).toBe(1)
      expect(readStream(repo.root, planId).filter((e) => e.t === 'gate-run' && e.gate === 'ship')).toHaveLength(1)
    } finally { release() }
  }, 120_000)
  it('a session of a drive that is not manual, and a job of a manual one, still refuse', async () => {
    const { repo, planId, env } = await bench()
    const plain = held(repo.root, false)
    try {
      const r = await repo.cli(['gate', 'ship', planId, '--manual'], { env: { ...env, WITNESS_DRIVE: planId } })
      expect([r.code, r.stderr]).toEqual([2, expect.stringContaining('manual-in-session')])
    } finally { plain() }
    const manual = held(repo.root, true)
    try {
      const r = await repo.cli(['gate', 'ship', planId, '--manual'], { env: { ...env, WITNESS_JOB: 'base-lint' } })
      expect([r.code, r.stderr]).toEqual([2, expect.stringContaining('manual-in-session')])
    } finally { manual() }
  }, 120_000)
})
