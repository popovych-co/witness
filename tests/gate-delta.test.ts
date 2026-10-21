import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import type { GateRunEntry } from '../src/rounds.js'
import { findById, loadCanon } from '../src/scan.js'
import { approve, fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, writePlan, writeSpec } from './helpers.js'

const PLAN = 'auth-refresh-plan-1'
const S1 = `${PLAN} > ## Step: s1`
const S2 = `${PLAN} > ## Step: s2`
const PARENT = 'auth-refresh > ## Behavior'
const STEPS2 = { steps: [{ id: 's1', title: 'rotate', criteria: ['ac-rotate'] }, { id: 's2', title: 'wire', scaffolding: true }] }
const body = (s1: string, s2 = 'Stable wiring.') => `## Step: s1\n${s1}\n\n## Step: s2\n${s2}\n`
const COVER = [{ anchor: S1, note: 'read' }, { anchor: PARENT, note: 'read' }]
type F = { anchor: unknown; blocking?: boolean; contradicts_pin?: number }
const verdict = (...fs: F[]) => ({ coverage: COVER, findings: fs.map((f) => ({ blocking: true, claim: 'x', ...f })) })
const MALFORMED = { coverage: COVER, findings: [{ blocking: true, anchor: `${PLAN} > ## Nowhere`, claim: 'ghost' }] }
const runs = (root: string) => readStream(root, PLAN).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]
const stdin = (scenario: string, n: number) => readFileSync(join(scenario, `claude-calls/call-${n}/stdin`), 'utf8')

async function planRounds() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh'); approve(repo, 'auth-refresh')
  await writePlan(repo, PLAN, STEPS2, body('Attempt 1.'))
  const scenario = fakeScenario()
  const out: string[] = []
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario), out: (l) => out.push(l) })
  const gate = () => runGate(ctx, 'plan', PLAN, { fresh: false, manual: false })
  const edit = (s1: string, s2?: string) => writePlan(repo, PLAN, STEPS2, body(s1, s2))
  return { repo, scenario, out, gate, edit }
}
// round 1 blocks at s1; s1 is edited; round 2 answers `second`
async function twoRounds(second: unknown, first: unknown = verdict({ anchor: S1 })) {
  const t = await planRounds()
  putVerdict(t.scenario, first, 1); await t.gate()
  await t.edit('Attempt 2.')
  putVerdict(t.scenario, second, 2)
  const code = await t.gate()
  return { ...t, code }
}

