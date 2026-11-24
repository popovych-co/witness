import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { cliAct, exitsLine, type Act } from '../src/act.js'
import { menuFor } from '../src/arbiter.js'
import { loadConfig, type Config } from '../src/config.js'
import { decideView, type DecideView } from '../src/decide-view.js'
import { gateSpec, renderGateRun } from '../src/gate.js'
import '../src/gates/index.js'
import { appendEntry, readStream, type Entry } from '../src/journal.js'
import { needsYou } from '../src/needs-you.js'
import { AFTER_EDIT, recommend, type Decision, type Option } from '../src/recommend.js'
import { effortReviewedSha } from '../src/reviewed.js'
import {
  SESSION_LINE, actKey, actLive, exitActs, lastGateRun, liveActs,
  type ActFacts, type GateRunEntry, type GateStateKind, type LiveActs,
} from '../src/rounds.js'
import { loadCanon } from '../src/scan.js'
import { actFacts, gateParked } from '../src/verbs/next.js'
import { diffBase } from '../src/evidence.js'
import { diffReviewedSha, implementReviewedSha } from '../src/reviewed.js'
import { findById } from '../src/scan.js'
import {
  approve, commitEntry, fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, shippableRepo, writePlan, writeSpec,
  type CliResult, type TestRepo,
} from './helpers.js'
import { scratchDir } from './scratch.js'

// Row 244 (#87, design §4.2.1 "Who reads it", §4.2.2, §4.2.9). Every screen, hint, refusal and the
// arbiter's menu offers only live acts: the exits line, recommend's block, `decide --show`, what
// needs you, the arbiter's menu and every refusal's want, each read off the one derivation `decide`
// accepts by (`liveActs`). The walk runs on the real decompose gate, whose upstream is the effort
// itself, with each state's journal written into a seeded effort stream (the twin of
// tests/decide-live.test.ts, which runs every live act). Every round in it is the real gate's round,
// its key and checks, so a re-gate a screen recommends meets it as it would a human's (S2-C).

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
  // One round of the real gate, in a copy: the key every round of the walk carries (S2-C).
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

// Design §4.2.1's state walk, and the corners the first build's review found (S2-1, S2-2). Each row:
// the journal (given the content's current sha) and the state `liveActs` reads.
const STATES: Array<[string, (s: string) => Entry[], GateStateKind]> = [
  ['pending', (s) => [run(1, s)], 'pending'],
  ['stale', () => [run(1, MOVED)], 'pending'],
  ['revised', (s) => [run(1, s), dec('revise', { note: 'tighten the slicing' })], 'revised'],
  ['revised after a stop', (s) => [run(1, s), dec('stop', ARBITER), dec('revise', { note: 'try again' })], 'revised'],
  ['revised after a malformed round', (s) => [run(1, s), run(2, s, 'malformed'), dec('revise')], 'revised'],
  ['revised after a malformed round on moved content', (s) => [run(1, MOVED), run(2, s, 'malformed'), dec('revise')], 'revised'],
  ['revised with a malformed round after the revise', (s) => [run(1, s), dec('revise'), run(2, s, 'malformed')], 'revised'],
  ['repair-revised', (s) => [...bound(s), dec('stop', { ...ARBITER, rule: 'bound' }), dec('revise', { repair: true, selected: 'affirmation', rule: 'bound' })], 'revised'],
  ['reopened after an approve', (s) => [run(1, s), dec('approve', { override: true }), dec('revise', REOPEN)], 'revised'],
  ['parked', (s) => [run(1, s), dec('stop')], 'parked'],
  ['parked, then a malformed re-review (S2-2)', (s) => [run(1, s), dec('stop'), run(2, s, 'malformed')], 'parked'],
  ['parked at the bound', (s) => [...bound(s), dec('stop', ARBITER)], 'parked'],
  ['parked at the bound, content moved (S2-5)', () => [...bound(MOVED), dec('stop', ARBITER)], 'parked'],
  ['parked at the bound, then reopened', (s) => [...bound(s), dec('stop', ARBITER), dec('revise', REOPEN)], 'at-bound'],
  ['settled by an approve', (s) => [run(1, s), dec('approve', { override: true })], 'settled'],
  ['settled by a pass', (s) => [run(1, s, 'passed')], 'settled'],
  ['at the bound', bound, 'at-bound'],
  ['stale after a malformed round (S2-1)', (s) => [run(1, MOVED), run(2, s, 'malformed')], 'pending'],
  ['handed back', (s) => [run(1, s), dec('revise'), back('r1', s)], 'handed-back'],
  ['handed back, content moved since', () => [run(1, MOVED), dec('revise'), back('r1', MOVED)], 'handed-back-moved'],
  ['handed back, then decided', (s) => [run(1, s), dec('revise'), back('r1', s), dec('approve', { override: true })], 'settled'],
  ['handed back, then --fresh', (s) => [run(1, s), dec('revise'), back('r1', s), run(2, s)], 'pending'],
  ['handed back, then revised again', (s) => [run(1, s), dec('revise'), back('r1', s), dec('revise', { note: 'change the expiry' })], 'revised'],
  ['retracted', (s) => [run(1, s), dec('approve', { override: true }), dec('revise', { note: 'the stamp was wrong' })], 'retracted'],
  // S3-3: a malformed round after the revise on other content, the content back on the disposed run's.
  ['malformed on other content after the revise (S3-3)', (s) => [run(1, s), dec('revise', { note: 'tighten the slicing' }), run(2, OTHER, 'malformed')], 'revised'],
  ['handed back, then malformed on other content (S3-3)', (s) => [run(1, s), dec('revise'), back('r1', s), run(2, OTHER, 'malformed')], 'handed-back'],
  ['retracted, then malformed on other content (S3-3)', (s) => [run(1, s, 'passed'), dec('revise', { note: 'the pass was wrong' }), run(2, OTHER, 'malformed')], 'retracted'],
]
const STATE = new Map(STATES.map(([name, journal, kind]) => [name, { journal, kind }]))

