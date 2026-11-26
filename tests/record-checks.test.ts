import { describe, expect, it } from 'vitest'
import { appendEntry, type Entry } from '../src/journal.js'
import { checksFold, record, recordLine, recordTables } from '../src/record.js'
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
    expect(recordLine(r)).toContain('checks added 3 (lint 2 · test 1) · tolerated spots not measured')
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

