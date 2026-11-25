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
import { run as dismiss } from '../src/verbs/dismiss.js'
import { gateParked } from '../src/verbs/next.js'
import { loadConfig } from '../src/config.js'
import { needsYou, needYouRows } from '../src/needs-you.js'
import { loadCanon } from '../src/scan.js'
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
  const gateOut = async (name: string): Promise<string> => {
    const lines: string[] = []
    await runGate(fakeCtx(repo.root, { env: gateEnv(scenario), out: (l) => lines.push(l) }), name, planId, PLAIN)
    return lines.join('\n')
  }
  const lastRun = () => runs(repo, planId).at(-1)!
  return { repo, wt, planId, scenario, gate, gateOut, lastRun }
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

// Row 270 (§5, C23). Who gets the booking: the human, as a decision naming its act; never the policy.
describe('the human gets the booking; nobody else takes it (row 270)', () => {
  const cfgOf = (root: string) => { const r = loadConfig(root); if (!r.ok) throw new Error('config'); return r.value }

  it('a stop only the human may book is a decision naming its --book act (Done-when)', async () => {
    const b = await notJudged()
    const item = needsYou(b.repo.root, fakeCtx(b.repo.root), cfgOf(b.repo.root), loadCanon(b.repo.root), []).find((i) => i.kind === 'decision')!
    expect(needYouRows(item)).toEqual([`wait: decision · ship ${b.planId}`, `  run: witness decide ship ${b.planId} --show`, `  book: witness decide ship ${b.planId} --book lint`])
  }, 240_000)

  it('under autonomy a stop red only on the base is left for the human with no model call, and nothing is journaled (§5)', async () => {
    const b = await redForShip('on')
    expect(await b.gate('ship')).toBe(1)                                    // not measured: the policy revises
    baseRedFor(b)
    const decided = decisions(b.repo, b.planId).length
    const calls = callCount(b.scenario)
    const out = await b.gateOut('ship')                                     // the base read red: not judged
    expect(b.lastRun().checks.at(-1)!.parts).toEqual([expect.objectContaining({ part: 'ui', state: 'not-judged' })])
    expect(out).toContain(`autonomy: left for a human — only the human books lint — ui red on the base too · witness decide ship ${b.planId} --show`)
    expect(callCount(b.scenario)).toBe(calls)
    expect(decisions(b.repo, b.planId)).toHaveLength(decided)
  }, 240_000)

  it("two parts red, one the author can fix: the policy revises; once it is fixed the stop is the human's; a --book typed first books both (Review Focus 3)", async () => {
    const FIX = '! grep -rq FIXME src'
    const twoParts = async () => {
      const b = await redForShip('on')
      patchConfig(b.repo, { ship: { lint: { ui: LINT, fx: FIX } } })
      b.repo.git('add', 'witness.config.yaml'); b.repo.git('commit', '-q', '-m', 'two lint parts')
      grantCommands(b.repo.root, [FIX])
      writeFileSync(join(b.wt, 'src', 'fix.ts'), '// FIXME\n')
      expect(await b.gate('ship')).toBe(1)                                  // both not measured: the policy revises
      // ui red on the base too, fx green there: fx's red is the plan's own
      const [ui, fx] = b.lastRun().checks.at(-1)!.parts!
      const commit = parseBaseKey(ui!.key!)!.commit
      const tree = b.repo.git('rev-parse', `${commit}^{tree}`)
      journalShard(b.repo.root, { kind: BASE_LINT, key: ui!.key!, shard: 1, of: 1, outcome: 'done', ms: 1, result: { exit: 1, tree, commit } })
      journalShard(b.repo.root, { kind: BASE_LINT, key: fx!.key!, shard: 1, of: 1, outcome: 'done', ms: 1, result: { exit: 0, tree, commit } })
      expect(await b.gate('ship')).toBe(1)
      expect(b.lastRun().checks.at(-1)!.parts!.map((p) => [p.part, p.state])).toEqual([['ui', 'not-judged'], ['fx', 'red']])
      expect(decisions(b.repo, b.planId).at(-1)).toMatchObject({ decision: 'revise', selected: 'policy', rule: 'checks-only' })
      return b
    }
    const b = await twoParts()
    writeFileSync(join(b.wt, 'src', 'fix.ts'), '// fixed\n')              // the author fixes theirs
    const calls = callCount(b.scenario)
    const out = await b.gateOut('ship')
    expect(b.lastRun().checks.at(-1)!.parts!.map((p) => [p.part, p.state])).toEqual([['ui', 'not-judged'], ['fx', 'green']])
    expect(out).toContain('autonomy: left for a human — only the human books lint — ui red on the base too')
    expect(callCount(b.scenario)).toBe(calls)
    // a --book typed before the fix, at the human's terminal, books both parts, each listed
    const c = await twoParts()
    const asked: string[] = []
    const ctx: Ctx = { ...fakeCtx(c.repo.root, { tty: true }), ask: async (q) => { asked.push(q); return 'y' } }
    expect(await decide(ctx, ['ship', c.planId, '--book', 'lint'])).toBe(0)
    expect(asked[0]).toContain('\n  ui — the whole part, red against ')
    expect(asked[0]).toContain('\n  fx — the whole part, red against ')
    expect(openItems(c.repo.root, { plan: c.planId }).map((i) => i.part)).toEqual(['ui', 'fx'])
  }, 480_000)
})

describe('a booking — slice 2 review (row 270)', () => {
  it('under committed autonomy an uncommitted autonomy: off edit never skips the terminal (I3, row 171)', async () => {
    const b = await redForShip('on')
    expect(await b.gate('ship')).toBe(1)                                  // checks only: the policy revises
    patchConfig(b.repo, { autonomy: 'off' })                              // the working copy only — HEAD still says on
    const r = await b.repo.cli(['decide', 'ship', b.planId, '--book', 'lint'])
    expect([r.code, r.stderr]).toEqual([2, expect.stringContaining('book-needs-terminal')])
    expect(ledgerLen(b.repo)).toBe(0)
  }, 240_000)
})

describe('a booking dismissed in flight (row 269)', () => {
  it('a booking dismissed while its plan is in flight withholds again from the next lint run, never read as a pass (Review Focus 5)', async () => {
    const b = await notJudged()
    expect((await b.repo.cli(['decide', 'ship', b.planId, '--book', 'lint'])).code).toBe(0)
    const ctx: Ctx = { ...fakeCtx(b.repo.root, { tty: true }), ask: async () => 'y' }
    expect(await dismiss(ctx, ['ledger', '--item', '1', '--cause', 'judged-wrong', '--note', 'the error is ours'])).toBe(0)
    expect(ledgerItems(b.repo.root)[0]).toMatchObject({ state: 'dismissed', end: { cause: 'judged-wrong', note: 'the error is ours' } })
    expect(await b.gate('ship')).toBe(1)
    expect(b.lastRun()).toMatchObject({ checks_only: true })
    expect(b.lastRun().checks.at(-1)!.parts).toEqual([expect.objectContaining({ part: 'ui', state: 'not-judged' })])
  }, 240_000)
})
