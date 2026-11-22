import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliAct } from '../src/act.js'
import { version } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { changedFiles, diffBase } from '../src/evidence.js'
import { gateSpec, registerGate } from '../src/gate.js'
// The gates register on this import, before any synthetic wrapper below replaces one for a test.
import '../src/gates/index.js'
import { journalRel, readStream, type Entry } from '../src/journal.js'
import { SESSION_LINE, actKey, lastGateRun, liveActs, type GateRunEntry } from '../src/rounds.js'
import { loadCanon } from '../src/scan.js'
import { kv } from '../src/toon.js'
import { actFacts } from '../src/verbs/next.js'
import {
  PLAN_BLOCKING, callCount, commitEntry, fakeScenario, gateEnv, plannedRepo, putVerdict, seededRepo, shippableRepo,
  writeSpec, type CliResult, type TestRepo,
} from './helpers.js'

// Row 244 (#87, design §4.2.4, §4.2.9). `witness gate <gate> <target> --unchanged`: the author's
// deliberate hand-back of a revise they judge needs no change. Where the gate would answer
// changed-nothing about the run the revise disposed of, it journals `revise-returned` for that run
// instead, and the revise is decided again. Anywhere else it runs as the plain gate and says why
// nothing was handed back, or — where a hand-back is not legal — refuses from the journal before
// any lane or battery runs.

const P = 'auth-refresh-plan-1'
const S = 'auth-refresh'
const E = 'auth-hardening'

const backs = (repo: TestRepo, stream: string) => readStream(repo.root, stream).filter((e) => e.t === 'revise-returned')
const runsOf = (repo: TestRepo, stream: string, gate: string) =>
  readStream(repo.root, stream).filter((e) => e.t === 'gate-run' && (e as unknown as GateRunEntry).gate === gate) as unknown as GateRunEntry[]

async function ok(repo: TestRepo, args: string[], env: Record<string, string>, code = 0): Promise<CliResult> {
  const r = await repo.cli(args, { env })
  expect(r.code, `${args.join(' ')}: ${r.stdout}\n${r.stderr}`).toBe(code)
  return r
}

// A plan gate stopped on a blocking finding in the plan, with autonomy off.
async function stoppedPlan(): Promise<{ repo: TestRepo; env: Record<string, string>; scenario: string; run: GateRunEntry }> {
  const repo = await plannedRepo({ autonomy: false })
  const scenario = fakeScenario()
  putVerdict(scenario, PLAN_BLOCKING)
  const env = gateEnv(scenario)
  await ok(repo, ['gate', 'plan', P], env, 1)
  return { repo, env, scenario, run: lastGateRun(readStream(repo.root, P), 'plan')! }
}
// …and the human's revise of it, the content left as it was.
async function revisedPlan() {
  const f = await stoppedPlan()
  await ok(f.repo, ['decide', 'plan', P, '--revise', '--note', 'make step s1 testable'], f.env)
  return f
}

// A round copied from a journaled one, as another run of the same gate would journal it.
const copyRun = (r: GateRunEntry, patch: Partial<GateRunEntry>): Entry => ({ ...r, ...patch } as unknown as Entry)
const decision = (gate: string, artifact: string, d: string, extra: Record<string, unknown> = {}) =>
  ({ v: 1 as const, t: 'human-decision' as const, gate, artifact, round: 1, decision: d, ...extra })

