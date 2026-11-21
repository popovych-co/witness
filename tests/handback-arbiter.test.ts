import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { cliAct, type Act } from '../src/act.js'
import { decisionEvidence, menuFor, type ArbiterRequest } from '../src/arbiter.js'
import { policyFor } from '../src/autonomy.js'
import { BUSY_DIR } from '../src/busy.js'
import { EXIT } from '../src/cli.js'
import { loadConfig, type Config } from '../src/config.js'
import { contentSha } from '../src/content-sha.js'
import '../src/gates/index.js'
import { appendEntry, readStream, type Entry } from '../src/journal.js'
import { needsYou } from '../src/needs-you.js'
import { recommend, renderDecision, type Decision } from '../src/recommend.js'
import { effortReviewedSha } from '../src/reviewed.js'
import {
  actKey, ladderSpent, lastGateRun, liveActs, settledToken, standingHandBack,
  type ActFacts, type DecisionEntry, type GateRunEntry, type GateStateKind,
} from '../src/rounds.js'
import { findById, loadCanon } from '../src/scan.js'
import { settleStop } from '../src/settle.js'
import { applyDecision, decisionAct } from '../src/verbs/decide.js'
import { owedRun } from '../src/verbs/next.js'
import {
  PLAN_BLOCKING, callFor, fakeCtx, fakeScenario, gateEnv, plannedRepo, putVerdict, seededRepo, writePlan, writeSpec,
  type CliResult, type TestRepo,
} from './helpers.js'

// Row 244 (#87, design §4.2.6; amends rows 121, 171, 172). Who decides a revise its author handed back
// unchanged: recommend's rule `revise-returned` (send upstream where the blocking finding anchors in the
// parent and D123's ladder is unspent, else park), the policy's arm that hands it to the arbiter after
// the arms that belong elsewhere, the arbiter's menu that never revises it again, the hand-back as a
// journal fact in the arbiter's evidence (never the author's words), and `--manual`, which keeps it
// for the human in every settle that reads it.

// The arbiter: the real one (the fake harness answers it) unless a test seats a stand-in, which runs
// `during` while it "thinks" and then picks the option `pick` names. Every request the CLI composed is
// kept, so a test reads the menu and the evidence the arbiter was given.
const arbiter = vi.hoisted(() => ({
  standIn: undefined as undefined | { during?: () => Promise<void> | void; pick: (argv: readonly string[]) => boolean },
  requests: [] as ArbiterRequest[],
}))
vi.mock('../src/arbiter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/arbiter.js')>()
  return {
    ...real,
    arbitrate: async (...args: Parameters<typeof real.arbitrate>) => {
      const req = args[3]
      arbiter.requests.push(req)
      const s = arbiter.standIn
      if (s === undefined) return real.arbitrate(...args)
      await s.during?.()
      const i = req.menu.findIndex((o) => o.act !== undefined && s.pick(o.act.argv))
      if (i < 0) throw new Error(`stand-in: no such option in ${req.menu.map((o) => o.command).join(' | ')}`)
      return { ok: true, value: { choice: i + 1, reason: 'stand-in: the evidence names no fix', model: 'm', prompts_sha: 'p' } }
    },
  }
})
const seat = (pick: (argv: readonly string[]) => boolean, during?: () => Promise<void> | void): void => {
  arbiter.standIn = { pick, ...(during ? { during } : {}) }
  arbiter.requests = []
}
const unseat = (): void => { arbiter.standIn = undefined; arbiter.requests = [] }

const P = 'auth-refresh-plan-1'
const S = 'auth-refresh'
const IN_PLAN = `${P} > ## Step: s1`
const IN_PARENT = `${S} > ## Behavior`
const HANDED_BACK = 'the author handed this revise back with the content unchanged'
const BLOCKING_PARENT = {
  coverage: [{ anchor: IN_PLAN, note: 'read' }, { anchor: IN_PARENT, note: 'read' }],
  findings: [{ blocking: true, anchor: IN_PARENT, claim: 'the behavior leaves the expiry unbounded' }],
}

const isPlainRevise = (argv: readonly string[]) => argv.includes('--revise') && !argv.includes('--upstream') && !argv.includes('--repair')
const stops = (argv: readonly string[]) => argv.includes('--stop')
const upstreams = (argv: readonly string[]) => argv.includes('--upstream')

// ---- journals, written by hand (the pure tests) -------------------------------------------------

type Outcome = 'stopped' | 'passed' | 'malformed'
const run = (gate: string, round: number, sha: string, anchors: string[], extra: Record<string, unknown> = {}): Entry => ({
  v: 1, t: 'gate-run', gate, artifact: 'p1', round, run_id: `r-${round}`, reviewed_sha: sha,
  prompts_sha: 'ps', witness: '0.16.0', model: 'm', pin: 'm', harness: 'claude-code', checks: [], outcome: 'stopped' as Outcome,
  verdicts: [{ reviewer: 'lens', coverage: [], findings: anchors.map((anchor) => ({ blocking: true, anchor, claim: 'x' })) }],
  ...extra,
} as unknown as Entry)
const malformed = (gate: string, round: number, sha: string): Entry =>
  run(gate, round, sha, [], { outcome: 'malformed', verdicts: [], malformed: [{ reviewer: 'lens', violations: [] }] })
const decision = (gate: string, d: string, extra: Record<string, unknown> = {}): Entry =>
  ({ v: 1, t: 'human-decision', gate, artifact: 'p1', round: 1, decision: d, ...extra } as unknown as Entry)
