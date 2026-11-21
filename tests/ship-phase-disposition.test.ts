import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { cliAct } from '../src/act.js'
import { loadConfig, type Config } from '../src/config.js'
import { decideView } from '../src/decide-view.js'
import { diffBase } from '../src/evidence.js'
import { gateSpec, runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { appendEntry, readStream, type Entry } from '../src/journal.js'
import { diffReviewedSha, effortReviewedSha } from '../src/reviewed.js'
import { appendKind, gateRuns, keyOf, lastGateRun, liveActs, type GateRunEntry } from '../src/rounds.js'
import { findById, loadCanon, type CanonDoc } from '../src/scan.js'
import { runShip, shipPhase } from '../src/ship.js'
import { actFacts, authoringOwed, gateSettled } from '../src/verbs/next.js'
import {
  addOrigin, fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, shippableRepo, writeSpec,
  type CliResult, type TestRepo,
} from './helpers.js'

// Row 244 (#87, design §4.2.3, §4.2.9). Ship and the cache read a gate's LAST disposition, after the
// run it disposed of (malformed runs skipped): an approve that answered a revise goes on to ship (P9),
// a retraction after a pass un-settles the gate (P23), a stop after a pass reads parked, and a
// malformed round after a pass leaves it settled for `next` as for every screen.

// ---------------------------------------------------------------------------------------------
// shipPhase, as a pure function of the ship gate's journal

const PLAN = { rel: 'plans/p.md', meta: {}, body: '', violations: [], satisfiedNeeds: [] } as CanonDoc
const TREE = 'tree-sha'
type Outcome = 'passed' | 'stopped' | 'malformed'
const shipRun = (n: number, sha: string, outcome: Outcome = 'stopped'): Entry => ({
  v: 1, t: 'gate-run', gate: 'ship', artifact: 'p', round: n, run_id: `s${n}`, reviewed_sha: sha,
  prompts_sha: 'p', witness: '0', model: 'm', checks: [],
  ...(outcome === 'malformed'
    ? { verdicts: [], malformed: [{ reviewer: 'code-reviewer', violations: [] }] }
    : { verdicts: [{ reviewer: 'code-reviewer', coverage: [], findings: [{ blocking: true, anchor: 'src/token.ts', claim: 'x' }] }] }),
  outcome,
} as unknown as Entry)
const shipDec = (decision: string, extra: Record<string, unknown> = {}): Entry =>
  ({ v: 1, t: 'human-decision', gate: 'ship', artifact: 'p', round: 1, decision, ...extra } as unknown as Entry)

describe('shipPhase reads the ship gate\'s last disposition (design §4.2.3)', () => {
  it.each<[string, string, Entry[]]>([
    ['no run', 'gate', []],
    ['a stopped run, no decision', 'awaiting-decision', [shipRun(1, TREE)]],
    ['a revise, then an approve on unchanged content (P9)', 'pr', [shipRun(1, TREE), shipDec('revise'), shipDec('approve')]],
    ['a revise, then an override approve (P9)', 'pr', [shipRun(1, TREE), shipDec('revise'), shipDec('approve', { override: true })]],
    ['a revise', 'gate', [shipRun(1, TREE), shipDec('revise')]],
    ['an approve, then a retraction', 'gate', [shipRun(1, TREE), shipDec('approve'), shipDec('revise', { note: 'wrong' })]],
    ['a revise, then a stop', 'gate', [shipRun(1, TREE), shipDec('revise'), shipDec('stop')]],
    ['an approve on a tree that moved since', 'gate', [shipRun(1, 'old-tree'), shipDec('approve')]],
    // A malformed round judged nothing: the disposition is read after the run before it.
    ['a malformed round after a revise', 'gate', [shipRun(1, TREE), shipDec('revise'), shipRun(2, TREE, 'malformed')]],
    ['a malformed round, the stop before it undecided', 'awaiting-decision', [shipRun(1, TREE), shipRun(2, TREE, 'malformed')]],
    ['an approve, then a malformed round on the same tree', 'pr', [shipRun(1, TREE), shipDec('approve'), shipRun(2, TREE, 'malformed')]],
    ['only a malformed round', 'awaiting-decision', [shipRun(1, TREE, 'malformed')]],
  ])('%s → %s', (_name, phase, entries) => {
    expect(shipPhase(PLAN, entries, TREE)).toBe(phase)
  })

  it('the base or a hold moving still re-gates an approve that answered a revise', () => {
    const entries = [shipRun(1, TREE), shipDec('revise'), shipDec('approve')]
    expect(shipPhase(PLAN, entries, TREE, true)).toBe('gate')
    expect(shipPhase(PLAN, entries, TREE, false, true)).toBe('gate')
  })
})

// ---------------------------------------------------------------------------------------------
// P9 on a real plan: `witness ship` after a revise and an approve on unchanged content opens the PR

const COVERAGE = [
  { anchor: '.gitignore', note: 'read' }, { anchor: 'package.json', note: 'read' },
  { anchor: 'src/token.ts', note: 'read' }, { anchor: 'tests/token.test.ts', note: 'read' },
]
const CLEAN = { coverage: COVERAGE, findings: [] }
const BLOCKING = { coverage: COVERAGE, findings: [{ blocking: true, anchor: 'src/token.ts', claim: 'rotation off by one' }] }

describe('an approve after a revise on the ship gate goes on to ship (P9)', () => {
  it('ship: a revise, then an approve on unchanged content → shipPhase pr, and witness ship opens the PR (P9)', async () => {
    const seed = await shippableRepo()
    addOrigin(seed.repo)
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const env = gateEnv(scenario)
    const ctx = fakeCtx(seed.repo.root, { env })
    await runGate(ctx, 'implement', seed.planId, { fresh: false, manual: false })
    putVerdict(scenario, BLOCKING)
    expect(await runShip(ctx, seed.planId)).toBe(1)                     // the gate phase stops on the finding
    const rev = await seed.repo.cli(['decide', 'ship', seed.planId, '--revise'], { env })
    expect(rev.code, rev.stderr).toBe(0)
    // The author changed nothing; the decider approves over the finding.
    const ap = await seed.repo.cli(['decide', 'ship', seed.planId, '--approve', '--override'], { env })
    expect(ap.code, ap.stderr).toBe(0)
    const entries = readStream(seed.repo.root, seed.planId)
    expect(entries.filter((e) => e.t === 'human-decision').map((e) => (e as unknown as { decision: string }).decision))
      .toEqual(['revise', 'approve'])
    const cfgR = loadConfig(seed.repo.root)
    if (!cfgR.ok) throw new Error('config')
    const base = diffBase(seed.wt, cfgR.value)
    if (!base.ok) throw new Error('base')
    const plan = findById(loadCanon(seed.repo.root), seed.planId)!
    expect(shipPhase(plan, entries, diffReviewedSha(seed.wt, base.value))).toBe('pr')
    expect(gateSettled(entries, 'ship', diffReviewedSha(seed.wt, base.value))).toBe(true)

    const out: string[] = []
    const shipCtx = fakeCtx(seed.repo.root, { env, out: (l) => out.push(l), err: (l) => out.push(l) })
    expect(await runShip(shipCtx, seed.planId), out.join('\n')).toBe(0)
    expect(out.join('\n')).not.toContain('revise changed nothing')
    expect(readFileSync(join(scenario, 'gh-calls'), 'utf8')).toContain('pr create')
    expect(findById(loadCanon(seed.repo.root), seed.planId)!.meta.pr).toBe(1)
    // no second battery: the approval was the last word
    expect(gateRuns(readStream(seed.repo.root, seed.planId), 'ship')).toHaveLength(1)
  }, 300_000)
})

// Fix round 2 (design §4.2.2, §4.2.4). A retraction asks for a re-review, not an edit: `witness ship`
// re-judges the tree the retracted approval judged (the ship gate's `--fresh`, after its own rebase),
// where it printed "revise owed — edit the code". `next` and `status` keep naming `witness ship`, the
// ship session's one verb, and `decide --show` leads with the `gate ship --fresh` it runs.
describe('a retracted ship approval: witness ship re-reviews (row 244)', () => {
  it('witness ship runs the ship gate fresh, never "revise owed", after a retraction', async () => {
    const seed = await shippableRepo()
    addOrigin(seed.repo)
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const env = gateEnv(scenario)
    const ctx = fakeCtx(seed.repo.root, { env })
    await runGate(ctx, 'implement', seed.planId, { fresh: false, manual: false })
    putVerdict(scenario, BLOCKING)
    expect(await runShip(ctx, seed.planId)).toBe(1)                     // the ship gate stops
    expect((await seed.repo.cli(['decide', 'ship', seed.planId, '--approve', '--override'], { env })).code).toBe(0)
    const retract = await seed.repo.cli(['decide', 'ship', seed.planId, '--revise', '--note', 'the approval missed the drift'], { env })
    expect(retract.code, retract.stderr).toBe(0)
    const show = await seed.repo.cli(['decide', 'ship', seed.planId, '--show'], { env })
    expect(show.stdout).toContain(`run: ${cliAct('gate', 'ship', seed.planId, '--fresh').line}`)
    const next = await seed.repo.cli(['next'], { env })
    expect(next.stdout).toContain(`next: witness ship ${seed.planId}`)

    const out: string[] = []
    const shipCtx = fakeCtx(seed.repo.root, { env, out: (l) => out.push(l), err: (l) => out.push(l) })
    expect(await runShip(shipCtx, seed.planId), out.join('\n')).toBe(1)  // the re-review stops, as the ship gate always does
    expect(out.join('\n')).not.toContain('revise owed')
    expect(out.join('\n')).not.toContain('revise changed nothing')
    expect(gateRuns(readStream(seed.repo.root, seed.planId), 'ship')).toHaveLength(2)
  }, 300_000)
})

// ---------------------------------------------------------------------------------------------
// gateSettled reads the last disposition after a pass too, against the last run that judged something

const G = 'decompose'
const run = (gate: string, n: number, sha: string, outcome: Outcome = 'stopped'): Entry => ({
  v: 1, t: 'gate-run', gate, artifact: 'e', round: n, run_id: `r${n}`, reviewed_sha: sha,
  prompts_sha: 'p', witness: '0', model: 'm', checks: [],
  ...(outcome === 'malformed'
    ? { verdicts: [], malformed: [{ reviewer: 'slicing-critic', violations: [] }] }
    : { verdicts: [{ reviewer: 'slicing-critic', coverage: [], findings: [] }] }),
  outcome,
} as unknown as Entry)
const dec = (gate: string, decision: string, extra: Record<string, unknown> = {}): Entry =>
  ({ v: 1, t: 'human-decision', gate, artifact: 'e', round: 1, decision, ...extra } as unknown as Entry)

describe('gateSettled reads the last disposition, after a pass too (design §4.2.3, §4.2.9)', () => {
  it.each<[string, boolean, string | undefined, Entry[]]>([
    ['a pass', true, 'a', [run(G, 1, 'a', 'passed')]],
    ['a pass, content moved', false, 'b', [run(G, 1, 'a', 'passed')]],
    ['a pass, then a retraction (P23)', false, 'a', [run(G, 1, 'a', 'passed'), dec(G, 'revise', { note: 'wrong' })]],
    ['a pass, then a retraction, sha unknown (P23)', false, undefined, [run(G, 1, 'a', 'passed'), dec(G, 'revise', { note: 'wrong' })]],
    ['a pass, then a stop: parked, not settled', false, undefined, [run(G, 1, 'a', 'passed'), dec(G, 'stop')]],
    ['a pass, then an approve', true, 'a', [run(G, 1, 'a', 'passed'), dec(G, 'approve')]],
    ['a pass, then a retraction, then an approve', true, 'a', [run(G, 1, 'a', 'passed'), dec(G, 'revise', { note: 'x' }), dec(G, 'approve')]],
    ['a stop answered by an approve', true, 'a', [run(G, 1, 'a'), dec(G, 'approve')]],
    ['an approve, then a retraction', false, 'a', [run(G, 1, 'a'), dec(G, 'approve'), dec(G, 'revise', { note: 'x' })]],
    // A malformed round judged nothing: the settlement stands for the content it judged (S2-1).
    ['a pass, then a malformed round', true, 'a', [run(G, 1, 'a', 'passed'), run(G, 2, 'a', 'malformed')]],
    ['a pass, then a malformed round on moved content', false, 'b', [run(G, 1, 'a', 'passed'), run(G, 2, 'b', 'malformed')]],
    ['an approve, then a malformed round', true, 'a', [run(G, 1, 'a'), dec(G, 'approve'), run(G, 2, 'a', 'malformed')]],
    ['only a malformed round', false, 'a', [run(G, 1, 'a', 'malformed')]],
  ])('%s → settled %s', (_name, settled, sha, entries) => {
    expect(gateSettled(entries, G, sha)).toBe(settled)
    // and it agrees with the one derivation every screen reads
    const live = liveActs(G, 'e', entries, { upstream: 'e', stale: sha !== undefined && sha !== 'a', holdLifted: false, owed: false, upstreamOwed: false })
    expect(live.state === 'settled' && (sha === undefined || sha === 'a')).toBe(settled)
  })

  it('authoringOwed pairs a revise with the run it disposed of, malformed runs skipped (design §4.2.3)', () => {
    // P45: a revise after a malformed round on the disposed run's content — the re-gate would change nothing
    expect(authoringOwed([run(G, 1, 'a'), run(G, 2, 'a', 'malformed'), dec(G, 'revise')], G, 'a')).toBe(true)
    // P50: content edited between the stopped run and the malformed one has no verdict — the gate is owed
    expect(authoringOwed([run(G, 1, 'a'), run(G, 2, 'b', 'malformed'), dec(G, 'revise')], G, 'b')).toBe(false)
    expect(authoringOwed([run(G, 1, 'a'), run(G, 2, 'b', 'malformed'), dec(G, 'revise')], G, 'a')).toBe(true)
    // a malformed round after the revise on that content: its free re-run repairs it
    expect(authoringOwed([run(G, 1, 'a'), dec(G, 'revise'), run(G, 2, 'a', 'malformed')], G, 'a')).toBe(false)
    // one on other content leaves the pairing with the disposed run (S3-3)
    expect(authoringOwed([run(G, 1, 'a'), dec(G, 'revise'), run(G, 2, 'b', 'malformed')], G, 'a')).toBe(true)
    // the last disposition, by position: an approve answered the revise
    expect(authoringOwed([run(G, 1, 'a'), dec(G, 'revise'), dec(G, 'approve')], G, 'a')).toBe(false)
  })

  // Fix round 2. The gate pairs on its whole key; `next` sees only the content's sha. P50's exception
  // reads the content for both: a malformed round after the revise on the content the revise asked
  // about ends the pairing whatever its setup, so `next` routes the gate in every setup and the gate
  // never answers changed-nothing there: reverted, it replays the disposed run; kept, it repairs the
  // malformed round; a third setup runs fresh. No loop in any of them.
  it.each<[string, string, string]>([
    ['the setup reverted to the disposed run\'s', 'p', 'cached'],
    ['the setup kept on the malformed round\'s', 'p2', 'repair'],
    ['a third setup', 'p3', 'fresh'],
  ])('a malformed round after the revise under another setup, %s (%s): next routes the gate, which answers %s', (_name, setup, kind) => {
    const r1 = run(G, 1, 'a')
    const m = { ...(run(G, 2, 'a', 'malformed') as unknown as Record<string, unknown>), prompts_sha: 'p2' } as unknown as Entry
    const entries = [r1, dec(G, 'revise'), m]
    expect(authoringOwed(entries, G, 'a')).toBe(false)
    expect(appendKind(entries, G, { ...keyOf(r1 as unknown as GateRunEntry), prompts_sha: setup }).kind).toBe(kind)
  })

  it('a malformed round after the revise under the same setup: its re-run repairs it, for both readers', () => {
    const r1 = run(G, 1, 'a')
    const same = [r1, dec(G, 'revise'), run(G, 2, 'a', 'malformed')]
    expect(authoringOwed(same, G, 'a')).toBe(false)
    expect(appendKind(same, G, keyOf(r1 as unknown as GateRunEntry)).kind).toBe('repair')
  })
})

// ---------------------------------------------------------------------------------------------
// The real decompose gate on a seeded effort: the retraction, the park after a pass, the malformed
// round after a pass, and a malformed round between a stopped run and a revise.

const ANCHOR = 'auth-refresh > ## Behavior'
const VERDICT = {
  coverage: [{ anchor: ANCHOR, note: 'read' }],
  findings: [{ blocking: true, anchor: ANCHOR, claim: 'expiry unbounded' }],
}

let base: { repo: TestRepo; sha: string; scenario: string; effort: string }
beforeAll(async () => {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  const scenario = fakeScenario()
  putVerdict(scenario, VERDICT)
  base = { repo, sha: effortReviewedSha(repo.root, loadCanon(repo.root), repo.effort).sha, scenario, effort: repo.effort }
}, 120_000)

const effortRun = (n: number, sha: string, outcome: Outcome = 'stopped'): Entry =>
  ({ ...(run(G, n, sha, outcome) as unknown as Record<string, unknown>), artifact: base.effort } as unknown as Entry)
const effortDec = (decision: string, extra: Record<string, unknown> = {}): Entry =>
  ({ ...(dec(G, decision, extra) as unknown as Record<string, unknown>), artifact: base.effort } as unknown as Entry)

function copyOf(root: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'witness-disposition-')))
  cpSync(root, dir, { recursive: true })
  return dir
}
function repoWith(entries: Entry[], from = base.repo.root): string {
  const root = copyOf(from)
  for (const e of entries) appendEntry(root, base.effort, e as unknown as { t: 'gate-run' })
  base.repo.git('-C', root, 'add', '.witness/journal')
  base.repo.git('-C', root, 'commit', '-qm', 'disposition: state', '-m', 'Witness-State: 1')
  return root
}
const cli = (root: string, args: string[]): Promise<CliResult> =>
  base.repo.cli(args, { cwd: root, env: gateEnv(base.scenario) })
