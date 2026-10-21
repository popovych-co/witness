import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ok } from '../src/refusal.js'
import { appendEntry, readStream } from '../src/journal.js'
import { openDeferrals, type DeferralEntry } from '../src/deferral.js'
import { registerGate, runGate, type GateInput } from '../src/gate.js'
import type { GateCheck, GateRunEntry } from '../src/rounds.js'
import { canonicalSha } from '../src/sha.js'
import { findById } from '../src/scan.js'
import { snapshotFiles } from '../src/snapshot.js'
import { SPEC_BODY, callCount, callFor, fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, writeSpec } from './helpers.js'

const DOC = 'auth-refresh > ## Behavior'
const BLOCKING = { coverage: [{ anchor: DOC, note: 'read' }], findings: [{ blocking: true, anchor: DOC, claim: 'unbounded' }] }
const CLEAN = { coverage: [{ anchor: DOC, note: 'read' }], findings: [] }
const SCREEN = (blocking: boolean) => ({ coverage: [{ anchor: 'home.png', note: 'seen' }],
  findings: blocking ? [{ blocking: true, anchor: 'home.png', claim: 'off-look' }] : [] })
const runs = (root: string) => readStream(root, 'auth-refresh').filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]
const F = { fresh: false, manual: false }
let checks: GateCheck[] = []

function input(root: string, doc: { meta: Record<string, unknown>; body: string }, target: string, extra: Partial<GateInput> = {}): GateInput {
  return {
    class: 'feature', reviewedSha: canonicalSha(doc.meta, doc.body),
    reviewed: { kind: 'docs', docs: [{ id: target, body: doc.body }] }, promptBody: doc.body, checks, stamps: [],
    snapshot: { tree: snapshotFiles(root, [{ name: `${target}.md`, content: doc.body }])!, context: 'synthetic' }, ...extra,
  }
}
// Registered before every test: an in-process `decide` imports gates/index.js, which puts the
// real gates back for the rest of the file.
beforeEach(() => {
  registerGate({ gate: 'plan', targetKind: 'plan',
    async resolve(root, _c, canon, _cfg, target) { return ok(input(root, findById(canon, target)!, target)) } })
  // Demotes as the real code gates do, over docs: the section-level cases of the rule reach gate.ts here.
  registerGate({ gate: 'ship', targetKind: 'plan', demotes: true, backstops: 'implement',
    async resolve(root, _c, canon, _cfg, target) {
      return ok(input(root, findById(canon, target)!, target, { checks: [{ name: 'synthetic', ok: true }],
        lensOverrides: { 'code-reviewer': { reviewed: { kind: 'screens', captures: [{ name: 'home.png', path: '/w/home.png' }] }, promptBody: 'READ /w/home.png' } } }))
    } })
})

async function spec() {
  const repo = await seededRepo(); await writeSpec(repo, 'auth-refresh')
  const scenario = fakeScenario()
  return { repo, scenario, ctx: fakeCtx(repo.root, { env: gateEnv(scenario) }) }
}
const amend = (repo: Awaited<ReturnType<typeof spec>>['repo']) => writeSpec(repo, 'auth-refresh', {}, `${SPEC_BODY}\n## Notes\nMore.\n`)

describe('delta review on synthetic gates (C3)', () => {
  it('a check flip on a delta round replays it as a new round with its delta mark (row 112)', async () => {
    checks = [{ name: 'goal-coverage', ok: false }]
    const { repo, scenario, ctx } = await spec()
    putVerdict(scenario, BLOCKING); await runGate(ctx, 'plan', 'auth-refresh', F)
    await amend(repo); putVerdict(scenario, CLEAN); await runGate(ctx, 'plan', 'auth-refresh', F)
    checks = [{ name: 'goal-coverage', ok: true }]
    expect(await runGate(ctx, 'plan', 'auth-refresh', F)).toBe(0)
    const [, r2, r3] = runs(repo.root)
    expect(r2!.delta).toBeDefined()
    expect(r3!.cached).toBe(true)
    expect(r3!.delta).toEqual(r2!.delta)
    expect(r3!.verdicts).toEqual(r2!.verdicts)
    expect(callCount(scenario)).toBe(2)
  })

  it('a lens reviewing an override always reviews in full; the others get the delta', async () => {
    const { repo, scenario, ctx } = await spec()
    // round 1: both lenses block, so the base holds a screens finding the docs lens must not be shown
    putVerdict(scenario, BLOCKING, 'drift-reviewer'); putVerdict(scenario, SCREEN(true), 'code-reviewer')
    await runGate(ctx, 'ship', 'auth-refresh', F)
    await amend(repo)
    await runGate(ctx, 'ship', 'auth-refresh', F)
    const prompt = (lens: string) => readFileSync(join(callFor(scenario, lens)!, 'stdin'), 'utf8')
    expect(prompt('drift-reviewer')).toContain('## Delta review')
    expect(prompt('drift-reviewer')).toContain('unbounded (drift-reviewer)')
    expect(prompt('drift-reviewer')).not.toContain('off-look')                 // no screens finding in the block
    expect(prompt('code-reviewer')).not.toContain('## Delta review')
    expect(runs(repo.root)[1]!.delta).toEqual({ round: 1, run: runs(repo.root)[0]!.run_id })
  })
})