const back = (gate: string, runId: string, sha = 'a', extra: Record<string, unknown> = {}): Entry =>
  ({ v: 1, t: 'revise-returned', gate, artifact: 'p1', run_id: runId, sha, ...extra } as unknown as Entry)
// The plan gate stopped on `anchors`, revised by a human and handed back by its author.
const handedBack = (anchors: string[], extra: Record<string, unknown> = {}): Entry[] =>
  [run('plan', 1, 'a', anchors, extra), decision('plan', 'revise', { note: 'make step s1 testable' }), back('plan', 'r-1')]

const blockOf = (gate: string, entries: Entry[], o: { upstream?: string | null; stale?: boolean } = {}): Decision | undefined =>
  recommend({ gate, target: 'p1', entries, upstream: o.upstream === null ? undefined : (o.upstream ?? 'auth-refresh'), stale: o.stale ?? false })
const argvs = (d: Decision | undefined) => (d?.options ?? []).map((o) => o.act?.argv.slice(3).join(' '))

describe('the rule revise-returned (design §4.2.6, row 121)', () => {
  it('recommend on a hand-back: rule revise-returned, anchor = primary; upstream when the anchor is in the parent, else park', () => {
    // In the parent: the author found nothing to change because the fault is above.
    const parent = blockOf('plan', handedBack([IN_PARENT]))!
    expect(parent.rule).toBe('revise-returned')
    expect(parent.anchor).toBe(IN_PARENT)
    expect(argvs(parent)).toEqual(['--revise --upstream auth-refresh', '--approve --override', '--stop', '--fresh', '--revise --note <why>'])
    expect(parent.options[0]!.why).toContain('the fix belongs in the parent')
    expect(renderDecision(parent).at(-1)).toBe('run: witness decide plan p1 --revise --upstream auth-refresh')

    // In this artifact: neither the author nor a reviewer found a fix — park.
    const here = blockOf('plan', handedBack([IN_PLAN]))!
    expect(here.rule).toBe('revise-returned')
    expect(here.anchor).toBe(IN_PLAN)
    expect(argvs(here)[0]).toBe('--stop')
    expect(here.options[0]!.why).toBe('the author handed the revise back unchanged — neither the author nor a reviewer found a fix')

    // The anchor is the run's primary one, and "in the parent" means every blocking finding is.
    const mixed = blockOf('plan', handedBack([IN_PLAN, IN_PARENT]))!
    expect(mixed.anchor).toBe(IN_PLAN)
    expect(argvs(mixed)[0]).toBe('--stop')
    const both = blockOf('plan', handedBack([IN_PARENT, `${S} > ## Constraints`]))!
    expect(both.anchor).toBe(IN_PARENT)
    expect(argvs(both)[0]).toBe('--revise --upstream auth-refresh')

    // D123: once the ladder is spent for the primary anchor, no upstream is offered and the park leads.
    const spent = blockOf('plan', [
      run('plan', 1, 'a', [IN_PARENT]), decision('plan', 'revise-upstream', { anchor: IN_PARENT, upstream: { artifact: S, gate: 'decompose' } }),
      run('plan', 2, 'b', [IN_PARENT]), decision('plan', 'revise', { note: 'x' }), back('plan', 'r-2', 'b'),
    ], { stale: false })!
    expect(spent.rule).toBe('revise-returned')
    expect(argvs(spent)[0]).toBe('--stop')
    expect(argvs(spent).some((a) => a?.includes('--upstream'))).toBe(false)

    // No parent resolves: the upstream is a slot for the human to fill, never an option, and the park leads.
    const orphan = blockOf('plan', handedBack([IN_PARENT]), { upstream: null })!
    expect(orphan.rule).toBe('revise-returned')
    expect(argvs(orphan)[0]).toBe('--stop')
    expect(argvs(orphan).some((a) => a?.includes('--upstream'))).toBe(false)
  })

  it('it matches after stale-below-bound, and before malformed-rerun only when a revise follows the malformed run (§4.2.3)', () => {
    // Moved since the hand-back: the stale row, the re-gate first and no approve — its options still carry
    // the primary anchor, so an upstream taken there spends the ladder (P47).
    const moved = blockOf('plan', handedBack([IN_PARENT]), { stale: true })!
    expect(moved.rule).toBe('stale-below-bound')
    expect(moved.anchor).toBe(IN_PARENT)
    expect(argvs(moved)[0]).toBe('')
    expect(moved.options[0]!.act?.argv).toEqual(['gate', 'plan', 'p1'])
    expect(argvs(moved).some((a) => a?.includes('--approve'))).toBe(false)
    // A malformed round before the revise judged nothing: the hand-back's rule, never a re-run that
    // would change nothing (P45).
    const p45 = blockOf('plan', [run('plan', 1, 'a', [IN_PLAN]), malformed('plan', 2, 'a'), decision('plan', 'revise'), back('plan', 'r-1')])!
    expect(p45.rule).toBe('revise-returned')
    expect(p45.anchor).toBe(IN_PLAN)
    // A malformed round after the hand-back, on the content it handed back, leads with its free re-run,
    // which repairs it (P50, §4.2.2) …
    const p50 = blockOf('plan', [...handedBack([IN_PLAN]), malformed('plan', 2, 'a')])!
    expect(p50.rule).toBe('malformed-rerun')
    // … and one on other content leaves the pairing with the disposed run: the hand-back's own rule (S3-3).
    const s33 = blockOf('plan', [...handedBack([IN_PLAN]), malformed('plan', 2, 'b')])!
    expect(s33.rule).toBe('revise-returned')
  })
})

