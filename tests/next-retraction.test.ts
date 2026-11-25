import { describe, expect, it } from 'vitest'
import { designStamp } from '../src/design.js'
import { readStream } from '../src/journal.js'
import { findById, loadCanon } from '../src/scan.js'
import { gateParked, gateSettled } from '../src/verbs/next.js'
import {
  approve, fakeCtx, fakeScenario, gateEnv, PLAN_BLOCKING, plannedRepo, putVerdict, seededRepo, shippableRepo, stampLive, witnessDesign,
  writeDesign, writePlan, writeSpec, type CliResult, type TestRepo,
} from './helpers.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'

// Row 244 (design §4.2.3), review finding S2-B. A retraction (`decide --revise --note` after an approve
// or a pass) un-settles the gate, but approve and pass leave their canon stamps: a plan's `approved`, an
// effort's approved specs, a spec's `design:` meta. Canon is never rewritten, so `next`'s routers read
// the gate's journal beside the stamp: a retracted gate routes its lead (`gate --fresh`), and a park
// after the retraction routes nothing past it, so `next` and `status` agree.

const P = 'auth-refresh-plan-1'
const E = 'auth-hardening'
const S = 'auth-refresh'
const ANCHOR = `${S} > ## Behavior`
const DECOMPOSE_BLOCKING = { coverage: [{ anchor: ANCHOR, note: 'read' }], findings: [{ blocking: true, anchor: ANCHOR, claim: 'expiry unbounded' }] }
const DESIGN_CLEAN = { coverage: [{ anchor: 'design#save-bar', note: 'r' }, { anchor: ANCHOR, note: 'r' }], findings: [] }

const lineOf = (stdout: string): string => /^next: (.*)$/m.exec(stdout)?.[1] ?? ''
async function nextOf(repo: TestRepo, env: Record<string, string>): Promise<string> {
  const r = await repo.cli(['next'], { env })
  expect(r.code, r.stderr).toBe(0)
  return lineOf(r.stdout)
}
// `witness status` names the park, and its own `next:` line is the one `next` prints.
async function statusOf(repo: TestRepo, env: Record<string, string>): Promise<CliResult> {
  const r = await repo.cli(['status'], { env })
  expect(r.code, r.stderr).toBe(0)
  return r
}
async function ok(repo: TestRepo, args: string[], env: Record<string, string>, code = 0): Promise<void> {
  const r = await repo.cli(args, { env })
  expect(r.code, `${args.join(' ')}: ${r.stdout}\n${r.stderr}`).toBe(code)
}
async function agreeParked(repo: TestRepo, env: Record<string, string>, gate: string, target: string, onward: string[]): Promise<void> {
  const next = await nextOf(repo, env)
  for (const line of onward) expect(next).not.toContain(line)
  expect(next).not.toContain(`witness gate ${gate} `)
  expect(next).not.toContain(`witness decide ${gate} `)
  const status = await statusOf(repo, env)
  const parked = status.stdout.split('\n').filter((l) => l.includes(`${gate},${target},`))
  expect(parked.length, status.stdout).toBeGreaterThan(0)
  expect(lineOf(status.stdout)).toBe(next)
}

describe('a retracted plan approval (S2-B)', () => {
  async function approvedPlan(): Promise<{ repo: TestRepo; env: Record<string, string> }> {
    const repo = await plannedRepo({ autonomy: false })
    const scenario = fakeScenario()
    putVerdict(scenario, PLAN_BLOCKING)
    const env = gateEnv(scenario)
    await ok(repo, ['gate', 'plan', P], env, 1)
    await ok(repo, ['decide', 'plan', P, '--approve', '--override'], env)
    expect(await nextOf(repo, env)).toBe(`witness start ${P}`)
    return { repo, env }
  }

  it('next routes the retracted gate\'s lead, gate plan --fresh, never start; status agrees', async () => {
    const { repo, env } = await approvedPlan()
    await ok(repo, ['decide', 'plan', P, '--revise', '--note', 'the approval was wrong'], env)
    expect(findById(loadCanon(repo.root), P)!.meta.status).toBe('approved')
    expect(gateSettled(readStream(repo.root, P), 'plan')).toBe(false)
    const next = await nextOf(repo, env)
    expect(next).toBe(`witness gate plan ${P} --fresh`)
    expect(lineOf((await statusOf(repo, env)).stdout)).toBe(next)
    // the lead lands: the re-review spends a round, and its stop is the human's decision
    await ok(repo, ['gate', 'plan', P, '--fresh'], env, 1)
    expect(await nextOf(repo, env)).toBe(`witness decide plan ${P} --show`)
  }, 180_000)

  it('retract, then --stop: next and status agree — parked, no start', async () => {
    const { repo, env } = await approvedPlan()
    await ok(repo, ['decide', 'plan', P, '--revise', '--note', 'the approval was wrong'], env)
    await ok(repo, ['decide', 'plan', P, '--stop'], env)
    expect(gateParked(readStream(repo.root, P), 'plan')).toBe(true)
    await agreeParked(repo, env, 'plan', P, [`witness start ${P}`])
  }, 180_000)

  it('revised again after the retraction: next routes the plan\'s rewrite, never start', async () => {
    const { repo, env } = await approvedPlan()
    await ok(repo, ['decide', 'plan', P, '--revise', '--note', 'the approval was wrong'], env)
    await ok(repo, ['decide', 'plan', P, '--revise', '--note', 'split step s1'], env)
    const next = await nextOf(repo, env)
    expect(next).toContain(`witness write ${P} --effort ${E}`)
    expect(next).not.toContain('witness start')
  }, 180_000)

  // Row 95's site: a started plan's own plan gate un-settled routes before its implement work, as an
  // open reopen does.
  it('a started plan whose plan approval is retracted: next routes gate plan --fresh before any implement work', async () => {
    const { repo, env } = await approvedPlan()
    await ok(repo, ['start', P], env)
    expect(await nextOf(repo, env)).not.toContain('gate plan')
    await ok(repo, ['decide', 'plan', P, '--revise', '--note', 'the approval was wrong'], env)
    expect(await nextOf(repo, env)).toBe(`witness gate plan ${P} --fresh`)
    await ok(repo, ['decide', 'plan', P, '--stop'], env)
    await agreeParked(repo, env, 'plan', P, ['test-evidence', 'verify-red', 'step-close', `witness gate implement ${P}`])
  }, 180_000)
})