function copyOf(root: string, shared = false): string {
  const dir = scratchDir('witness-screens-', { shared })
  cpSync(root, dir, { recursive: true })
  return dir
}
// A repo with these entries appended to the effort's stream and committed.
function repoWith(entries: Entry[], from = base.repo.root, shared = false): string {
  const root = copyOf(from, shared)
  for (const e of entries) appendEntry(root, base.effort, e as unknown as { t: 'gate-run' })
  base.repo.git('-C', root, 'add', '.witness/journal')
  base.repo.git('-C', root, 'commit', '-qm', 'screens: state', '-m', 'Witness-State: 1')
  return root
}
// Shared: `built` hands one state's repo to every later test that reads that state.
const built = new Map<string, string>()
function stateRoot(name: string): string {
  const cached = built.get(name)
  if (cached !== undefined) return cached
  const root = repoWith(STATE.get(name)!.journal(base.sha), base.repo.root, true)
  built.set(name, root)
  return root
}
function cfgOf(root: string): Config {
  const r = loadConfig(root)
  if (!r.ok) throw new Error('config')
  return r.value
}

const cli = (root: string, args: string[]): Promise<CliResult> =>
  base.repo.cli(args, { cwd: root, env: gateEnv(base.scenario) })
const unquoted = (text: string): string => text.replaceAll('""', '"')
const ruleOf = (stderr: string): string | undefined => /^\s+[^,\s]+,([a-z-]+),/m.exec(stderr)?.[1]

// What `decide` reads in this repo: the facts beside the journal, and the gate's live acts.
function liveIn(root: string): { live: LiveActs; facts: ActFacts; entries: Entry[]; upstream: string | undefined } {
  const cfg = cfgOf(root)
  const canon = loadCanon(root)
  const entries = readStream(root, base.effort)
  const spec = gateSpec(G)!
  const upstream = spec.upstreamOf!(root, canon, base.effort)
  const facts = actFacts(root, cfg, canon, G, base.effort, entries, { sha: spec.currentSha!(root, canon, cfg, base.effort), upstream })
  return { live: liveActs(G, base.effort, entries, facts), facts, entries, upstream }
}

// The revised state's recommended re-gate is conditional — "after you change the work" (design
// §4.2.1): on unchanged content the gate answers changed-nothing, so it is the one option the walk
// does not hold to the live set.
const conditional = (o: Option): boolean =>
  o.when === AFTER_EDIT && o.act !== undefined && actKey(o.act) === actKey(cliAct('gate', G, base.effort))
const blockActs = (d: Decision | undefined): Act[] => (d?.options ?? []).filter((o) => !conditional(o)).flatMap((o) => (o.act ? [o.act] : []))
// `decide --show` is a read of the gate, not an act on it: no state lists it.
const notRead = (a: Act): boolean => !a.argv.includes('--show')

function viewActs(view: DecideView): Act[] {
  switch (view.state) {
    case 'no-runs': return []
    case 'parked': return view.reopen
    case 'reopened':
    case 'settled': return view.exits
    case 'actionable':
    case 'handed-back': return [...blockActs(view.block), ...view.exits]
  }
}