describe('the policy hands it to the arbiter (design §4.2.6, row 171)', () => {
  const policy = (gate: string, entries: Entry[], o: { untrusted?: string[]; stale?: boolean } = {}) => {
    const block = blockOf(gate, entries, { stale: o.stale ?? false })!
    return { rule: block.rule, policy: policyFor({ at: 'gate', gate, target: 'p1', entries, run: owedRun(entries, gate)!, block, untrusted: o.untrusted ?? [] }) }
  }
  const ARBITER = { kind: 'arbiter' }
  const take = (...argv: string[]) => ({ kind: 'take', act: cliAct(...argv) })

  it('policyFor sends revise-returned to the arbiter after the trust, re-run and design-look arms', () => {
    // The arm: no rule has the right answer for a revise the author found nothing to change in.
    expect(policy('plan', handedBack([IN_PLAN]))).toEqual({ rule: 'revise-returned', policy: ARBITER })
    // Outside TAKEN: its recommended upstream is runnable, yet the arbiter judges it, where
    // `blocking-parent` on a pending stop is taken as it stands.
    expect(policy('plan', handedBack([IN_PARENT]))).toEqual({ rule: 'revise-returned', policy: ARBITER })
    expect(policy('plan', [run('plan', 1, 'a', [IN_PARENT])])).toEqual({ rule: 'blocking-parent', policy: take('decide', 'plan', 'p1', '--revise', '--upstream', 'auth-refresh') })
    // A failed check on the disposed run is still the arbiter's, never checks-failed's revise.
    expect(policy('plan', handedBack([], { checks: [{ name: 'lint', ok: false, detail: 'x' }] }))).toEqual({ rule: 'revise-returned', policy: ARBITER })

    // Ahead of it, in order. The human's trust grant:
    const blockedCheck = { checks: [{ name: 'drift-lane', ok: false, detail: 'ac:fail', untrusted: ['pnpm verify'] }] }
    expect(policy('plan', handedBack([IN_PLAN], blockedCheck), { untrusted: ['pnpm verify'] }).policy).toEqual({ kind: 'human', stop: 'trust-grant' })
    // the stale re-run (the moved row) and the malformed one:
    expect(policy('plan', handedBack([IN_PLAN]), { stale: true })).toEqual({ rule: 'stale-below-bound', policy: take('gate', 'plan', 'p1') })
    expect(policy('plan', [...handedBack([IN_PLAN]), malformed('plan', 2, 'a')])).toEqual({ rule: 'malformed-rerun', policy: take('gate', 'plan', 'p1') })
    // the fallen-back re-run:
    const fell = { pin: 'm1', model: 'session-default', fallback: ['m1'] }
    expect(policy('plan', handedBack([IN_PLAN], fell))).toEqual({ rule: 'revise-returned', policy: take('gate', 'plan', 'p1') })
    // the design look — a hand-back at a clean design gate is the human's look:
    const design = (anchors: string[]) => [
      run('design', 1, 'a', anchors, { standing: 'the look is the human\'s' }), decision('design', 'revise', { note: 'x' }), back('design', 'r-1'),
    ]
    expect(policy('design', design([]))).toEqual({ rule: 'revise-returned', policy: { kind: 'human', stop: 'design-look' } })
    expect(policy('design', design(['design#save-bar']))).toEqual({ rule: 'revise-returned', policy: ARBITER })
    // and the re-run of a check whose command was trusted since:
    expect(policy('plan', handedBack([IN_PLAN], blockedCheck))).toEqual({ rule: 'revise-returned', policy: take('gate', 'plan', 'p1') })
  })
})

describe('the arbiter\'s menu (design §4.2.6, row 172)', () => {
  const menu = (gate: string, entries: Entry[], o: { upstream?: string | null } = {}) =>
    menuFor(blockOf(gate, entries, o)!, owedRun(entries, gate)!).map((m) => m.act.argv.slice(3).join(' '))

  it('the arbiter is never offered a plain revise or --revise --note for this rule (P38)', () => {
    // The human's block keeps revising again with a note (§4.2.7) …
    expect(argvs(blockOf('plan', handedBack([IN_PLAN])))).toContain('--revise --note <why>')
    // … the arbiter's never holds a plain revise: approve despite the finding, send upstream, park.
    expect(menu('plan', handedBack([IN_PLAN]))).toEqual(['--stop', '--approve --override', '--revise --upstream auth-refresh'])
    expect(menu('plan', handedBack([IN_PARENT]))).toEqual(['--revise --upstream auth-refresh', '--approve --override', '--stop'])
    // A clean run's approve is the plain one; with no parent, park and approve alone.
    expect(menu('plan', handedBack([]))).toEqual(['--stop', '--approve', '--revise --upstream auth-refresh'])
    expect(menu('plan', handedBack([IN_PLAN]), { upstream: null })).toEqual(['--stop', '--approve --override'])
    // Filtered as today otherwise: no approve over a failed check, none at the design gate.
    expect(menu('plan', handedBack([IN_PLAN], { checks: [{ name: 'lint', ok: false, detail: 'x' }] }))).toEqual(['--stop', '--revise --upstream auth-refresh'])
    const design = [run('design', 1, 'a', ['design#save-bar']), decision('design', 'revise', { note: 'x' }), back('design', 'r-1')]
    expect(menu('design', design)).toEqual(['--stop', '--revise --upstream auth-refresh'])
    // A pending stop is the policy's or the arbiter's to revise: the filter is the hand-back's, not every block's.
    expect(menu('plan', [run('plan', 1, 'a', [IN_PLAN])])).toContain('--revise')
  })
})