const M = 'auth-refresh > ## Motivation'
const NOTES = 'auth-refresh > ## Notes'
const at = (anchor: unknown, extra: Record<string, unknown> = {}) =>
  ({ coverage: [{ anchor: DOC, note: 'read' }], findings: [{ blocking: true, anchor, claim: 'x', ...extra }] })
// round 1 blocks at `first` · the spec gains a Notes section · round 2 answers `second`
async function demoting(second: unknown, first: unknown = at(M)) {
  const { repo, scenario } = await spec()
  const out: string[] = []
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario), out: (l) => out.push(l) })
  putVerdict(scenario, SCREEN(false), 'code-reviewer')
  putVerdict(scenario, first, 'drift-reviewer'); await runGate(ctx, 'ship', 'auth-refresh', F)
  await amend(repo)
  putVerdict(scenario, second, 'drift-reviewer')
  const code = await runGate(ctx, 'ship', 'auth-refresh', F)
  const found = runs(repo.root)[1]!.verdicts!.find((v) => v.reviewer === 'drift-reviewer')!.findings
  return { out, code, found }
}

describe('the demotion rule at a demoting gate (C3)', () => {
  it('a new blocking finding in an unchanged section is demoted and the round passes', async () => {
    const { out, code, found } = await demoting(at(DOC))
    expect(code).toBe(0)
    expect(found).toEqual([{ blocking: false, anchor: DOC, claim: 'x', demoted: 1 }])
    expect(out.join('\n')).toContain(`demoted: ${DOC} — unchanged since round 1`)
  })

  it('an anchor round 1 reported keeps blocking though its section is unchanged', async () => {
    const { code, found } = await demoting(at(DOC), { coverage: [{ anchor: DOC, note: 'read' }],
      findings: [{ blocking: true, anchor: M, claim: 'x' }, { blocking: true, anchor: DOC, claim: 'x' }] })
    expect(code).toBe(1)
    expect(found[0]).toEqual({ blocking: true, anchor: DOC, claim: 'x' })
  })

  it('a new blocking finding in the changed section blocks', async () => {
    const { code, found } = await demoting(at(NOTES))
    expect(code).toBe(1)
    expect(found[0]).toMatchObject({ anchor: NOTES, blocking: true })
  })

  it('a pin contradiction is never demoted', async () => {
    const { found } = await demoting(at(DOC, { contradicts_pin: 1 }))
    expect(found[0]).toEqual({ blocking: true, anchor: DOC, claim: 'x', contradicts_pin: 1 })
  })

  it('an omission scoped to an unchanged section is demoted', async () => {
    const { found } = await demoting(at({ kind: 'omission', scope: DOC }))
    expect(found[0]).toMatchObject({ blocking: false, demoted: 1 })
  })
})

