// Row 284 (§4 T4, C50). A tolerated set's allowance: the plan's own sets whole, merged plans' sets capped by
// the lines the plan's base still holds; growth is the multiset difference against it.
import { describe, expect, it } from 'vitest'
import { diagnosticKey, type Diagnostic } from '../src/diagnostics.js'
import { appendEntry } from '../src/journal.js'
import { LEDGER_STREAM } from '../src/streams.js'
import { allowance, applicableSets, growth, ruleKey, toleratedRules, witnessRules } from '../src/tolerated.js'
import { git, tmpRepo, type TestRepo } from './helpers.js'

const RULE = 'no-x'
const at = (file: string, snippet: string, line = 1): Diagnostic => ({ tool: 'eslint', rule: RULE, file, line, snippet })
const key = (file: string, snippet: string) => diagnosticKey(at(file, snippet))
let n = 0
const set = (repo: TestRepo, plan: string, spots: Record<string, { file: string; copies: number }>, over: Record<string, unknown> = {}): string => {
  const id = `l-${(++n).toString(16).padStart(8, '0')}`
  appendEntry(repo.root, LEDGER_STREAM, { t: 'ledger-open', id, key: id.slice(2).padEnd(16, '0'), kind: 'tolerated-set', check: 'tolerated', plan, gate: 'implement',
    round: 1, run_id: 'r-1', tool: 'eslint', rule: RULE, origin: 'guard', anchor: 'src/token.ts', subject: { spots }, ...over } as never)
  return id
}
const merged = (repo: TestRepo, plan: string) =>
  appendEntry(repo.root, plan, { t: 'status', artifact: plan, from: 'in-progress', to: 'done', cause: 'merge', pr: 3 } as never)
const commit = (repo: TestRepo, files: Record<string, string>): string => {
  for (const [p, body] of Object.entries(files)) repo.write(p, body)
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-qm', 'base', '--allow-empty')
  return git(repo.root, 'rev-parse', 'HEAD')
}
const sets = (repo: TestRepo, plan: string) => applicableSets(repo.root, plan)