describe('the arbiter\'s evidence (design §4.2.6, anti-goal 1)', () => {
  it('decisionEvidence carries the hand-back fact and no author narration', async () => {
    const repo = await seededRepo()
    const canon = loadCanon(repo.root)
    // A hand-back entry a hand or a later version wrote with words in it: none of them reaches the arbiter.
    const NARRATION = 'AUTHOR SAYS the reviewer misread step s1'
    const entries = [
      run('plan', 1, 'a', [IN_PLAN]), decision('plan', 'revise', { note: 'make step s1 testable' }),
      back('plan', 'r-1', 'a', { note: NARRATION, reason: NARRATION, why: NARRATION, claim: NARRATION }),
    ]
    const block = blockOf('plan', entries)!
    const sections = decisionEvidence(repo.root, canon, { gate: 'plan', target: 'p1', entries, run: owedRun(entries, 'plan')!, block })
    const history = sections.find((s) => s.title === 'Round history')!.body.split('\n')
    // The fact, in its place in the gate's history: after the revise it answers.
    const revise = history.findIndex((l) => l.startsWith('  - revise · human'))
    expect(revise).toBeGreaterThan(0)
    expect(history[revise + 1]).toBe(`  - handed back · ${HANDED_BACK}`)
    expect(sections.find((s) => s.title === 'The stop')!.body).toContain('rule: revise-returned')
    expect(JSON.stringify(sections)).not.toContain('AUTHOR')
    // A revise not handed back carries no such fact.
    const plain = [run('plan', 1, 'a', [IN_PLAN])]
    expect(JSON.stringify(decisionEvidence(repo.root, canon, { gate: 'plan', target: 'p1', entries: plain, run: owedRun(plain, 'plan')!, block: blockOf('plan', plain)! })))
      .not.toContain('handed back')

    // What the real arbiter reads (the fake harness's stdin): the fact, and an options list with no revise.
    unseat()
    const f = await autonomousHandBack()
    putVerdict(f.scenario, { choice: 1, reason: 'neither the author nor the reviewer names a fix' }, 'arbiter')
    const r = await f.repo.cli(['gate', 'plan', P, '--unchanged'], { env: f.env })
    expect(r.code, r.stderr).toBe(EXIT.FINDINGS)
    const asked = readFileSync(join(callFor(f.scenario, 'arbiter')!, 'stdin'), 'utf8')
    expect(asked).toContain(`  - handed back · ${HANDED_BACK}`)
    expect(asked).toContain(`1. ${cliAct('decide', 'plan', P, '--stop').line}`)
    expect(asked).not.toMatch(/^\d+\. witness decide plan \S+ --revise( --note.*)?$/m)
    expect(decisions(f.repo).at(-1)).toMatchObject({ decision: 'stop', selected: 'arbiter', rule: 'revise-returned', anchor: IN_PLAN })
  }, 180_000)
})

// ---- the real plan gate (the CLI tests) -------------------------------------------------------------

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
const decisions = (repo: TestRepo) =>
  (readStream(repo.root, P).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[]).filter((d) => d.gate === 'plan')
const backs = (repo: TestRepo) => readStream(repo.root, P).filter((e) => e.t === 'revise-returned')
const blockRun = (gate: string, target: string, ...rest: string[]) => `run: ${cliAct('decide', gate, target, ...rest).line}`

// Autonomy on: the plan gate stops on a blocking finding in the plan and the policy revises it at the
// gate's tail (`blocking-here`); the author then judges there is nothing to change.
async function autonomousHandBack(): Promise<{ repo: TestRepo; env: Record<string, string>; scenario: string; run: GateRunEntry }> {
  const repo = await plannedRepo()
  const scenario = fakeScenario()
  putVerdict(scenario, PLAN_BLOCKING)
  const env = gateEnv(scenario)
  await ok(repo, ['gate', 'plan', P], env, EXIT.FINDINGS)
  expect(decisions(repo).at(-1)).toMatchObject({ decision: 'revise', selected: 'policy', rule: 'blocking-here' })
  return { repo, env, scenario, run: lastGateRun(readStream(repo.root, P), 'plan')! }
}

const OTHER = process.ppid                                   // a live pid that is not this process
const holdSettle = (root: string) => {
  mkdirSync(join(root, BUSY_DIR), { recursive: true })
  writeFileSync(join(root, BUSY_DIR, `${P}.settle.json`), JSON.stringify({ pid: OTHER, since: Date.now(), until: Date.now() + 3_600_000 }))
}
const busyFiles = (root: string) => { try { return readdirSync(join(root, BUSY_DIR)) } catch { return [] } }

