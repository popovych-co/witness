import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cliAct } from '../src/act.js'
import { loadConfig, type Config } from '../src/config.js'
import { contentSha } from '../src/content-sha.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream, type Entry } from '../src/journal.js'
import { needsYou } from '../src/needs-you.js'
import { recommend } from '../src/recommend.js'
import { decisionOwed, gateRuns, lastGateRun, liveActs, standingHandBack, type GateRunEntry } from '../src/rounds.js'
import { findById, loadCanon, type CanonDoc } from '../src/scan.js'
import { settleOwed } from '../src/settle.js'
import { runShip, shipPhase } from '../src/ship.js'
import { authoringOwed, owedDecisions, owedRun } from '../src/verbs/next.js'
import {
  PLAN_BLOCKING, TOKEN_FIXED, addOrigin, fakeCtx, fakeScenario, gateEnv, plannedRepo, putVerdict, seededRepo, shippableRepo,
  writePlan, writeSpec, type CliResult, type TestRepo,
} from './helpers.js'

// Row 244 (#87, design §4.2.5, rows 94 and 173). A standing hand-back is the third kind of owed
// decision: the gate's latest disposition is a revise, the author handed it back for the run it
// disposed of, and nothing judged since. One predicate, `decisionOwed` — the pending run, else the run
// a standing hand-back names — replaces `pendingDecision` in every reader, so `next`, settle, needs-you,
// check, status and ship all owe it, and none of them routes the edit the author declined. Staleness
// is judged where the decision is made (P34): the predicate needs no current sha.

// The arbiter stand-in for the settle pass: it parks, an act every handed-back block offers.
const arbiter = vi.hoisted(() => ({ calls: 0, rules: [] as string[] }))
vi.mock('../src/arbiter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/arbiter.js')>()
  return {
    ...real,
    arbitrate: async (_ctx: unknown, _root: string, _cfg: unknown, req: { menu: ReadonlyArray<{ act?: { argv: readonly string[] } }> }) => {
      arbiter.calls++
      const i = req.menu.findIndex((o) => o.act?.argv.includes('--stop') === true)
      return { ok: true, value: { choice: i + 1, reason: 'stand-in: neither the author nor a reviewer found a fix', model: 'm', prompts_sha: 'p' } }
    },
  }
})

const P = 'auth-refresh-plan-1'
const S = 'auth-refresh'
const E = 'auth-hardening'

const cfgOf = (repo: TestRepo): Config => {
  const r = loadConfig(repo.root)
  if (!r.ok) throw new Error(`config refused: ${JSON.stringify(r.violations)}`)
  return r.value
}

async function ok(repo: TestRepo, args: string[], env: Record<string, string>, code = 0): Promise<CliResult> {
  const r = await repo.cli(args, { env })
  expect(r.code, `${args.join(' ')}: ${r.stdout}\n${r.stderr}`).toBe(code)
  return r
}

const show = (gate: string, target: string) => cliAct('decide', gate, target, '--show').line
const linesWith = (out: string, ...parts: string[]) => out.split('\n').filter((l) => parts.every((p) => l.includes(p)))

// A plan gate stopped on a blocking finding in the plan and revised by a human, with autonomy off;
// `handBack` is its author's `--unchanged`.
async function revisedPlan(): Promise<{ repo: TestRepo; env: Record<string, string>; run: GateRunEntry; handBack: () => Promise<CliResult> }> {
  const repo = await plannedRepo({ autonomy: false })
  const scenario = fakeScenario()
  putVerdict(scenario, PLAN_BLOCKING)
  const env = gateEnv(scenario)
  await ok(repo, ['gate', 'plan', P], env, 1)
  const run = lastGateRun(readStream(repo.root, P), 'plan')!
  await ok(repo, ['decide', 'plan', P, '--revise', '--note', 'make step s1 testable'], env)
  return { repo, env, run, handBack: () => ok(repo, ['gate', 'plan', P, '--unchanged'], env, 1) }
}

const planSha = (repo: TestRepo): string | undefined => contentSha(repo.root, loadCanon(repo.root), cfgOf(repo), 'plan', P)

