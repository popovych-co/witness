// Row 270 (the trust design §3.2's waiver, §3.3, §3.9). A human books a lint red the author cannot
// fix: one decision and its ledger items, in one transaction; the re-gate then runs the lenses.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { grantCommands } from '../src/allowlist.js'
import { BASE_LINT, parseBaseKey } from '../src/base-lint.js'
import type { Ctx } from '../src/cli.js'
import { diagnosticKey } from '../src/diagnostics.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { journalShard } from '../src/jobs.js'
import { appendEntry, readStream } from '../src/journal.js'
import { bookLines, bookingsOf, ledgerItems, openItems } from '../src/ledger.js'
import type { DecisionEntry, GateRunEntry } from '../src/rounds.js'
import { LEDGER_STREAM } from '../src/streams.js'
import { applyDecision, run as decide } from '../src/verbs/decide.js'
import { gateParked } from '../src/verbs/next.js'
import {
  TOKEN_FIXED, callCount, crashCli, fakeCtx, fakeLint, fakeScenario, gateEnv, patchConfig, putVerdict, shippableRepo, type TestRepo,
} from './helpers.js'

// vitest-single lands 4 files in the worktree diff — coverage-minimum needs an anchor for each.
const CLEAN = {
  coverage: [
    { anchor: '.gitignore', note: 'read' },
    { anchor: 'package.json', note: 'read' },
    { anchor: 'src/token.ts', note: 'read' },
    { anchor: 'tests/token.test.ts', note: 'read' },
  ],
  findings: [],
}
const PLAIN = { fresh: false, manual: false }
const LINT = '! grep -rq LINTBAD src'

const runs = (repo: TestRepo, id: string) => readStream(repo.root, id).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]
const decisions = (repo: TestRepo, id: string) =>
  readStream(repo.root, id).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[]

// A shippable plan whose implement gate passed; `ship.lint` one opaque part, red on the plan's tree
// for ship alone. Autonomy as asked.
async function redForShip(autonomy: 'on' | 'off' = 'off') {
  const { repo, wt, planId } = await shippableRepo()
  const scenario = fakeScenario()
  putVerdict(scenario, CLEAN)
  const gate = (name: string, env: Record<string, string> = {}) =>
    runGate(fakeCtx(repo.root, { env: gateEnv(scenario, env) }), name, planId, PLAIN)
  expect(await gate('implement')).toBe(0)
  patchConfig(repo, { autonomy, ship: { lint: { ui: LINT } } })
  repo.git('add', 'witness.config.yaml'); repo.git('commit', '-q', '-m', 'one lint part')
  grantCommands(repo.root, [LINT])
  writeFileSync(join(wt, 'src', 'token.ts'), `${TOKEN_FIXED}// LINTBAD\n`)
  const lastRun = () => runs(repo, planId).at(-1)!
  return { repo, wt, planId, scenario, gate, lastRun }
}
type Bench = Awaited<ReturnType<typeof redForShip>>

// The base of the round's first lint part, read red as drive would journal it: no reader, not judged.
function baseRedFor(b: Bench): void {
  const key = b.lastRun().checks.at(-1)!.parts![0]!.key!
  const commit = parseBaseKey(key)!.commit
  journalShard(b.repo.root, { kind: BASE_LINT, key, shard: 1, of: 1, outcome: 'done', ms: 1,
    result: { exit: 1, tree: b.repo.git('rev-parse', `${commit}^{tree}`), commit } })
}

// A checks-only ship round whose ui part is not judged: red on the plan's tree and on its base.
async function notJudged(autonomy: 'on' | 'off' = 'off'): Promise<Bench> {
  const b = await redForShip(autonomy)
  expect(await b.gate('ship')).toBe(1)                                    // ui red, its base not measured
  baseRedFor(b)
  expect(await b.gate('ship')).toBe(1)                                    // the base read red: not judged
  expect(b.lastRun().checks.at(-1)!.parts).toEqual([expect.objectContaining({ part: 'ui', state: 'not-judged' })])
  return b
}

