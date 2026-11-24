import { cpSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Act } from '../src/act.js'
import { loadConfig } from '../src/config.js'
import { decideView } from '../src/decide-view.js'
import { designCurrentSha } from '../src/design.js'
import { appendEntry, readStream, type Entry } from '../src/journal.js'
import { effortReviewedSha } from '../src/reviewed.js'
import { AFTER_EDIT } from '../src/recommend.js'
import {
  actKey, lastGateRun, liveActs, settledToken, type ActFacts, type DecisionEntry, type GateRunEntry, type GateStateKind,
} from '../src/rounds.js'
import { loadCanon } from '../src/scan.js'
import { applyDecision } from '../src/verbs/decide.js'
import { actFacts } from '../src/verbs/next.js'
import { fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, writeSpec, type CliResult, type TestRepo } from './helpers.js'

// Row 244 (#87, design §4.2.1 "What stays in decide", §4.2.3's retraction, §4.2.7, §4.2.9). `decide`
// accepts exactly the acts `liveActs` offers: every act a state offers lands, an act it does not offer
// refuses with the rule that says why, and revising again or retracting takes a human and a note.
// The walk runs on the real decompose gate, whose upstream is the effort itself and whose endgame
// abandons it, with each state's journal written into a seeded effort stream. Every round in it is
// the real gate's round, its key and checks, so a re-gate of unchanged content meets it as it meets a
// human's: resumed, repaired, or answered changed-nothing — which journals nothing and lands nothing.

const G = 'decompose'
const MOVED = 'moved-content-sha'
const OTHER = 'other-content-sha'
const ANCHOR = 'auth-refresh > ## Behavior'
const VERDICT = {
  coverage: [{ anchor: ANCHOR, note: 'read' }],
  findings: [{ blocking: true, anchor: ANCHOR, claim: 'expiry unbounded' }],
}
const ARBITER = { selected: 'arbiter', reason: 'the bound is spent', arbiter: { model: 'm', prompts_sha: 'p' } }
const REOPEN = { caused_by: { artifact: 'auth-refresh', gate: 'design', round: 1 }, note: 'the slicing is wrong' }

let base: { repo: TestRepo; sha: string; scenario: string; effort: string; real: GateRunEntry }
beforeAll(async () => {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  const scenario = fakeScenario()
  putVerdict(scenario, VERDICT)
  const sha = effortReviewedSha(repo.root, loadCanon(repo.root), repo.effort).sha
  // One round of the real gate, in a copy: the key every round of the walk carries (S2-C). A made-up
  // key never meets the gate's, so every re-gate ran a fresh round and counted as landed.
  const ran = copyOf(repo.root)
  const g = await repo.cli(['gate', G, repo.effort], { cwd: ran, env: gateEnv(scenario) })
  if (g.code !== 1) throw new Error(`gate: ${g.stdout}\n${g.stderr}`)
  const real = lastGateRun(readStream(ran, repo.effort), G)!
  if (real.reviewed_sha !== sha) throw new Error(`the real round judged ${real.reviewed_sha}, not ${sha}`)
  base = { repo, sha, scenario, effort: repo.effort, real }
}, 120_000)

