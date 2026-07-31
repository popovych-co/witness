import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ok } from '../src/refusal.js'
import { appendEntry, readStream } from '../src/journal.js'
import { registerGate, runGate, type GateInput } from '../src/gate.js'
import type { GateRunEntry } from '../src/rounds.js'
import { canonicalSha } from '../src/sha.js'
import { loadCanon, findById } from '../src/scan.js'
import { SPEC_META, fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, writeSpec } from './helpers.js'

const CLEAN = (doc: string) => ({
  coverage: [{ anchor: `${doc} > ## Behavior`, note: 'read' }], findings: [],
})
const BLOCKING = (doc: string) => ({
  coverage: [{ anchor: `${doc} > ## Behavior`, note: 'read' }],
  findings: [{ blocking: true, anchor: `${doc} > ## Behavior`, claim: 'expiry bound missing' }],
})

let synthetic = false
function registerSynthetic() {
  if (synthetic) return
  synthetic = true
  registerGate({
    gate: 'plan',
    targetKind: 'plan',
    async resolve(root, _ctx, canon, _cfg, target) {
      const doc = findById(canon, target)!
      return ok<GateInput>({
        class: 'feature',
        reviewedSha: canonicalSha(doc.meta, doc.body),
        artifactSha: canonicalSha(doc.meta, doc.body),
        reviewed: { kind: 'docs', docs: [{ id: target, body: doc.body }] },
        promptBody: doc.body,
        checks: [{ name: 'synthetic', ok: true }],
        stamps: [{ artifact: target, to: 'approved' }],
      })
    },
  })
}

async function gateRepo(env: Record<string, string> = {}) {
  registerSynthetic()
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  const scenario = fakeScenario()
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario, env) })
  return { repo, scenario, ctx }
}
const runs = (repo: { root: string }) =>
  readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]

// Simulates a human-decision entry the way a real `witness decide` would land it:
// appendEntry() alone only touches the working tree — write.ts's unrelated-dirty
// guard then refuses the next `witness write` unless this is committed too.
function journalDecision(repo: { root: string; git: (...args: string[]) => string }, artifact: string, entry: Parameters<typeof appendEntry>[2]): void {
  appendEntry(repo.root, artifact, entry)
  repo.git('add', `.witness/journal/${artifact}.jsonl`)
  repo.git('commit', '-m', `decide(${artifact}): ${(entry as { decision?: string }).decision}`, '-m', 'Witness-State: 1')
}