// The acts a printed text names, read the way the act renderers print them (`exitsLine`): a command
// is `witness <verb>`, its positionals (two for decide and gate, one for abandon), then its flags, a
// valued flag taking the next word; a ` | ` segment of flags shares the decide before it. A command
// the text names as the step after another (`…, then witness gate … --fresh re-judges it`) is
// conditional on that one, as the revised state's re-gate is (design §4.2.1), and is not read.
function actsIn(text: string): string[][] {
  const words = unquoted(text).split(/\s+/).map((w) =>
    w.startsWith('"<why>"') ? '<why>' : w.replace(/^"(?=witness$)/, '').replace(/[",]+$/, ''))
  const out: string[][] = []
  for (let i = 0; i < words.length; i++) {
    const verb = words[i + 1]
    if (words[i] !== 'witness' || (verb !== 'decide' && verb !== 'gate' && verb !== 'abandon')) continue
    const after = words[i - 1] === 'then' || words[i - 1] === 'then:'
    let j = i + 2
    const pos = words.slice(j, j + (verb === 'abandon' ? 1 : 2))
    j += pos.length
    const flags = (): string[] => {
      const got: string[] = []
      while (j < words.length && words[j]!.startsWith('--')) {
        got.push(words[j]!)
        if (['--note', '--upstream', '--pin', '--via'].includes(words[j]!)) got.push(words[++j] ?? '')
        j++
      }
      return got
    }
    const first = [verb, ...pos, ...flags()]
    if (!after) out.push(first)
    while (verb === 'decide' && words[j] === '|' && words[j + 1]?.startsWith('--')) {
      j++
      out.push([verb, ...pos, ...flags()])
    }
    i = j - 1
  }
  return out
}

// Each refusal a human meets in this state, read for the acts its want, `help:` and `run:` rows name:
// a `--fresh` (settled-approve, the parked hint; at the bound, the gate's own endgame screen) and an
// approve (nothing-pending, the withheld approve's blockers, the terminus). One that lands is no
// refusal and is not read.
async function wantActs(name: string): Promise<Act[]> {
  const acts: Act[] = []
  for (const argv of [['gate', G, base.effort, '--fresh'], ['decide', G, base.effort, '--approve']]) {
    const root = copyOf(stateRoot(name))
    const before = readStream(root, base.effort).length
    const r = await cli(root, argv)
    if (readStream(root, base.effort).length !== before) continue
    expect(r.code, `${argv.join(' ')}: ${r.stderr}`).toBeGreaterThanOrEqual(2)
    acts.push(...actsIn(`${r.stdout}\n${r.stderr}`).map((w) => cliAct(...w)))
  }
  return acts
}

// The acts `witness status` names for the effort: its parked rows' reopen, read from the text.
async function statusActs(name: string): Promise<Act[]> {
  const r = await cli(stateRoot(name), ['status'])
  expect(r.code, r.stderr).toBe(0)
  return actsIn(r.stdout).filter((a) => a[a[0] === 'abandon' ? 1 : 2] === base.effort).map((w) => cliAct(...w))
}

// Every act each screen shows in a state, named by the screen that shows it.
async function shownIn(name: string): Promise<{ live: LiveActs; shown: Array<[string, Act]>; block?: Decision }> {
  const root = stateRoot(name)
  const cfg = cfgOf(root)
  const canon = loadCanon(root)
  const { live, facts, entries, upstream } = liveIn(root)
  const stale = facts.stale || facts.holdLifted
  const shown: Array<[string, Act]> = []
  const add = (screen: string, acts: readonly Act[]) => acts.filter(notRead).forEach((a) => shown.push([screen, a]))
  add('exits line', exitActs(G, base.effort, entries, stale, upstream))
  const block = recommend({ gate: G, target: base.effort, entries, upstream, stale })
  add('recommend', blockActs(block))
  add('decide --show', viewActs(decideView(root, cfg, canon, G, base.effort)))
  add('needs you', needsYou(root, fakeCtx(root), cfg, canon, []).filter((i) => i.target === base.effort).flatMap((i) =>
    i.kind === 'parked' ? i.reopen : i.kind === 'decision' ? [i.show] : []))
  if (block !== undefined) add('the arbiter\'s menu', menuFor(block, live.anchor ?? lastGateRun(entries, G)!).map((o) => o.act))
  add('witness status', await statusActs(name))
  add('a refusal\'s want', await wantActs(name))
  return { live, shown, ...(block ? { block } : {}) }
}