type Outcome = 'passed' | 'stopped' | 'malformed'
// A round as the real gate journals it, on content `sha`: the real round's key and checks, never its
// tree, basis or delta (a round of the walk is no delta base). A pass carries no standing stop.
const run = (n: number, sha: string, outcome: Outcome = 'stopped'): Entry => {
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
const dec = (decision: string, extra: Record<string, unknown> = {}): Entry =>
  ({ v: 1, t: 'human-decision', gate: G, artifact: base.effort, round: 1, decision, ...extra } as unknown as Entry)
const back = (runId: string, sha: string): Entry =>
  ({ v: 1, t: 'revise-returned', gate: G, artifact: base.effort, run_id: runId, sha } as unknown as Entry)
const bound = (s: string): Entry[] => [run(1, s), dec('revise'), run(2, s), dec('revise'), run(3, s)]

// Design §4.2.1's state walk. Each row: the journal (given the content's current sha), the state
// liveActs reads, and whether the content moved since the run it judges.
const STATES: Array<[string, (s: string) => Entry[], GateStateKind, boolean]> = [
  ['pending', (s) => [run(1, s)], 'pending', false],
  ['stale', () => [run(1, MOVED)], 'pending', true],
  ['revised', (s) => [run(1, s), dec('revise', { note: 'tighten the slicing' })], 'revised', false],
  ['revised after a stop', (s) => [run(1, s), dec('stop', ARBITER), dec('revise', { note: 'try again' })], 'revised', false],
  ['revised after a malformed round', (s) => [run(1, s), run(2, s, 'malformed'), dec('revise')], 'revised', false],
  ['revised after a malformed round on moved content', (s) => [run(1, MOVED), run(2, s, 'malformed'), dec('revise')], 'revised', true],
  ['revised with a malformed round after the revise', (s) => [run(1, s), dec('revise'), run(2, s, 'malformed')], 'revised', false],
  // #87's journal: the bound, the arbiter's stop, a human's repair, the content unchanged.
  ['repair-revised', (s) => [...bound(s), dec('stop', { ...ARBITER, rule: 'bound' }), dec('revise', { repair: true, selected: 'affirmation', rule: 'bound' })], 'revised', false],
  ['reopened after an approve', (s) => [run(1, s), dec('approve', { override: true }), dec('revise', REOPEN)], 'revised', false],
  ['parked', (s) => [run(1, s), dec('stop')], 'parked', false],
  ['parked at the bound', (s) => [...bound(s), dec('stop', ARBITER)], 'parked', false],
  ['parked at the bound, then reopened', (s) => [...bound(s), dec('stop', ARBITER), dec('revise', REOPEN)], 'at-bound', false],
  ['settled by an approve', (s) => [run(1, s), dec('approve', { override: true })], 'settled', false],
  ['settled by a pass', (s) => [run(1, s, 'passed')], 'settled', false],
  ['at the bound', bound, 'at-bound', false],
  ['handed back', (s) => [run(1, s), dec('revise'), back('r1', s)], 'handed-back', false],
  ['handed back, content moved since', () => [run(1, MOVED), dec('revise'), back('r1', MOVED)], 'handed-back-moved', true],
  ['handed back, then decided', (s) => [run(1, s), dec('revise'), back('r1', s), dec('approve', { override: true })], 'settled', false],
  ['handed back, then --fresh', (s) => [run(1, s), dec('revise'), back('r1', s), run(2, s)], 'pending', false],
  ['handed back, then revised again', (s) => [run(1, s), dec('revise'), back('r1', s), dec('revise', { note: 'change the expiry' })], 'revised', false],
  ['retracted', (s) => [run(1, s), dec('approve', { override: true }), dec('revise', { note: 'the stamp was wrong' })], 'retracted', false],
  // S3-3: a malformed round after the revise on other content, the content back on the disposed run's.
  // It leaves the pairing with the disposed run, so a re-gate answers changed-nothing: no state leads
  // with a re-run there.
  ['malformed on other content after the revise (S3-3)', (s) => [run(1, s), dec('revise', { note: 'tighten the slicing' }), run(2, OTHER, 'malformed')], 'revised', false],
  ['handed back, then malformed on other content (S3-3)', (s) => [run(1, s), dec('revise'), back('r1', s), run(2, OTHER, 'malformed')], 'handed-back', false],
  ['retracted, then malformed on other content (S3-3)', (s) => [run(1, s, 'passed'), dec('revise', { note: 'the pass was wrong' }), run(2, OTHER, 'malformed')], 'retracted', false],
]
const STATE = new Map(STATES.map(([name, journal, kind, stale]) => [name, { journal, kind, stale }]))

// A copy of a repo in a directory of its own: every act runs on the state as the walk wrote it.
function copyOf(root: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'witness-live-')))
  cpSync(root, dir, { recursive: true })
  return dir
}
const built = new Map<string, string>()
// The state's repo: the seeded effort with the state's journal appended and committed.
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
  ({ upstream: base.effort, stale: STATE.get(name)!.stale, holdLifted: false, owed: false, upstreamOwed: false, checksMoved: false })