const ruleOf = (stderr: string): string | undefined => /^\s+[^,\s]+,([a-z-]+),/m.exec(stderr)?.[1]
function cfgOf(root: string): Config {
  const r = loadConfig(root)
  if (!r.ok) throw new Error('config')
  return r.value
}
function liveIn(root: string) {
  const cfg = cfgOf(root)
  const canon = loadCanon(root)
  const entries = readStream(root, base.effort)
  const spec = gateSpec(G)!
  const sha = spec.currentSha!(root, canon, cfg, base.effort)
  const facts = actFacts(root, cfg, canon, G, base.effort, entries, { sha, upstream: spec.upstreamOf!(root, canon, base.effort) })
  return { live: liveActs(G, base.effort, entries, facts), entries, sha }
}
const WARNING = 'warning: reviewer setup changed'
const runsIn = (root: string): GateRunEntry[] => gateRuns(readStream(root, base.effort), G)

describe('a retraction un-settles a pass (design §4.2.3, P23)', () => {
  it('a retraction after a pass un-settles the gate, and gate --fresh runs (P23)', async () => {
    const root = repoWith([effortRun(1, base.sha, 'passed')])
    expect(liveIn(root).live.state).toBe('settled')
    const retract = await cli(root, ['decide', G, base.effort, '--revise', '--note', 'the pass missed the expiry'])
    expect(retract.code, retract.stderr).toBe(0)
    const { live, entries, sha } = liveIn(root)
    expect(live.state).toBe('retracted')
    // the retracted state's re-review runs, and no warning claims it discards a settlement
    const fresh = await cli(root, ['gate', G, base.effort, '--fresh'])
    expect(fresh.code, `${fresh.stdout}\n${fresh.stderr}`).toBeLessThanOrEqual(1)
    expect(fresh.stderr).not.toContain('settled-approve')
    expect(fresh.stderr).not.toContain(WARNING)
    expect(runsIn(root)).toHaveLength(2)
    // the journal the retraction left reads unsettled, with or without the content's sha
    expect(gateSettled(entries, G, sha)).toBe(false)
    expect(gateSettled(entries, G)).toBe(false)
  }, 120_000)

  it('a stop after a pass reads parked: --fresh runs, with no false "setup changed" warning', async () => {
    const root = repoWith([effortRun(1, base.sha, 'passed'), effortDec('stop')])
    const { live, entries } = liveIn(root)
    expect(live.state).toBe('parked')
    expect(live.acts.map((a) => a.line)).toContain(cliAct('gate', G, base.effort, '--fresh').line)
    const fresh = await cli(root, ['gate', G, base.effort, '--fresh'])
    expect(fresh.code, `${fresh.stdout}\n${fresh.stderr}`).toBeLessThanOrEqual(1)
    expect(fresh.stderr).not.toContain(WARNING)
    expect(runsIn(root)).toHaveLength(2)
    expect(gateSettled(entries, G)).toBe(false)
  }, 120_000)
})

