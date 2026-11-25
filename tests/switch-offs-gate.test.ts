// Row 273 (§4 T3, §3.2). A switch-off a plan adds is a judged red at implement and ship: the battery
// still runs, the reviewers are told each line from the tree, and the round stops.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { appendEntry, readStream } from '../src/journal.js'
import type { GateRunEntry } from '../src/rounds.js'
import { LEDGER_STREAM } from '../src/streams.js'
import { switchOffKey, switchOffsCheck } from '../src/switch-offs.js'
import {
  CLEAN_THREE, TOKEN_FIXED, callCount, callFor, fakeCtx, fakeScenario, gateEnv, offRed, putVerdict, shippableRepo, tmpRepo, type TestRepo,
} from './helpers.js'

const CLEAN = CLEAN_THREE
const PLAIN = { fresh: false, manual: false }

const runs = (repo: TestRepo, id: string) => readStream(repo.root, id).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]

describe('the switch-offs check (row 273)', () => {
  it('a switch-off the plan adds is a judged red: the lenses run, the round stops, the line is journaled', async () => {
    const b = await offRed()
    expect(await b.gate()).toBe(1)
    expect(b.lastRun().checks_only).toBeUndefined()
    expect(callCount(b.scenario)).toBeGreaterThan(0)
    expect(b.offsCheck()).toMatchObject({ ok: false,
      offs: [{ token: 'eslint-disable-next-line', file: 'src/token.ts', line: 8, count: 1, rules: ['no-console'] }],
      detail: expect.stringContaining('src/token.ts:8 eslint-disable-next-line (no-console)') })
  }, 240_000)

  it("the reviewers' prompt names each switch-off from the tree (§4 T3: reviewers see it)", async () => {
    const b = await offRed()
    await b.gate()
    const asked = readFileSync(join(callFor(b.scenario, 'code-reviewer')!, 'stdin'), 'utf8')
    expect(asked).toContain('### Switch-offs this plan adds\n\n- src/token.ts:8 — eslint-disable-next-line (no-console)')
  }, 240_000)

  it('a plan that adds none passes it at implement and ship', async () => {
    const { repo, planId } = await shippableRepo()
    const scenario = fakeScenario(); putVerdict(scenario, CLEAN)
    const gate = (name: string) => runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), name, planId, PLAIN)
    const offsOf = () => runs(repo, planId).at(-1)!.checks.find((c) => c.name === 'switch-offs')
    expect(await gate('implement')).toBe(0)
    // Row 275: the gate appends the tests segment (a filtered runner never compares).
    expect(offsOf()).toMatchObject({ ok: true, detail: expect.stringMatching(
      /^no switch-off in the lines the plan adds \(\d+ files\) · tests not checked — the runner is filtered — the tests effect reads a full-suite junit report$/) })
    expect(offsOf()!.offs).toBeUndefined()
    const asked = readFileSync(join(callFor(scenario, 'code-reviewer')!, 'stdin'), 'utf8')
    expect(asked).not.toContain('### Switch-offs this plan adds')
    await gate('ship')
    expect(runs(repo, planId).at(-1)!.gate).toBe('ship')
    expect(offsOf()).toMatchObject({ ok: true })
  }, 240_000)

  it('ship runs it too', async () => {
    const { repo, wt, planId } = await shippableRepo()
    const scenario = fakeScenario(); putVerdict(scenario, CLEAN)
    const gate = (name: string) => runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), name, planId, PLAIN)
    expect(await gate('implement')).toBe(0)
    writeFileSync(join(wt, 'src/token.ts'), `${TOKEN_FIXED}// @ts-expect-error a type test\n`)
    expect(await gate('ship')).toBe(1)
    const run = runs(repo, planId).at(-1)!
    expect(run.gate).toBe('ship')
    expect(run.checks.find((c) => c.name === 'switch-offs')).toMatchObject({ ok: false,
      offs: [{ token: '@ts-expect-error', file: 'src/token.ts', line: 8, count: 1 }] })
    expect(readFileSync(join(callFor(scenario, 'code-reviewer')!, 'stdin'), 'utf8'))
      .toContain('### Switch-offs this plan adds\n\n- src/token.ts:8 — @ts-expect-error\n')
  }, 240_000)

  it('a path holding a bidi character is spelled out in the detail and the note (Review Focus 3)', async () => {
    const odd = `src/we${String.fromCodePoint(0x202e)}ird.ts`
    const b = await offRed('// @ts-ignore', odd)
    putVerdict(b.scenario, { ...CLEAN, coverage: [...CLEAN.coverage, { anchor: odd, note: 'read' }] })
    await b.gate()
    const detail = b.offsCheck()!.detail!
    expect(detail).toContain('src/we\\u{202e}ird.ts:1 @ts-ignore')
    expect(detail).not.toContain(String.fromCodePoint(0x202e))
    expect(readFileSync(join(callFor(b.scenario, 'code-reviewer')!, 'stdin'), 'utf8')).toContain('- src/we\\u{202e}ird.ts:1 — @ts-ignore')
  }, 240_000)
})