describe('P47: the moved row spends the ladder', () => {
  it('an upstream taken from the moved row journals its anchor, so ladderSpent counts it (P47)', async () => {
    const repo = await plannedRepo({ autonomy: false })
    const scenario = fakeScenario()
    putVerdict(scenario, BLOCKING_PARENT)
    const env = gateEnv(scenario)
    await ok(repo, ['gate', 'plan', P], env, EXIT.FINDINGS)
    await ok(repo, ['decide', 'plan', P, '--revise', '--note', 'route around the expiry'], env)
    await ok(repo, ['gate', 'plan', P, '--unchanged'], env, EXIT.FINDINGS)
    // The author edits after handing back: the hand-back moved under a verdict nobody re-read.
    expect((await writePlan(repo, P, {}, '## Step: s1\nImplement rotation with TDD, due at 80% of the TTL.\n')).code).toBe(0)
    const show = await ok(repo, ['decide', 'plan', P, '--show'], env)
    expect(show.stdout).toContain(`run: ${cliAct('gate', 'plan', P).line}`)
    expect(show.stdout).toContain(cliAct('decide', 'plan', P, '--revise', '--upstream', S).line)
    expect(ladderSpent(readStream(repo.root, P), 'plan', IN_PARENT)).toBe(false)

    await ok(repo, ['decide', 'plan', P, '--revise', '--upstream', S], env)
    expect(decisions(repo).at(-1)).toMatchObject({ decision: 'revise-upstream', rule: 'stale-below-bound', anchor: IN_PARENT })
    const entries = readStream(repo.root, P)
    expect(ladderSpent(entries, 'plan', IN_PARENT)).toBe(true)
    // So the next hand-back of the same anchor offers no upstream: the park leads (D123).
    const sha = contentSha(repo.root, loadCanon(repo.root), cfgOf(repo), 'plan', P)!
    const again = [
      ...entries,
      { ...lastGateRun(entries, 'plan')!, round: 2, run_id: 'r-again', reviewed_sha: sha } as unknown as Entry,
      { v: 1, t: 'human-decision', gate: 'plan', artifact: P, round: 2, decision: 'revise', note: 'x' } as unknown as Entry,
      { v: 1, t: 'revise-returned', gate: 'plan', artifact: P, run_id: 'r-again', sha } as unknown as Entry,
    ]
    const d = recommend({ gate: 'plan', target: P, entries: again, upstream: S, stale: false })!
    expect(d.rule).toBe('revise-returned')
    expect(d.options[0]!.act?.argv).toEqual(['decide', 'plan', P, '--stop'])
    expect(d.options.some((o) => o.act?.argv.includes('--upstream'))).toBe(false)
  }, 180_000)
})

describe('a manual hand-back (design §4.2.4)', () => {
  it('a manual hand-back goes to the human', async () => {
    unseat()
    const f = await autonomousHandBack()
    const root = f.repo.root
    // The `--manual` hand-back: for that run autonomy is off, so its block is printed for the human.
    const handed = await ok(f.repo, ['gate', 'plan', P, '--unchanged', '--manual'], f.env, EXIT.FINDINGS)
    expect(backs(f.repo)).toEqual([expect.objectContaining({ run_id: f.run.run_id, manual: true })])
    expect(handed.stdout).toContain(blockRun('plan', P, '--stop'))
    const decided = decisions(f.repo).length

    // Every settle that reads it leaves it to the human: next's settle pass …
    const next = await ok(f.repo, ['next'], f.env)
    expect(next.stdout).toContain(`next: ${cliAct('decide', 'plan', P, '--show').line}`)
    // … the settle itself …
    expect(await settleStop(fakeCtx(root, { env: f.env }), root, cfgOf(f.repo), 'plan', P)).toEqual({ kind: 'none' })
    // … and a plain re-gate's tail, whose screen therefore prints the block (gate's leftToTail).
    const regate = await ok(f.repo, ['gate', 'plan', P], f.env, EXIT.FINDINGS)
    expect(regate.stdout).toContain('outcome: revise changed nothing')
    expect(regate.stdout).toContain(blockRun('plan', P, '--stop'))
    expect(callFor(f.scenario, 'arbiter')).toBeUndefined()
    expect(decisions(f.repo)).toHaveLength(decided)
    expect(standingHandBack(readStream(root, P), 'plan')?.manual).toBe(true)
    // The human's screens show it.
    expect(needsYou(root, { env: f.env }, cfgOf(f.repo), loadCanon(root), [])).toContainEqual(
      expect.objectContaining({ kind: 'decision', target: P, gate: 'plan' }))
  }, 180_000)
})

describe('autonomy on: the gate\'s tail settles a hand-back (design §4.2.4, §4.2.6)', () => {
  it('autonomy on: gate --unchanged settles at once under the settle lock; the exit is the settle\'s', async () => {
    const f = await autonomousHandBack()
    const root = f.repo.root
    let locked: string | undefined
    seat(overridesApprove, () => {
      locked = busyFiles(root).includes(`${P}.settle.json`) ? readFileSync(join(root, BUSY_DIR, `${P}.settle.json`), 'utf8') : undefined
    })
    const r = await f.repo.cli(['gate', 'plan', P, '--unchanged'], { env: f.env })
    // The exit is the settle's: an approve is a pass.
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(EXIT.OK)
    expect(backs(f.repo)).toEqual([expect.objectContaining({ run_id: f.run.run_id })])
    expect(decisions(f.repo).at(-1)).toMatchObject({
      decision: 'approve', override: true, selected: 'arbiter', rule: 'revise-returned', anchor: IN_PLAN, round: f.run.round,
    })
    expect(r.stdout).toContain('outcome: handed back')
    expect(r.stdout).toContain(`decided: plan ${P} → approve (override) · arbiter · revise-returned`)
    // The block was the tail's to print, and the tail decided: nothing for a human on this screen.
    expect(r.stdout).not.toContain(blockRun('plan', P, '--stop'))
    // Judged under the settle lock, held by this process and released at the end.
    expect(locked).toBeDefined()
    expect(JSON.parse(locked!).pid).toBe(process.pid)
    expect(busyFiles(root)).toEqual([])
    // The arbiter was asked once, with no revise on its menu and the hand-back in its evidence.
    expect(arbiter.requests).toHaveLength(1)
    expect(arbiter.requests[0]!.menu.map((o) => o.act?.argv.slice(3).join(' '))).toEqual(['--stop', '--approve --override', '--revise --upstream auth-refresh'])
    expect(arbiter.requests[0]!.evidence.find((s) => s.title === 'Round history')!.body).toContain(`  - handed back · ${HANDED_BACK}`)
    expect(standingHandBack(readStream(root, P), 'plan')).toBeUndefined()
    unseat()
  }, 180_000)

  it('a settle lock held elsewhere: the hand-back stands, the exit is busy\'s, and a later re-gate\'s tail settles it', async () => {
    const f = await autonomousHandBack()
    const root = f.repo.root
    seat(stops)
    holdSettle(root)
    const r = await f.repo.cli(['gate', 'plan', P, '--unchanged'], { env: f.env })
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(EXIT.BLOCKED)
    expect(r.stdout).toMatch(new RegExp(`^busy: ${P} — another witness run is deciding plan \\(pid ${OTHER}, since \\d\\d:\\d\\d\\)$`, 'm'))
    expect(backs(f.repo)).toHaveLength(1)
    expect(arbiter.requests).toHaveLength(0)
    expect(owedRun(readStream(root, P), 'plan')?.run_id).toBe(f.run.run_id)

    // The holder is gone: a plain re-gate meets changed-nothing, and its tail settles the hand-back — so
    // its screen prints no block for a human (row 173: the block is the tail's to print).
    rmSync(join(root, BUSY_DIR, `${P}.settle.json`))
    const regate = await f.repo.cli(['gate', 'plan', P], { env: f.env })
    expect(regate.code, `${regate.stdout}\n${regate.stderr}`).toBe(EXIT.FINDINGS)
    expect(regate.stdout).toContain('outcome: revise changed nothing')
    expect(regate.stdout).not.toContain(blockRun('plan', P, '--stop'))
    expect(regate.stdout).toContain(`decided: plan ${P} → stop · arbiter · revise-returned`)
    expect(arbiter.requests).toHaveLength(1)
    unseat()
  }, 180_000)
})