// Task 10's review: after a pass then a malformed round, decide --show read settled (the retraction
// alone) and `gate --fresh` refused, while `next` still routed the malformed round's re-run. Settled
// means nothing is owed to the gate, on every reader.
describe('a malformed round after a pass leaves the gate settled for next too (design §4.2.9)', () => {
  it('next routes nothing to the gate; decide --show reads settled; gate --fresh refuses', async () => {
    const root = repoWith([effortRun(1, base.sha, 'passed'), effortRun(2, base.sha, 'malformed')])
    const { live, entries, sha } = liveIn(root)
    expect(live.state).toBe('settled')
    const next = await cli(root, ['next'])
    expect(next.code, next.stderr).toBe(0)
    expect(next.stdout).not.toContain(`witness gate ${G}`)
    expect(gateSettled(entries, G, sha)).toBe(true)
    const view = decideView(root, cfgOf(root), loadCanon(root), G, base.effort)
    expect(view.state).toBe('settled')
    const fresh = await cli(root, ['gate', G, base.effort, '--fresh'])
    expect(fresh.code).toBe(2)
    expect(ruleOf(fresh.stderr)).toBe('settled-approve')
    expect(runsIn(root)).toHaveLength(2)
  }, 120_000)
})

// P50, on the real gate: the content an author edited between a stopped run and a malformed one has
// no verdict, so a re-gate after the revise judges it rather than calling it unchanged.
describe('a malformed round between a stopped run and a revise (design §4.2.3, P50)', () => {
  it('content edited between a stopped run and a malformed one: the re-gate runs, never changed-nothing (P50)', async () => {
    const root = copyOf(base.repo.root)
    const g = await cli(root, ['gate', G, base.effort])
    expect(g.code, `${g.stdout}\n${g.stderr}`).toBe(1)
    const stopped = lastGateRun(readStream(root, base.effort), G)!
    expect(stopped.outcome).toBe('stopped')
    // the author edits the work before any decision, and a re-gate of the edit comes back malformed
    const rel = 'specs/auth-refresh.md'
    writeFileSync(join(root, rel), `${readFileSync(join(root, rel), 'utf8')}\nRotation is logged.\n`)
    base.repo.git('-C', root, 'add', rel)
    base.repo.git('-C', root, 'commit', '-qm', 'the author edits the work', '-m', 'Witness-State: 1')
    const edited = effortReviewedSha(root, loadCanon(root), base.effort).sha
    expect(edited).not.toBe(stopped.reviewed_sha)
    const { reviewed_tree: _t, basis_sha: _b, delta: _d, carried: _c, ...key } = stopped
    const malformed = {
      ...key, round: stopped.round + 1, run_id: 'r-malformed', reviewed_sha: edited,
      verdicts: [], malformed: (stopped.verdicts ?? []).map((v) => ({ reviewer: v.reviewer, violations: [] })), outcome: 'malformed',
    }
    const at = repoWith([malformed as unknown as Entry], root)
    const rev = await cli(at, ['decide', G, base.effort, '--revise', '--note', 'tighten the slicing'])
    expect(rev.code, rev.stderr).toBe(0)
    const revised = readStream(at, base.effort)
    const regate = await cli(at, ['gate', G, base.effort])
    expect(regate.stdout).not.toContain('revise changed nothing')
    expect(regate.code, `${regate.stdout}\n${regate.stderr}`).toBeLessThanOrEqual(1)
    const runs = runsIn(at)
    expect(runs).toHaveLength(3)
    expect(runs.at(-1)!.reviewed_sha).toBe(edited)
    expect(runs.at(-1)!.outcome).not.toBe('malformed')
    // and `next` routes that re-gate, not the authoring a changed-nothing would owe
    expect(authoringOwed(revised, G, edited)).toBe(false)
  }, 180_000)
})

