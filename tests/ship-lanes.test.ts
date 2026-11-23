import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import type { GateRunEntry } from '../src/rounds.js'
import { canonicalSha } from '../src/sha.js'
import { findById, loadCanon } from '../src/scan.js'
import { TOKEN_BROKEN, fakeCtx, fakeScenario, fixtureEnv, gateEnv, patchConfig, putVerdict, shippableRepo, writeSpec } from './helpers.js'
import { BASE_LINT, baseLintKind } from '../src/base-lint.js'
import { loadConfig, type Config } from '../src/config.js'
import { acquireDriveLock } from '../src/drive-presence.js'
import { journalShard } from '../src/jobs.js'

const cfgOf = (root: string): Config => { const r = loadConfig(root); if (!r.ok) throw new Error('config'); return r.value }

// vitest-single fixture lands 4 files in the worktree diff (.gitignore, package.json,
// src/token.ts, tests/token.test.ts) — coverage-minimum needs an anchor per each.
const CLEAN = {
  coverage: [
    { anchor: '.gitignore', note: 'read' },
    { anchor: 'package.json', note: 'read' },
    { anchor: 'src/token.ts', note: 'read' },
    { anchor: 'tests/token.test.ts', note: 'read' },
  ],
  findings: [],
}
const runs = (repo: { root: string }, id: string) =>
  readStream(repo.root, id).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]

describe('ship gate', () => {
  it('always stops — green lanes and a clean battery still land a stop', async () => {
    const { repo, planId } = await shippableRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })       // pass implement first
    expect(await runGate(ctx, 'ship', planId, { fresh: false, manual: false })).toBe(1)
    const entry = runs(repo, planId).at(-1)!
    expect(entry.gate).toBe('ship')
    expect(entry.outcome).toBe('stopped')
    expect(entry.standing).toContain('ship')
    for (const name of ['implement-gate', 'tests', 'lint', 'drift-lane']) {
      expect(entry.checks.find((c) => c.name === name)!.ok).toBe(true)
    }
  })

  it('a red drift lane fails closed', async () => {
    const { repo, wt, planId } = await shippableRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
    expect(await runGate(ctx, 'ship', planId, { fresh: false, manual: false })).toBe(1)
    const entry = runs(repo, planId).at(-1)!
    expect(entry.checks.find((c) => c.name === 'drift-lane')!.ok).toBe(false)
  })

  it('re-pins derives-from to what the lane executed against, in the gate commit', async () => {
    const { repo, planId, specId } = await shippableRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    // prose-only amendment: criteria unchanged, so the lane still passes — but the pin is stale
    await writeSpec(repo, specId, { summary: 'rotation, now with clearer prose' })
    const before = String(findById(loadCanon(repo.root), planId)!.meta['derives-from'])
    expect(await runGate(ctx, 'ship', planId, { fresh: true, manual: false })).toBe(1)
    const canon = loadCanon(repo.root)
    const parent = findById(canon, specId)!
    const pin = String(findById(canon, planId)!.meta['derives-from'])
    expect(pin).not.toBe(before)
    expect(pin).toBe(canonicalSha(parent.meta, parent.body))
    expect(repo.git('log', '-1', '--format=%B')).toContain('gate(ship)')
  })

  it('an unpassed implement gate fails the implement-gate check', async () => {
    const { repo, planId } = await shippableRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    expect(await runGate(ctx, 'ship', planId, { fresh: false, manual: false })).toBe(1)
    const entry = runs(repo, planId).at(-1)!
    expect(entry.checks.find((c) => c.name === 'implement-gate')!.ok).toBe(false)
  })

  // Characterization, deliberately asymmetric with `next`: a moved worktree re-arms the
  // implement gate for `next` (D75) but must NOT un-settle it for ship. Ship's own pr
  // stamp moves the tree via the watch-phase rebase, so a sha-sensitive check here is
  // the approve → pr → lapse → gate livelock D75/D77 record. The asymmetry is the fix,
  // not a bug — this test exists so nobody "unifies" it back into a deadlock.
  it('keeps implement-gate settled when the worktree moves after the pass', async () => {
    const { repo, wt, planId } = await shippableRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    writeFileSync(join(wt, 'shipped-after-the-verdict.md'), 'a state commit reaching the worktree\n')

    expect(await runGate(ctx, 'ship', planId, { fresh: false, manual: false })).toBe(1)
    const entry = runs(repo, planId).at(-1)!
    expect(entry.checks.find((c) => c.name === 'implement-gate')!.ok).toBe(true)
  })
})

// D94, ship side: shipPhase returns 'gate' after a revise, and the gate answers
// changed-nothing on unchanged content — so `witness ship` spent a turn telling the
// human to run the command that had just declined.
describe('a revised ship gate hands back', () => {
  it('does not re-gate unchanged content after a ship revise', async () => {
    const { repo, wt, planId } = await shippableRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'ship', planId, { fresh: false, manual: false })
    const revised = await repo.cli(['decide', 'ship', planId, '--revise', '--note', 'rename the helper'])
    expect(revised.code).toBe(0)

    const before = readStream(repo.root, planId).filter((e) => e.t === 'gate-run').length
    const res = await repo.cli(['ship', planId], { env: gateEnv(scenario) })
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('revise owed')
    expect(res.stdout).toContain(wt)
    expect(readStream(repo.root, planId).filter((e) => e.t === 'gate-run').length).toBe(before)
  })
})