const overridesApprove = (argv: readonly string[]) => argv.includes('--approve') && argv.includes('--override')

describe('a refused arbiter choice on a hand-back (row 240\'s F4, carried from Task 13)', () => {
  // A hand-back, then a malformed round on other content, then the content back on the handed-back
  // sha: the stop reaches the arbiter (the malformed round judged nothing and leads with no re-run,
  // S3-3). The gate's last run is the malformed one, the owed run is the one handed back.
  it('a refused arbiter choice parks once, never a silent moved that pays the arbiter again at every next', async () => {
    const repo = await plannedRepo()
    const root = repo.root
    const sha = contentSha(root, loadCanon(root), cfgOf(repo), 'plan', P)!
    const stopped = {
      v: 1, t: 'gate-run', gate: 'plan', artifact: P, round: 1, run_id: 'r-1', reviewed_sha: sha,
      prompts_sha: 'p', witness: '0', model: 'm', outcome: 'stopped', checks: [],
      verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [{ blocking: true, anchor: IN_PLAN, claim: 'x' }] }],
    }
    appendEntry(root, P, stopped as never)
    appendEntry(root, P, { v: 1, t: 'human-decision', gate: 'plan', artifact: P, round: 1, decision: 'revise', note: 'make s1 testable' } as never)
    appendEntry(root, P, { v: 1, t: 'revise-returned', gate: 'plan', artifact: P, run_id: 'r-1', sha } as never)
    appendEntry(root, P, { ...stopped, round: 2, run_id: 'r-2', reviewed_sha: 'other-content-sha', outcome: 'malformed', verdicts: [],
      malformed: [{ reviewer: 'plan-critic', violations: [] }] } as never)
    expect(owedRun(readStream(root, P), 'plan')?.run_id).toBe('r-1')
    expect(lastGateRun(readStream(root, P), 'plan')?.run_id).toBe('r-2')

    // The arbiter sends it upstream; while it judges, the parent spec goes, so the door refuses the
    // upstream (`unknown-artifact`, exit 2) — a refusal no re-read cures.
    const parent = findById(loadCanon(root), S)!
    seat(upstreams, () => { rmSync(join(root, parent.rel)); repo.git('add', '-A', parent.rel); repo.git('commit', '-qm', 'the parent goes') })
    const errs: string[] = []
    const s = await settleStop(fakeCtx(root, { err: (l) => errs.push(l) }), root, cfgOf(repo), 'plan', P)
    expect(errs.join('\n')).toContain('unknown-artifact')
    expect(s).toEqual({ kind: 'decided', by: 'policy', decision: 'stop', rule: 'revise-returned' })
    expect(decisions(repo).at(-1)).toMatchObject({ decision: 'stop', selected: 'policy' })
    expect(decisions(repo).at(-1)!.note).toContain('the arbiter\'s choice was refused (unknown-artifact)')
    // Parked once: the next settle has nothing owed and asks no model.
    expect(await settleStop(fakeCtx(root), root, cfgOf(repo), 'plan', P)).toEqual({ kind: 'none' })
    expect(arbiter.requests).toHaveLength(1)
    unseat()
  }, 120_000)
})

// ---- §4.2.1's state walk, the arbiter's half -------------------------------------------------------
// decide-live walks every act a screen offers as a human; this walks every act on each state's arbiter
// menu as `selected: 'arbiter'`, through the one door, as settle takes it (row 240's run and token).
// The same real decompose gate and journals: each round carries the real gate's key and checks.

const G = 'decompose'
const MOVED = 'moved-content-sha'
const OTHER_SHA = 'other-content-sha'
const ANCHOR = 'auth-refresh > ## Behavior'
const VERDICT = {
  coverage: [{ anchor: ANCHOR, note: 'read' }],
  findings: [{ blocking: true, anchor: ANCHOR, claim: 'expiry unbounded' }],
}
const ARB = { selected: 'arbiter', reason: 'the bound is spent', arbiter: { model: 'm', prompts_sha: 'p' } }
const REOPEN = { caused_by: { artifact: 'auth-refresh', gate: 'design', round: 1 }, note: 'the slicing is wrong' }

