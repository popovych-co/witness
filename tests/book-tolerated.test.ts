// Row 284 (§3.2, C46). Tolerated growth is the human's to book: a typed booking opens a `book` set for the
// plan; the arbiter's menu holds none, the policy revises, a session or the policy refuses.
import { describe, expect, it } from 'vitest'
import { menuFor } from '../src/arbiter.js'
import { policyFor } from '../src/autonomy.js'
import type { Ctx } from '../src/cli.js'
import type { Config } from '../src/config.js'
import { diagnosticKey, normalizeSnippet } from '../src/diagnostics.js'
import { appendEntry, readStream } from '../src/journal.js'
import { ledgerItems } from '../src/ledger.js'
import { recommend } from '../src/recommend.js'
import type { DecisionEntry } from '../src/rounds.js'
import { LEDGER_STREAM } from '../src/streams.js'
import { applicableSets, toleratedCheck } from '../src/tolerated.js'
import { applyDecision, run as decide } from '../src/verbs/decide.js'
import { autonomyOn, fakeCtx, git, tmpRepo, toleratedBench, TOLERATED_L1, TOLERATED_SET, TOLERATED_TWO } from './helpers.js'

const NEW = 'export const three = 3 // SWALLOW three'
const keyOf = (file: string, line: string) => diagnosticKey({ tool: 'eslint', rule: 'no-swallow', file, snippet: normalizeSnippet(line) })

// The swap of tests/tolerated-gate.test.ts: a round withheld by `tolerated`, one new spot at src/a.ts:2.
async function swapped() {
  const b = await toleratedBench({ main: TOLERATED_TWO, set: TOLERATED_SET })
  b.put('src/a.ts', `${TOLERATED_L1}\n${NEW}\n`)
  await b.gate()
  expect(b.last().checks.at(-1)).toMatchObject({ name: 'tolerated', ok: false })
  const decisions = () => readStream(b.repo.root, b.planId).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[]
  return { ...b, decisions }
}

describe('a human books tolerated growth (row 284)', () => {
  it('a human books growth: the set opens for this plan and the re-gate passes (row 284)', async () => {
    const b = await swapped()
    const out: string[] = []
    expect(await decide({ ...fakeCtx(b.repo.root), out: (l) => out.push(l) }, ['implement', b.planId, '--book', 'tolerated'])).toBe(0)
    const sets = ledgerItems(b.repo.root).filter((i) => i.kind === 'tolerated-set' && i.plan === b.planId)
    expect(sets).toEqual([expect.objectContaining({ kind: 'tolerated-set', check: 'tolerated', origin: 'book', state: 'open',
      subject: { spots: { [keyOf('src/a.ts', NEW)]: { file: 'src/a.ts', copies: 1 } } } })])
    expect(sets[0]).not.toHaveProperty('anchor')
    expect(b.decisions().at(-1)).toMatchObject({ decision: 'book', book: { check: 'tolerated', items: [sets[0]!.id] } })
    expect(out.join('\n')).toContain('tolerated · eslint no-swallow tolerated')
    await b.gate()
    expect(b.check('tolerated')).toMatchObject({ ok: true })
  }, 300_000)

  it('the arbiter and the policy never book tolerated growth: the policy revises (row 284, Review Focus 5)', async () => {
    const b = await swapped()
    const entries = readStream(b.repo.root, b.planId)
    const block = recommend({ gate: 'implement', target: b.planId, upstream: undefined, stale: false, entries })!
    expect(block.rule).toBe('checks-only')
    expect(block.options.map((o) => o.command)).toContain(`witness decide implement ${b.planId} --book tolerated`)
    expect(menuFor(block, b.last()).some((o) => o.act.argv.includes('--book'))).toBe(false)
    const policy = policyFor({ at: 'gate', gate: 'implement', target: b.planId, entries, run: b.last(), block, untrusted: [] })
    expect(policy).toMatchObject({ kind: 'take', act: { argv: ['decide', 'implement', b.planId, '--revise'] } })
    const errs: string[] = []
    expect(await applyDecision(fakeCtx(b.repo.root, { err: (l) => errs.push(l) }),
      { gate: 'implement', target: b.planId, decision: 'book', book: 'tolerated', selected: 'policy' })).toBe(2)
    expect(errs.join('\n')).toContain('autonomy-cannot')
    expect(errs.join('\n')).toContain('only the human books tolerated')
    const session = await b.repo.cli(['decide', 'implement', b.planId, '--book', 'tolerated'], { env: { WITNESS_DRIVE: b.planId } })
    expect([session.code, session.stderr]).toEqual([2, expect.stringContaining('book-human')])
    expect(b.decisions().filter((d) => d.decision === 'book')).toEqual([])
  }, 300_000)

  it('under committed autonomy the booking asks at a terminal, naming each rule and its spots (row 284)', async () => {
    const b = await swapped()
    autonomyOn(b.repo)
    const plain = await b.repo.cli(['decide', 'implement', b.planId, '--book', 'tolerated'])
    expect([plain.code, plain.stderr]).toEqual([2, expect.stringContaining('book-needs-terminal')])
    const asked: string[] = []
    const at: Ctx = { ...fakeCtx(b.repo.root, { tty: true }), ask: async (q) => { asked.push(q); return 'y' } }
    expect(await decide(at, ['implement', b.planId, '--book', 'tolerated'])).toBe(0)
    expect(asked[0]).toBe(`book tolerated for implement ${b.planId}:\n  eslint no-swallow: 1 spot in src/a.ts\nbook? an item stays open until main no longer holds it [y/N]`)
  }, 300_000)
})

describe('a booked growth set once its plan merged (row 284)', () => {
  it('a booked growth set applies to every plan once its plan merges (row 284)', () => {
    const repo = tmpRepo()
    const spot = { tool: 'eslint' as const, rule: 'no-swallow', file: 'src/a.ts', line: 2, snippet: normalizeSnippet(NEW) }
    appendEntry(repo.root, LEDGER_STREAM, { t: 'ledger-open', id: 'l-00000001', key: '1'.repeat(16), kind: 'tolerated-set', check: 'tolerated', plan: 'booker',
      gate: 'implement', round: 2, run_id: 'r-2', tool: 'eslint', rule: 'no-swallow', origin: 'book', subject: { spots: { [diagnosticKey(spot)]: { file: 'src/a.ts', copies: 1 } } } } as never)
    repo.write('src/a.ts', `x\n${NEW}\n`)
    git(repo.root, 'add', '-A'); git(repo.root, 'commit', '-qm', 'the booker merged')
    const base = git(repo.root, 'rev-parse', 'HEAD')
    const cfg = { readers: { eslint: 'npx eslint -f json .' } } as unknown as Config
    const check = () => toleratedCheck(repo.root, repo.root, cfg, 'later', base, 'implement',
      { sets: applicableSets(repo.root, 'later'), tools: new Map([['eslint', { ok: true, spots: [spot] }]]), wrote: [] })
    expect(applicableSets(repo.root, 'later')).toEqual([])
    appendEntry(repo.root, 'booker', { t: 'status', artifact: 'booker', from: 'in-progress', to: 'done', cause: 'merge', pr: 5 } as never)
    expect(check()).toMatchObject({ ok: true, detail: 'eslint no-swallow: 1 spot, all tolerated' })
  })
})