describe('a standing hand-back is owed to every reader (row 244, design §4.2.5)', () => {
  it('a standing hand-back is owed to owedRun, owedDecisions, settleOwed, needsYou, next tier 2, flowBlocked, check and status (P10)', async () => {
    const f = await revisedPlan()
    await f.handBack()
    const root = f.repo.root
    const entries = readStream(root, P)
    // P10: on the code before this task `owedDecisions` was empty here.
    expect(owedDecisions(root, loadCanon(root))).toEqual([{ gate: 'plan', target: P, bound: false }])
    expect(owedRun(entries, 'plan')).toEqual(f.run)
    expect(standingHandBack(entries, 'plan')).toMatchObject({ run_id: f.run.run_id, sha: f.run.reviewed_sha })
    expect(decisionOwed(entries, 'plan')).toEqual(f.run)

    // needsYou's decision row names the screen the decision is made on.
    expect(needsYou(root, { env: f.env }, cfgOf(f.repo), loadCanon(root), [])).toContainEqual(
      expect.objectContaining({ kind: 'decision', target: P, gate: 'plan', show: cliAct('decide', 'plan', P, '--show') }))

    // next's tier 2: the decision, never the rewrite the revise asked for.
    const next = await ok(f.repo, ['next'], f.env)
    expect(next.stdout).toContain(`next: ${show('plan', P)}`)
    expect(next.stdout).not.toContain('revise owed')

    // check's gate-awaiting-decision names the same screen.
    const check = await f.repo.cli(['check'], { env: f.env })
    expect(linesWith(check.stdout, 'gate-awaiting-decision', P, show('plan', P))).toHaveLength(1)

    // status: the gates table reads it, as `handed back`, and its `next:` agrees with next's.
    const status = await ok(f.repo, [], f.env)
    expect(status.stdout).toContain('gates[1]{gate,target,round,outcome}:')
    expect(status.stdout).toContain(`  plan,${P},${f.run.round},handed back`)
    expect(status.stdout).toContain(`next: ${show('plan', P)}`)

    // flowBlocked: the plan started with its plan gate still handed back is no tier-1 motion — the flow
    // waits on the decision, and tier 2 routes it.
    f.repo.flipStatus(P, 'approved')
    await ok(f.repo, ['start', P], f.env)
    const started = await ok(f.repo, ['next'], f.env)
    expect(started.stdout).toContain(`next: ${show('plan', P)}`)
    expect(started.stdout).not.toContain('test-evidence')

    // settleOwed reads the same predicate: under autonomy the settle pass judges the hand-back (the
    // stand-in parks it), and then nothing is owed.
    arbiter.calls = 0
    const reports = await settleOwed(fakeCtx(root, { env: f.env }), root, cfgOf(f.repo))
    expect(reports).toEqual([{ gate: 'plan', target: P, settled: { kind: 'decided', by: 'arbiter', rule: 'revise-returned', decision: 'stop' } }])
    expect(arbiter.calls).toBe(1)
    expect(standingHandBack(readStream(root, P), 'plan')).toBeUndefined()
    expect(owedDecisions(root, loadCanon(root))).toEqual([])
  }, 180_000)

  it('authoringOwed is false while it stands; next stops routing the edit', async () => {
    const f = await revisedPlan()
    const edit = 'revise owed — rewrite the plan, then re-gate'
    // Before the hand-back the revise owes the author an edit.
    expect(authoringOwed(readStream(f.repo.root, P), 'plan', planSha(f.repo))).toBe(true)
    expect((await ok(f.repo, ['next'], f.env)).stdout).toContain(edit)

    await f.handBack()
    expect(authoringOwed(readStream(f.repo.root, P), 'plan', planSha(f.repo))).toBe(false)
    const after = await ok(f.repo, ['next'], f.env)
    expect(after.stdout).toContain(`next: ${show('plan', P)}`)
    expect(after.stdout).not.toContain(edit)
    expect(after.stdout).not.toContain('next: witness write')

    // A human's revise again with a note ends the hand-back (§4.2.7): the edit is owed again.
    await ok(f.repo, ['decide', 'plan', P, '--revise', '--note', 'split s1 into two steps'], f.env)
    expect(standingHandBack(readStream(f.repo.root, P), 'plan')).toBeUndefined()
    expect(authoringOwed(readStream(f.repo.root, P), 'plan', planSha(f.repo))).toBe(true)
    expect((await ok(f.repo, ['next'], f.env)).stdout).toContain(edit)
  }, 180_000)

  // The decompose gate reads the same predicate on the effort's stream: next stops routing the
  // re-authoring, and status names the hand-back on its own gates row (the first build's S3-7).
  it('a handed-back decompose: next routes its decision, not the re-authoring, and status reads handed back', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, S)
    const scenario = fakeScenario()
    putVerdict(scenario, {
      coverage: [{ anchor: `${S} > ## Behavior`, note: 'read' }],
      findings: [{ blocking: true, anchor: `${S} > ## Behavior`, claim: 'the rotation window is unstated' }],
    })
    const env = gateEnv(scenario)
    await ok(repo, ['gate', 'decompose', E], env, 1)
    const run = lastGateRun(readStream(repo.root, E), 'decompose')!
    await ok(repo, ['decide', 'decompose', E, '--revise', '--note', 'state the rotation window'], env)
    expect((await ok(repo, ['next'], env)).stdout).toContain('revise owed — re-author')

    await ok(repo, ['gate', 'decompose', E, '--unchanged'], env, 1)
    const next = await ok(repo, ['next'], env)
    expect(next.stdout).toContain(`next: ${show('decompose', E)}`)
    expect(next.stdout).not.toContain('revise owed')
    const status = await ok(repo, [], env)
    expect(status.stdout).toContain(`  decompose,${E},${run.round},handed back`)
    const check = await repo.cli(['check'], { env })
    expect(linesWith(check.stdout, 'gate-awaiting-decision', E, show('decompose', E))).toHaveLength(1)
    expect(decisionOwed(readStream(repo.root, E), 'decompose')).toEqual(run)
  }, 180_000)

  it('content moved since the hand-back: recommend offers the moved row with the re-gate first (P34)', async () => {
    const f = await revisedPlan()
    await f.handBack()
    const root = f.repo.root
    // The author's edit lands after the hand-back.
    expect((await writePlan(f.repo, P, {}, '## Step: s1\nImplement rotation with TDD, due at 80% of the TTL.\n')).code).toBe(0)
    const entries = readStream(root, P)
    expect(planSha(f.repo)).not.toBe(f.run.reviewed_sha)
    // The entry records what was handed back; the predicate needs no current sha.
    expect(standingHandBack(entries, 'plan')?.sha).toBe(f.run.reviewed_sha)
    expect(owedDecisions(root, loadCanon(root))).toEqual([{ gate: 'plan', target: P, bound: false }])
    expect(decisionOwed(entries, 'plan')).toEqual(f.run)
    expect(liveActs('plan', P, entries, { upstream: S, stale: true, holdLifted: false, owed: false, upstreamOwed: false }).state)
      .toBe('handed-back-moved')

    // P34: stale, the guard admits the hand-back and offers the moved row — the re-gate first, no approve.
    const moved = recommend({ gate: 'plan', target: P, entries, upstream: S, stale: true })
    expect(moved?.rule).toBe('stale-below-bound')
    expect(moved?.options[0]?.act).toEqual(cliAct('gate', 'plan', P))
    expect(moved?.options.some((o) => o.act?.argv.includes('--approve'))).toBe(false)
    expect(moved?.options.map((o) => o.act?.argv.slice(3).join(' '))).toEqual(['', '--stop', `--revise --upstream ${S}`, '--revise --note <why>'])
    // Unmoved, the same journal is the hand-back's own rule.
    expect(recommend({ gate: 'plan', target: P, entries, upstream: S, stale: false })?.rule).toBe('revise-returned')

    // next routes the decision; the screen it names reads the staleness itself.
    expect((await ok(f.repo, ['next'], f.env)).stdout).toContain(`next: ${show('plan', P)}`)
    const screen = await ok(f.repo, ['decide', 'plan', P, '--show'], f.env)
    expect(screen.stdout).toContain(`run: ${cliAct('gate', 'plan', P).line}`)
    expect(screen.stdout).not.toContain('--approve')
    // The re-gate judges what moved: a round, never changed-nothing, and the hand-back ends (P33).
    const regate = await f.repo.cli(['gate', 'plan', P], { env: f.env })
    expect(regate.stdout).not.toContain('revise changed nothing')
    expect(gateRuns(readStream(root, P), 'plan')).toHaveLength(2)
    expect(standingHandBack(readStream(root, P), 'plan')).toBeUndefined()
  }, 180_000)

  // Carried from the Slice 2 close review: planReworkOwed and planGateStep read a handed-back plan
  // gate as neither rework nor a decision. `decisionOwed` reaches tier 2 (an approved plan) and
  // flowBlocked (a started one) ahead of both.
  it('a handed-back plan gate on an approved, then a started plan: next routes the decision, never gate plan or implement work', async () => {
    const repo = await plannedRepo({ autonomy: false })
    const scenario = fakeScenario()
    putVerdict(scenario, PLAN_BLOCKING)
    const env = gateEnv(scenario)
    await ok(repo, ['gate', 'plan', P], env, 1)
    await ok(repo, ['decide', 'plan', P, '--approve', '--override'], env)
    expect(String(findById(loadCanon(repo.root), P)!.meta.status)).toBe('approved')
    // A human retracts the approval, the re-review stops, a human revises, the author hands it back.
    await ok(repo, ['decide', 'plan', P, '--revise', '--note', 'the approval missed step s1'], env)
    await ok(repo, ['gate', 'plan', P, '--fresh'], env, 1)
    await ok(repo, ['decide', 'plan', P, '--revise', '--note', 'make step s1 testable'], env)
    await ok(repo, ['gate', 'plan', P, '--unchanged'], env, 1)
    expect(standingHandBack(readStream(repo.root, P), 'plan')).toBeDefined()
    expect(String(findById(loadCanon(repo.root), P)!.meta.status)).toBe('approved')

    const approved = (await ok(repo, ['next'], env)).stdout
    expect(approved).toContain(`next: ${show('plan', P)}`)
    expect(approved).not.toContain(`next: ${cliAct('gate', 'plan', P).line}`)
    expect(approved).not.toContain(`next: ${cliAct('start', P).line}`)
    expect(approved).not.toContain('revise owed')

    await ok(repo, ['start', P], env)
    const started = (await ok(repo, ['next'], env)).stdout
    expect(started).toContain(`next: ${show('plan', P)}`)
    expect(started).not.toContain('test-evidence')
    expect(started).not.toContain('stage: implement')
    expect((await ok(repo, [], env)).stdout).toContain(`next: ${show('plan', P)}`)
  }, 180_000)
})