describe('the allowance (row 284)', () => {
  it("the allowance takes the plan's own sets whole (row 284)", () => {
    const repo = tmpRepo()
    const k = key('src/a.ts', '} catch {')
    set(repo, 'p1', { [k]: { file: 'src/a.ts', copies: 2 } })
    const base = commit(repo, { 'src/b.ts': 'x\n' })
    expect(allowance(repo.root, 'p1', base, sets(repo, 'p1')).get(ruleKey('eslint', RULE))!.get(k)).toBe(2)
  })

  it("a merged plan's set is capped by the lines the plan's base holds: a fixed line drops (row 284)", () => {
    const repo = tmpRepo()
    const k1 = key('src/a.ts', '} catch {')
    const k2 = key('src/a.ts', 'catch (e) {}')
    merged(repo, 'old-plan')
    set(repo, 'old-plan', { [k1]: { file: 'src/a.ts', copies: 1 }, [k2]: { file: 'src/a.ts', copies: 1 } })
    const base = commit(repo, { 'src/a.ts': '  } catch {\nfine\n' })
    const allowed = allowance(repo.root, 'p1', base, sets(repo, 'p1')).get(ruleKey('eslint', RULE))!
    expect(allowed.get(k1)).toBe(1)
    expect(allowed.get(k2) ?? 0).toBe(0)
  })

  it('two merged sets naming one key never allow more copies than the base holds (row 284)', () => {
    const repo = tmpRepo()
    const k = key('src/a.ts', '} catch {')
    merged(repo, 'old-plan'); merged(repo, 'older-plan')
    set(repo, 'old-plan', { [k]: { file: 'src/a.ts', copies: 1 } })
    set(repo, 'older-plan', { [k]: { file: 'src/a.ts', copies: 1 } })
    const base = commit(repo, { 'src/a.ts': '} catch {\n' })
    expect(allowance(repo.root, 'p1', base, sets(repo, 'p1')).get(ruleKey('eslint', RULE))!.get(k)).toBe(1)
  })

  it("the plan's own guard set and a merged set naming one key never allow more than the base's lines (slice 1 review I2)", () => {
    const repo = tmpRepo()
    const k = key('src/a.ts', '} catch {')
    merged(repo, 'old-plan')
    set(repo, 'p1', { [k]: { file: 'src/a.ts', copies: 1 } })
    set(repo, 'old-plan', { [k]: { file: 'src/a.ts', copies: 1 } })
    const base = commit(repo, { 'src/a.ts': '} catch {\n' })
    expect(allowance(repo.root, 'p1', base, sets(repo, 'p1')).get(ruleKey('eslint', RULE))!.get(k)).toBe(1)
    // a booked copy is new code: it never uses up a base line
    set(repo, 'p1', { [k]: { file: 'src/a.ts', copies: 1 } }, { origin: 'book', anchor: undefined })
    expect(allowance(repo.root, 'p1', base, sets(repo, 'p1')).get(ruleKey('eslint', RULE))!.get(k)).toBe(2)
  })

  it('a git failure reading the base allows none of a merged set (row 284)', () => {
    const repo = tmpRepo()
    const k = key('src/a.ts', '} catch {')
    merged(repo, 'old-plan')
    set(repo, 'old-plan', { [k]: { file: 'src/a.ts', copies: 1 } })
    commit(repo, { 'src/a.ts': '} catch {\n' })
    expect(allowance(repo.root, 'p1', 'b'.repeat(40), sets(repo, 'p1')).get(ruleKey('eslint', RULE))?.get(k) ?? 0).toBe(0)
  })

  it('a set whose plan is still in flight applies to its own plan only (row 284)', () => {
    const repo = tmpRepo()
    const id = set(repo, 'p1', { [key('a.ts', 'x')]: { file: 'a.ts', copies: 1 } })
    expect(sets(repo, 'other').map((i) => i.id)).toEqual([])
    expect(sets(repo, 'p1').map((i) => i.id)).toEqual([id])
    merged(repo, 'p1')
    expect(sets(repo, 'other').map((i) => i.id)).toEqual([id])
  })

  it('the rules: open sets name the tolerated ones, every set ever opened the witness ones (row 284)', () => {
    const repo = tmpRepo()
    const gone = set(repo, 'p1', { [key('a.ts', 'x')]: { file: 'a.ts', copies: 1 } }, { rule: 'no-gone' })
    appendEntry(repo.root, LEDGER_STREAM, { t: 'ledger-closed', id: gone, by: 'abandon', plan: 'p1' } as never)
    set(repo, 'p1', { [key('a.ts', 'x')]: { file: 'a.ts', copies: 1 } }, { tool: 'biome', rule: 'lint/a/b' })
    expect(toleratedRules(sets(repo, 'p1'))).toEqual(new Map([['biome', new Set(['lint/a/b'])]]))
    expect(witnessRules(repo.root)).toEqual(new Map([['eslint', new Set(['no-gone'])], ['biome', new Set(['lint/a/b'])]]))
  })
})

describe('growth (row 284)', () => {
  it('growth is the multiset difference: a swap of one old spot for one new one is one new spot (row 284, §4 T4)', () => {
    const k1 = key('a.ts', 'old one')
    const k2 = key('a.ts', 'old two')
    const k3 = key('a.ts', 'new one')
    const g = growth([at('a.ts', 'old one', 3), at('a.ts', 'new one', 9)], new Map([[k1, 1], [k2, 1]]))
    expect(g).toEqual({ grown: { [k3]: { file: 'a.ts', copies: 1 } }, lines: { [k3]: 9 }, total: 1 })
  })

  it('a second copy of an allowed key is growth, its line the copy beyond the allowance (row 284)', () => {
    const k1 = key('a.ts', 'old one')
    expect(growth([at('a.ts', 'old one', 3), at('a.ts', 'old one', 7)], new Map([[k1, 1]]))).toEqual({ grown: { [k1]: { file: 'a.ts', copies: 1 } }, lines: { [k1]: 7 }, total: 1 })
    expect(growth([at('a.ts', 'old one', 3)], undefined)).toEqual({ grown: { [k1]: { file: 'a.ts', copies: 1 } }, lines: { [k1]: 3 }, total: 1 })
  })
})