let base: { repo: TestRepo; sha: string; effort: string; real: GateRunEntry }
const copyOf = (root: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'witness-arbiter-walk-')))
  cpSync(root, dir, { recursive: true })
  return dir
}
const walkRun = (n: number, sha: string, outcome: Outcome = 'stopped'): Entry => {
  const { reviewed_tree: _t, basis_sha: _b, delta: _d, carried: _c, standing, verdicts: _v, malformed: _m, ...key } = base.real
  return {
    ...key, ...(outcome !== 'passed' && standing !== undefined ? { standing } : {}),
    round: n, run_id: `r${n}`, reviewed_sha: sha,
    ...(outcome === 'malformed'
      ? { verdicts: [], malformed: [{ reviewer: 'slicing-critic', violations: [] }] }
      : { verdicts: [{ reviewer: 'slicing-critic', coverage: VERDICT.coverage, findings: outcome === 'stopped' ? VERDICT.findings : [] }] }),
    outcome,
  } as unknown as Entry
}
const dec = (d: string, extra: Record<string, unknown> = {}): Entry =>
  ({ v: 1, t: 'human-decision', gate: G, artifact: base.effort, round: 1, decision: d, ...extra } as unknown as Entry)
const handBack = (runId: string, sha: string): Entry =>
  ({ v: 1, t: 'revise-returned', gate: G, artifact: base.effort, run_id: runId, sha } as unknown as Entry)
const bound = (s: string): Entry[] => [walkRun(1, s), dec('revise'), walkRun(2, s), dec('revise'), walkRun(3, s)]

// Design §4.2.1's states, as decide-live walks them: the journal (given the content's sha), the state
// liveActs reads, and whether the content moved since the run it judges.
const STATES: Array<[string, (s: string) => Entry[], GateStateKind, boolean]> = [
  ['pending', (s) => [walkRun(1, s)], 'pending', false],
  ['stale', () => [walkRun(1, MOVED)], 'pending', true],
  ['revised', (s) => [walkRun(1, s), dec('revise', { note: 'tighten the slicing' })], 'revised', false],
  ['revised after a stop', (s) => [walkRun(1, s), dec('stop', ARB), dec('revise', { note: 'try again' })], 'revised', false],
  ['revised after a malformed round', (s) => [walkRun(1, s), walkRun(2, s, 'malformed'), dec('revise')], 'revised', false],
  ['revised after a malformed round on moved content', (s) => [walkRun(1, MOVED), walkRun(2, s, 'malformed'), dec('revise')], 'revised', true],
  ['revised with a malformed round after the revise', (s) => [walkRun(1, s), dec('revise'), walkRun(2, s, 'malformed')], 'revised', false],
  ['repair-revised', (s) => [...bound(s), dec('stop', { ...ARB, rule: 'bound' }), dec('revise', { repair: true, selected: 'affirmation', rule: 'bound' })], 'revised', false],
  ['reopened after an approve', (s) => [walkRun(1, s), dec('approve', { override: true }), dec('revise', REOPEN)], 'revised', false],
  ['parked', (s) => [walkRun(1, s), dec('stop')], 'parked', false],
  ['parked at the bound', (s) => [...bound(s), dec('stop', ARB)], 'parked', false],
  ['parked at the bound, then reopened', (s) => [...bound(s), dec('stop', ARB), dec('revise', REOPEN)], 'at-bound', false],
  ['settled by an approve', (s) => [walkRun(1, s), dec('approve', { override: true })], 'settled', false],
  ['settled by a pass', (s) => [walkRun(1, s, 'passed')], 'settled', false],
  ['at the bound', bound, 'at-bound', false],
  ['handed back', (s) => [walkRun(1, s), dec('revise'), handBack('r1', s)], 'handed-back', false],
  ['handed back, content moved since', () => [walkRun(1, MOVED), dec('revise'), handBack('r1', MOVED)], 'handed-back-moved', true],
  ['handed back, then decided', (s) => [walkRun(1, s), dec('revise'), handBack('r1', s), dec('approve', { override: true })], 'settled', false],
  ['handed back, then --fresh', (s) => [walkRun(1, s), dec('revise'), handBack('r1', s), walkRun(2, s)], 'pending', false],
  ['handed back, then revised again', (s) => [walkRun(1, s), dec('revise'), handBack('r1', s), dec('revise', { note: 'change the expiry' })], 'revised', false],
  ['retracted', (s) => [walkRun(1, s), dec('approve', { override: true }), dec('revise', { note: 'the stamp was wrong' })], 'retracted', false],
  ['malformed on other content after the revise (S3-3)', (s) => [walkRun(1, s), dec('revise', { note: 'tighten the slicing' }), walkRun(2, OTHER_SHA, 'malformed')], 'revised', false],
  ['handed back, then malformed on other content (S3-3)', (s) => [walkRun(1, s), dec('revise'), handBack('r1', s), walkRun(2, OTHER_SHA, 'malformed')], 'handed-back', false],
  ['retracted, then malformed on other content (S3-3)', (s) => [walkRun(1, s, 'passed'), dec('revise', { note: 'the pass was wrong' }), walkRun(2, OTHER_SHA, 'malformed')], 'retracted', false],
]
const STATE = new Map(STATES.map(([name, journal, kind, stale]) => [name, { journal, kind, stale }]))
// Where the policy hands the state's stop to the arbiter: the bound, and a standing hand-back.
const REACHES_ARBITER = ['parked at the bound, then reopened', 'at the bound', 'handed back', 'handed back, then malformed on other content (S3-3)']

