import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ok } from '../src/refusal.js'
import { appendEntry, readStream } from '../src/journal.js'
import { registerGate, runGate, type GateInput } from '../src/gate.js'
import type { GateRunEntry } from '../src/rounds.js'
import { canonicalSha } from '../src/sha.js'
import { loadCanon, findById } from '../src/scan.js'
import { SPEC_META, callCount, fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, writeSpec, patchConfig } from './helpers.js'

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
    reads: 'docs',
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
    // D129: the upstream is resolved by the gate and threaded into every render, so a
    // stand-in gate must supply one or `liveExits` correctly omits the option. Asserting
    // on `--revise --upstream` below therefore also proves runGate does the threading.
    upstreamOf(_root, _canon, target) {
      return target
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
    expect(all[0]).not.toHaveProperty('calibration')
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
    const { repo, scenario, ctx } = await gateRepo({ PI_CODING_AGENT: 'true' })
    patchConfig(repo, { harness: 'pi' })   // row 193: the judge is declared, never detected
    putVerdict(scenario, CLEAN('auth-refresh'))
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(0)
    const argv = readFileSync(join(scenario, 'pi-calls/call-1/argv'), 'utf8')
    expect(argv).toContain('--mode\njson')
    expect(argv).toContain('--thinking\noff')
    // full routing, no fallback: claude is never spawned on a pi-resolved gate
    expect(existsSync(join(scenario, 'claude-calls'))).toBe(false)
    expect(runs(repo)[0]!.harness).toBe('pi')
  })

  it('declared reviewerExtensions reach the pi argv and the gate-run journal entry', async () => {
    const { repo, scenario, ctx } = await gateRepo({ PI_CODING_AGENT: 'true' })
    patchConfig(repo, { harness: 'pi' })
    putVerdict(scenario, CLEAN('auth-refresh'))
    repo.write('.witness/config.local.yaml', "reviewerExtensions: ['/opt/pi/oauth-adapter']\n")
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(0)
    const argv = readFileSync(join(scenario, 'pi-calls/call-1/argv'), 'utf8')
    expect(argv).toContain('-e\n/opt/pi/oauth-adapter')
    expect(runs(repo)[0]!.reviewer_extensions).toEqual(['/opt/pi/oauth-adapter'])
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
    // init's config pins every gate (row 193) — the plan gate's own pin is the one that runs
    patchConfig(repo, { gates: { plan: { model: 'test-plan-model' } } })
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

  it('a re-gate after a malformed round runs its lens again (P1, row 209)', async () => {
    const { repo, scenario, ctx } = await gateRepo()
    putVerdict(scenario, { coverage: [], findings: [] })
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(1)
    putVerdict(scenario, CLEAN('auth-refresh'))
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(0)
    expect(runs(repo).map((r) => r.outcome)).toEqual(['malformed', 'passed'])
    expect(runs(repo)[1]).not.toHaveProperty('carried')
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

  it('a dead pin refuses the gate with the invocation rows and the pin to fix, journaling nothing (row 212)', async () => {
    const { repo, scenario } = await gateRepo()
    writeFileSync(join(repo.root, 'witness.config.yaml'), 'schema: 1\ngates:\n  model: test-model-1\n')
    putVerdict(scenario, CLEAN('auth-refresh'))
    writeFileSync(join(scenario, 'claude-error'),
      "There's an issue with the selected model (test-model-1). It may not exist or you may not have access to it.")
    const errs: string[] = []
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario), err: (l: string) => errs.push(l) })
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(2)
    expect(runs(repo)).toHaveLength(0)
    expect(callCount(scenario)).toBe(1)
    expect(errs.join('\n')).toContain('gates.plan.model')
    expect(errs.join('\n')).toContain("a human's decision: pin-unanswered")
  })

  it('a provider failure on a live pin names the pin, but leaves the re-run to the reader (row 212)', async () => {
    const { repo, scenario } = await gateRepo()
    writeFileSync(join(repo.root, 'witness.config.yaml'), 'schema: 1\ngates:\n  model: test-model-1\n')
    putVerdict(scenario, CLEAN('auth-refresh'))
    writeFileSync(join(scenario, 'claude-error'), 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}')
    writeFileSync(join(scenario, 'claude-error-calls'), '1')
    const errs: string[] = []
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario), err: (l: string) => errs.push(l) })
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(2)
    expect(errs.join('\n')).toContain('gates.plan.model,pin-unanswered')
    expect(errs.join('\n')).not.toContain("a human's decision")
    expect(errs.join('\n')).toContain('help: fix each row and re-run')
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(0)   // the blip clears
  })

  it('a pin this harness cannot run is refused under its own setting, not the retired gates.model (row 212)', async () => {
    const { repo, scenario } = await gateRepo()
    writeFileSync(join(repo.root, 'witness.config.yaml'), 'schema: 1\ngates:\n  model: anthropic/test-model-1\n')
    putVerdict(scenario, CLEAN('auth-refresh'))
    const errs: string[] = []
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario), err: (l: string) => errs.push(l) })
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(2)
    expect(callCount(scenario)).toBe(0)
    expect(errs.join('\n')).toContain('gates.plan.model,provider-unrunnable')
    expect(errs.join('\n')).not.toMatch(/^\s*gates\.model,/m)
  })

  it('the model line names the model alone; the entry carries no calibration stamp (row 212)', async () => {
    const { repo, scenario } = await gateRepo()
    writeFileSync(join(repo.root, 'witness.config.yaml'), 'schema: 1\ngates:\n  model: test-model-1\n')
    putVerdict(scenario, CLEAN('auth-refresh'))
    const out: string[] = []
    const err: string[] = []
    await runGate(fakeCtx(repo.root, { env: gateEnv(scenario), out: (l) => out.push(l), err: (l) => err.push(l) }),
      'plan', 'auth-refresh', { fresh: false, manual: false })
    const run = runs(repo)[0]!
    expect(out).toContain('model: test-model-1')
    expect(`${out.join('\n')}\n${err.join('\n')}`).not.toMatch(/calibrat/i)
    expect(run).not.toHaveProperty('calibration')
  })

  it('after a fallen-back round 0.25.x journaled, a re-gate asks the pin and journals no fallback', async () => {
    const { repo, scenario } = await gateRepo()
    writeFileSync(join(repo.root, 'witness.config.yaml'), 'schema: 1\ngates:\n  model: test-model-1\n')
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'pin')
    const doc = findById(loadCanon(repo.root), 'auth-refresh')!
    journalDecision(repo, 'auth-refresh', {
      v: 1, t: 'gate-run', gate: 'plan', artifact: 'auth-refresh', round: 1, run_id: 'r-0250',
      reviewed_sha: canonicalSha(doc.meta, doc.body), prompts_sha: 'p', witness: '0.25.0',
      model: 'session-default', pin: 'test-model-1', harness: 'claude-code', calibration: 'none', fallback: ['test-model-1'],
      standing: 'fallback — reviewers ran on session-default, not the pinned test-model-1; the human decides whether that verdict counts',
      checks: [{ name: 'synthetic', ok: true }], verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [] }], outcome: 'stopped',
    } as never)
    putVerdict(scenario, CLEAN('auth-refresh'))
    expect(await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(0)
    const last = runs(repo).at(-1)!
    expect([last.model, last.pin, last.fallback]).toEqual(['test-model-1', 'test-model-1', undefined])
    expect(callCount(scenario)).toBe(1)
  })
})

