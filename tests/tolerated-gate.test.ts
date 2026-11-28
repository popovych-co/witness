// Row 285 (C51) and row 284. Every code gate rewrites the tolerated lists for its tree before anything reads
// it, then runs the tolerated check; ship commits them; ship's rebase never stops on them.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendEntry } from '../src/journal.js'
import { rebaseIfMoved } from '../src/ship.js'
import { LEDGER_STREAM } from '../src/streams.js'
import { TOLERATED_L1, TOLERATED_L2, TOLERATED_SET, TOLERATED_TWO, addOrigin, shippableRepo, toleratedBench } from './helpers.js'

const PLAN = 'auth-refresh-plan-1'
const L1 = TOLERATED_L1
const L2 = TOLERATED_L2
const listText = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`
const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '')

const TWO = TOLERATED_TWO
const SET = TOLERATED_SET
// fake-lint.mjs's `eslint` mode, run in the plan's worktree
const bench = async (opts: Parameters<typeof toleratedBench>[0]) => {
  const b = await toleratedBench(opts)
  return { ...b, eslint: () => spawnSync('node', ['fake-lint.mjs', 'eslint'], { cwd: b.wt, encoding: 'utf8' }) }
}

describe('the gates rewrite the tolerated lists (row 285)', () => {
  it('a plan that swaps a tolerated spot for a new one in the same file reads red at implement, though ESLint passes (row 284, §4 T4)', async () => {
    const b = await bench({ main: TWO, set: SET })
    b.put('src/a.ts', `${L1}\nexport const three = 3 // SWALLOW three\n`)
    expect(b.eslint().status).toBe(0)
    await b.gate()
    expect(b.last().checks_only).toBe(true)
    expect(b.last().checks.at(-1)).toMatchObject({ name: 'tolerated', ok: false })
    expect(b.check('tolerated')!.detail).toContain('src/a.ts:2')
    expect(b.check('tolerated')!.detail).not.toContain('src/a.ts:1')
  }, 240_000)

  it("the gate writes the list for the tree before lint runs: an agent's stale list never reads unread (row 285, Review Focus 2)", async () => {
    const b = await bench({ main: TWO, set: SET })
    b.put('src/a.ts', `${L1}\n`)
    expect(b.eslint().status).toBe(2)
    await b.gate()
    expect(JSON.parse(b.read('eslint-suppressions.json'))).toEqual({ 'src/a.ts': { 'no-swallow': { count: 1 } } })
    expect(g(b.wt, 'status', '--porcelain', '--', 'eslint-suppressions.json')).toBe(' M eslint-suppressions.json')
    expect(b.check('tolerated')).toMatchObject({ ok: true })
    expect(b.check('lint')).toMatchObject({ ok: true })
  }, 240_000)

  it('ship rewrites the lists after its rebase and commits them with the trailer (row 285)', async () => {
    const b = await bench({ main: { ...TWO, 'src/a.ts': `${L1}\nx1\nx2\nx3\n${L2}\n` }, set: SET })
    // the plan fixed L1 and committed its list; another flow fixed L2 on main, its list alike
    b.put('src/a.ts', `x1\nx2\nx3\n${L2}\n`)
    b.put('eslint-suppressions.json', listText({ 'src/a.ts': { 'no-swallow': { count: 1 } } }))
    g(b.wt, 'commit', '-qam', 'fix one')
    b.repo.write('src/a.ts', `${L1}\nx1\nx2\nx3\n`)
    b.repo.write('eslint-suppressions.json', listText({ 'src/a.ts': { 'no-swallow': { count: 1 } } }))
    b.repo.git('add', '-A'); b.repo.git('commit', '-q', '-m', 'another flow fixed two')
    g(b.wt, 'rebase', '-q', 'main')
    expect(b.read('src/a.ts')).toBe('x1\nx2\nx3\n')
    await b.gate('ship')
    expect(g(b.wt, 'log', '-1', '--format=%s%n%b').trim()).toBe(`ship(${PLAN}): tolerated lists rewritten for its base\nWitness-State: 1`)
    // slice 2 review I2: an emptied list is kept as {} — a removal is a modify/delete no merge driver sees
    expect(b.read('eslint-suppressions.json')).toBe('{}\n')
    expect(g(b.wt, 'status', '--porcelain', '--', 'eslint-suppressions.json')).toBe('')
  }, 240_000)

  it('two spots of one rule on one line, tolerated by a merged set, never read as a later plan\'s growth (final review C1)', async () => {
    const both = 'export function f(a: any, b: any) {} // SWALLOW SWALLOW'
    const b = await bench({ main: { 'src/a.ts': `${both}\n`, 'eslint-suppressions.json': listText({ 'src/a.ts': { 'no-swallow': { count: 2 } } }) },
      set: [['src/a.ts', both, 2, 1]], perLine: 2 })
    b.put('src/c.ts', 'export const c = 1\n')
    await b.gate()
    expect(b.check('tolerated')).toMatchObject({ ok: true, tolerated: [{ state: 'measured', spots: 2, allowed: 2 }] })
    expect(b.check('lint')).toMatchObject({ ok: true })
  }, 240_000)

  it('a plan with no tolerated set gains no tolerated check and writes nothing (row 285)', async () => {
    const b = await bench({ main: { 'src/a.ts': 'export const clean = 1\n' } })
    b.put('src/a.ts', 'export const clean = 2\n')
    await b.gate()
    expect(b.last().checks.map((c) => c.name)).not.toContain('tolerated')
    expect(existsSync(join(b.wt, 'eslint-suppressions.json'))).toBe(false)
    expect(existsSync(join(b.wt, 'biome.witness.json'))).toBe(false)
  }, 240_000)

  it("the repo's own ESLint entries stay at the base's count: a raised count is written back and ESLint reads the new spot (row 285, Review Focus 3)", async () => {
    const b = await bench({ main: { 'src/a.ts': `${L1}\n${L2}\n`, 'src/b.ts': 'export const b = "BAD"\n',
      'eslint-suppressions.json': listText({ 'src/a.ts': { 'no-swallow': { count: 2 } }, 'src/b.ts': { 'no-bad': { count: 1 } } }) }, set: SET })
    b.put('src/b.ts', 'export const b = "BAD"\nexport const c = "BAD"\n')
    b.put('eslint-suppressions.json', listText({ 'src/a.ts': { 'no-swallow': { count: 2 } }, 'src/b.ts': { 'no-bad': { count: 2 } } }))
    await b.gate()
    expect(JSON.parse(b.read('eslint-suppressions.json'))).toEqual({ 'src/a.ts': { 'no-swallow': { count: 2 } }, 'src/b.ts': { 'no-bad': { count: 1 } } })
    expect(b.check('tolerated')).toMatchObject({ ok: true })
    expect(b.check('lint')).toMatchObject({ ok: false })
    const report = JSON.parse(b.eslint().stdout) as Array<{ filePath: string; messages: unknown[] }>
    expect(report.find((r) => r.filePath.endsWith('src/b.ts'))!.messages).toHaveLength(2)
  }, 240_000)

  it('a list that is a link is never written through: not measured, the target untouched (row 285, security review)', async () => {
    const b = await bench({ main: TWO, set: SET })
    const outside = join(b.repo.root, '..', `outside-${Date.now()}.txt`)
    writeFileSync(outside, 'keep me\n')
    rmSync(join(b.wt, 'eslint-suppressions.json'))
    symlinkSync(outside, join(b.wt, 'eslint-suppressions.json'))
    b.put('src/a.ts', `${L1}\n`)
    await b.gate()
    expect(readFileSync(outside, 'utf8')).toBe('keep me\n')
    expect(b.check('tolerated')).toMatchObject({ ok: false, tolerated: [{ tool: 'eslint', rule: 'no-swallow', state: 'not-measured', why: 'list-not-file' }] })
    expect(b.check('tolerated')!.detail).toContain('eslint-suppressions.json is not a regular file')
  }, 240_000)

  it("another plan's set in flight never strips the repo's own entries from a plan it does not apply to (slice 2 review I1)", async () => {
    const list = listText({ 'src/b.ts': { 'no-bad': { count: 1 } } })
    const b = await bench({ main: { 'src/b.ts': 'export const b = "BAD"\n', 'eslint-suppressions.json': list } })
    appendEntry(b.repo.root, LEDGER_STREAM, { t: 'ledger-open', id: 'l-0000000b', key: '0'.repeat(16), kind: 'tolerated-set', check: 'tolerated', plan: 'other-plan',
      gate: 'implement', round: 1, run_id: 'r-1', tool: 'eslint', rule: 'no-bad', origin: 'guard', anchor: 'src/x.ts',
      subject: { spots: { ['ab'.repeat(8)]: { file: 'src/b.ts', copies: 1 } } } } as never)
    b.repo.git('add', '.witness'); b.repo.git('commit', '-q', '-m', 'another plan in flight')
    b.put('src/c.ts', 'export const c = 1\n')
    await b.gate()
    expect(b.read('eslint-suppressions.json')).toBe(list)
    expect(b.last().checks.map((c) => c.name)).not.toContain('tolerated')
    expect(b.check('lint')).toMatchObject({ ok: true })
  }, 240_000)

  it('a gitignored list reads list-ignored and is never written (row 285)', async () => {
    const b = await bench({ main: { 'src/a.ts': `${L1}\n${L2}\n`, '.gitignore': 'node_modules/\neslint-suppressions.json\n' }, set: SET })
    b.put('src/a.ts', `${L1}\n${L2}\nexport const x = 1\n`)
    await b.gate()
    expect(b.check('tolerated')).toMatchObject({ ok: false, tolerated: [{ tool: 'eslint', rule: 'no-swallow', state: 'not-measured', why: 'list-ignored' }] })
    expect(existsSync(join(b.wt, 'eslint-suppressions.json'))).toBe(false)
  }, 240_000)
})