describe('a retracted decompose approval: the specs stay approved (S2-B)', () => {
  async function approvedEffort(withPlan: boolean): Promise<{ repo: TestRepo; env: Record<string, string> }> {
    const repo = await seededRepo()
    await writeSpec(repo, S)
    const scenario = fakeScenario()
    putVerdict(scenario, DECOMPOSE_BLOCKING)
    const env = gateEnv(scenario)
    await ok(repo, ['gate', 'decompose', E], env, 1)
    await ok(repo, ['decide', 'decompose', E, '--approve', '--override'], env)
    expect(findById(loadCanon(repo.root), S)!.meta.status).toBe('approved')
    if (withPlan) {
      expect((await writePlan(repo, P)).code).toBe(0)
      approve(repo, P)
      expect(await nextOf(repo, env)).toBe(`witness start ${P}`)
    } else {
      expect(await nextOf(repo, env)).toContain(`witness write ${P} --effort ${E}`)
    }
    return { repo, env }
  }

  it('next routes gate decompose --fresh, never the plan write the approved spec would get; status agrees', async () => {
    const { repo, env } = await approvedEffort(false)
    await ok(repo, ['decide', 'decompose', E, '--revise', '--note', 'the slicing was wrong'], env)
    expect(findById(loadCanon(repo.root), S)!.meta.status).toBe('approved')
    const next = await nextOf(repo, env)
    expect(next).toBe(`witness gate decompose ${E} --fresh`)
    expect(lineOf((await statusOf(repo, env)).stdout)).toBe(next)
  }, 180_000)

  it('retract, then --stop: next and status agree — parked, no plan write and no start under its specs', async () => {
    for (const withPlan of [false, true]) {
      const { repo, env } = await approvedEffort(withPlan)
      await ok(repo, ['decide', 'decompose', E, '--revise', '--note', 'the slicing was wrong'], env)
      await ok(repo, ['decide', 'decompose', E, '--stop'], env)
      expect(gateParked(readStream(repo.root, E), 'decompose')).toBe(true)
      await agreeParked(repo, env, 'decompose', E, [`witness write ${P}`, `witness start ${P}`, `witness gate plan ${P}`])
    }
  }, 300_000)
})

describe('a retracted design approval: the design stamp stays (S2-B)', () => {
  async function approvedLook(): Promise<{ repo: TestRepo; env: Record<string, string> }> {
    const repo = await seededRepo()
    await writeSpec(repo, S, { ui: true })
    approve(repo, S)
    expect((await writeDesign(repo, S)).code).toBe(0)
    expect((await witnessDesign(repo, S)).code).toBe(0)
    const scenario = fakeScenario()
    putVerdict(scenario, DESIGN_CLEAN)
    const env = gateEnv(scenario)
    await ok(repo, ['gate', 'design', S], env, 1)   // the look is the human's
    await ok(repo, ['decide', 'design', S, '--approve'], env)
    expect(await nextOf(repo, env)).toContain(`witness write ${P} --effort ${E}`)
    return { repo, env }
  }

  it('next routes gate design --fresh, never the plan write the stamped look would get; status agrees', async () => {
    const { repo, env } = await approvedLook()
    await ok(repo, ['decide', 'design', S, '--revise', '--note', 'the look was wrong'], env)
    expect(designStamp(findById(loadCanon(repo.root), S)!)).toBeDefined()
    const next = await nextOf(repo, env)
    expect(next).toBe(`witness gate design ${S} --fresh`)
    expect(lineOf((await statusOf(repo, env)).stdout)).toBe(next)
  }, 180_000)

  it('retract, then --stop: next and status agree — parked, no plan write under the spec', async () => {
    const { repo, env } = await approvedLook()
    await ok(repo, ['decide', 'design', S, '--revise', '--note', 'the look was wrong'], env)
    await ok(repo, ['decide', 'design', S, '--stop'], env)
    expect(gateParked(readStream(repo.root, S), 'design')).toBe(true)
    await agreeParked(repo, env, 'design', S, [`witness write ${P}`, `witness design ${S}`])
  }, 180_000)
})