describe('every screen offers only live acts (design §4.2.1, #87)', () => {
  it.each(STATES.map(([name]) => name))('%s: every act on every screen is live', async (name) => {
    const { live, shown, block } = await shownIn(name)
    expect(live.state).toBe(STATE.get(name)!.kind)
    expect(shown.length).toBeGreaterThan(0)
    const dead = shown.filter(([, a]) => !actLive(live, actKey(a))).map(([screen, a]) => `${screen}: ${a.line}`)
    expect(dead).toEqual([])
    // Only the revised state's block carries the conditional re-gate, and only as its first option.
    const cond = (block?.options ?? []).findIndex(conditional)
    expect(cond).toBe(live.state === 'revised' && block !== undefined && !live.malformedRerun ? 0 : -1)
    // No screen offers a plain revise where a revise again needs its note (design §4.2.7).
    if (['revised', 'handed-back', 'handed-back-moved', 'retracted', 'settled'].includes(live.state)) {
      expect(shown.filter(([, a]) => actKey(a) === actKey(['decide', G, base.effort, '--revise']) && !a.argv.includes('--note'))).toEqual([])
    }
  }, 300_000)

  // A screen's `run:` is never a dead loop: a re-gate the block recommends unconditionally journals a
  // round on the real gate, never the changed-nothing that re-prints the same `run:` (S2-A, S3-3).
  it.each(STATES.map(([name]) => name))('%s: a recommended re-gate journals a round', async (name) => {
    const root = stateRoot(name)
    const { facts, entries, upstream } = liveIn(root)
    const first = recommend({ gate: G, target: base.effort, entries, upstream, stale: facts.stale || facts.holdLifted })?.options[0]
    if (first?.act === undefined || first.act.argv[0] !== 'gate' || !first.runnable || conditional(first)) return
    const at = copyOf(root)
    const runs = readStream(at, base.effort).filter((e) => e.t === 'gate-run').length
    const r = await cli(at, first.act.argv as string[])
    expect(r.stdout, first.act.line).not.toContain('revise changed nothing')
    expect(r.code, `${first.act.line}: ${r.stdout}\n${r.stderr}`).toBeLessThanOrEqual(1)
    expect(readStream(at, base.effort).filter((e) => e.t === 'gate-run')).toHaveLength(runs + 1)
  }, 120_000)
})