// ---------------------------------------------------------------------------------------------
// Ship: a standing hand-back awaits the decision, with or without a PR

const PLAN_DOC = { rel: 'plans/p.md', meta: {}, body: '', violations: [], satisfiedNeeds: [] } as CanonDoc
const PLAN_PR = { ...PLAN_DOC, meta: { pr: 1 } } as CanonDoc
const TREE = 'tree-sha'
const shipRun = (n: number, outcome: 'stopped' | 'malformed' = 'stopped'): Entry => ({
  v: 1, t: 'gate-run', gate: 'ship', artifact: 'p', round: n, run_id: `s${n}`, reviewed_sha: TREE,
  prompts_sha: 'p', witness: '0', model: 'm', checks: [],
  ...(outcome === 'malformed'
    ? { verdicts: [], malformed: [{ reviewer: 'code-reviewer', violations: [] }] }
    : { verdicts: [{ reviewer: 'code-reviewer', coverage: [], findings: [{ blocking: true, anchor: 'src/token.ts', claim: 'x' }] }] }),
  outcome,
} as unknown as Entry)
const shipDec = (decision: string): Entry =>
  ({ v: 1, t: 'human-decision', gate: 'ship', artifact: 'p', round: 1, decision } as unknown as Entry)
const shipBack = (runId: string): Entry =>
  ({ v: 1, t: 'revise-returned', gate: 'ship', artifact: 'p', run_id: runId, sha: TREE } as unknown as Entry)