describe("the plan's own booking covers its line (row 274, C17)", () => {
  // A repo whose plan adds one switch-off line twice over its base's none.
  function twice() {
    const repo = tmpRepo()
    repo.write('src/a.ts', 'a()\n'); repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'base')
    const base = repo.git('rev-parse', 'HEAD')
    repo.write('src/a.ts', 'a()\n// @ts-ignore\nb()\n// @ts-ignore\n')
    const key = switchOffKey({ token: '@ts-ignore', file: 'src/a.ts', snippet: '// @ts-ignore' })
    const book = (id: string, over: Record<string, unknown> = {}) => appendEntry(repo.root, LEDGER_STREAM, {
      t: 'ledger-open', id, key: '0'.repeat(16), kind: 'booked-switch-off', check: 'switch-offs', plan: 'p1', gate: 'implement',
      round: 1, run_id: 'r-1', file: 'src/a.ts', token: '@ts-ignore', subject: { lines: { [key]: 1 } }, ...over } as never)
    const check = () => switchOffsCheck(repo.root, repo.root, { checks: { switchOffs: [] } } as never, base, 'p1', ['src/a.ts'])
    return { repo, key, book, check }
  }

  it('a booking of one copy leaves the other red; a second covers it and the check passes', () => {
    const t = twice()
    expect(t.check()).toMatchObject({ ok: false, offs: [{ key: t.key, count: 2 }] })
    t.book('l-00000001')
    expect(t.check()).toMatchObject({ ok: false, offs: [{ key: t.key, count: 2, booked: 1, items: ['l-00000001'] }],
      detail: '1 switch-off line the plan adds — src/a.ts:2 @ts-ignore · 1 booked (l-00000001)' })
    t.book('l-00000002')
    expect(t.check()).toMatchObject({ ok: true, offs: [{ key: t.key, count: 2, booked: 2, items: ['l-00000001', 'l-00000002'] }],
      detail: 'no unbooked switch-off in the lines the plan adds — 2 booked (l-00000001, l-00000002)' })
  })

  it("another plan's booking, a closed one and a dismissed one cover nothing", () => {
    const t = twice()
    t.book('l-00000001', { plan: 'p9' })
    t.book('l-00000002')
    appendEntry(t.repo.root, LEDGER_STREAM, { t: 'ledger-closed', id: 'l-00000002', by: 'merge', plan: 'p8' } as never)
    t.book('l-00000003', { subject: { lines: { [t.key]: 2 } } })
    appendEntry(t.repo.root, LEDGER_STREAM, { t: 'ledger-dismissed', id: 'l-00000003', cause: 'judged-wrong', note: 'x' } as never)
    const c = t.check()
    expect(c.ok).toBe(false)
    expect(c.offs![0]!.booked).toBeUndefined()
    expect(c.offs![0]!.items).toBeUndefined()
  })
})
