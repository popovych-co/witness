import { describe, expect, it } from 'vitest'
import { ok } from '../src/refusal.js'
import { readStream } from '../src/journal.js'
import { registerGate, runGate, type GateInput } from '../src/gate.js'
import type { GateCheck, GateRunEntry } from '../src/rounds.js'
import { canonicalSha } from '../src/sha.js'
import { findById } from '../src/scan.js'
import { fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, writeSpec } from './helpers.js'

const BLOCKING = {
  coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }],
  findings: [{ blocking: true, anchor: 'auth-refresh > ## Behavior', claim: 'expiry unbounded' }],
}
const CLEAN = { coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [] }

// The reviewed sha is deliberately fixed while `checks` is mutable: that is the exact
// shape row 112 is about — a deterministic check reading an input the cache key cannot
// see (journaled `covers`, a sibling plan's `derives-from`, the canon graph).
let checks: GateCheck[] = []
function syntheticGate() {
  registerGate({
    gate: 'plan',
    targetKind: 'plan',
    async resolve(_root, _ctx, canon, _cfg, target) {
      const doc = findById(canon, target)!
      return ok<GateInput>({
        class: 'feature',
        reviewedSha: canonicalSha(doc.meta, doc.body),
        reviewed: { kind: 'docs', docs: [{ id: target, body: doc.body }] },
        promptBody: doc.body,
        checks,
        stamps: [],
      })
    },
  })
}

const runs = (root: string) =>
  readStream(root, 'auth-refresh').filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]

async function gated(first: GateCheck[], verdict: unknown = BLOCKING) {
  syntheticGate()
  checks = first
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  const scenario = fakeScenario()
  putVerdict(scenario, verdict)
  const out: string[] = []
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario), out: (l: string) => out.push(l) })
  await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })
  return { repo, scenario, ctx, out }
}

describe('a resume cannot serve a verdict its own checks contradict (row 112)', () => {
  it('a check that flips replays the verdict into a NEW round with the fresh checks', async () => {
    const { repo, ctx } = await gated([{ name: 'goal-coverage', ok: false, detail: 'uncovered goals: g2' }], CLEAN)
    expect(runs(repo.root).length).toBe(1)
    expect(runs(repo.root)[0]!.outcome).toBe('stopped')

    // the journaled `covers` is corrected — same doc bytes, so the key cannot move
    checks = [{ name: 'goal-coverage', ok: true, detail: '11 goals covered' }]
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(0)
    const all = runs(repo.root)
    expect(all.length).toBe(2)
    expect(all[1]!.cached).toBe(true)                        // no battery re-invoked
    expect(all[1]!.checks).toEqual([{ name: 'goal-coverage', ok: true, detail: '11 goals covered' }])
    expect(all[1]!.outcome).toBe('passed')
    expect(all[1]!.verdicts).toEqual(all[0]!.verdicts)       // the reviewer judgment is replayed, not re-asked
  })

  it('unchanged checks still resume — a resume must not spend a round on a detail', async () => {
    const { repo, ctx } = await gated([{ name: 'goal-coverage', ok: false, detail: 'uncovered goals: g2' }])
    checks = [{ name: 'goal-coverage', ok: false, detail: 'uncovered goals: g2 (recomputed)' }]
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(1)
    expect(runs(repo.root).length).toBe(1)
  })

  it('a malformed round is never replayed as a cached one', async () => {
    // an unresolvable anchor twice → outcome malformed, no verdicts to replay
    const { repo, ctx } = await gated([{ name: 'goal-coverage', ok: false }], {
      coverage: [{ anchor: 'ghost > ## Nope', note: 'read' }], findings: [],
    })
    expect(runs(repo.root)[0]!.outcome).toBe('malformed')
    checks = [{ name: 'goal-coverage', ok: true }]
    await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })
    const all = runs(repo.root)
    expect(all.every((r) => r.cached !== true)).toBe(true)
  })
})