const ledgerLen = (repo: TestRepo) => readStream(repo.root, LEDGER_STREAM).length

describe('a human books a lint red (row 270)', () => {
  it('an opaque part red on the base too is booked whole: one decision, one item, then the re-gate runs the lenses (§3.3)', async () => {
    const b = await notJudged()
    const r = await b.repo.cli(['decide', 'ship', b.planId, '--book', 'lint'])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`decided: ship ${b.planId} → book`)
    expect(r.stdout).toMatch(/^booked: l-[0-9a-f]{8} — ui · the whole part, red against [0-9a-f]{7}, until main moves$/m)
    expect(r.stdout).toContain(`help: the re-gate reads it — witness gate ship ${b.planId}`)
    const d = decisions(b.repo, b.planId).at(-1)!
    expect(d).toMatchObject({ gate: 'ship', decision: 'book', book: { check: 'lint', items: [expect.stringMatching(/^l-/)] } })
    expect(openItems(b.repo.root, { plan: b.planId })).toEqual([expect.objectContaining({
      id: d.book!.items[0], kind: 'booked-check', check: 'lint', part: 'ui', subject: { whole: true },
      part_key: b.lastRun().checks.at(-1)!.parts![0]!.key, gate: 'ship', run_id: b.lastRun().run_id,
    })])
    expect((await b.repo.cli(['decide', 'ship', b.planId, '--show'])).stdout).toMatch(/state: booked — the re-gate reads the booking[^]*witness gate ship /)
    const calls = callCount(b.scenario)
    // lint booked: the lenses ran and found nothing; ship then stops for the human, as every PR does
    expect(await b.gate('ship')).toBe(1)
    expect(callCount(b.scenario)).toBeGreaterThan(calls)
    expect(b.lastRun()).toMatchObject({ outcome: 'stopped', standing: expect.stringContaining('a human sends every PR') })
    expect(b.lastRun().checks_only).toBeUndefined()
    expect(b.lastRun().verdicts!.flatMap((v) => v.findings)).toEqual([])
    expect(b.lastRun().checks.find((c) => c.name === 'lint')!.parts![0]).toMatchObject({ state: 'booked', items: d.book!.items })
  }, 240_000)

  it("a reader-bound part books its errors one by one: the item holds the round's book keys", async () => {
    const b = await redForShip()
    const cmd = fakeLint(b.repo)
    patchConfig(b.repo, { ship: { lint: { ui: undefined, biome: cmd.check } }, readers: { biome: cmd.sarif } })
    b.repo.git('add', '-A'); b.repo.git('commit', '-q', '-m', 'a reader')
    grantCommands(b.repo.root, [cmd.check, cmd.sarif])
    writeFileSync(join(b.wt, 'fake-lint.mjs'), b.repo.read('fake-lint.mjs'))
    writeFileSync(join(b.wt, 'src', 'new.ts'), 'BAD\n')
    writeFileSync(join(b.wt, 'src', 'token.ts'), TOKEN_FIXED)              // fake-lint reads LINTBAD as an error too
    expect(await b.gate('ship')).toBe(1)                                  // biome red, its base not measured
    // the base read red with an error of its own, as drive's base lint journals it
    const key = b.lastRun().checks.at(-1)!.parts![0]!.key!
    const commit = parseBaseKey(key)!.commit
    journalShard(b.repo.root, { kind: BASE_LINT, key, shard: 1, of: 1, outcome: 'done', ms: 1,
      result: { exit: 1, tree: b.repo.git('rev-parse', `${commit}^{tree}`), commit, read: { total: 1, keys: { ['e'.repeat(16)]: 1 } } } })
    expect(await b.gate('ship')).toBe(1)
    const part = b.lastRun().checks.at(-1)!.parts![0]!
    const KEY_NEW = diagnosticKey({ tool: 'biome', rule: 'lint/test/noBad', file: 'src/new.ts', snippet: 'BAD' })
    expect(part).toMatchObject({ part: 'biome', state: 'new' })
    expect(part.book).toEqual({ [KEY_NEW]: 1 })
    const r = await b.repo.cli(['decide', 'ship', b.planId, '--book', 'lint'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^booked: l-[0-9a-f]{8} — biome · 1 diagnostic$/m)
    expect(openItems(b.repo.root, { plan: b.planId })).toEqual([expect.objectContaining({ part: 'biome', tool: 'biome', subject: { diagnostics: part.book } })])
  }, 240_000)

  it('--book refuses where nothing is bookable or the stream is taken, writing nothing (Review Focus 4)', async () => {
    const b = await notJudged()
    const unchanged = () => [decisions(b.repo, b.planId).length, ledgerLen(b.repo)]
    const before = unchanged()
    const markers = await b.repo.cli(['decide', 'ship', b.planId, '--book', 'markers'])
    expect([markers.code, markers.stderr]).toEqual([2, expect.stringContaining('no-waiver')])
    const nope = await b.repo.cli(['decide', 'ship', b.planId, '--book', 'nope'])
    expect([nope.code, nope.stderr]).toEqual([2, expect.stringContaining('unknown-check')])
    const both = await b.repo.cli(['decide', 'ship', b.planId, '--book', 'lint', '--override'])
    expect([both.code, both.stderr]).toEqual([2, expect.stringContaining('book-scope')])
    const two = await b.repo.cli(['decide', 'ship', b.planId, '--book', 'lint', '--stop'])
    expect([two.code, two.stderr]).toEqual([2, expect.stringContaining('one-of-required')])
    expect(unchanged()).toEqual(before)
    expect((await b.repo.cli(['decide', 'ship', b.planId, '--book', 'lint'])).code).toBe(0)
    const again = await b.repo.cli(['decide', 'ship', b.planId, '--book', 'lint'])
    expect(again.code).toBe(2)
    expect(again.stderr).toContain('nothing-pending')
    expect(again.stderr).toContain(`witness gate ship ${b.planId}`)
    // a judged round: nothing to book
    expect(await b.gate('ship')).toBe(1)                                  // judged; ship stops for the human
    expect(b.lastRun().checks_only).toBeUndefined()
    const judged = unchanged()
    const settled = await b.repo.cli(['decide', 'ship', b.planId, '--book', 'lint'])
    expect([settled.code, settled.stderr]).toEqual([2, expect.stringContaining('nothing-pending')])
    expect(unchanged()).toEqual(judged)
  }, 240_000)

  it('a ledger stream another history holds refuses the booking, writing nothing (Review Focus 4)', async () => {
    const b = await notJudged()
    appendEntry(b.repo.root, LEDGER_STREAM, { t: 'recap', effort: 'ledger' } as never)
    b.repo.git('add', '.witness/journal'); b.repo.git('commit', '-q', '-m', 'a doc named ledger')
    const before = decisions(b.repo, b.planId).length
    const r = await b.repo.cli(['decide', 'ship', b.planId, '--book', 'lint'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('stream-taken')
    expect(decisions(b.repo, b.planId)).toHaveLength(before)
    expect(ledgerLen(b.repo)).toBe(1)
  }, 240_000)

  it("a booking is the human's: the policy, the arbiter, a drive session and a nod are refused (§3.9)", async () => {
    const b = await notJudged()
    const errs: string[] = []
    const ctx = fakeCtx(b.repo.root, { err: (l) => errs.push(l) })
    const base = { gate: 'ship', target: b.planId, decision: 'book' as const, book: 'lint' }
    expect(await applyDecision(ctx, { ...base, selected: 'policy' })).toBe(2)
    expect(await applyDecision(ctx, { ...base, selected: 'arbiter', reason: 'r', arbiter: { model: 'm', prompts_sha: 'p' } })).toBe(2)
    expect(errs.filter((l) => l.includes('autonomy-cannot'))).toHaveLength(2)
    const session = await b.repo.cli(['decide', 'ship', b.planId, '--book', 'lint'], { env: { WITNESS_DRIVE: b.planId } })
    expect([session.code, session.stderr]).toEqual([2, expect.stringContaining('book-human')])
    expect(session.stderr).toContain(`witness decide ship ${b.planId} --book lint`)
    const nod = await b.repo.cli(['decide', 'ship', b.planId, '--book', 'lint', '--via', 'affirmation'])
    expect([nod.code, nod.stderr]).toEqual([2, expect.stringContaining('nod-cannot')])
    expect(decisions(b.repo, b.planId).filter((d) => d.decision === 'book')).toEqual([])
    expect(ledgerLen(b.repo)).toBe(0)
  }, 240_000)

  it('under committed autonomy a typed --book needs a terminal and asks first (Done-when)', async () => {
    const b = await redForShip('on')
    expect(await b.gate('ship')).toBe(1)                                  // checks only: the policy revises
    expect(decisions(b.repo, b.planId).at(-1)).toMatchObject({ decision: 'revise', selected: 'policy' })
    const argv = ['ship', b.planId, '--book', 'lint']
    const plain = await b.repo.cli(['decide', ...argv])
    expect([plain.code, plain.stderr]).toEqual([2, expect.stringContaining('book-needs-terminal')])
    const asked: string[] = []
    const errs: string[] = []
    const at = (answer: string): Ctx => ({
      ...fakeCtx(b.repo.root, { tty: true, err: (l) => errs.push(l) }), ask: async (q) => { asked.push(q); return answer },
    })
    expect(await decide(at('n'), argv)).toBe(2)
    expect(errs.join('\n')).toContain('book-declined')
    expect(asked[0]).toMatch(new RegExp(`^book lint for ship ${b.planId}:\\n  ui — the whole part, red against [0-9a-f]{7}, until main moves\\nbook\\? an item stays open until main no longer holds it \\[y/N\\]$`))
    expect(decisions(b.repo, b.planId).filter((d) => d.decision === 'book')).toEqual([])
    expect(ledgerLen(b.repo)).toBe(0)
    expect(await decide(at('y'), argv)).toBe(0)
    expect(decisions(b.repo, b.planId).filter((d) => d.decision === 'book')).toHaveLength(1)
    expect(openItems(b.repo.root, { plan: b.planId })).toHaveLength(1)
  }, 240_000)

  it('a kill after the journal lines land is completed once (Done-when)', async () => {
    const b = await notJudged()
    expect(await crashCli(b.repo.root, ['decide', 'ship', b.planId, '--book', 'lint'], 'decide-journal')).toBe(9)
    expect((await b.repo.cli(['recover', '--complete'])).code).toBe(0)
    expect(decisions(b.repo, b.planId).filter((d) => d.decision === 'book')).toHaveLength(1)
    expect(ledgerItems(b.repo.root)).toHaveLength(1)
    expect(readStream(b.repo.root, LEDGER_STREAM)).toHaveLength(1)
    const again = await b.repo.cli(['decide', 'ship', b.planId, '--book', 'lint'])
    expect([again.code, again.stderr]).toEqual([2, expect.stringContaining('nothing-pending')])
  }, 240_000)

  it('a booking on a parked gate lifts the park, and a booking whose key is open reuses its item', async () => {
    const b = await notJudged()
    expect((await b.repo.cli(['decide', 'ship', b.planId, '--stop'])).code).toBe(0)
    expect(gateParked(readStream(b.repo.root, b.planId), 'ship')).toBe(true)
    expect((await b.repo.cli(['decide', 'ship', b.planId, '--book', 'lint'])).code).toBe(0)
    expect(gateParked(readStream(b.repo.root, b.planId), 'ship')).toBe(false)
    expect((await b.repo.cli(['decide', 'ship', b.planId, '--show'])).stdout).toContain('state: booked')
    const [open] = openItems(b.repo.root, { plan: b.planId })
    const lines = bookLines(b.repo.root, b.planId, 'ship', b.lastRun(), bookingsOf(b.lastRun(), 'lint'))
    expect(lines).toEqual([{ id: open!.id }])
  }, 240_000)
})