// D99: gateSettled reads only the LAST run, so any new run un-settles the gate. Content
// moving is a self-explaining reason. A flag is not — and row 94 removed --fresh's other
// job (escaping the changed-nothing deadlock), so it can afford to refuse.
describe('a settled approve is never discarded in silence', () => {
  it('refuses --fresh on a settled gate and names the retraction verb', async () => {
    const { repo, scenario, ctx } = await gateRepo()
    putVerdict(scenario, CLEAN('auth-refresh'))
    expect(await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(0)

    const err: string[] = []
    const code = await runGate(fakeCtx(repo.root, { env: gateEnv(scenario), err: (l) => err.push(l) }),
      'plan', 'auth-refresh', { fresh: true, manual: false })
    expect(code).toBe(2)
    expect(err.join('\n')).toContain('settled-approve')
    expect(err.join('\n')).toContain('--revise')
    expect(runs(repo).length).toBe(1)                       // nothing appended
  })

  it('warns when a reviewer-setup change is about to drop a settled approve', async () => {
    const { repo, scenario, ctx } = await gateRepo()
    putVerdict(scenario, CLEAN('auth-refresh'))
    await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })

    // a re-pinned model moves the gate key without moving one byte of content
    repo.write('witness.config.yaml', 'schema: 1\ngates:\n  plan: { model: claude-sonnet-5 }\n')
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'repin plan model')

    const err: string[] = []
    await runGate(fakeCtx(repo.root, { env: gateEnv(scenario), err: (l) => err.push(l) }),
      'plan', 'auth-refresh', { fresh: false, manual: false })
    expect(err.join('\n')).toContain('discards the settled approve')
  })
})