describe('a check names the commands trust blocked (A1)', () => {
  it('a check names each command trust blocked, and only then (A1)', async () => {
    const { repo, planId } = await shippableRepo()
    const scenario = fakeScenario(); putVerdict(scenario, CLEAN)
    await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'implement', planId, { fresh: false, manual: false })
    expect(runs(repo, planId).at(-1)!.checks.every((c) => c.untrusted === undefined)).toBe(true)
    rmSync(join(repo.root, '.witness', 'allow.json'))           // a machine that trusts nothing yet
    const blocked = fakeCtx(repo.root, { env: gateEnv(scenario, { WITNESS_TRUST_CMDS: '' }) })
    expect(await runGate(blocked, 'ship', planId, { fresh: false, manual: false })).toBe(1)
    const checks = runs(repo, planId).at(-1)!.checks
    expect(checks.find((c) => c.name === 'tests')!.untrusted).toEqual(['true'])
    expect(checks.find((c) => c.name === 'lint')!.untrusted).toEqual(['true'])
    const lane = checks.find((c) => c.name === 'drift-lane')!
    expect(lane.untrusted).toHaveLength(1)
    expect(lane.untrusted![0]).toContain('run -t "@spec:{id}"')
    expect(lane.detail).toBe('ac-rotate:fail')
  })
})

describe('the lint lane in a ship gate (row 263)', () => {
  it('a ship gate journals a pending base key, the job answers it, and the next round reads it (row 263)', async () => {
    const { repo, wt, planId } = await shippableRepo()
    patchConfig(repo, { ship: { lint: { ui: '! grep -rq LINTBAD src' } } })
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'a lint part')
    writeFileSync(join(wt, 'src', 'bad.ts'), 'LINTBAD\n')
    const scenario = fakeScenario()
    putVerdict(scenario, { ...CLEAN, coverage: [...CLEAN.coverage, { anchor: 'src/bad.ts', note: 'read' }] })
    const lint = () => runs(repo, planId).at(-1)!.checks.find((c) => c.name === 'lint')!.parts![0]!
    const held = acquireDriveLock(repo.root, {})
    try {
      await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'ship', planId, { fresh: true, manual: false })
      const pending = lint()
      expect(pending).toMatchObject({ part: 'ui', state: 'pending', key: expect.stringMatching(/^ui@[0-9a-f]{40}\.[0-9a-f]{12}$/) })
      const owed = baseLintKind.owed(repo.root, cfgOf(repo.root), loadCanon(repo.root))
      expect(owed).toEqual([{ kind: BASE_LINT, key: pending.key, shards: 1 }])
      const r = baseLintKind.run(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), cfgOf(repo.root), owed[0]!, 1)
      expect(r).toMatchObject({ outcome: 'done', result: { exit: 0 } })
      journalShard(repo.root, { kind: BASE_LINT, key: pending.key!, shard: 1, of: 1, outcome: 'done', ms: 1, result: (r as { result: unknown }).result })
      await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'ship', planId, { fresh: true, manual: false })
      expect(lint()).toEqual({ part: 'ui', state: 'red', key: pending.key })
    } finally {
      if (held.ok) held.value()
    }
  }, 240_000)
})

describe('the lint lane in a ship gate — slice 3 review (row 263)', () => {
  it('a re-run gate on unchanged content journals the judged verdict, never resumes the pending round (I1)', async () => {
    const { repo, wt, planId } = await shippableRepo()
    patchConfig(repo, { ship: { lint: { ui: '! grep -rq LINTBAD src' } } })
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'a lint part')
    writeFileSync(join(wt, 'src', 'bad.ts'), 'LINTBAD\n')
    const scenario = fakeScenario()
    putVerdict(scenario, { ...CLEAN, coverage: [...CLEAN.coverage, { anchor: 'src/bad.ts', note: 'read' }] })
    const lint = () => runs(repo, planId).at(-1)!.checks.find((c) => c.name === 'lint')!.parts![0]!
    const held = acquireDriveLock(repo.root, {})
    try {
      await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'ship', planId, { fresh: true, manual: false })
      const pending = lint()
      expect(pending).toMatchObject({ state: 'pending' })
      const r = baseLintKind.run(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), cfgOf(repo.root), { kind: BASE_LINT, key: pending.key!, shards: 1 }, 1)
      journalShard(repo.root, { kind: BASE_LINT, key: pending.key!, shard: 1, of: 1, outcome: 'done', ms: 1, result: (r as { result: unknown }).result })
      await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'ship', planId, { fresh: false, manual: false })
      expect(runs(repo, planId)).toHaveLength(2)
      expect(lint()).toEqual({ part: 'ui', state: 'red', key: pending.key })
    } finally {
      if (held.ok) held.value()
    }
  }, 240_000)
})
