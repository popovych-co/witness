import { describe, expect, it } from 'vitest'
import { appendEntry, type Entry } from '../src/journal.js'
import { checksFold, record, recordLine, recordTables } from '../src/record.js'
import { diagnosticKey, normalizeSnippet } from '../src/diagnostics.js'
import { LEDGER_STREAM } from '../src/streams.js'
import { loadCanon } from '../src/scan.js'
import { PLAN_BODY, approve, seededRepo, writePlan, writeSpec, type CliResult, type TestRepo } from './helpers.js'

// Row 282. The record's checks added: the guards merged plans journaled — lint by tool and rule, with
// the plans that added them, and tests counted. A plan still in flight adds none.

const must = (r: CliResult) => { if (r.code !== 0) throw new Error(`${r.stdout}\n${r.stderr}`) }
const guard = (repo: TestRepo, plan: string, kind: 'lint' | 'test', rule?: { tool: string; rule: string }) =>
  appendEntry(repo.root, plan, {
    t: 'guard', gate: 'implement', anchor: 'src/a.ts', round: 1, run: 'r1', kind, ...(rule !== undefined ? { rule } : { tests: ['x'] }),
    files: {}, base: 'b', red: 'r', green: 'g', ms: 1,
  } as unknown as Entry)
// Every plan is written before any entry is appended: an uncommitted journal line refuses the next write.
async function plans(repo: TestRepo, ids: string[]): Promise<void> {
  for (const id of ids) must(await writePlan(repo, id, { parent: 'auth-refresh' }, PLAN_BODY))
}
const merged = (repo: TestRepo, id: string) =>
  appendEntry(repo.root, id, { t: 'status', artifact: id, from: 'in-progress', to: 'done', cause: 'merge', pr: 1 } as unknown as Entry)
async function base(): Promise<TestRepo> {
  const repo = await seededRepo()
  must(await writeSpec(repo, 'auth-refresh')); approve(repo, 'auth-refresh')
  return repo
}

describe('the record counts the checks fixes added (row 282)', () => {
  it('checks added counts the guards of merged plans, lint by tool and rule (row 282)', async () => {
    const repo = await base()
    await plans(repo, ['p-one', 'p-two']); merged(repo, 'p-one'); merged(repo, 'p-two')
    guard(repo, 'p-one', 'lint', { tool: 'biome', rule: 'lint/test/noSwallow' })
    guard(repo, 'p-two', 'lint', { tool: 'biome', rule: 'lint/test/noSwallow' })
    guard(repo, 'p-two', 'test')
    const r = record(repo.root, loadCanon(repo.root))
    expect(r.checks).toEqual({ measured: true, lint: [{ tool: 'biome', rule: 'lint/test/noSwallow', plans: ['p-one', 'p-two'] }], tests: 1 })
    expect(recordLine(r)).toContain('checks added 3 (lint 2 · test 1) · tolerated spots 0')
    expect(recordTables(r).join('\n')).toContain('biome lint/test/noSwallow')
  })

  it('a plan still in flight adds none; with none merged, checks added reads not measured', async () => {
    const repo = await base()
    await plans(repo, ['p-live'])
    guard(repo, 'p-live', 'test')
    expect(checksFold(repo.root, loadCanon(repo.root))).toEqual({ measured: false })
    expect(recordLine(record(repo.root, loadCanon(repo.root)))).toContain('checks added not measured')
  })

  it('a journaled lint guard naming no reader tool is not counted, and a rule is spelled out (security review)', async () => {
    const repo = await base()
    await plans(repo, ['p-one']); merged(repo, 'p-one')
    guard(repo, 'p-one', 'lint', { tool: '\u001b[2Jbiome', rule: 'x' })
    guard(repo, 'p-one', 'lint', { tool: 'eslint', rule: 'no-x\u202e' })
    const r = record(repo.root, loadCanon(repo.root))
    expect(r.checks).toMatchObject({ measured: true, lint: [{ tool: 'eslint', rule: 'no-x\u202e', plans: ['p-one'] }] })
    const out = recordTables(r).join('\n')
    expect(out).toContain('eslint no-x\\u{202e}')
    expect(out).not.toContain('\u001b')
  })
})


// Row 287. The record's tolerated spots: per (tool, rule) of the open sets whose plan merged, the copies main's
// HEAD still holds (the allowance's cap over HEAD), measured once checks added is.
const LINES = ['export const a = 1 // SWALLOW a', 'export const b = 2 // SWALLOW b', 'export const c = 3 // SWALLOW c']
const tolSet = (repo: TestRepo, plan: string, lines: readonly string[]) =>
  appendEntry(repo.root, LEDGER_STREAM, { t: 'ledger-open', id: `l-${plan.length.toString(16).padStart(8, '0')}`, key: '0'.repeat(16), kind: 'tolerated-set',
    check: 'tolerated', plan, gate: 'implement', round: 1, run_id: 'r1', tool: 'biome', rule: 'lint/test/noSwallow', origin: 'guard', anchor: 'src/a.ts',
    subject: { spots: Object.fromEntries(lines.map((l) => [diagnosticKey({ tool: 'biome', rule: 'lint/test/noSwallow', file: 'src/a.ts', snippet: normalizeSnippet(l) }), { file: 'src/a.ts', copies: 1 }])) } } as unknown as Entry)
async function tolerated(onHead: readonly string[]): Promise<TestRepo> {
  const repo = await base()
  await plans(repo, ['p-one'])
  repo.write('src/a.ts', `${onHead.join('\n')}\n`)
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'main holds the spots')
  merged(repo, 'p-one')
  guard(repo, 'p-one', 'lint', { tool: 'biome', rule: 'lint/test/noSwallow' })
  tolSet(repo, 'p-one', LINES)
  return repo
}

describe('the record counts tolerated spots (row 287)', () => {
  it('the record counts the tolerated spots main still holds per rule (row 287)', async () => {
    const repo = await tolerated(LINES)
    const r = record(repo.root, loadCanon(repo.root))
    expect(r.tolerated).toEqual({ measured: true, rules: [{ tool: 'biome', rule: 'lint/test/noSwallow', spots: 3, sets: 1 }] })
    expect(recordLine(r)).toContain('tolerated spots 3')
    expect(recordTables(r).join('\n')).toMatch(/tolerated\[1\]\{tool,rule,spots,sets\}:\n\s+biome,lint\/test\/noSwallow,3,1/)
  })

  it('a tolerated spot main fixed drops from the count (row 287)', async () => {
    const repo = await tolerated(LINES.slice(0, 2))
    expect(record(repo.root, loadCanon(repo.root)).tolerated).toMatchObject({ measured: true, rules: [{ spots: 2, sets: 1 }] })
  })

  it('tolerated spots read 0, measured, once a guard merged with nothing to tolerate (row 287)', async () => {
    const repo = await base()
    await plans(repo, ['p-one']); merged(repo, 'p-one')
    guard(repo, 'p-one', 'lint', { tool: 'biome', rule: 'lint/test/noSwallow' })
    const r = record(repo.root, loadCanon(repo.root))
    expect(r.tolerated).toEqual({ measured: true, rules: [] })
    expect(recordLine(r)).toContain('checks added 1 (lint 1 · test 0) · tolerated spots 0')
  })
})