describe('the refusals name live acts (design §4.2.3, P8)', () => {
  it('gate --fresh on a settled gate names the retraction, then gate --fresh (P8)', async () => {
    for (const name of ['settled by an approve', 'settled by a pass', 'handed back, then decided']) {
      const root = copyOf(stateRoot(name))
      const runs = readStream(root, base.effort).length
      const r = await cli(root, ['gate', G, base.effort, '--fresh'])
      expect(r.code, `${name}: ${r.stderr}`).toBe(2)
      expect(ruleOf(r.stderr)).toBe('settled-approve')
      const retraction = cliAct('decide', G, base.effort, '--revise', '--note', '<why>')
      const fresh = cliAct('gate', G, base.effort, '--fresh')
      expect(unquoted(r.stderr)).toContain(`${retraction.line} — retract the settlement, then ${fresh.line} re-judges it`)
      expect(readStream(root, base.effort).length).toBe(runs)
    }
  }, 120_000)

  // S2-3. A settlement is of the bytes it judged: on moved content it lapsed (D75), and `--fresh` runs.
  it('on moved content a settled gate runs --fresh (S2-3)', async () => {
    const root = repoWith([run(1, MOVED), dec('approve', { override: true })])
    expect(liveIn(root).live.state).toBe('settled')
    const r = await cli(root, ['gate', G, base.effort, '--fresh'])
    expect(r.code, r.stderr).toBeLessThanOrEqual(1)
    expect(r.stderr).not.toContain('settled-approve')
    expect(readStream(root, base.effort).filter((e) => e.t === 'gate-run')).toHaveLength(2)
  }, 120_000)

  // The parked hint names the park's live acts but the `--fresh` just refused: below the bound the
  // revise, at the bound the endgame — never the revise `decide` refuses there (row 108).
  it('a --fresh refused on a parked gate names the park\'s live acts, never a dead one', async () => {
    // The battery refuses these runs: the one lens's every call fails.
    const failing = fakeScenario()
    putVerdict(failing, VERDICT)
    writeFileSync(join(failing, 'claude-fail-slicing-critic'), '')
    for (const name of ['parked', 'parked at the bound']) {
      const root = copyOf(stateRoot(name))
      const r = await base.repo.cli(['gate', G, base.effort, '--fresh'], { cwd: root, env: gateEnv(failing) })
      const { live } = liveIn(root)
      if (live.acts.some((a) => actKey(a) === actKey(cliAct('abandon', base.effort)))) {
        // At the bound the gate will not run again: it names the endgame on its own screen, unrefused.
        expect(r.code, r.stderr).toBe(3)
        for (const a of actsIn(r.stdout)) expect(actLive(live, actKey(a)), a.join(' ')).toBe(true)
        continue
      }
      expect(r.code, `${name}: ${r.stdout}\n${r.stderr}`).toBe(2)
      expect(r.stderr).toContain(`help: ${G} ${base.effort} is parked`)
      const named = actsIn(r.stderr)
      expect(named).toContainEqual(['decide', G, base.effort, '--revise', '--note', '<why>'])
      for (const a of named) expect(actLive(live, actKey(a)), a.join(' ')).toBe(true)
      expect(named.filter((a) => a.includes('--fresh'))).toEqual([])
    }
  }, 120_000)

  // Row 241 (R9) refuses every implement review while a plan step is open, at the bound too, so a
  // `--fresh` on an implement gate parked at the bound is refused: its way back is the endgame, and
  // the plain revise `decide` answers with the terminus there is never named (row 108).
  it('a --fresh refused on an implement gate parked at the bound names the endgame', async () => {
    const seed = await shippableRepo()
    const steps = { steps: [{ id: 's1', title: 'rotate tokens on refresh', criteria: ['ac-rotate'] },
      { id: 's2', title: 'added by an amendment', criteria: ['ac-rotate'] }] }
    expect((await writePlan(seed.repo, seed.planId, steps, '## Step: s1\nRotate.\n\n## Step: s2\nAdded.\n')).code).toBe(0)
    const cfg = cfgOf(seed.repo.root)
    const from = diffBase(seed.wt, cfg)
    if (!from.ok) throw new Error('base')
    const doc = findById(loadCanon(seed.repo.root), seed.planId)!
    for (const round of [1, 2, 3]) {
      commitEntry(seed.repo, seed.planId, {
        t: 'gate-run', gate: 'implement', artifact: seed.planId, round, run_id: `ri-${round}`,
        reviewed_sha: implementReviewedSha(seed.wt, from.value, doc), diff_sha: diffReviewedSha(seed.wt, from.value),
        prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped',
        verdicts: [{ reviewer: 'code-reviewer', coverage: [], findings: [{ blocking: true, anchor: 'src/token.ts', claim: 'x' }] }],
      })
      if (round < 3) commitEntry(seed.repo, seed.planId, { t: 'human-decision', gate: 'implement', artifact: seed.planId, round, decision: 'revise' })
    }
    commitEntry(seed.repo, seed.planId, { t: 'human-decision', gate: 'implement', artifact: seed.planId, round: 3, decision: 'stop',
      selected: 'arbiter', reason: 'the bound is spent', arbiter: { model: 'm', prompts_sha: 'p' } })
    const r = await seed.repo.cli(['gate', 'implement', seed.planId, '--fresh'])
    expect(r.code, r.stderr).toBe(2)
    expect(r.stderr).toContain(`help: implement ${seed.planId} is parked`)
    const entries = readStream(seed.repo.root, seed.planId)
    const canon = loadCanon(seed.repo.root)
    const spec = gateSpec('implement')!
    const live = liveActs('implement', seed.planId, entries, actFacts(seed.repo.root, cfg, canon, 'implement', seed.planId, entries,
      { sha: spec.currentSha!(seed.repo.root, canon, cfg, seed.planId), upstream: spec.upstreamOf!(seed.repo.root, canon, seed.planId) }))
    expect(live.state).toBe('parked')
    const hint = r.stderr.split('\n').slice(r.stderr.split('\n').findIndex((l) => l.startsWith('help: implement')))
    const named = actsIn(hint.join('\n'))
    expect(named).toContainEqual(['abandon', seed.planId])
    for (const a of named) expect(actLive(live, actKey(a)), a.join(' ')).toBe(true)
  }, 180_000)
})

