// Row 281 (§4 T4's waiver, the map's C41). A marked finding without a proven guard is the judge's to
// waive: a booking that is a decision naming the anchors, never a ledger item.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Ctx } from '../src/cli.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { guardsCheck } from '../src/guard.js'
import { readStream } from '../src/journal.js'
import { ledgerItems } from '../src/ledger.js'
import { recommend } from '../src/recommend.js'
import type { DecisionEntry, GateRunEntry } from '../src/rounds.js'
import { applyDecision, run as decide } from '../src/verbs/decide.js'
import { CLEAN_THREE, callFor, fakeCtx, fakeScenario, gateEnv, patchConfig, putVerdict, shippableRepo } from './helpers.js'

const mark = (anchor: string) => ({ anchor, claim: 'rotates late', blocking: true, guard: 'test' })

// Round 1 marks `anchors` (blocking); the author revises; round 2's lenses find nothing, so the guards
// check is the round's only red.
async function guardRed(anchors = ['src/token.ts'], opts: { autonomy?: boolean; env?: Record<string, string>; arbiter?: unknown } = {}) {
  const { repo, wt, planId } = await shippableRepo()
  const scenario = fakeScenario()
  const gate = (env: Record<string, string> = {}) =>
    runGate(fakeCtx(repo.root, { env: gateEnv(scenario, env) }), 'implement', planId, { fresh: false, manual: false })
  putVerdict(scenario, { ...CLEAN_THREE, findings: anchors.map(mark) })
  await gate()
  const head = execFileSync('git', ['show', 'HEAD:src/token.ts'], { cwd: wt, encoding: 'utf8' })
  writeFileSync(join(wt, 'src/token.ts'), `${head}// revised\n`)
  execFileSync('git', ['commit', '-qam', 'revise'], { cwd: wt })
  if (opts.autonomy === true) { patchConfig(repo, { autonomy: 'on' }); repo.git('add', 'witness.config.yaml'); repo.git('commit', '-q', '-m', 'autonomy') }
  if (opts.arbiter !== undefined) putVerdict(scenario, opts.arbiter, 'arbiter')
  putVerdict(scenario, CLEAN_THREE)
  const code = await gate(opts.env)
  const runs = () => readStream(repo.root, planId).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]
  const decisions = () => readStream(repo.root, planId).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[]
  const check = () => guardsCheck(repo.root, wt, planId, 'implement')
  return { repo, wt, planId, scenario, code, runs, decisions, check }
}

