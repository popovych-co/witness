// Row 274 (the trust design §3.2's waiver, §3.3, §3.9; the map's C26). A switch-off red on a round the
// lenses ran offers the booking — the AI judge's or the human's — after the revise that removes it; one
// item per line, and the re-gate on unchanged content replays the round's verdicts.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Ctx } from '../src/cli.js'
import { readStream } from '../src/journal.js'
import { ledgerItems, openItems } from '../src/ledger.js'
import type { DecisionEntry } from '../src/rounds.js'
import { applyDecision, run as decide } from '../src/verbs/decide.js'
import { run as dismiss } from '../src/verbs/dismiss.js'
import { CLEAN_FOUR, TOKEN_BROKEN, TOKEN_FIXED, callCount, fakeCtx, offRed, patchConfig, putVerdict } from './helpers.js'

const decisions = (b: Awaited<ReturnType<typeof offRed>>) =>
  readStream(b.repo.root, b.planId).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[]
const show = async (b: Awaited<ReturnType<typeof offRed>>) => (await b.repo.cli(['decide', 'implement', b.planId, '--show'])).stdout

describe('a switch-off red offers the booking (row 274)', () => {
  it('the block leads with the revise, then --book switch-offs; one item per line, and the re-gate replays the verdicts', async () => {
    const b = await offRed()
    expect(await b.gate()).toBe(1)
    // the revise may print bare or with its <why> slot (reviseAct); either way it leads, and the booking follows
    expect(await show(b)).toMatch(/1 · recommended · root[^\n]*\n {3}witness decide implement \S+ --revise[^\n]*\n[^]*2 · deferral[^\n]*\n {3}witness decide implement \S+ --book switch-offs\n/)
    const r = await b.repo.cli(['decide', 'implement', b.planId, '--book', 'switch-offs'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/^booked: l-[0-9a-f]{8} — switch-offs · eslint-disable-next-line in src\/token\.ts$/m)
    expect(decisions(b).at(-1)).toMatchObject({ decision: 'book', rule: 'waivable', recommended: 'revise', book: { check: 'switch-offs' } })
    expect(openItems(b.repo.root, { plan: b.planId })).toEqual([expect.objectContaining({
      kind: 'booked-switch-off', check: 'switch-offs', file: 'src/token.ts', token: 'eslint-disable-next-line' })])
    const calls = callCount(b.scenario)
    expect(await b.gate()).toBe(0)                                  // booked: the verdicts replayed, the round passed
    expect(callCount(b.scenario)).toBe(calls)                       // no lens was asked
    expect(b.lastRun().cached).toBe(true)
    expect(b.offsCheck()).toMatchObject({ ok: true, offs: [expect.objectContaining({ booked: 1 })] })
  }, 300_000)

  it('a booking dismissed before its re-gate journals a new round, red again, with the booking offered again (Review Focus 1)', async () => {
    const b = await offRed()
    await b.gate()
    expect((await b.repo.cli(['decide', 'implement', b.planId, '--book', 'switch-offs'])).code).toBe(0)
    const id = openItems(b.repo.root, { plan: b.planId })[0]!.id
    expect(await dismiss(fakeCtx(b.repo.root, { tty: true, answers: ['y'] }), ['ledger', '--item', id, '--cause', 'judged-wrong', '--note', 'remove it'])).toBe(0)
    const before = b.runs().length
    expect(await b.gate()).toBe(1)
    expect(b.runs()).toHaveLength(before + 1)
    expect(b.offsCheck()!.ok).toBe(false)
    const out = await show(b)
    expect(out).not.toContain('state: booked')
    expect(out).toContain('--book switch-offs')
  }, 300_000)

  it('not live beside a blocking finding or another failed check; the approve stays live after the booking (C26, row 93)', async () => {
    // a blocking finding: the revise is the author's first
    const b = await offRed()
    putVerdict(b.scenario, { ...CLEAN_FOUR, findings: [{ blocking: true, anchor: 'src/token.ts#rotateDue', claim: 'no expiry bound' }] })
    expect(await b.gate()).toBe(1)
    expect(await show(b)).not.toContain('--book')
    const r = await b.repo.cli(['decide', 'implement', b.planId, '--book', 'switch-offs'])
    expect([r.code, r.stderr]).toEqual([2, expect.stringContaining('nothing-pending')])
    // another red check beside it (the drift lane: the tests fail on the broken token)
    const c = await offRed()
    writeFileSync(join(c.wt, 'src/token.ts'), `${TOKEN_BROKEN}// eslint-disable-next-line no-console\n`)
    expect(await c.gate()).toBe(1)
    expect(c.lastRun().checks.filter((x) => !x.ok).map((x) => x.name).sort()).toEqual(['drift-lane', 'switch-offs'])
    expect(await show(c)).not.toContain('--book')
    // the approve stays the human's, live after the booking's block offered both
    const d = await offRed()
    await d.gate()
    const block = await show(d)
    expect(block).toContain(`witness decide implement ${d.planId} --approve`)
    expect(block).toMatch(/tradeoff: stamps the artifact over the red check — nothing books it, so the next gate meets it again/)
    expect((await d.repo.cli(['decide', 'implement', d.planId, '--approve'])).code).toBe(0)
  }, 600_000)

  it('a third copy of a booked line reads red for one copy and books as a fresh item (Review Focus 2)', async () => {
    const b = await offRed()
    writeFileSync(join(b.wt, 'src/token.ts'), `${TOKEN_FIXED}// @ts-ignore\nconst x = 1\n// @ts-ignore\n`)
    expect(await b.gate()).toBe(1)
    expect(b.offsCheck()).toMatchObject({ ok: false, offs: [{ token: '@ts-ignore', count: 2 }] })
    expect((await b.repo.cli(['decide', 'implement', b.planId, '--book', 'switch-offs'])).code).toBe(0)
    expect(await b.gate()).toBe(0)
    const first = openItems(b.repo.root, { plan: b.planId }).map((i) => i.id)
    writeFileSync(join(b.wt, 'src/token.ts'), `${TOKEN_FIXED}// @ts-ignore\nconst x = 1\n// @ts-ignore\n// @ts-ignore\n`)
    expect(await b.gate()).toBe(1)
    expect(b.offsCheck()).toMatchObject({ ok: false, offs: [{ token: '@ts-ignore', count: 3, booked: 2, items: first }] })
    const r = await b.repo.cli(['decide', 'implement', b.planId, '--book', 'switch-offs'])
    expect(r.code, r.stderr).toBe(0)
    const now = openItems(b.repo.root, { plan: b.planId })
    expect(now).toHaveLength(2)
    expect(now.find((i) => !first.includes(i.id))).toMatchObject({ kind: 'booked-switch-off', subject: { lines: { [b.offsCheck()!.offs![0]!.key]: 1 } } })
  }, 300_000)

  it('a typed booking: refused for the policy, on a nod, in a drive session; under committed autonomy only at a terminal, after a y (§3.9)', async () => {
    const b = await offRed()
    expect(await b.gate()).toBe(1)
    const errs: string[] = []
    const base = { gate: 'implement', target: b.planId, decision: 'book' as const, book: 'switch-offs' }
    expect(await applyDecision(fakeCtx(b.repo.root, { err: (l) => errs.push(l) }), { ...base, selected: 'policy' })).toBe(2)
    expect(errs.join('\n')).toContain('autonomy-cannot')
    expect(errs.join('\n')).toContain('the arbiter or the human books switch-offs')
    const nod = await b.repo.cli(['decide', 'implement', b.planId, '--book', 'switch-offs', '--via', 'affirmation'])
    expect([nod.code, nod.stderr]).toEqual([2, expect.stringContaining('nod-cannot')])
    const session = await b.repo.cli(['decide', 'implement', b.planId, '--book', 'switch-offs'], { env: { WITNESS_DRIVE: b.planId } })
    expect([session.code, session.stderr]).toEqual([2, expect.stringContaining('book-human')])
    patchConfig(b.repo, { autonomy: 'on' }); b.repo.git('add', 'witness.config.yaml'); b.repo.git('commit', '-q', '-m', 'autonomy')
    const argv = ['implement', b.planId, '--book', 'switch-offs']
    const plain = await b.repo.cli(['decide', ...argv])
    expect([plain.code, plain.stderr]).toEqual([2, expect.stringContaining('book-needs-terminal')])
    const asked: string[] = []
    const at = (answer: string): Ctx => ({ ...fakeCtx(b.repo.root, { tty: true, err: (l) => errs.push(l) }), ask: async (q) => { asked.push(q); return answer } })
    expect(await decide(at('n'), argv)).toBe(2)
    expect(errs.join('\n')).toContain('book-declined')
    expect(asked[0]).toBe(`book switch-offs for implement ${b.planId}:\n  eslint-disable-next-line in src/token.ts: no-console\nbook? an item stays open until main no longer holds it [y/N]`)
    expect(decisions(b).filter((d) => d.decision === 'book')).toEqual([])
    expect(await decide(at('y'), argv)).toBe(0)
    expect(decisions(b).filter((d) => d.decision === 'book')).toHaveLength(1)
    expect(openItems(b.repo.root, { plan: b.planId })).toHaveLength(1)
  }, 300_000)

  it("--book names its check: lint on a switch-off round books nothing and refuses nothing-pending, the ledger untouched (T2e's act-key ruling)", async () => {
    const b = await offRed()
    await b.gate()
    const r = await b.repo.cli(['decide', 'implement', b.planId, '--book', 'lint'])
    expect([r.code, r.stderr]).toEqual([2, expect.stringContaining('nothing-pending')])
    expect(ledgerItems(b.repo.root)).toEqual([])
  }, 300_000)
})