// Row 187: a demoted finding is still a finding — its anchor counts as reported — and it is not
// blocking, so an override mints nothing for it.
describe('what a demotion counts for (C3)', () => {
  const open = (root: string) => openDeferrals(readStream(root, 'auth-refresh'))
  const both = (a: string, ab: boolean, b: string, bb: boolean) => ({ coverage: [{ anchor: DOC, note: 'read' }],
    findings: [{ blocking: ab, anchor: a, claim: 'x' }, { blocking: bb, anchor: b, claim: 'x' }] })

  it('guard: a demoted finding at an obligation anchor keeps it open', async () => {
    const { repo, scenario, ctx } = await spec()
    appendEntry(repo.root, 'auth-refresh', { v: 1, t: 'deferral', id: 'd-0000c3c3', artifact: 'auth-refresh', gate: 'ship',
      round: 3, anchor: DOC, kind: 'artifact-debt', caused_by_run: 'r-0' } as never)
    putVerdict(scenario, SCREEN(false), 'code-reviewer')
    putVerdict(scenario, both(M, true, DOC, false), 'drift-reviewer'); await runGate(ctx, 'ship', 'auth-refresh', F)
    await amend(repo)
    putVerdict(scenario, at(DOC), 'drift-reviewer'); await runGate(ctx, 'ship', 'auth-refresh', F)
    expect(runs(repo.root)[1]!.verdicts!.find((v) => v.reviewer === 'drift-reviewer')!.findings[0])
      .toMatchObject({ anchor: DOC, blocking: false, demoted: 1 })
    expect(open(repo.root).map((d) => d.id)).toEqual(['d-0000c3c3'])
  })

  it('guard: an override mints no obligation for a demoted finding', async () => {
    const { repo, scenario, ctx } = await spec()
    putVerdict(scenario, SCREEN(false), 'code-reviewer')
    putVerdict(scenario, at(M), 'drift-reviewer'); await runGate(ctx, 'ship', 'auth-refresh', F)
    await amend(repo); await runGate(ctx, 'ship', 'auth-refresh', F)
    await writeSpec(repo, 'auth-refresh', {}, `${SPEC_BODY}\n## Notes\nEven more.\n`)
    putVerdict(scenario, both(M, true, DOC, true), 'drift-reviewer'); await runGate(ctx, 'ship', 'auth-refresh', F)
    const r3 = runs(repo.root)[2]!.verdicts!.find((v) => v.reviewer === 'drift-reviewer')!.findings
    expect(r3).toEqual([{ blocking: true, anchor: M, claim: 'x' }, { blocking: false, anchor: DOC, claim: 'x', demoted: 2 }])
    const d = await repo.cli(['decide', 'ship', 'auth-refresh', '--approve', '--override'])
    expect(d.code).toBe(0)
    const minted = readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'deferral') as unknown as DeferralEntry[]
    expect(minted.map((x) => x.anchor)).toEqual([M])
  })
})

// Final review I1. Ship lists implement's outstanding demotions and promises "it then blocks
// here" — so ship must never demote one of them again, whichever lens reports it.
describe('ship never demotes what it backstops (C3, final review)', () => {
  it('a listed implement demotion re-reported in a ship delta round blocks', async () => {
    const { repo, scenario, ctx } = await spec()
    const imp = (round: number, findings: unknown[], extra: Record<string, unknown> = {}) => appendEntry(repo.root, 'auth-refresh', {
      v: 1, t: 'gate-run', gate: 'implement', artifact: 'auth-refresh', round, run_id: `i-${round}`, reviewed_sha: `x${round}`,
      prompts_sha: 'p', witness: '0', model: 'm', pin: 'm', calibration: 'none', checks: [], outcome: 'passed',
      verdicts: [{ reviewer: 'pr-test', coverage: [], findings }], ...extra } as never)
    imp(1, [])
    imp(2, [{ blocking: false, anchor: DOC, claim: 'x', demoted: 1 }], { delta: { round: 1, run: 'i-1' } })
    putVerdict(scenario, SCREEN(false), 'code-reviewer')
    putVerdict(scenario, at(M), 'drift-reviewer'); await runGate(ctx, 'ship', 'auth-refresh', F)
    await amend(repo)
    putVerdict(scenario, at(DOC), 'drift-reviewer')
    expect(await runGate(ctx, 'ship', 'auth-refresh', F)).toBe(1)
    const r2 = runs(repo.root).filter((r) => r.gate === 'ship')[1]!
    expect(r2.delta).toBeDefined()
    expect(r2.verdicts!.find((v) => v.reviewer === 'drift-reviewer')!.findings[0]).toEqual({ blocking: true, anchor: DOC, claim: 'x' })
  })
})
