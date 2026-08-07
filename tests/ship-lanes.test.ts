import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import type { GateRunEntry } from '../src/rounds.js'
import { canonicalSha } from '../src/sha.js'
import { findById, loadCanon } from '../src/scan.js'
import { TOKEN_BROKEN, fakeCtx, fakeScenario, gateEnv, putVerdict, shippableRepo, writeSpec } from './helpers.js'

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