// Rows 109/110. The round that SPENDS the budget renders like any other — the help line
// recited the off-bound triple, so the natural next act (fix the finding, re-gate) was
// advertised by the tool and then refused by it, twice: `changed-nothing` is not what
// happens, the gate simply never runs again and `--approve` is forfeit.
describe('the bound announces itself before it bites', () => {
  async function atBound() {
    const { repo, scenario, ctx } = await gateRepo()
    putVerdict(scenario, BLOCKING('auth-refresh'))
    await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })
    for (const round of [1, 2]) {
      journalDecision(repo, 'auth-refresh', { v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh', round, decision: 'revise' })
      await writeSpec(repo, 'auth-refresh', { ...SPEC_META, summary: `content ${round}` })
      if (round === 2) break
      await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })
    }
    const out: string[] = []
    const ctxOut = fakeCtx(repo.root, { env: gateEnv(scenario), out: (l: string) => out.push(l) })
    await runGate(ctxOut, 'plan', 'auth-refresh', { fresh: false, manual: false })   // round 3
    return { repo, scenario, ctx, out }
  }

  it('the budget-spending round warns that an edit now forfeits approve', async () => {
    const { repo, out } = await atBound()
    const text = out.join('\n')
    expect(runs(repo).length).toBe(3)
    expect(text).toContain('round: 3 of 3')
    expect(text).toContain('last-round')
    expect(text).toContain('--approve --override')
    expect(text).toContain('--revise --repair')
    expect(text).not.toContain('--revise --note')     // the off-bound exit is a lie here
  })

  it('a granted repair lets the gate run once more, and the budget line says 4', async () => {
    const { repo, scenario } = await atBound()
    journalDecision(repo, 'auth-refresh', { v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh', round: 3, decision: 'revise', repair: true })
    await writeSpec(repo, 'auth-refresh', { ...SPEC_META, summary: 'the fix the finding asked for' })
    const out: string[] = []
    const ctx2 = fakeCtx(repo.root, { env: gateEnv(scenario), out: (l: string) => out.push(l) })
    expect(await runGate(ctx2, 'plan', 'auth-refresh', { fresh: false, manual: false })).toBe(1)
    expect(runs(repo).length).toBe(4)
    expect(runs(repo)[3]!.round).toBe(4)
    const text = out.join('\n')
    expect(text).toContain('round: 4 of 4')
    expect(text).toContain('last-round')
    expect(text).not.toContain('--revise --repair')   // spent
  })
})