describe('the guards waiver (row 281)', () => {
  it('the human books a guard at a terminal: one decision naming the finding, no ledger item; the re-gate reads it waived (row 281)', async () => {
    const b = await guardRed()
    expect(b.runs().at(-1)!.checks.find((c) => c.name === 'guards')).toMatchObject({ ok: false })
    patchConfig(b.repo, { autonomy: 'on' }); b.repo.git('add', 'witness.config.yaml'); b.repo.git('commit', '-q', '-m', 'autonomy')
    const asked: string[] = []
    const at: Ctx = { ...fakeCtx(b.repo.root, { tty: true }), ask: async (q) => { asked.push(q); return 'y' } }
    const out: string[] = []
    expect(await decide({ ...at, out: (l) => out.push(l) }, ['implement', b.planId, '--book', 'guards'])).toBe(0)
    expect(asked[0]).toBe(`book guards for implement ${b.planId}:\n  guards · src/token.ts\nbook? the guard is waived for this plan, and the PR's proof lists it [y/N]`)
    expect(b.decisions().at(-1)).toMatchObject({ decision: 'book', book: { check: 'guards', items: [], findings: ['src/token.ts'] } })
    expect(out).toContain('booked: guards · src/token.ts')
    expect(ledgerItems(b.repo.root)).toEqual([])
    expect(b.check()).toMatchObject({ ok: true, guards: [{ anchor: 'src/token.ts', state: 'waived' }] })
  }, 300_000)

  it('--finding names one owed anchor; an anchor the round does not owe refuses', async () => {
    const b = await guardRed(['src/token.ts', 'tests/token.test.ts'])
    const nope = await b.repo.cli(['decide', 'implement', b.planId, '--book', 'guards', '--finding', 'src/nope.ts'])
    expect([nope.code, nope.stderr]).toEqual([2, expect.stringContaining('finding-not-owed')])
    const one = await b.repo.cli(['decide', 'implement', b.planId, '--book', 'guards', '--finding', 'tests/token.test.ts'])
    expect(one.code, one.stderr).toBe(0)
    expect(b.decisions().at(-1)).toMatchObject({ book: { check: 'guards', items: [], findings: ['tests/token.test.ts'] } })
    expect(b.check()).toMatchObject({ ok: false, guards: [{ anchor: 'src/token.ts', state: 'owed' }, { anchor: 'tests/token.test.ts', state: 'waived' }] })
  }, 300_000)

  it('--finding with another check, or without --book, refuses book-scope', async () => {
    const b = await guardRed()
    for (const argv of [['--book', 'switch-offs', '--finding', 'src/token.ts'], ['--revise', '--finding', 'src/token.ts']]) {
      const r = await b.repo.cli(['decide', 'implement', b.planId, ...argv])
      expect([r.code, r.stderr]).toEqual([2, expect.stringContaining('book-scope')])
    }
    expect(b.decisions().filter((d) => d.decision === 'book')).toEqual([])
  }, 300_000)

  it('a typed booking under committed autonomy without a terminal refuses book-needs-terminal; under a session marker book-human; the policy never books', async () => {
    const b = await guardRed()
    const session = await b.repo.cli(['decide', 'implement', b.planId, '--book', 'guards'], { env: { WITNESS_DRIVE: b.planId } })
    expect([session.code, session.stderr]).toEqual([2, expect.stringContaining('book-human')])
    const errs: string[] = []
    expect(await applyDecision(fakeCtx(b.repo.root, { err: (l) => errs.push(l) }),
      { gate: 'implement', target: b.planId, decision: 'book', book: 'guards', selected: 'policy' })).toBe(2)
    expect(errs.join('\n')).toContain('autonomy-cannot')
    patchConfig(b.repo, { autonomy: 'on' }); b.repo.git('add', 'witness.config.yaml'); b.repo.git('commit', '-q', '-m', 'autonomy')
    const plain = await b.repo.cli(['decide', 'implement', b.planId, '--book', 'guards'])
    expect([plain.code, plain.stderr]).toEqual([2, expect.stringContaining('book-needs-terminal')])
    expect(b.decisions().filter((d) => d.decision === 'book')).toEqual([])
  }, 300_000)

  it('rule waivable offers --book guards with its words when guards is the only red', async () => {
    const b = await guardRed()
    const rec = recommend({ gate: 'implement', target: b.planId, entries: readStream(b.repo.root, b.planId) })!
    expect(rec.rule).toBe('waivable')
    expect(rec.options.map((o) => o.act?.argv.join(' '))).toContain(`decide implement ${b.planId} --book guards`)
    expect(rec.options[0]!.why).toContain('1 marked finding has no proven guard (src/token.ts)')
    expect(rec.options[0]!.why).toContain('prove a guard')
    const booking = rec.options.find((o) => o.act?.argv.includes('--book'))!
    expect(booking.when).toContain('the finding is not one a machine can catch')
    expect(booking.tradeoff).toContain("waives the guard for this plan; the PR's proof lists it")
  }, 300_000)
})

describe('the judge books a guard under autonomy (row 281)', () => {
  it('the arbiter books it in-process in the gate a drive session ran, reading counts and the owed anchor', async () => {
    const b = await guardRed(['src/token.ts'], { autonomy: true, env: { WITNESS_DRIVE: 'x' }, arbiter: { choice: 2, reason: 'the finding names a judgment, not a shape' } })
    expect(b.decisions().at(-1)).toMatchObject({ decision: 'book', selected: 'arbiter', rule: 'waivable', book: { check: 'guards', items: [], findings: ['src/token.ts'] } })
    const asked = readFileSync(join(callFor(b.scenario, 'arbiter')!, 'stdin'), 'utf8')
    expect(asked).toContain(`2. witness decide implement ${b.planId} --book guards`)
    expect(asked).toContain('guards: FAILED · 1 marked · 0 proven · 0 waived · 1 owed (lint 0, test 1) · owed src/token.ts')
    expect(asked).toContain('A marked finding without a proven guard is waived only when the finding is not one a machine can catch')
    expect(ledgerItems(b.repo.root)).toEqual([])
  }, 300_000)
})