// Fix round 2. `next` sees the content's sha, the gate its whole key. P50's exception reads the content
// for every reader: a malformed round after the revise, on the content the revise asked about, ends the
// pairing whatever its setup. So in every setup `next` routes the gate and the gate journals a round —
// the setup reverted replays the disposed run, the setup kept repairs the malformed round, and a third
// setup runs fresh — never the changed-nothing `next` would route every turn (D94's loop), and never
// the authoring a malformed round's free re-run outranks (design §4.2.2, §4.2.3).
describe('next and the gate agree on a malformed round after the revise, in every setup (design §4.2.3)', () => {
  // The run the real gate journals here: its key is the setup the gate builds now.
  let real: GateRunEntry
  beforeAll(async () => {
    const root = copyOf(base.repo.root)
    const g = await cli(root, ['gate', G, base.effort])
    if (g.code !== 1) throw new Error(`gate: ${g.stdout}\n${g.stderr}`)
    real = lastGateRun(readStream(root, base.effort), G)!
  }, 120_000)

  // A run as `real`, under the setup `setup` names (undefined: the gate's own).
  const under = (r: GateRunEntry, setup: string | undefined): GateRunEntry => {
    const { setup_sha: _s, ...rest } = r
    return setup === undefined ? r : { ...rest, prompts_sha: setup } as GateRunEntry
  }
  const malformedOf = (r: GateRunEntry): Entry => {
    const { reviewed_tree: _t, basis_sha: _b, delta: _d, carried: _c, ...key } = r
    return {
      ...key, round: r.round + 1, run_id: 'r-malformed', verdicts: [],
      malformed: (r.verdicts ?? []).map((v) => ({ reviewer: v.reviewer, violations: [] })), outcome: 'malformed',
    } as unknown as Entry
  }

  it.each<[string, string | undefined, string | undefined, (run: GateRunEntry) => void]>([
    // the setup reverted to the disposed run's: the gate replays it, a journaled round with no battery
    ['reverted to the disposed run\'s', undefined, 'another-setup', (r) => expect(r.cached).toBe(true)],
    // the setup kept on the malformed round's (an upgrade after the revise): its free re-run repairs it
    ['kept on the malformed round\'s', 'old-setup', undefined, (r) => expect(r.cached).toBeUndefined()],
    // a third setup: a fresh round
    ['moved to a third one', 'old-setup', 'another-setup', (r) => expect(r.cached).toBeUndefined()],
  ])('the setup %s: next routes the gate, and the gate journals a round', async (_name, disposedSetup, malformedSetup, check) => {
    const at = repoWith([
      under(real, disposedSetup) as unknown as Entry,
      effortDec('revise', { note: 'tighten the slicing' }),
      malformedOf(under(real, malformedSetup)),
    ])
    const journal = readStream(at, base.effort)
    const next = await cli(at, ['next'])
    expect(next.code, next.stderr).toBe(0)
    expect(next.stdout).not.toContain('revise owed')
    expect(next.stdout).toContain(`witness gate ${G}`)
    expect(authoringOwed(journal, G, real.reviewed_sha)).toBe(false)
    const regate = await cli(at, ['gate', G, base.effort])
    expect(regate.stdout).not.toContain('revise changed nothing')
    expect(regate.code, `${regate.stdout}\n${regate.stderr}`).toBeLessThanOrEqual(1)
    const runs = runsIn(at)
    expect(runs).toHaveLength(3)
    expect(runs.at(-1)!.reviewed_sha).toBe(real.reviewed_sha)
    expect(runs.at(-1)!.outcome).not.toBe('malformed')
    check(runs.at(-1)!)
  }, 180_000)
})