// What the state offers: liveActs over the journal as decide reads it.
const liveOf = (name: string) => liveActs(G, base.effort, readStream(stateRoot(name), base.effort), factsOf(name))

const cli = (root: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> =>
  base.repo.cli(args, { cwd: root, env: { ...gateEnv(base.scenario), ...env } })
const decide = (root: string, ...rest: string[]) => cli(root, ['decide', G, base.effort, ...rest])
const decisions = (root: string) =>
  readStream(root, base.effort).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[]

// The act with its slots filled, as a human fills them: a note, and the upstream named.
const filled = (act: Act): string[] => act.argv.map((w, at) => {
  const input = act.inputs.find((i) => i.at === at)
  return input === undefined ? w : input.name === 'why' ? 'the walk names a reason' : base.effort
})

// Run one act on a fresh copy of the state. A decide lands when it journals its decision, a gate when
// it journals a round (changed-nothing journals none and lands nothing), anything else on exit 0.
async function tryAct(name: string, act: Act): Promise<{ landed: boolean; argv: string[]; r: CliResult }> {
  const root = copyOf(stateRoot(name))
  const argv = filled(act)
  const count = (t: string) => readStream(root, base.effort).filter((e) => e.t === t).length
  const runs = count('gate-run')
  const decided = count('human-decision')
  const r = await cli(root, argv)
  const landed = argv[0] === 'gate' ? r.code <= 1 && count('gate-run') === runs + 1
    : argv[0] === 'decide' ? r.code === 0 && count('human-decision') === decided + 1
    : r.code === 0
  return { landed, argv, r }
}
// The first refusal row's rule, and the refusal as it reads: a TOON cell doubles each quote it holds.
const ruleOf = (stderr: string): string | undefined => /^\s+[^,\s]+,([a-z-]+),/m.exec(stderr)?.[1]
const unquoted = (stderr: string): string => stderr.replaceAll('""', '"')

describe('decide accepts every act a state offers (design §4.2.1, #87)', () => {
  // Every slot filled, no state's screen states a refusal of its own acts: each one lands.
  it.each(STATES.map(([name]) => name))('%s: every offered act lands (human)', async (name) => {
    const live = liveOf(name)
    expect(live.state).toBe(STATE.get(name)!.kind)
    expect(live.acts.length).toBeGreaterThan(0)
    const refused: string[] = []
    for (const act of live.acts) {
      const t = await tryAct(name, act)
      if (!t.landed) refused.push(`${t.argv.join(' ')} → exit ${t.r.code} ${ruleOf(t.r.stderr) ?? ''}\n${t.r.stderr}`)
    }
    expect(refused).toEqual([])
  }, 300_000)

  // P3 inverted. #87's own screen listed four acts and every one refused nothing-pending.
  it('#87\'s journal: every act --show lists lands (P3 inverted)', async () => {
    const root = stateRoot('repair-revised')
    const cfg = loadConfig(root)
    if (!cfg.ok) throw new Error('config')
    const view = decideView(root, cfg.value, loadCanon(root), G, base.effort)
    if (view.state !== 'actionable') throw new Error(`state ${view.state}`)
    // The one exemption (design §4.2.1): the revised state's re-gate "after you change the work" is
    // conditional, since on unchanged content the gate answers changed-nothing.
    const conditional = (o: { when?: string; act?: Act }) =>
      o.when === AFTER_EDIT && o.act !== undefined && actKey(o.act) === actKey(['gate', G, base.effort])
    expect((view.block?.options ?? []).filter(conditional)).toHaveLength(1)
    const shown = [...(view.block?.options ?? []).filter((o) => !conditional(o)).flatMap((o) => (o.act ? [o.act] : [])), ...view.exits]
    const acts = shown.filter((a, i) => shown.findIndex((b) => b.line === a.line) === i)
    expect(acts.length).toBeGreaterThanOrEqual(4)
    for (const act of acts) {
      const t = await tryAct('repair-revised', act)
      // A bare revise in the revised state asks for its note (§4.2.7): never nothing-pending, and with
      // the note it lands.
      if (actKey(act) === actKey(['decide', G, base.effort, '--revise']) && !act.argv.includes('--note')) {
        expect(t.r.code, t.r.stderr).toBe(2)
        expect(ruleOf(t.r.stderr)).toBe('note-required')
        const noted = await tryAct('repair-revised', { ...act, argv: [...act.argv, '--note', 'bound the expiry'] })
        expect(noted.landed, noted.r.stderr).toBe(true)
        continue
      }
      expect(t.landed, `${t.argv.join(' ')} → ${t.r.stderr}`).toBe(true)
    }
  }, 300_000)

  // P24. A reopen by another gate's upstream revise is a revise of any kind, so approve and stop stay
  // reachable on the content the approve judged, in either approve spelling (D122).
  it('after an approve and a reopen, the offered approve and stop land (P24)', async () => {
    for (const rest of [['--approve', '--override'], ['--approve'], ['--stop']]) {
      const root = copyOf(stateRoot('reopened after an approve'))
      const r = await decide(root, ...rest)
      expect(r.code, `${rest.join(' ')}: ${r.stderr}`).toBe(0)
      expect(decisions(root).at(-1)).toMatchObject({ decision: rest[0]!.slice(2), round: 1 })
    }
  }, 120_000)

  // P8, P23. The retraction anchors on the last run and un-settles the gate, after an approve or a pass.
  // (`gate --fresh` re-judging after it is Task 11's.)
  it('a gate settled by a pass or an approve: the retraction lands and un-settles it (P8, P23)', async () => {
    for (const name of ['settled by a pass', 'settled by an approve']) {
      const root = copyOf(stateRoot(name))
      const r = await decide(root, '--revise', '--note', 'the verdict missed the expiry')
      expect(r.code, `${name}: ${r.stderr}`).toBe(0)
      expect(decisions(root).at(-1)).toMatchObject({ decision: 'revise', note: 'the verdict missed the expiry', round: 1 })
      expect(r.stdout).toContain('revise-context:')
      const after = liveActs(G, base.effort, readStream(root, base.effort), factsOf(name))
      expect(after.state).toBe('retracted')
      expect(after.anchor?.run_id).toBe('r1')
    }
  }, 120_000)
})

describe('revising again takes a note and a human (design §4.2.7)', () => {
  it.each(['revised', 'handed back', 'settled by a pass', 'retracted'])('a bare --revise in the %s state refuses note-required', async (name) => {
    const root = copyOf(stateRoot(name))
    const before = decisions(root).length
    for (const rest of [['--revise'], ['--revise', '--note', '   ']]) {
      const r = await decide(root, ...rest)
      expect(r.code, r.stderr).toBe(2)
      expect(ruleOf(r.stderr)).toBe('note-required')
      expect(unquoted(r.stderr)).toContain(`witness decide ${G} ${base.effort} --revise --note "<why>"`)
    }
    expect(decisions(root)).toHaveLength(before)
  }, 120_000)

  it('revise again with a note refuses revise-human for policy, arbiter and a drive child', async () => {
    for (const name of ['revised', 'handed back', 'settled by a pass', 'retracted']) {
      const root = copyOf(stateRoot(name))
      const before = decisions(root).length
      for (const selected of ['policy', 'arbiter'] as const) {
        const errs: string[] = []
        const code = await applyDecision(fakeCtx(root, { err: (l) => errs.push(l) }), {
          gate: G, target: base.effort, decision: 'revise', note: 'change the expiry', selected,
          ...(selected === 'arbiter' ? { reason: 'r', arbiter: { model: 'm', prompts_sha: 'p' } } : {}),
        } as never)
        expect(code, `${name} · ${selected}`).toBe(2)
        expect(ruleOf(errs.join('\n')), `${name} · ${selected}`).toBe('revise-human')
      }
      const child = await cli(root, ['decide', G, base.effort, '--revise', '--note', 'change the expiry'], { WITNESS_DRIVE: base.effort })
      expect(child.code, `${name} · drive child`).toBe(2)
      expect(ruleOf(child.stderr), `${name} · drive child`).toBe('revise-human')
      expect(unquoted(child.stderr)).toContain(`witness decide ${G} ${base.effort} --revise --note "<why>"`)
      expect(decisions(root), name).toHaveLength(before)
    }
  }, 180_000)

  it('the human\'s revise again carries its note to the session and ends a standing hand-back', async () => {
    const root = copyOf(stateRoot('handed back'))
    const r = await decide(root, '--revise', '--note', 'change the expiry to 15m')
    expect(r.code, r.stderr).toBe(0)
    expect(decisions(root).at(-1)).toMatchObject({ decision: 'revise', note: 'change the expiry to 15m' })
    expect(r.stdout).toContain('note: change the expiry to 15m')
    expect(liveActs(G, base.effort, readStream(root, base.effort), factsOf('handed back')).state).toBe('revised')
  }, 120_000)

  it('the policy still revises a pending stop, and a bare revise there journals the prefill (row 239)', async () => {
    const root = copyOf(stateRoot('pending'))
    expect(await applyDecision(fakeCtx(root), { gate: G, target: base.effort, decision: 'revise', selected: 'policy' })).toBe(0)
    expect(decisions(root).at(-1)).toMatchObject({ decision: 'revise', selected: 'policy', note: `1 blocking finding: ${ANCHOR}` })
  }, 120_000)
})

describe('an act no state offers refuses with the rule that says why (design §4.2.9)', () => {
  it('a second repair in a window is not offered and refuses repair-spent', async () => {
    const journal = (s: string) => [...bound(s), dec('revise', { repair: true }), run(4, s)]
    const root = copyOf(base.repo.root)
    for (const e of journal(base.sha)) appendEntry(root, base.effort, e as unknown as { t: 'gate-run' })
    const live = liveActs(G, base.effort, readStream(root, base.effort), { ...factsOf('pending') })
    expect(live.state).toBe('at-bound')
    expect(live.acts.some((a) => actKey(a) === actKey(['decide', G, base.effort, '--revise', '--repair']))).toBe(false)
    const r = await decide(root, '--revise', '--repair')
    expect(r.code).toBe(2)
    expect(ruleOf(r.stderr)).toBe('repair-spent')
    expect(r.stderr).not.toContain('--repair |')
  }, 120_000)

  it('an approve the screens withhold names the blocker: moved content, the bound without --override', async () => {
    const cases: Array<[string, string[], string]> = [
      ['revised after a malformed round on moved content', ['--approve'], 'stale-verdict'],
      ['handed back, content moved since', ['--approve', '--override'], 'stale-verdict'],
      ['stale', ['--approve'], 'stale-verdict'],
      ['at the bound', ['--approve'], 'override-required'],
      ['parked at the bound, then reopened', ['--approve'], 'override-required'],
    ]
    for (const [name, rest, rule] of cases) {
      const root = copyOf(stateRoot(name))
      const r = await decide(root, ...rest)
      expect(r.code, `${name}: ${r.stderr}`).toBe(2)
      expect(r.stderr, name).toContain(`,${rule},`)
      expect(r.stderr, name).not.toContain('nothing-pending')
    }
  }, 120_000)

  // A lifted hold reads like moved content (design §4.2.9): the revised state offers only the re-gate,
  // and the approve names its blocker. The design gate's criteria are its spec's, which holds none now.
  it('a hold lifted since the revised run withholds the approve, naming hold-lifted', async () => {
    const root = copyOf(base.repo.root)
    const cfg = loadConfig(root)
    if (!cfg.ok) throw new Error('config')
    const spec = loadCanon(root).docs.find((d) => d.meta.id === 'auth-refresh')!
    appendEntry(root, 'auth-refresh', {
      v: 1, t: 'gate-run', gate: 'design', artifact: 'auth-refresh', round: 1, run_id: 'd1',
      reviewed_sha: designCurrentSha(root, cfg.value.paths, spec), prompts_sha: 'p', witness: '0', model: 'm',
      checks: [{ name: 'drift', ok: true, held: [{ criterion: 'ac-rotate', need: 'prod', satisfy: '' }] }],
      verdicts: [{ reviewer: 'design-reviewer', coverage: [], findings: VERDICT.findings }], outcome: 'stopped',
    })
    appendEntry(root, 'auth-refresh', { v: 1, t: 'human-decision', gate: 'design', artifact: 'auth-refresh', round: 1, decision: 'revise', note: 'x' })
    const r = await cli(root, ['decide', 'design', 'auth-refresh', '--approve', '--override'])
    expect(r.code, r.stderr).toBe(2)
    expect(r.stderr).toContain(',hold-lifted,')
    expect(r.stderr).not.toContain('stale-verdict')
    expect(r.stderr).not.toContain('nothing-pending')
  }, 120_000)

  it('in the settled, parked and none states an act not offered is nothing-pending, naming what is live', async () => {
    const cases: Array<[string, string[], string]> = [
      ['settled by an approve', ['--approve'], `witness decide ${G} ${base.effort} --revise --note "<why>"`],
      ['settled by a pass', ['--stop'], `witness decide ${G} ${base.effort} --revise --note "<why>"`],
      ['parked', ['--approve'], `witness decide ${G} ${base.effort} --revise --note "<why>" | witness gate ${G} ${base.effort} --fresh`],
      ['parked', ['--revise', '--upstream', 'x'], `witness gate ${G} ${base.effort} --fresh`],
    ]
    for (const [name, rest, want] of cases) {
      const root = copyOf(stateRoot(name))
      const r = await decide(root, ...rest)
      expect(r.code, `${name}: ${r.stderr}`).toBe(2)
      expect(ruleOf(r.stderr), name).toBe('nothing-pending')
      expect(unquoted(r.stderr), name).toContain(want)
    }
    // settled on moved content: the approval lapsed, and the re-gate is the one live act (D75)
    const moved = copyOf(base.repo.root)
    for (const e of [run(1, MOVED), dec('approve', { override: true })]) appendEntry(moved, base.effort, e as unknown as { t: 'gate-run' })
    const r = await decide(moved, '--revise', '--note', 'retract')
    expect(ruleOf(r.stderr)).toBe('nothing-pending')
    expect(r.stderr).toContain(`witness gate ${G} ${base.effort}`)
    // an abandoned effort: nothing is live
    const gone = copyOf(stateRoot('pending'))
    appendEntry(gone, base.effort, { v: 1, t: 'human-decision', gate: 'effort', artifact: base.effort, round: 0, decision: 'abandon-effort' })
    const a = await decide(gone, '--approve')
    expect(ruleOf(a.stderr)).toBe('nothing-pending')
  }, 120_000)

  // Row 183, kept: a cap park disposes of the flow, so it parks on the run drive names (`caps.ts`: the
  // gate's last run, a malformed one included), whatever is live.
  it('a cap park keeps its own anchor: the gate\'s last run, live stop or not (row 183)', async () => {
    for (const [name, runId] of [['revised with a malformed round after the revise', 'r2'], ['revised after a malformed round on moved content', 'r2'], ['settled by an approve', 'r1']]) {
      const root = copyOf(stateRoot(name!))
      const errs: string[] = []
      const entries = readStream(root, base.effort)
      const code = await applyDecision(fakeCtx(root, { err: (l) => errs.push(l) }), {
        gate: G, target: base.effort, decision: 'stop', note: 'drive cap', selected: 'policy', rule: 'cap-rounds', park: true,
        runId: runId!, token: settledToken(entries, G, runId!),
      })
      expect(code, `${name}: ${errs.join('\n')}`).toBe(0)
      expect(decisions(root).at(-1)).toMatchObject({ decision: 'stop', rule: 'cap-rounds', selected: 'policy' })
    }
  }, 120_000)

  // `decisionAct` reads the gate and the target and ignores a positional word after them, as always.
  it('a stray word after the target is ignored, as decide\'s parser ignores it', async () => {
    const root = copyOf(stateRoot('revised'))
    const r = await decide(root, 'stray', '--stop')
    expect(r.code, r.stderr).toBe(0)
    expect(decisions(root).at(-1)).toMatchObject({ decision: 'stop' })
  }, 120_000)

  // D67, row 108: at the bound nothing pending still prints the terminus, never a self-repair refusal.
  it('a parked gate at the bound answers an act it does not offer with the terminus', async () => {
    const root = copyOf(stateRoot('parked at the bound'))
    const r = await decide(root, '--revise', '--note', 'x')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('bound reached')
    expect(r.stderr).toContain('upstream reopens the parent and resets the budget')
    expect(r.stderr).not.toContain('rows are structured for self-repair')
  }, 120_000)
})

// Row 244 (design §4.2.1, §4.2.9). The facts `decide` hands liveActs, computed once for every reader.
describe('actFacts', () => {
  const cfgOf = (root: string) => { const c = loadConfig(root); if (!c.ok) throw new Error('config'); return c.value }
  const factsAt = (root: string, gate: string, target: string, entries: Entry[], spec: { sha?: string; upstream?: string }) =>
    actFacts(root, cfgOf(root), loadCanon(root), gate, target, entries, spec)
  const entry = (gate: string, artifact: string, e: Record<string, unknown>): Entry => ({ v: 1, gate, artifact, ...e } as unknown as Entry)
  const gateRun = (gate: string, artifact: string, n: number, extra: Record<string, unknown> = {}): Entry => entry(gate, artifact, {
    t: 'gate-run', round: n, run_id: `${gate}-${n}`, reviewed_sha: 's', prompts_sha: 'p', witness: '0', model: 'm',
    checks: [], verdicts: [], outcome: 'stopped', ...extra,
  })
  const decision = (gate: string, artifact: string, d: string, extra: Record<string, unknown> = {}): Entry =>
    entry(gate, artifact, { t: 'human-decision', round: 1, decision: d, ...extra })

  // decide and the walk read one set of facts, staleness against the run that judged something (S2-1)
  it.each(STATES.map(([name]) => name))('%s: the facts decide reads are the walk\'s', (name) => {
    const root = stateRoot(name)
    expect(factsAt(root, G, base.effort, readStream(root, base.effort), { sha: base.sha, upstream: base.effort })).toEqual(factsOf(name))
  })

  it('reads staleness against the last run that judged something, and an uncomputable sha as unmoved', () => {
    const root = base.repo.root
    const moved = [run(1, MOVED), run(2, base.sha, 'malformed')]
    expect(factsAt(root, G, base.effort, moved, { sha: base.sha }).stale).toBe(true)
    expect(factsAt(root, G, base.effort, [run(1, base.sha), run(2, MOVED, 'malformed')], { sha: base.sha }).stale).toBe(false)
    expect(factsAt(root, G, base.effort, moved, {}).stale).toBe(false)
    expect(factsAt(root, G, base.effort, [run(1, MOVED, 'malformed')], { sha: base.sha }).stale).toBe(false)
  })

  it('computes a lifted hold itself, against the last run that judged something', () => {
    const root = base.repo.root
    const held = { checks: [{ name: 'drift', ok: true, held: [{ criterion: 'ac-rotate', need: 'prod', satisfy: '' }] }] }
    const lifted = [gateRun('design', 'auth-refresh', 1, held)]
    // auth-refresh has no needs now, so the criterion the run held is no longer held
    expect(factsAt(root, 'design', 'auth-refresh', lifted, {}).holdLifted).toBe(true)
    expect(factsAt(root, 'design', 'auth-refresh', [...lifted, gateRun('design', 'auth-refresh', 2, { outcome: 'malformed' })], {}).holdLifted).toBe(true)
    expect(factsAt(root, 'design', 'auth-refresh', [gateRun('design', 'auth-refresh', 1)], {}).holdLifted).toBe(false)
  })

  it('reads owed work through parkOwed: the gate\'s last act before the park sent work upstream', () => {
    const root = base.repo.root
    const up = dec('revise-upstream', { upstream: { artifact: base.effort, gate: 'recap' } })
    expect(factsAt(root, G, base.effort, [run(1, base.sha), up, dec('stop')], {}).owed).toBe(true)
    expect(factsAt(root, G, base.effort, [run(1, base.sha), dec('stop')], {}).owed).toBe(false)
  })

  it('upstream work is owed while the reopen the gate\'s own upstream revise booked is open (P48)', () => {
    // implement → its plan's own plan gate, on the same stream
    const p = 'auth-refresh-plan-1'
    const sent = [gateRun('implement', p, 1), decision('implement', p, 'revise-upstream', { upstream: { artifact: p, gate: 'plan' } }),
      decision('plan', p, 'revise', { caused_by: { artifact: p, gate: 'implement', round: 1 } })]
    expect(factsAt(base.repo.root, 'implement', p, sent, {}).upstreamOwed).toBe(true)
    expect(factsAt(base.repo.root, 'implement', p, [...sent, gateRun('plan', p, 1)], {}).upstreamOwed).toBe(false)
    expect(factsAt(base.repo.root, 'implement', p, [...sent, decision('plan', p, 'approve')], {}).upstreamOwed).toBe(false)
    // a later revise of the gate's own replaces the upstream one
    expect(factsAt(base.repo.root, 'implement', p, [...sent, decision('implement', p, 'revise', { note: 'x' })], {}).upstreamOwed).toBe(false)
    // another gate's reopen of this one is a revise of it, not one it sent upstream
    expect(factsAt(base.repo.root, 'plan', p, sent, {}).upstreamOwed).toBe(false)
  })

  it('reads the reopen on the stream the revise booked it on, and only by an id', () => {
    const root = copyOf(base.repo.root)
    const spec = [gateRun('design', 'auth-refresh', 1),
      decision('design', 'auth-refresh', 'revise-upstream', { upstream: { artifact: base.effort, gate: 'decompose' } })]
    expect(factsAt(root, 'design', 'auth-refresh', spec, {}).upstreamOwed).toBe(false)   // no reopen booked
    appendEntry(root, base.effort, { v: 1, t: 'human-decision', gate: 'decompose', artifact: base.effort, round: 1, decision: 'revise',
      caused_by: { artifact: 'auth-refresh', gate: 'design', round: 1 } })
    expect(factsAt(root, 'design', 'auth-refresh', spec, {}).upstreamOwed).toBe(true)
    const forged = [spec[0]!, decision('design', 'auth-refresh', 'revise-upstream', { upstream: { artifact: `../${base.effort}`, gate: 'decompose' } })]
    expect(factsAt(root, 'design', 'auth-refresh', forged, {}).upstreamOwed).toBe(false)
    for (const upstream of [null, 'x', { artifact: base.effort }]) {
      const odd = [spec[0]!, decision('design', 'auth-refresh', 'revise-upstream', { upstream })]
      expect(factsAt(root, 'design', 'auth-refresh', odd, {}).upstreamOwed).toBe(false)
    }
    appendEntry(root, base.effort, run(1, base.sha) as unknown as { t: 'gate-run' })
    expect(factsAt(root, 'design', 'auth-refresh', spec, {}).upstreamOwed).toBe(false)   // the decompose re-ran: discharged
  })

  it('for decompose, upstream work is owed until a recap lands after the revise', () => {
    const root = base.repo.root
    const sent = [run(1, base.sha), dec('revise-upstream', { upstream: { artifact: base.effort, gate: 'recap' } })]
    expect(factsAt(root, G, base.effort, sent, {}).upstreamOwed).toBe(true)
    const recap = { v: 1, t: 'recap', effort: base.effort } as unknown as Entry
    expect(factsAt(root, G, base.effort, [...sent, recap], {}).upstreamOwed).toBe(false)
    expect(factsAt(root, G, base.effort, [recap, ...sent], {}).upstreamOwed).toBe(true)
  })
})