describe('round 2 reviews the change (C3)', () => {
  it('round 1 is a full review; round 2 carries round 1 blocking findings and the plan diff', async () => {
    const { repo, scenario, out } = await twoRounds(verdict({ anchor: S1 }))
    const [r1, r2] = runs(repo.root)
    expect(stdin(scenario, 1)).not.toContain('## Delta review')
    const p = stdin(scenario, 2)
    expect(p).toContain('## Delta review — round 1 to now')
    expect(p).toContain(`1. ${S1} — x (plan-critic)`)
    expect(p).toContain('-Attempt 1.')
    expect(p).toContain('+Attempt 2.')
    // the menu heading line — the plan-critic prompt itself mentions `## Valid anchors` in prose
    expect(p.indexOf('## Delta review')).toBeLessThan(p.indexOf('\n## Valid anchors\n'))
    expect(r1!.delta).toBeUndefined()
    expect(r2!.delta).toEqual({ round: 1, run: r1!.run_id })
    expect(out.join('\n')).toContain('review: delta since round 1')
  })

  it('the block joins prompts_sha while setup_sha keeps the full-review sha', async () => {
    const { repo } = await twoRounds(verdict({ anchor: S1 }))
    const [r1, r2] = runs(repo.root)
    expect(r1!.setup_sha).toBeUndefined()
    expect(r2!.setup_sha).toBe(r1!.prompts_sha)
    expect(r2!.prompts_sha).not.toBe(r2!.setup_sha)
  })

  // Review Focus 1
  it('re-gating unchanged content after a delta round resumes — no battery and no entry', async () => {
    const { repo, scenario, gate } = await twoRounds(verdict({ anchor: S1 }))
    expect(await gate()).toBe(1)
    expect(runs(repo.root)).toHaveLength(2)
    expect(existsSync(join(scenario, 'claude-calls/call-3'))).toBe(false)
  })

  it('a revise that changes nothing after a delta round is still changed-nothing', async () => {
    const { repo, out, gate } = await twoRounds(verdict({ anchor: S1 }))
    await repo.cli(['decide', 'plan', PLAN, '--revise', '--note', 'again'])
    expect(await gate()).toBe(1)
    expect(runs(repo.root)).toHaveLength(2)
    expect(out.join('\n')).toContain('changed nothing')
  })

  it('guard: edit-then-revert replays the full round-1 verdict', async () => {
    const { repo, scenario, gate, edit } = await twoRounds(verdict({ anchor: S1 }))
    await edit('Attempt 1.')
    expect(await gate()).toBe(1)
    const r3 = runs(repo.root)[2]!
    expect(r3.cached).toBe(true)
    expect(r3.delta).toBeUndefined()
    expect(existsSync(join(scenario, 'claude-calls/call-3'))).toBe(false)
  })

  // Review Focus 4
  it('two malformed delta rounds on changing content still trip malformed-streak', async () => {
    const t = await planRounds()
    putVerdict(t.scenario, verdict({ anchor: S1 }), 1); await t.gate()
    putVerdict(t.scenario, MALFORMED)                         // every later call, both attempts of each round
    await t.edit('B.'); expect(await t.gate()).toBe(1)
    await t.edit('C.'); expect(await t.gate()).toBe(1)
    const [, r2, r3] = runs(t.repo.root)
    expect(r2!.prompts_sha).not.toBe(r3!.prompts_sha)        // different deltas…
    expect(r2!.setup_sha).toBe(r3!.setup_sha)                 // …one setup
    await t.edit('D.')
    const errs: string[] = []
    const code = await runGate(fakeCtx(t.repo.root, { env: gateEnv(t.scenario), err: (l) => errs.push(l) }), 'plan', PLAN, { fresh: false, manual: false })
    expect(code).toBe(2)
    expect(errs.join('\n')).toContain('malformed-streak')
  })

  // Review Focus 5
  it('a base tree pruned by gc makes round 2 a full review', async () => {
    const t = await planRounds()
    putVerdict(t.scenario, verdict({ anchor: S1 }), 1); await t.gate()
    t.repo.git('gc', '-q', '--prune=now')
    await t.edit('Attempt 2.')
    putVerdict(t.scenario, verdict({ anchor: S1 }), 2)
    expect(await t.gate()).toBe(1)
    expect(stdin(t.scenario, 2)).not.toContain('## Delta review')
    expect(runs(t.repo.root)[1]!.delta).toBeUndefined()
  })

  it('a re-pinned model is a new reviewer — round 2 is a full review', async () => {
    const t = await planRounds()
    putVerdict(t.scenario, verdict({ anchor: S1 }), 1); await t.gate()
    const cfg = join(t.repo.root, 'witness.config.yaml')
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('plan: { reviewers: [plan-critic] }', 'plan: { reviewers: [plan-critic], model: test-plan-model }'))
    t.repo.git('add', 'witness.config.yaml'); t.repo.git('commit', '-m', 'pin plan model')
    await t.edit('Attempt 2.')
    putVerdict(t.scenario, verdict({ anchor: S1 }), 2)
    await t.gate()
    expect(runs(t.repo.root)[1]!.delta).toBeUndefined()
  })
})

// Review Focus 5. Plan decision 15: only the code gates demote. The doc gates get the delta
// block — the machinery is shared — but no later full review re-reads their artifact.
describe('the doc gates never demote (C3)', () => {
  it('guard: a new blocking finding in an unchanged plan section still blocks though the round reviewed the change', async () => {
    const { repo, out, code } = await twoRounds(verdict({ anchor: S2 }))
    expect(code).toBe(1)
    const [r1, r2] = runs(repo.root)
    expect(r2!.delta).toEqual({ round: 1, run: r1!.run_id })
    expect(r2!.verdicts![0]!.findings).toEqual([{ blocking: true, anchor: S2, claim: 'x' }])
    expect(out.join('\n')).not.toContain('demoted:')
    expect(findById(loadCanon(repo.root), PLAN)!.meta.status).not.toBe('approved')
  })
})