describe('gate engine', () => {
  it('green path: clean covering verdict + green checks → passed, stamped, committed', async () => {
    const { repo, scenario, ctx } = await gateRepo()
    putVerdict(scenario, CLEAN('auth-refresh'))
    const code = await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })
    expect(code).toBe(0)
    const all = runs(repo)
    expect(all.length).toBe(1)
    expect(all[0].outcome).toBe('passed')
    expect(all[0].calibration).toBe('none')
    const canon = loadCanon(repo.root)
    expect(findById(canon, 'auth-refresh')!.meta.status).toBe('approved')
    const statuses = readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'status')
    expect(statuses.length).toBe(1)
    expect(repo.git('log', '-1', '--format=%B')).toContain('Witness-State: 1')
    // doc reviews carry the verbatim anchor menu ahead of the reviewed content
    const stdin = readFileSync(join(scenario, 'claude-calls/call-1/stdin'), 'utf8')
    expect(stdin).toContain('## Valid anchors')
    expect(stdin).toContain('- auth-refresh > ## Behavior')
  })

  it('runs the battery through pi when the resolved harness is pi', async () => {
    const { repo, scenario, ctx } = await gateRepo({ WITNESS_HARNESS: 'pi' })
    putVerdict(scenario, CLEAN('auth-refresh'))
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(0)
    const argv = readFileSync(join(scenario, 'pi-calls/call-1/argv'), 'utf8')
    expect(argv).toContain('--mode\njson')
    expect(argv).toContain('--thinking\noff')
    // full routing, no fallback: claude is never spawned on a pi-resolved gate
    expect(existsSync(join(scenario, 'claude-calls'))).toBe(false)
    expect(runs(repo)[0]!.harness).toBe('pi')
  })

  it('blocking finding → stopped, no stamp; resume renders without appending', async () => {
    const { repo, scenario, ctx } = await gateRepo()
    putVerdict(scenario, BLOCKING('auth-refresh'))
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(1)
    expect(runs(repo).length).toBe(1)
    expect(runs(repo)[0].outcome).toBe('stopped')
    expect(findById(loadCanon(repo.root), 'auth-refresh')!.meta.status).toBe('draft')
    // resume: same content, same key — nothing appends, claude not re-invoked
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(1)
    expect(runs(repo).length).toBe(1)
    expect(readFileSync(join(scenario, 'claude-calls/call-1/stdin'), 'utf8')).toBeTruthy()
    expect(() => readFileSync(join(scenario, 'claude-calls/call-2/stdin'), 'utf8')).toThrow()
  })

  it('a per-gate model pin reaches the reviewer invocation and the journal', async () => {
    const { repo, scenario, ctx } = await gateRepo()
    // init's config already pins a global gates.model — the per-gate pin must beat it
    const cfgPath = join(repo.root, 'witness.config.yaml')
    writeFileSync(cfgPath, readFileSync(cfgPath, 'utf8').replace(
      'plan: { reviewers: [plan-critic] }',
      'plan: { reviewers: [plan-critic], model: test-plan-model }'))
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'pin plan model')
    putVerdict(scenario, CLEAN('auth-refresh'))
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(0)
    expect(runs(repo)[0].model).toBe('test-plan-model')
    expect(readFileSync(join(scenario, 'claude-calls/call-1/argv'), 'utf8')).toContain('test-plan-model')
  })

  it('malformed verdict (unresolvable anchor) → one reroll, then outcome malformed, fail-closed stop', async () => {
    const { repo, scenario, ctx } = await gateRepo()
    putVerdict(scenario, {
      coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }],
      findings: [{ blocking: true, anchor: 'auth-refresh > ## Nowhere', claim: 'ghost' }],
    })
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(1)
    const [entry] = runs(repo)
    expect(entry!.outcome).toBe('malformed')
    expect(entry!.rerolled).toEqual(['plan-critic'])
    expect(entry!.malformed![0]!.violations[0]!.rule).toBe('anchor-unresolvable')
    // both attempts consumed claude calls; the retry carried the rejection back
    const retry = readFileSync(join(scenario, 'claude-calls/call-2/stdin'), 'utf8')
    expect(retry).toContain('## Previous attempt rejected')
    expect(retry).toContain('anchor-unresolvable')
  })

  it('malformed first attempt + clean reroll → verdict counted, round not poisoned', async () => {
    const { repo, scenario, ctx } = await gateRepo()
    putVerdict(scenario, {
      coverage: [{ anchor: 'auth-refresh > ## Nowhere', note: 'ghost' }],
      findings: [],
    }, 1)
    putVerdict(scenario, CLEAN('auth-refresh'), 2)
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(0)
    const [entry] = runs(repo)
    expect(entry!.outcome).toBe('passed')
    expect(entry!.rerolled).toEqual(['plan-critic'])
    expect(entry!.malformed).toBeUndefined()
    expect(entry!.verdicts).toHaveLength(1)
  })

  it('previously seen content re-appends its cached verdict and counts a round', async () => {
    const { repo, scenario, ctx } = await gateRepo()
    putVerdict(scenario, BLOCKING('auth-refresh'))
    await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })   // A, round 1
    journalDecision(repo, 'auth-refresh', { v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh', round: 1, decision: 'revise' })
    await writeSpec(repo, 'auth-refresh', { ...SPEC_META, summary: 'content B' })  // B
    await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })   // B, round 2
    journalDecision(repo, 'auth-refresh', { v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh', round: 2, decision: 'revise' })
    await writeSpec(repo, 'auth-refresh')                                         // back to A
    await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })   // cached, round 3
    const all = runs(repo)
    expect(all.length).toBe(3)
    expect(all[2]!.cached).toBe(true)
    expect(all[2]!.round).toBe(3)
    const calls = readFileSync(join(scenario, 'claude-calls/call-2/stdin'), 'utf8')
    expect(calls).toBeTruthy()
    expect(() => readFileSync(join(scenario, 'claude-calls/call-3/stdin'), 'utf8')).toThrow()
    // round 3 of 3 → the bound now refuses a fourth
    journalDecision(repo, 'auth-refresh', { v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh', round: 3, decision: 'revise' })
    await writeSpec(repo, 'auth-refresh', { ...SPEC_META, summary: 'content C' })
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(3)
    expect(runs(repo).length).toBe(3)
  })

  it('bound short-circuit and render advertise every live exit and the budget', async () => {
    const { repo, scenario, ctx } = await gateRepo()
    putVerdict(scenario, BLOCKING('auth-refresh'))
    const out: string[] = []
    const ctxOut = fakeCtx(repo.root, { env: gateEnv(scenario), out: (l: string) => out.push(l) })
    await runGate(ctxOut, 'plan', 'auth-refresh', { fresh: false, manual: false })
    expect(out.join('\n')).toContain('round: 1 of 3')
    expect(out.join('\n')).toContain('--revise --upstream')
    for (const round of [1, 2]) {
      journalDecision(repo, 'auth-refresh', { v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh', round, decision: 'revise' })
      await writeSpec(repo, 'auth-refresh', { ...SPEC_META, summary: `content ${round}` })
      await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })
    }
    journalDecision(repo, 'auth-refresh', { v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh', round: 3, decision: 'stop' })
    await writeSpec(repo, 'auth-refresh', { ...SPEC_META, summary: 'content after stop' })
    const out2: string[] = []
    const ctx2 = fakeCtx(repo.root, { env: gateEnv(scenario), out: (l: string) => out2.push(l) })
    expect(await runGate(ctx2, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(3)
    const text = out2.join('\n')
    expect(text).toContain('--approve --override')
    expect(text).toContain('--revise --upstream')
    expect(text).toContain('witness abandon auth-refresh')
  })

  it('two consecutive malformed rounds on the same model+prompts → third run refused with remedy', async () => {
    const { repo, scenario, ctx } = await gateRepo()
    putVerdict(scenario, {
      coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }],
      findings: [{ blocking: true, anchor: 'auth-refresh > ## Nowhere', claim: 'ghost' }],
    })
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: true, manual: false })).toBe(1)
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: true, manual: false })).toBe(1)
    expect(runs(repo).every((r) => r.outcome === 'malformed')).toBe(true)
    // changed content would normally trigger a fresh (costly) battery run —
    // the brake refuses it while the same model+prompts keep emitting garbage
    await writeSpec(repo, 'auth-refresh', { ...SPEC_META, summary: 'revised after malformed rounds' })
    const errs: string[] = []
    const ctx3 = fakeCtx(repo.root, { env: gateEnv(scenario), err: (l: string) => errs.push(l) })
    expect(await runGate(ctx3, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(2)
    expect(errs.join('\n')).toContain('malformed-streak')
    expect(runs(repo).length).toBe(2)
    // --fresh is the explicit escape hatch: forces a live re-run anyway
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: true, manual: false })).toBe(1)
    expect(runs(repo).length).toBe(3)
  })

  it('a revise that lands identical content is an explicit changed-nothing stop', async () => {
    const { repo, scenario, ctx } = await gateRepo()
    putVerdict(scenario, BLOCKING('auth-refresh'))
    await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })
    journalDecision(repo, 'auth-refresh', { v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh', round: 1, decision: 'revise' })
    const out: string[] = []
    const ctx2 = fakeCtx(repo.root, { env: gateEnv(scenario), out: (l: string) => out.push(l) })
    expect(await runGate(ctx2, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(1)
    expect(runs(repo).length).toBe(1)
    expect(out.join('\n')).toContain('changed nothing')
  })

  it('--manual stops even a green run; --fresh re-rolls the reviewer', async () => {
    const { repo, scenario, ctx } = await gateRepo()
    putVerdict(scenario, CLEAN('auth-refresh'))
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: true })).toBe(1)
    expect(runs(repo)[0]!.outcome).toBe('stopped')
    expect(runs(repo)[0]!.manual).toBe(true)
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: true, manual: false })).toBe(0)
    expect(runs(repo).length).toBe(2)
    expect(readFileSync(join(scenario, 'claude-calls/call-2/stdin'), 'utf8')).toBeTruthy()
  })

  it('walks the model fallback chain on invocation failure and records it', async () => {
    const { repo, scenario } = await gateRepo()
    writeFileSync(join(repo.root, 'witness.config.yaml'), 'schema: 1\ngates:\n  model: test-model-1\n')
    writeFileSync(join(repo.root, '.witness/calibration.local.yaml'), 'models:\n  - test-model-2\n')
    putVerdict(scenario, CLEAN('auth-refresh'))
    writeFileSync(join(scenario, 'claude-fail'), '1')
    const errs: string[] = []
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario), err: (l: string) => errs.push(l) })
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(0)
    const [entry] = runs(repo)
    expect(entry!.fallback).toEqual(['test-model-1'])
    expect(entry!.model).toBe('test-model-2')
    expect(entry!.calibration).toBe('local')
    // a dead head model is config rot — it must be named, not silently absorbed
    expect(errs.join('\n')).toContain('test-model-1 failed to invoke')
  })
})