describe('witness gate --unchanged hands a revise back (row 244, design §4.2.4)', () => {
  it('hands back: journals revise-returned for the disposed run; autonomy off exits 1 with the decision row', async () => {
    const { repo, wt, planId } = await shippableRepo()
    const cfg = loadConfig(repo.root)
    const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
    const files = changedFiles(wt, base.ok ? base.value : '')
    const scenario = fakeScenario()
    putVerdict(scenario, {
      coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })),
      findings: [{ blocking: true, anchor: 'src/token.ts', claim: 'rotation is unbounded' }],
    })
    const env = gateEnv(scenario)
    await ok(repo, ['gate', 'implement', planId], env, 1)
    const stopped = lastGateRun(readStream(repo.root, planId), 'implement')!
    const stoppedRun = stopped.run_id
    const reviewedSha = stopped.reviewed_sha
    await ok(repo, ['decide', 'implement', planId, '--revise', '--note', 'bound the rotation'], env)
    const calls = callCount(scenario)

    const r = await repo.cli(['gate', 'implement', planId, '--unchanged'], { env })
    expect(r.code, r.stderr).toBe(1)
    const e = readStream(repo.root, planId).filter((x) => x.t === 'revise-returned')
    expect(e).toEqual([expect.objectContaining({ gate: 'implement', artifact: planId, run_id: stoppedRun, sha: reviewedSha })])
    expect(e[0]).not.toHaveProperty('manual')
    // No round and no battery: the hand-back judges nothing.
    expect(runsOf(repo, planId, 'implement')).toHaveLength(1)
    expect(callCount(scenario)).toBe(calls)
    expect(r.stdout).not.toContain('autonomy: on')
    expect(r.stdout).toContain('outcome: handed back')
    expect(r.stdout).not.toContain('revise changed nothing')
    // The decision row: the handed-back block, which leads with the park (the finding anchors here,
    // not in the parent plan), every option a live act.
    const live = liveActs('implement', planId, readStream(repo.root, planId),
      { upstream: planId, stale: false, holdLifted: false, owed: false, upstreamOwed: false })
    expect(live.state).toBe('handed-back')
    expect(r.stdout).toContain(`run: ${cliAct('decide', 'implement', planId, '--stop').line}`)
    const show = await ok(repo, ['decide', 'implement', planId, '--show'], env)
    expect(show.stdout).toContain('state: handed-back — the author handed the revise back with the content unchanged')
  }, 180_000)

  it('--manual journals manual: true', async () => {
    const { repo, env, run } = await revisedPlan()
    const r = await repo.cli(['gate', 'plan', P, '--unchanged', '--manual'], { env })
    expect(r.code, r.stderr).toBe(1)
    expect(backs(repo, P)).toEqual([expect.objectContaining({ gate: 'plan', run_id: run.run_id, sha: run.reviewed_sha, manual: true })])
    expect(r.stdout).toContain('outcome: handed back')
  }, 120_000)

  it('a plain re-run stays changed-nothing and journals nothing (V1)', async () => {
    const { repo, env, scenario } = await revisedPlan()
    const before = readStream(repo.root, P).length
    const calls = callCount(scenario)
    const r = await repo.cli(['gate', 'plan', P], { env })
    expect(r.code, r.stderr).toBe(1)
    expect(r.stdout).toContain('outcome: revise changed nothing')
    // The session's line names the hand-back as the author's act; the plain re-run never takes it.
    expect(r.stdout).toContain(kv('session', SESSION_LINE.revised))
    expect(backs(repo, P)).toEqual([])
    expect(readStream(repo.root, P)).toHaveLength(before)
    expect(callCount(scenario)).toBe(calls)
  }, 120_000)

  // P11. Row 112's own case on the real decompose gate: correcting a goal mapping leaves the doc bytes,
  // and so the key, where they were, while the coverage check flips. The flip is a new judgment, so
  // the gate replays the disposed run's verdicts into a round of its own, and nothing is handed back.
  it('a check that flipped runs a cached round and says nothing was handed back (P11)', async () => {
    const repo = await seededRepo({ goals: [{ id: 'g1', text: 'Refresh tokens rotate' }, { id: 'g2', text: 'Sessions revoke' }] })
    await writeSpec(repo, S)                                    // covers g1 only: goal-coverage fails
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [{ anchor: `${S} > ## Behavior`, note: 'read' }], findings: [] })
    const env = gateEnv(scenario)
    await ok(repo, ['gate', 'decompose', E], env, 1)
    const first = runsOf(repo, E, 'decompose')[0]!
    expect(first.checks.find((c) => c.name === 'goal-coverage')?.ok).toBe(false)
    await ok(repo, ['decide', 'decompose', E, '--revise', '--note', 'cover g2'], env)
    expect((await writeSpec(repo, S, { covers: ['g1', 'g2'] })).code).toBe(0)
    const calls = callCount(scenario)

    const r = await repo.cli(['gate', 'decompose', E, '--unchanged'], { env })
    expect(r.code, r.stderr).toBeLessThanOrEqual(1)
    expect(r.stdout).toContain(`note: nothing was handed back — a check changed since round ${first.round}`)
    expect(backs(repo, E)).toEqual([])
    const runs = runsOf(repo, E, 'decompose')
    expect(runs).toHaveLength(2)
    expect(runs[1]!.cached).toBe(true)
    expect(runs[1]!.reviewed_sha).toBe(first.reviewed_sha)
    expect(runs[1]!.checks.find((c) => c.name === 'goal-coverage')?.ok).toBe(true)
    expect(callCount(scenario)).toBe(calls)                     // replayed, never re-asked
  }, 120_000)

  // Design §4.2.9: the refusals come from liveActs' state, read from the journal before any lane or
  // battery runs, so nothing is spent and nothing is journaled.
  const SETUPS: Record<string, (f: Awaited<ReturnType<typeof stoppedPlan>>) => Promise<void>> = {
    'no revise': async () => {},
    'own upstream revise still owed': async ({ repo, env }) => {
      await ok(repo, ['decide', 'plan', P, '--revise', '--upstream', S, '--note', 'the spec leaves rotation open'], env)
    },
    'a retraction': async ({ repo, env }) => {
      await ok(repo, ['decide', 'plan', P, '--approve', '--override'], env)
      await ok(repo, ['decide', 'plan', P, '--revise', '--note', 'the approval was wrong'], env)
    },
    'one standing': async ({ repo, env }) => {
      await ok(repo, ['decide', 'plan', P, '--revise', '--note', 'make step s1 testable'], env)
      await ok(repo, ['gate', 'plan', P, '--unchanged'], env, 1)
    },
    // The bound spent, parked by the arbiter, then reopened by the implement gate's upstream revise:
    // a revise stands, and the endgame decides it.
    'at the bound': async ({ repo, run }) => {
      for (const e of [
        decision('plan', P, 'revise'), copyRun(run, { run_id: 'r-2', round: 2 }),
        decision('plan', P, 'revise'), copyRun(run, { run_id: 'r-3', round: 3 }),
        decision('plan', P, 'stop', { selected: 'arbiter', reason: 'the bound is spent', arbiter: { model: 'm', prompts_sha: 'p' } }),
        decision('plan', P, 'revise', { caused_by: { artifact: P, gate: 'implement', round: 1 }, note: 'the plan misses rotation' }),
      ]) commitEntry(repo, P, e as never)
    },
  }
  it.each([
    ['no revise', 'nothing-to-hand-back'],
    ['own upstream revise still owed', 'upstream-owed'],
    ['a retraction', 'retraction-owed'],
    ['one standing', 'hand-back-standing'],
    ['at the bound', 'hand-back-at-bound'],
  ])('%s refuses %s with exit 2 and journals nothing', async (setup, rule) => {
    const f = await stoppedPlan()
    await SETUPS[setup]!(f)
    const before = readStream(f.repo.root, P).length
    const backsBefore = backs(f.repo, P).length
    const calls = callCount(f.scenario)
    const r = await f.repo.cli(['gate', 'plan', P, '--unchanged'], { env: f.env })
    expect(r.code, r.stdout).toBe(2)
    expect(r.stderr).toContain(rule)
    expect(readStream(f.repo.root, P)).toHaveLength(before)
    expect(backs(f.repo, P)).toHaveLength(backsBefore)
    expect(callCount(f.scenario)).toBe(calls)
    // A retraction asks for a re-review: the refusal names it.
    if (rule === 'retraction-owed') expect(r.stderr).toContain(cliAct('gate', 'plan', P, '--fresh').line)
  }, 120_000)

  // Task 9's review: upstream work stays owed while ANY reopen this gate booked is open, not only while
  // its reopen is the upstream gate's latest — a sibling's later reopen hid it.
  it('own upstream revise stays owed when a sibling\'s reopen of the same gate came last', async () => {
    const { repo, env } = await stoppedPlan()
    await ok(repo, ['decide', 'plan', P, '--revise', '--upstream', S, '--note', 'the spec leaves rotation open'], env)
    commitEntry(repo, E, decision('decompose', E, 'revise',
      { caused_by: { artifact: 'token-store-plan-1', gate: 'plan', round: 1 }, note: 'the sibling\'s spec is wrong too' }) as never)
    const facts = () => actFacts(repo.root, undefined, loadCanon(repo.root), 'plan', P, readStream(repo.root, P), { upstream: S })
    expect(facts().upstreamOwed).toBe(true)
    const r = await repo.cli(['gate', 'plan', P, '--unchanged'], { env })
    expect(r.code, r.stdout).toBe(2)
    expect(r.stderr).toContain('upstream-owed')
    expect(backs(repo, P)).toEqual([])
    // A disposition of the upstream gate (no `caused_by`) answers every reopen before it.
    commitEntry(repo, E, decision('decompose', E, 'approve') as never)
    expect(facts().upstreamOwed).toBe(false)
  }, 120_000)

  // P48. Decompose's upstream is the recap: its `--revise --upstream` books no reopen, and its work is
  // owed until a recap lands after the revise.
  it('decompose\'s upstream revise refuses until a recap lands after it (P48)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, S)
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [{ anchor: `${S} > ## Behavior`, note: 'read' }], findings: [] })
    const env = gateEnv(scenario)
    await ok(repo, ['gate', 'decompose', E], env, 1)
    await ok(repo, ['decide', 'decompose', E, '--revise', '--upstream', E, '--note', 're-interview the scope'], env)
    const refused = await repo.cli(['gate', 'decompose', E, '--unchanged'], { env })
    expect(refused.code, refused.stdout).toBe(2)
    expect(refused.stderr).toContain('upstream-owed')
    expect(backs(repo, E)).toEqual([])

    // The amendment re-interviewed the scope and kept it: the recap it landed reads as the one the round
    // judged, so the content is unchanged and the author may now hand the revise back.
    await ok(repo, ['recap', '--amend', '--file', repo.writeRecap({})], env)
    const run = runsOf(repo, E, 'decompose')[0]!
    const r = await repo.cli(['gate', 'decompose', E, '--unchanged'], { env })
    expect(r.code, r.stderr).toBe(1)
    expect(r.stderr).not.toContain('upstream-owed')
    expect(r.stdout).toContain('outcome: handed back')
    expect(backs(repo, E)).toEqual([expect.objectContaining({ gate: 'decompose', run_id: run.run_id, sha: run.reviewed_sha })])
    expect(runsOf(repo, E, 'decompose')).toHaveLength(1)
  }, 120_000)

  // Review Focus. A revise left open across an upgrade carries its run under the old witness's key, and
  // a version bump moves the key, so a fresh round runs instead of a hand-back. Until the release bump
  // `version()` is still 0.29.0, so the fixture journals the run as the release before it.
  it('a revise left open across the upgrade (run key witness 0.29.0) runs a fresh round and says nothing was handed back (Review Focus)', async () => {
    const prior = version() === '0.29.0' ? '0.28.3' : '0.29.0'
    const { repo, env, scenario, run } = await stoppedPlan()
    const rel = journalRel(P)
    const lines = repo.read(rel).trimEnd().split('\n').map((l) => {
      const e = JSON.parse(l) as Record<string, unknown>
      return JSON.stringify(e.t === 'gate-run' && e.run_id === run.run_id ? { ...e, witness: prior } : e)
    })
    writeFileSync(join(repo.root, rel), `${lines.join('\n')}\n`)
    repo.git('add', rel)
    repo.git('commit', '-qm', 'journal: the run under the prior release', '-m', 'Witness-State: 1')
    await ok(repo, ['decide', 'plan', P, '--revise', '--note', 'make step s1 testable'], env)
    const calls = callCount(scenario)

    const r = await repo.cli(['gate', 'plan', P, '--unchanged'], { env })
    expect(r.code, r.stderr).toBe(1)
    expect(r.stdout).toContain(`note: nothing was handed back — witness's version moved from ${prior} to ${version()} since round 1 — its verdict no longer answers the content`)
    expect(backs(repo, P)).toEqual([])
    const runs = runsOf(repo, P, 'plan')
    expect(runs).toHaveLength(2)
    expect(runs[1]!.cached).toBeUndefined()
    expect(runs[1]!.witness).toBe(version())
    expect(callCount(scenario)).toBeGreaterThan(calls)          // a fresh battery judged it
  }, 120_000)

  // S3-1. The hand-back is the author's reply to the revise they read: a decision that lands while the
  // gate resolves (ship's and implement's lanes run there) is one they never read, so the gate refuses
  // `settled-since` rather than stand a hand-back on it.
  it('a decision that lands between --unchanged\'s read and its write refuses settled-since, and nothing is handed back', async () => {
    const { repo, env } = await revisedPlan()
    const real = gateSpec('plan')!
    registerGate({
      ...real,
      async resolve(root, ctx, canon, cfg, target) {
        commitEntry(repo, P, decision('plan', P, 'approve', { override: true }) as never)
        return real.resolve(root, ctx, canon, cfg, target)
      },
    })
    try {
      const r = await repo.cli(['gate', 'plan', P, '--unchanged'], { env })
      expect(r.code, r.stdout).toBe(2)
      expect(r.stderr).toContain('settled-since')
      expect(r.stderr).toContain(cliAct('decide', 'plan', P, '--show').line)
    } finally {
      registerGate(real)
    }
    expect(backs(repo, P)).toEqual([])
    expect(readStream(repo.root, P).filter((e) => e.t === 'human-decision').at(-1)).toMatchObject({ decision: 'approve' })
  }, 120_000)

  // S3-1, the lock's half: the read is checked again under the lock, right before the write, so a
  // decision landing after the gate's own read of the journal still refuses. The wrapper lands it when
  // the gate builds its lenses' setup (it reads `lensReads` there), after that read and before the lock.
  it('a decision that lands after the gate\'s read, before the lock, refuses settled-since under the lock', async () => {
    const { repo, env } = await revisedPlan()
    const real = gateSpec('plan')!
    let landed = false
    registerGate({
      ...real,
      get lensReads() {
        if (!landed) { landed = true; commitEntry(repo, P, decision('plan', P, 'approve', { override: true }) as never) }
        return real.lensReads
      },
    })
    try {
      const r = await repo.cli(['gate', 'plan', P, '--unchanged'], { env })
      expect(landed).toBe(true)
      expect(r.code, r.stdout).toBe(2)
      expect(r.stderr).toContain('settled-since')
    } finally {
      registerGate(real)
    }
    expect(backs(repo, P)).toEqual([])
  }, 120_000)

  // S3-2. While the gate's own upstream revise is owed, `--unchanged` refuses, so the changed-nothing
  // screen does not offer it: its session line drops the hint, and no row names `--unchanged`.
  it('the changed-nothing screen leaves out the hand-back hint while upstream work is owed', async () => {
    const { repo, env } = await stoppedPlan()
    await ok(repo, ['decide', 'plan', P, '--revise', '--upstream', S, '--note', 'the spec leaves rotation open'], env)
    const r = await repo.cli(['gate', 'plan', P], { env })
    expect(r.code, r.stderr).toBe(1)
    expect(r.stdout).toContain('outcome: revise changed nothing')
    expect(r.stdout).toContain(kv('session', SESSION_LINE['revised-upstream']))
    expect(r.stdout).not.toContain('--unchanged')
  }, 120_000)

  // S3-3. A malformed round on other content judged nothing and leaves the pairing with the disposed
  // run: on the disposed run's content the gate answers changed-nothing, so the author can hand back.
  it('a malformed round on other content leaves the pairing, so --unchanged hands back', async () => {
    const { repo, env, run } = await revisedPlan()
    commitEntry(repo, P, copyRun(run, {
      run_id: 'r-malformed', round: 2, reviewed_sha: 'other-content-sha', outcome: 'malformed',
      verdicts: [], malformed: [{ reviewer: 'plan-reviewer', violations: [] }],
    }) as never)
    const r = await repo.cli(['gate', 'plan', P, '--unchanged'], { env })
    expect(r.code, r.stderr).toBe(1)
    expect(backs(repo, P)).toEqual([expect.objectContaining({ gate: 'plan', run_id: run.run_id, sha: run.reviewed_sha })])
    expect(runsOf(repo, P, 'plan')).toHaveLength(2)
  }, 120_000)

  // First build's review S3-4: `--fresh` re-judges the same content and spends a round; `--unchanged`
  // hands it back unjudged. Together they ask for both, so the gate refuses before anything runs.
  it('--fresh with --unchanged refuses, spending nothing', async () => {
    const { repo, env, scenario } = await revisedPlan()
    const before = readStream(repo.root, P).length
    const calls = callCount(scenario)
    const r = await repo.cli(['gate', 'plan', P, '--unchanged', '--fresh'], { env })
    expect(r.code, r.stdout).toBe(2)
    expect(r.stderr).toContain('fresh-unchanged')
    expect(readStream(repo.root, P)).toHaveLength(before)
    expect(callCount(scenario)).toBe(calls)
  }, 120_000)

  // Design §4.2.4 "The skills". Each stage skill names its own gate's hand-back, and the command it
  // names is the act the CLI keys as the hand-back (`actKey`), never `decide`.
  it('every stage skill and the router carry the hand-back line', () => {
    const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')
    const line = (cmd: string) => `you judge there is nothing to change, hand the revise back with \`${cmd}\`, and never \`decide\``
    for (const [skill, gate, target] of [
      ['witness-decompose', 'decompose', '--effort <effort>'],
      ['witness-design', 'design', '<spec-id>'],
      ['witness-plan', 'plan', '<plan-id>'],
      ['witness-implement', 'implement', '<plan-id>'],
      ['witness-ship', 'ship', '<plan-id>'],
    ] as const) {
      const cmd = `$WITNESS gate ${gate} ${target} --unchanged`
      expect(read(`plugin/skills/${skill}/SKILL.md`), skill).toContain(line(cmd))
      const words = cmd.split(' ').slice(1)
      expect(actKey(words), skill).toBe(actKey(cliAct('gate', gate, target.split(' ').at(-1)!, '--unchanged')))
    }
    expect(read('plugin/commands/witness.md')).toContain(line('$WITNESS gate <gate> <target> --unchanged'))
  })
})