const built = new Map<string, string>()
function stateRoot(name: string): string {
  const cached = built.get(name)
  if (cached !== undefined) return cached
  const root = copyOf(base.repo.root)
  for (const e of STATE.get(name)!.journal(base.sha)) appendEntry(root, base.effort, e as unknown as { t: 'gate-run' })
  base.repo.git('-C', root, 'add', '.witness/journal')
  base.repo.git('-C', root, 'commit', '-qm', `walk: ${name}`, '-m', 'Witness-State: 1')
  built.set(name, root)
  return root
}
const factsOf = (name: string): ActFacts =>
  ({ upstream: base.effort, stale: STATE.get(name)!.stale, holdLifted: false, owed: false, upstreamOwed: false })

// The state's arbiter menu, as settle builds it: recommend's block for the state, filtered by menuFor
// against the run a decision disposes of (the owed run where one is owed).
function arbiterMenu(name: string): { menu: Array<{ act: Act }>; reaches: boolean; anchor?: GateRunEntry } {
  const entries = readStream(stateRoot(name), base.effort)
  const live = liveActs(G, base.effort, entries, factsOf(name))
  const block = recommend({ gate: G, target: base.effort, entries, upstream: base.effort, stale: STATE.get(name)!.stale })
  const owed = owedRun(entries, G)
  const anchor = owed ?? live.anchor
  const menu = block !== undefined && anchor !== undefined ? menuFor(block, anchor) : []
  const reaches = block !== undefined && owed !== undefined &&
    policyFor({ at: 'gate', gate: G, target: base.effort, entries, run: owed, block, untrusted: [] }).kind === 'arbiter'
  return { menu, reaches, ...(anchor !== undefined ? { anchor } : {}) }
}

describe('every act on the arbiter\'s menu lands (design §4.2.1, the arbiter\'s half)', () => {
  beforeAll(async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const scenario = fakeScenario()
    putVerdict(scenario, VERDICT)
    const sha = effortReviewedSha(repo.root, loadCanon(repo.root), repo.effort).sha
    // One round of the real gate, in a copy: the key every round of the walk carries.
    const ran = copyOf(repo.root)
    const g = await repo.cli(['gate', G, repo.effort], { cwd: ran, env: gateEnv(scenario) })
    if (g.code !== 1) throw new Error(`gate: ${g.stdout}\n${g.stderr}`)
    const real = lastGateRun(readStream(ran, repo.effort), G)!
    if (real.reviewed_sha !== sha) throw new Error(`the real round judged ${real.reviewed_sha}, not ${sha}`)
    base = { repo, sha, effort: repo.effort, real }
  }, 120_000)

  it.each(STATES.map(([name]) => name))('%s: every act on the arbiter\'s menu lands as selected: arbiter (§4.2.1\'s state walk)', async (name) => {
    const { menu, reaches, anchor } = arbiterMenu(name)
    expect(liveActs(G, base.effort, readStream(stateRoot(name), base.effort), factsOf(name)).state).toBe(STATE.get(name)!.kind)
    if (reaches) expect(menu.length).toBeGreaterThan(0)
    // A revise again is the human's in these states (§4.2.7): never on the arbiter's menu (§4.2.6).
    if (['revised', 'handed-back', 'handed-back-moved', 'retracted', 'settled'].includes(STATE.get(name)!.kind)) {
      expect(menu.filter((o) => isPlainRevise(o.act.argv)).map((o) => o.act.argv.join(' '))).toEqual([])
    }
    const refused: string[] = []
    for (const { act } of menu) {
      const root = copyOf(stateRoot(name))
      const entries = readStream(root, base.effort)
      // The one slot the arbiter may fill is the note, as settle fills it through argv.
      const argv = act.argv.map((w, at) => (act.inputs.some((i) => i.at === at && i.name === 'why') ? 'the arbiter names a reason' : w))
      const parsed = decisionAct([...argv.slice(1)])
      if (!parsed.ok) { refused.push(`${argv.join(' ')} → unparsed ${JSON.stringify(parsed.violations)}`); continue }
      const errs: string[] = []
      const before = (readStream(root, base.effort).filter((e) => e.t === 'human-decision')).length
      const code = await applyDecision(fakeCtx(root, { err: (l) => errs.push(l) }), {
        ...parsed.value, selected: 'arbiter', reason: 'the walk', arbiter: { model: 'm', prompts_sha: 'p' },
        runId: anchor!.run_id, token: settledToken(entries, G, anchor!.run_id),
      })
      const after = readStream(root, base.effort).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[]
      if (code !== 0 || after.length !== before + 1 || after.at(-1)!.selected !== 'arbiter') {
        refused.push(`${argv.join(' ')} → exit ${code}\n${errs.join('\n')}`)
      }
    }
    expect(refused).toEqual([])
  }, 300_000)

  it('the walk reaches the arbiter exactly where the bound and a standing hand-back send it', () => {
    expect(STATES.map(([name]) => name).filter((name) => arbiterMenu(name).reaches)).toEqual(REACHES_ARBITER)
    // The handed-back states' menus: park, approve despite the finding, send upstream — no revise.
    for (const name of ['handed back', 'handed back, then malformed on other content (S3-3)']) {
      expect(arbiterMenu(name).menu.map((o) => actKey(o.act)).sort()).toEqual([
        actKey(['decide', G, base.effort, '--stop']),
        actKey(['decide', G, base.effort, '--approve', '--override']),
        actKey(['decide', G, base.effort, '--revise', '--upstream', base.effort]),
      ].sort())
    }
  })
})