describe('decide --show on a handed-back gate (design §4.2.5)', () => {
  it('decide --show on a handed-back gate shows state handed-back', async () => {
    const root = stateRoot('handed back')
    const view = decideView(root, cfgOf(root), loadCanon(root), G, base.effort)
    if (view.state !== 'handed-back') throw new Error(`state ${view.state}`)
    expect(view.moved).toBe(false)
    expect(view.disposition).toStrictEqual({ decision: 'revise' })
    // The finding anchors in the spec, not in the parent (the effort), so the park leads (§4.2.2, S2-D).
    expect(view.block?.rule).toBe('revise-returned')
    expect(view.block?.anchor).toBe(ANCHOR)
    expect(view.block?.options[0]?.act?.argv).toEqual(['decide', G, base.effort, '--stop'])
    expect(view.exits).toEqual(liveIn(root).live.acts)
    const r = await cli(root, ['decide', G, base.effort, '--show'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('state: handed-back — the author handed the revise back with the content unchanged')
  }, 120_000)

  it('content moved since the hand-back: the re-gate leads, no approve, and the anchor rides the options (P47)', async () => {
    const root = stateRoot('handed back, content moved since')
    const view = decideView(root, cfgOf(root), loadCanon(root), G, base.effort)
    if (view.state !== 'handed-back') throw new Error(`state ${view.state}`)
    expect(view.moved).toBe(true)
    expect(view.block?.rule).toBe('stale-below-bound')
    expect(view.block?.anchor).toBe(ANCHOR)
    expect(view.block?.options.map((o) => o.act?.argv.slice(3))).toEqual([
      [], ['--stop'], ['--revise', '--upstream', base.effort], ['--revise', '--note', '<why>'],
    ])
    expect(view.block?.options[0]?.act?.argv[0]).toBe('gate')
    const r = await cli(root, ['decide', G, base.effort, '--show'])
    expect(r.stdout).toContain('state: handed-back — the content or a hold moved since the author handed the revise back')
    expect(r.stdout).not.toContain('--approve')
  }, 120_000)
})

describe('the first build\'s corners (S2-1, S2-2, S2-5)', () => {
  // S2-2. A malformed round judged nothing, so it leaves the park standing everywhere.
  it('a malformed re-review leaves a park standing (S2-2)', async () => {
    const root = stateRoot('parked, then a malformed re-review (S2-2)')
    const entries = readStream(root, base.effort)
    expect(gateParked(entries, G)).toBe(true)
    const { live } = liveIn(root)
    expect(live.state).toBe('parked')
    const view = decideView(root, cfgOf(root), loadCanon(root), G, base.effort)
    if (view.state !== 'parked') throw new Error(`state ${view.state}`)
    expect(view.reopen).toEqual(live.acts)
    expect(view.why).toBe(`parked by a human at ${ANCHOR}`)
    const parked = needsYou(root, fakeCtx(root), cfgOf(root), loadCanon(root), []).find((i) => i.kind === 'parked' && i.target === base.effort)
    expect(parked).toMatchObject({ kind: 'parked', gate: G, reopen: live.acts })
    // The gate's own screen after that malformed round offers the park's way back, not a plain re-run.
    const out: string[] = []
    renderGateRun(fakeCtx(root, { out: (l) => out.push(l) }), lastGateRun(entries, G)!, 'ran', { entries, upstream: base.effort })
    const named = actsIn(out.join('\n'))
    expect(named.length).toBeGreaterThan(0)
    for (const a of named) expect(actLive(live, actKey(a)), a.join(' ')).toBe(true)
  }, 120_000)

  // S2-1. Staleness is read against the last run that judged something: a malformed round on the
  // current content does not make a verdict on other content current.
  it('decide-view\'s staleness reads the last run that judged something (S2-1)', async () => {
    const root = stateRoot('stale after a malformed round (S2-1)')
    const view = decideView(root, cfgOf(root), loadCanon(root), G, base.effort)
    if (view.state !== 'actionable') throw new Error(`state ${view.state}`)
    expect(view.exits[0]).toEqual(cliAct('gate', G, base.effort))
    const offered = [...blockActs(view.block), ...view.exits]
    expect(offered.filter((a) => a.argv.includes('--approve'))).toEqual([])
  }, 120_000)

  // S2-1, gate's own choices: at the bound with moved content the gate will not run again, and its
  // block names the endgame minus approve, which `decide` would refuse `stale-verdict`.
  it('the gate\'s choices read staleness too: at the bound on moved content no approve (S2-1)', async () => {
    const root = repoWith(bound(MOVED))
    const r = await cli(root, ['gate', G, base.effort])
    expect(r.stdout).toContain('round bound reached')
    const named = actsIn(r.stdout)
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((a) => a.includes('--approve'))).toEqual([])
    const { live } = liveIn(root)
    expect(live.state).toBe('at-bound')
    for (const a of named) expect(actLive(live, actKey(a)), a.join(' ')).toBe(true)
  }, 120_000)

  // S2-5. Parked at the bound, the way back is the endgame, and on moved content it holds no approve —
  // on decide --show, in what needs you, and in `witness status`, whose parked rows read the content's
  // sha as `decide` does.
  it('a gate parked at the bound on moved content offers no approve (S2-5)', async () => {
    const root = stateRoot('parked at the bound, content moved (S2-5)')
    const { live } = liveIn(root)
    expect(live.state).toBe('parked')
    expect(live.acts.filter((a) => a.argv.includes('--approve'))).toEqual([])
    const view = decideView(root, cfgOf(root), loadCanon(root), G, base.effort)
    if (view.state !== 'parked') throw new Error(`state ${view.state}`)
    expect(view.reopen).toEqual(live.acts)
    const show = await cli(root, ['decide', G, base.effort, '--show'])
    expect(show.stdout).not.toContain('--approve')
    const parked = needsYou(root, fakeCtx(root), cfgOf(root), loadCanon(root), []).find((i) => i.kind === 'parked' && i.target === base.effort)
    expect(parked).toMatchObject({ kind: 'parked', reopen: live.acts })
    const status = await cli(root, ['status'])
    expect(status.stdout).toContain(`exits: ${exitsLine(live.acts)}`)
    expect(status.stdout).not.toContain('--approve')
  }, 120_000)
})

describe('the upstream slot (design §4.2.9)', () => {
  const plan = 'auth-refresh-plan-1'
  const planRun = (round: number): Entry => ({
    v: 1, t: 'gate-run', gate: 'plan', artifact: plan, round, run_id: `p${round}`, reviewed_sha: `ps${round}`,
    prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped',
    verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [{ blocking: true, anchor: `${plan} > ## Steps`, claim: 'x' }] }],
  } as unknown as Entry)
  const noParent: ActFacts = { upstream: undefined, stale: false, holdLifted: false, owed: false, upstreamOwed: false }

  it('where no parent resolves, the send-upstream is a slot: accepted, never in an exits line', () => {
    const slot = actKey(['decide', 'plan', plan, '--revise', '--upstream', 'auth-refresh'])
    for (const entries of [[planRun(1)], [planRun(1), planRun(2), planRun(3)]]) {
      const live = liveActs('plan', plan, entries, noParent)
      expect(live.acts.filter((a) => a.argv.includes('--upstream'))).toEqual([])
      expect(live.slots).toContainEqual(cliAct('decide', 'plan', plan, '--revise', '--upstream', '<effort>'))
      expect(actLive(live, slot)).toBe(true)
      expect(exitActs('plan', plan, entries, false, undefined).filter((a) => a.argv.includes('--upstream'))).toEqual([])
    }
    // The bound-recurrence block shows it for the human to fill: live, and never runnable.
    const recurring = [planRun(1), planRun(2), planRun(3)]
    const block = recommend({ gate: 'plan', target: plan, entries: recurring, upstream: undefined, stale: false })!
    expect(block.rule).toBe('bound-recurrence')
    const up = block.options.find((o) => o.act?.argv.includes('--upstream'))!
    expect(up).toMatchObject({ runnable: false, command: `witness decide plan ${plan} --revise --upstream <effort>` })
    expect(actLive(liveActs('plan', plan, recurring, noParent), actKey(up.act!))).toBe(true)
  })

  it('a filled --revise --upstream <effort> lands where no parent resolves', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, plan)
    // A parent outside the id set resolves no upstream (row 239, the plan gate's `upstreamOf`).
    repo.setMeta(plan, { parent: 'Auth Refresh' })
    appendEntry(repo.root, plan, planRun(1) as unknown as { t: 'gate-run' })
    repo.git('add', '.witness/journal')
    repo.git('commit', '-qm', 'a pending plan run', '-m', 'Witness-State: 1')
    expect(gateSpec('plan')!.upstreamOf!(repo.root, loadCanon(repo.root), plan)).toBeUndefined()
    const r = await repo.cli(['decide', 'plan', plan, '--revise', '--upstream', 'auth-refresh', '--note', 'the spec asks for it'])
    expect(r.code, r.stderr).toBe(0)
    expect(readStream(repo.root, plan).filter((e) => e.t === 'human-decision').at(-1)).toMatchObject({ decision: 'revise-upstream' })
  }, 120_000)
})