describe("ship's rebase passes the lists (row 285, probe §6)", () => {
  async function moved() {
    const seed = await shippableRepo()
    const { repo, wt, planId } = seed
    addOrigin(repo)
    repo.git('config', 'merge.conflictStyle', 'merge')
    repo.write('eslint-suppressions.json', listText({ 'src/a.ts': { 'no-x': { count: 1 } } }))
    repo.git('add', 'eslint-suppressions.json'); repo.git('commit', '-q', '-m', 'list'); repo.git('push', '-q', 'origin', 'main')
    g(wt, 'fetch', '-q', 'origin', 'main'); g(wt, 'rebase', '-q', 'origin/main')
    const moveMain = (count: number) => {
      repo.write('eslint-suppressions.json', listText({ 'src/a.ts': { 'no-x': { count } } }))
      repo.git('add', 'eslint-suppressions.json'); repo.git('commit', '-q', '-m', 'another flow'); repo.git('push', '-q', 'origin', 'main')
    }
    return { repo, wt, planId, moveMain, run: { planId, hasPr: false, env: {} } }
  }

  it('a list the plan created untracked, which the moved base also created, never stops the move (slice 2 review I2)', async () => {
    const seed = await shippableRepo()
    const { repo, wt, planId } = seed
    addOrigin(repo)
    writeFileSync(join(wt, 'eslint-suppressions.json'), listText({ 'src/a.ts': { 'no-x': { count: 1 } } }))
    repo.write('eslint-suppressions.json', listText({ 'src/b.ts': { 'no-y': { count: 2 } } }))
    repo.git('add', 'eslint-suppressions.json'); repo.git('commit', '-q', '-m', 'another flow'); repo.git('push', '-q', 'origin', 'main')
    expect(rebaseIfMoved(wt, repo.root, 'main', { planId, hasPr: false, env: {} })).toEqual({ ok: true, value: 'rebased' })
    expect(JSON.parse(readFileSync(join(wt, 'eslint-suppressions.json'), 'utf8'))).toEqual({ 'src/b.ts': { 'no-y': { count: 2 } } })
  }, 240_000)

  it('a list the plan removed uncommitted, which the moved base changed, never stops the move (slice 2 review I2)', async () => {
    const m = await moved()
    rmSync(join(m.wt, 'eslint-suppressions.json'))
    m.moveMain(3)
    expect(rebaseIfMoved(m.wt, m.repo.root, 'main', m.run)).toEqual({ ok: true, value: 'rebased' })
    expect(JSON.parse(readFileSync(join(m.wt, 'eslint-suppressions.json'), 'utf8'))).toEqual({ 'src/a.ts': { 'no-x': { count: 3 } } })
  }, 240_000)

  it("ship's rebase never stops on a list both sides changed, committed or carried (row 285, probe §6)", async () => {
    const m = await moved()
    writeFileSync(join(m.wt, 'eslint-suppressions.json'), listText({ 'src/a.ts': { 'no-x': { count: 2 } } }))
    g(m.wt, 'commit', '-qam', 'plan list')
    writeFileSync(join(m.wt, 'eslint-suppressions.json'), listText({ 'src/a.ts': { 'no-x': { count: 4 } } }))
    m.moveMain(3)
    expect(rebaseIfMoved(m.wt, m.repo.root, 'main', m.run)).toEqual({ ok: true, value: 'rebased' })
    expect(JSON.parse(readFileSync(join(m.wt, 'eslint-suppressions.json'), 'utf8'))).toEqual({ 'src/a.ts': { 'no-x': { count: 3 } } })
    expect(g(m.wt, 'status', '--porcelain')).not.toMatch(/^(UU|AA) /m)
    expect(spawnSync('git', ['config', '--get-regexp', '^merge\\.witness'], { cwd: m.wt }).status).toBe(1)   // nothing persists
  }, 240_000)
})