const HANDED = [shipRun(1), shipDec('revise'), shipBack('s1')]

const COVERAGE = [
  { anchor: '.gitignore', note: 'read' }, { anchor: 'package.json', note: 'read' },
  { anchor: 'src/token.ts', note: 'read' }, { anchor: 'tests/token.test.ts', note: 'read' },
]
const CLEAN = { coverage: COVERAGE, findings: [] }
const BLOCKING = { coverage: COVERAGE, findings: [{ blocking: true, anchor: 'src/token.ts', claim: 'rotation off by one' }] }

// A real plan whose ship gate stopped on a blocking finding in the code, with autonomy off.
async function stoppedShip(): Promise<{ repo: TestRepo; wt: string; env: Record<string, string>; ship: (out: string[]) => Promise<number> }> {
  const seed = await shippableRepo()
  addOrigin(seed.repo)
  expect(cfgOf(seed.repo).autonomy).toBe(false)
  const scenario = fakeScenario()
  putVerdict(scenario, CLEAN)
  const env = gateEnv(scenario)
  await runGate(fakeCtx(seed.repo.root, { env }), 'implement', P, { fresh: false, manual: false })
  putVerdict(scenario, BLOCKING)
  expect(await runShip(fakeCtx(seed.repo.root, { env }), P)).toBe(1)
  const ship = (out: string[]) => runShip(fakeCtx(seed.repo.root, { env, out: (l) => out.push(l), err: (l) => out.push(l) }), P)
  return { repo: seed.repo, wt: seed.wt, env, ship }
}

