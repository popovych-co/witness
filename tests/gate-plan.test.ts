import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import type { GateRunEntry } from '../src/rounds.js'
import { findById, loadCanon } from '../src/scan.js'
import { TIDY, callFor, choreOnSpec, decidedRepo, fakeCtx, stampLive, fakeScenario, gateEnv, putVerdict, seededRepo, turnDecision, writeSpec, writePlan, approve } from './helpers.js'

const PAIR_CLEAN = {
  coverage: [
    { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
    { anchor: 'auth-refresh > ## Behavior', note: 'read' },
  ],
  findings: [],
}
const runs = (repo: { root: string }) =>
  readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]

async function planRepo() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  const scenario = fakeScenario()
  putVerdict(scenario, PAIR_CLEAN)
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
  return { repo, scenario, ctx }
}

describe('plan gate', () => {
  // D167. One derivation with `decide`: row 95 keeps an in-flight status through a re-author,
  // and a passing re-gate must not take it back — nor bring a finished plan back to approved.
  it('a passing plan gate approves a draft and nothing else', async () => {
    for (const status of ['in-progress', 'done', 'abandoned']) {
      const { repo, ctx } = await planRepo()
      repo.flipStatus('auth-refresh-plan-1', status)
      expect(await runGate(ctx, 'plan', 'auth-refresh-plan-1', { fresh: false, manual: false })).toBe(0)
      expect(String(findById(loadCanon(repo.root), 'auth-refresh-plan-1')!.meta.status)).toBe(status)
    }
  })

  it('green path: pair-covering clean verdict auto-passes and stamps approved', async () => {
    const { repo, ctx } = await planRepo()
    expect(await runGate(ctx, 'plan', 'auth-refresh-plan-1', { fresh: false, manual: false })).toBe(0)
    expect(runs(repo)[0]!.outcome).toBe('passed')
    expect(runs(repo)[0]!.artifact_sha).toMatch(/^[0-9a-f]{64}$/)
    expect(findById(loadCanon(repo.root), 'auth-refresh-plan-1')!.meta.status).toBe('approved')
  })

  it('a parent amendment fails pin-fresh AND re-keys the verdict cache', async () => {
    const { repo, ctx } = await planRepo()
    await runGate(ctx, 'plan', 'auth-refresh-plan-1', { fresh: false, manual: false })   // passed
    await writeSpec(repo, 'auth-refresh', { summary: 'amended after the plan was written' })
    expect(await runGate(ctx, 'plan', 'auth-refresh-plan-1', { fresh: false, manual: false })).toBe(1)
    const all = runs(repo)
    expect(all.length).toBe(2)                                     // no stale resume — pair sha moved
    expect(all[1]!.reviewed_sha).not.toBe(all[0]!.reviewed_sha)
    const pin = all[1]!.checks.find((c) => c.name === 'pin-fresh')!
    expect(pin.ok).toBe(false)
    const parentCheck = all[1]!.checks.find((c) => c.name === 'parent-approved')!
    expect(parentCheck.ok).toBe(false)                             // amendment reset parent to draft
  })

  it('coverage must span both docs of the pair — plan-only coverage is malformed', async () => {
    const { repo, scenario, ctx } = await planRepo()
    putVerdict(scenario, {
      coverage: [{ anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' }],
      findings: [],
    })
    expect(await runGate(ctx, 'plan', 'auth-refresh-plan-1', { fresh: true, manual: false })).toBe(1)
    expect(runs(repo).at(-1)!.outcome).toBe('malformed')
  })

  it('refuses a plan no effort ever wrote', async () => {
    const { repo } = await planRepo()
    repo.write('plans/orphan-plan.md', '---\nid: orphan-plan\ntype: plan\nstatus: draft\nparent: auth-refresh\nderives-from: deadbeef\n---\n## Step: s1\nx\n')
    repo.git('add', '-A'); repo.git('commit', '-m', 'orphan')
    const r = await repo.cli(['gate', 'plan', 'orphan-plan'])
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('no-effort')
  })
})

describe('plan gate — carried decisions (row 198)', () => {
  it('a changed carried decision fails pin-fresh and re-keys the verdict', async () => {
    const repo = await decidedRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, PAIR_CLEAN)
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    expect(await runGate(ctx, 'plan', 'auth-refresh-plan-1', { fresh: false, manual: false })).toBe(0)
    await turnDecision(repo, 'Rotation is client-side')
    expect(await runGate(ctx, 'plan', 'auth-refresh-plan-1', { fresh: false, manual: false })).toBe(1)
    const [first, second] = runs(repo)
    expect(second!.reviewed_sha).not.toBe(first!.reviewed_sha)
    const pin = second!.checks.find((c) => c.name === 'pin-fresh')!
    expect(pin.ok).toBe(false)
    expect(pin.detail).toContain('decisions-from')
    expect(pin.detail).toContain('but auth-refresh carries decisions at')
  })

  it("a changed chore decision re-keys its chore plan's gate", async () => {
    const repo = await choreOnSpec()
    const before = repo.read('plans/auth-refresh-plan-1.md')
    const scenario = fakeScenario()
    putVerdict(scenario, PAIR_CLEAN)
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    await runGate(ctx, 'plan', 'auth-refresh-plan-1', { fresh: false, manual: false })
    repo.write('tidy.json', JSON.stringify({ ...TIDY, decisions: [{ id: 'd1', text: 'Break the public API' }] }))
    expect((await repo.cli(['recap', '--amend', '--file', 'tidy.json'])).code).toBe(0)
    await runGate(ctx, 'plan', 'auth-refresh-plan-1', { fresh: false, manual: false })
    const all = runs(repo)
    expect(all).toHaveLength(2)
    expect(all[1]!.reviewed_sha).not.toBe(all[0]!.reviewed_sha)
    expect(repo.read('plans/auth-refresh-plan-1.md')).not.toContain('decisions-from')
    expect(repo.read('plans/auth-refresh-plan-1.md').replace(/status: \S+/, '')).toBe(before.replace(/status: \S+/, ''))
  })

  it("the plan critic reads the parent's decisions, and a chore plan also reads its recap", async () => {
    const stdinOf = (scenario: string) => readFileSync(join(callFor(scenario, 'plan-critic')!, 'stdin'), 'utf8')
    const feature = await decidedRepo()
    const s1 = fakeScenario()
    putVerdict(s1, PAIR_CLEAN)
    await runGate(fakeCtx(feature.root, { env: gateEnv(s1) }), 'plan', 'auth-refresh-plan-1', { fresh: false, manual: false })
    expect(stdinOf(s1)).toContain('### Decisions auth-refresh carries — witness read auth-refresh --decisions')
    expect(stdinOf(s1)).toContain('  d1,Rotation is server-side')

    const chore = await choreOnSpec()
    const s2 = fakeScenario()
    putVerdict(s2, PAIR_CLEAN)
    await runGate(fakeCtx(chore.root, { env: gateEnv(s2) }), 'plan', 'auth-refresh-plan-1', { fresh: false, manual: false })
    expect(stdinOf(s2)).toContain("### The chore's recap — witness read tidy --decisions")
    expect(stdinOf(s2)).toContain('effort: tidy · chore')
  })

  it('a plan re-queued for decisions alone reads the decision delta', async () => {
    const repo = await decidedRepo()
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')
    await turnDecision(repo, 'Rotation is client-side')
    expect((await writePlan(repo, 'auth-refresh-plan-2')).code).toBe(0)
    const scenario = fakeScenario()
    putVerdict(scenario, { ...PAIR_CLEAN, coverage: [
      { anchor: 'auth-refresh-plan-2 > ## Step: s1', note: 'read' }, { anchor: 'auth-refresh > ## Behavior', note: 'read' },
    ] })
    await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'plan', 'auth-refresh-plan-2', { fresh: false, manual: false })
    const stdin = readFileSync(join(callFor(scenario, 'plan-critic')!, 'stdin'), 'utf8')
    expect(stdin).toContain('decisions moved since auth-refresh-plan-1:')
    expect(stdin).toContain('  d1,changed,Rotation is client-side')
  })
})