// Design §4.2.2. The changed-nothing screen — a re-gate on the content a revise left — prints the
// session's line and the state's live acts. The gate runs for real here, so the re-gate meets the
// key its own round journaled.
describe('the changed-nothing screen (design §4.2.2)', () => {
  let ran: { root: string; runId: string }
  beforeAll(async () => {
    const root = copyOf(base.repo.root)
    const g = await cli(root, ['gate', G, base.effort])
    if (g.code > 1) throw new Error(`gate: ${g.stdout}\n${g.stderr}`)
    const r = lastGateRun(readStream(root, base.effort), G)!
    ran = { root, runId: r.run_id }
  }, 120_000)

  const screen = async (entries: (runId: string) => Entry[]) => {
    const root = repoWith(entries(ran.runId), ran.root)
    const r = await cli(root, ['gate', G, base.effort])
    expect(r.stdout).toContain('outcome: revise changed nothing')
    expect(readStream(root, base.effort).filter((e) => e.t === 'gate-run')).toHaveLength(1)
    return { r, root, live: liveIn(root).live }
  }

  it('revised: the session\'s line, then the re-gate "after you change the work" and the live acts', async () => {
    const { r, live } = await screen(() => [dec('revise', { note: 'tighten the slicing' })])
    expect(live.state).toBe('revised')
    expect(r.stdout).toContain(`session: "${SESSION_LINE.revised}"`)
    const lines = r.stdout.split('\n')
    const first = lines.indexOf('1 · recommended · root')
    expect(lines[first + 1]).toBe(`   ${cliAct('gate', G, base.effort).line}`)
    expect(lines).toContain(`   when: ${AFTER_EDIT}`)
    expect(lines).toContain(`run: ${cliAct('gate', G, base.effort).line}`)
    const named = actsIn(r.stdout).filter((a) => actKey(a) !== actKey(cliAct('gate', G, base.effort)))
    expect(named.length).toBeGreaterThanOrEqual(4)
    for (const a of named) expect(actLive(live, actKey(a)), a.join(' ')).toBe(true)
    expect(named.filter((a) => a.includes('--revise') && !a.includes('--note') && !a.includes('--upstream'))).toEqual([])
  }, 120_000)

  it('retracted: the session\'s line, and the re-review leads', async () => {
    const { r, live } = await screen(() => [dec('approve', { override: true }), dec('revise', { note: 'the stamp was wrong' })])
    expect(live.state).toBe('retracted')
    expect(r.stdout).toContain(`session: "${SESSION_LINE.retracted}"`)
    expect(r.stdout).toContain(`run: ${cliAct('gate', G, base.effort, '--fresh').line}`)
    for (const a of actsIn(r.stdout)) expect(actLive(live, actKey(a)), a.join(' ')).toBe(true)
  }, 120_000)

  it('handed back: no session line — the arbiter or the human decides', async () => {
    const { r, live } = await screen((id) => [dec('revise'), back(id, base.sha)])
    expect(live.state).toBe('handed-back')
    expect(r.stdout).not.toContain('session:')
    for (const a of actsIn(r.stdout)) expect(actLive(live, actKey(a)), a.join(' ')).toBe(true)
  }, 120_000)

  // P3, moved here from Task 9. The revised state's recommended act is the conditional re-gate: once
  // the author changes the work it lands, as a round.
  it('after a plain revise the recommended act lands once the work changes (P3)', async () => {
    const root = repoWith([dec('revise', { note: 'tighten the slicing' })], ran.root)
    const rel = 'specs/auth-refresh.md'
    writeFileSync(join(root, rel), `${readFileSync(join(root, rel), 'utf8')}\nRotation is logged.\n`)
    base.repo.git('-C', root, 'add', rel)
    base.repo.git('-C', root, 'commit', '-qm', 'the author changes the work', '-m', 'Witness-State: 1')
    const view = decideView(root, cfgOf(root), loadCanon(root), G, base.effort)
    if (view.state !== 'actionable') throw new Error(`state ${view.state}`)
    // On the changed content the revised state's one act is the re-gate (D131), and it lands.
    expect(view.exits).toEqual([cliAct('gate', G, base.effort)])
    const r = await cli(root, view.exits[0]!.argv as string[])
    expect(r.code, r.stderr).toBeLessThanOrEqual(1)
    expect(readStream(root, base.effort).filter((e) => e.t === 'gate-run')).toHaveLength(2)
  }, 120_000)
})

// A revise anchored on the run it disposed of, read by the arbiter: the menu holds only the block's
// live acts, whatever the run's checks.
describe('the arbiter\'s menu reads the live block', () => {
  it('an owed stop\'s menu is a subset of the live acts', () => {
    const entries = [run(1, 'x')]
    const live = liveActs(G, 'e', entries, { upstream: 'e', stale: false, holdLifted: false, owed: false, upstreamOwed: false })
    const block = recommend({ gate: G, target: 'e', entries, upstream: 'e', stale: false })!
    const menu = menuFor(block, entries[0] as unknown as GateRunEntry)
    expect(menu.length).toBeGreaterThan(0)
    for (const o of menu) expect(actLive(live, actKey(o.act)), o.command).toBe(true)
  })
})