describe('ship with a standing hand-back (design §4.2.5)', () => {
  it.each<[string, string, CanonDoc, Entry[], string | undefined, boolean]>([
    ['handed back, no PR', 'awaiting-decision', PLAN_DOC, HANDED, TREE, false],
    ['handed back, with a PR', 'awaiting-decision', PLAN_PR, HANDED, TREE, false],
    // Staleness is judged where the decision is made: the block reads it, the phase does not.
    ['handed back, the tree moved since', 'awaiting-decision', PLAN_DOC, HANDED, 'other-tree', false],
    ['handed back, with a PR, the base moved', 'awaiting-decision', PLAN_PR, HANDED, TREE, true],
    // A malformed round judged nothing: the hand-back stands, and so does its decision.
    ['handed back, then a malformed round', 'awaiting-decision', PLAN_DOC, [...HANDED, shipRun(2, 'malformed')], TREE, false],
    // Any later disposition ends it.
    ['handed back, then approved', 'pr', PLAN_DOC, [...HANDED, shipDec('approve')], TREE, false],
    ['handed back, then approved, with a PR', 'watch', PLAN_PR, [...HANDED, shipDec('approve')], TREE, false],
    ['handed back, then parked', 'gate', PLAN_DOC, [...HANDED, shipDec('stop')], TREE, false],
    ['handed back, then revised again with a note', 'gate', PLAN_DOC, [...HANDED, shipDec('revise')], TREE, false],
  ])('%s → %s', (_name, phase, plan, entries, tree, baseMoved) => {
    expect(shipPhase(plan, entries, tree, baseMoved)).toBe(phase)
  })

  it('ship with a standing hand-back reads awaiting-decision, not "revise owed"', async () => {
    const f = await stoppedShip()
    await ok(f.repo, ['decide', 'ship', P, '--revise', '--note', 'bound the rotation'], f.env)
    const back = await ok(f.repo, ['gate', 'ship', P, '--unchanged'], f.env, 1)
    expect(back.stdout).toContain('outcome: handed back')
    expect(standingHandBack(readStream(f.repo.root, P), 'ship')).toBeDefined()

    const out: string[] = []
    expect(await f.ship(out)).toBe(1)
    const text = out.join('\n')
    expect(text).toContain(`ship: ${P} awaits the ship decision`)
    expect(text).not.toContain('revise owed')
    expect(text).not.toContain('revise changed nothing')
    // The handed-back block: the finding anchors in the code, so the park leads.
    expect(text).toContain(`run: ${cliAct('decide', 'ship', P, '--stop').line}`)
    expect(gateRuns(readStream(f.repo.root, P), 'ship')).toHaveLength(1)         // no round, no battery
    expect((await ok(f.repo, ['next'], f.env)).stdout).toContain(`next: ${show('ship', P)}`)

    // The tree moves after the hand-back: the block offers only live acts — the re-gate first, no approve.
    writeFileSync(join(f.wt, 'src/token.ts'), `${TOKEN_FIXED}// bounded at 80% of the TTL\n`)
    const moved: string[] = []
    expect(await f.ship(moved)).toBe(1)
    expect(moved.join('\n')).toContain(`ship: ${P} awaits the ship decision`)
    expect(moved.join('\n')).toContain(`run: ${cliAct('gate', 'ship', P).line}`)
    expect(moved.join('\n')).not.toContain('--approve')
  }, 300_000)

  // Carried from the Slice 2 close review: the awaiting-decision block read only lifted holds, so on a
  // moved tree it offered an approve `decide` refuses `stale-verdict`. It now passes content staleness.
  it('ship\'s awaiting-decision block on a moved tree offers only live acts: the re-gate first, no approve', async () => {
    const f = await stoppedShip()
    writeFileSync(join(f.wt, 'src/token.ts'), `${TOKEN_FIXED}// bounded at 80% of the TTL\n`)
    const out: string[] = []
    expect(await f.ship(out)).toBe(1)
    const text = out.join('\n')
    expect(text).toContain(`ship: ${P} awaits the ship decision`)
    expect(text).toContain('decide: ')
    expect(text).toContain(`run: ${cliAct('gate', 'ship', P).line}`)
    expect(text).not.toContain('--approve')
    // The approve the block used to offer is one `decide` refuses on the moved tree.
    const refused = await f.repo.cli(['decide', 'ship', P, '--approve', '--override'], { env: f.env })
    expect(refused.code, refused.stdout).toBe(2)
    expect(refused.stderr).toContain('stale-verdict')
    // decide --show, the screen next names, reads the same.
    expect((await ok(f.repo, ['decide', 'ship', P, '--show'], f.env)).stdout).toContain(`run: ${cliAct('gate', 'ship', P).line}`)
  }, 300_000)
})