// Fix round 2 (row 52). A finished effort keeps its stamp shortcut: an amendment's re-gate that stopped
// and was revised is no re-slice of shipped work, so `next` stays where it was — a critic round on
// shipped work, and under autonomy a headless decompose session rewriting live specs, are what the
// escape exists to prevent. A human's own retraction of its decompose still re-arms it (S2-B).
describe('a finished effort stays finished unless a human retracts it (row 52)', () => {
  const D = [{ id: 'd1', text: 'Rotation is server-side' }, { id: 'd2', text: 'Rotate at 80% of the TTL' }]
  async function finishedEffort(): Promise<{ repo: TestRepo; env: Record<string, string> }> {
    const repo = await seededRepo()
    await writeSpec(repo, S)
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [{ anchor: ANCHOR, note: 'read' }], findings: [] })
    const env = gateEnv(scenario)
    await ok(repo, ['gate', 'decompose', '--effort', E], env, 1)   // a feature's scope stop
    await ok(repo, ['decide', 'decompose', E, '--approve'], env)
    expect((await writePlan(repo, P)).code).toBe(0)
    repo.flipStatus(P, 'done')
    stampLive(repo, S)
    expect(await nextOf(repo, env)).toBe('witness check')
    return { repo, env }
  }

  it('an amendment re-gated and revised on a finished effort: next stays at witness check', async () => {
    const { repo, env } = await finishedEffort()
    await ok(repo, ['recap', '--amend', '--file', repo.writeRecap({ decisions: D })], env)
    expect(await nextOf(repo, env)).toBe('witness check')
    await ok(repo, ['gate', 'decompose', '--effort', E], env, 1)
    await ok(repo, ['decide', 'decompose', E, '--revise', '--note', 'carry the decisions'], env)
    const next = await nextOf(repo, env)
    expect(next).toBe('witness check')
    expect(next).not.toContain('witness write')
    expect(lineOf((await statusOf(repo, env)).stdout)).toBe(next)
  }, 180_000)

  it('a human\'s retraction of a finished effort\'s decompose re-arms it: next routes the retracted lead', async () => {
    const { repo, env } = await finishedEffort()
    await ok(repo, ['decide', 'decompose', E, '--revise', '--note', 'the slicing was wrong'], env)
    const next = await nextOf(repo, env)
    expect(next).toBe(`witness gate decompose ${E} --fresh`)
    expect(lineOf((await statusOf(repo, env)).stdout)).toBe(next)
  }, 180_000)
})

// Fix round 2 (design §4.2.2, §4.2.4: a retraction asks for a re-review, not an edit). A retracted
// implement approval routes its lead, `gate implement --fresh`, ahead of the edit a plain revise owes,
// so `next`, `status` and `decide --show` name one act.
describe('a retracted implement approval routes gate implement --fresh (row 244)', () => {
  it('next and status route gate implement --fresh, never the edit a plain revise owes', async () => {
    const seed = await shippableRepo()
    const scenario = fakeScenario()
    const coverage = ['package.json', 'src/token.ts', 'tests/token.test.ts'].map((anchor) => ({ anchor, note: 'read' }))
    putVerdict(scenario, { coverage, findings: [] })
    const env = gateEnv(scenario)
    expect(await runGate(fakeCtx(seed.repo.root, { env }), 'implement', seed.planId, { fresh: false, manual: false })).toBe(0)
    expect(await nextOf(seed.repo, env)).toBe(`witness ship ${seed.planId}`)
    await ok(seed.repo, ['decide', 'implement', seed.planId, '--revise', '--note', 'the pass missed the expiry'], env)
    const next = await nextOf(seed.repo, env)
    expect(next).toBe(`witness gate implement ${seed.planId} --fresh`)
    expect(lineOf((await statusOf(seed.repo, env)).stdout)).toBe(next)
    const show = await seed.repo.cli(['decide', 'implement', seed.planId, '--show'], { env })
    expect(show.stdout).toContain(`run: ${next}`)
  }, 240_000)
})
