// Row 284 (§4 T4, C46). The tolerated check: each new spot of a tolerated rule is red, the human's to book;
// a rule witness cannot measure is red too, never green.
import { describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import { diagnosticKey, type Diagnostic } from '../src/diagnostics.js'
import { appendEntry } from '../src/journal.js'
import type { ReaderTool } from '../src/settings.js'
import { LEDGER_STREAM } from '../src/streams.js'
import { applicableSets, toleratedCheck, type ToolReading } from '../src/tolerated.js'
import { git, tmpRepo, type TestRepo } from './helpers.js'

const PLAN = 'p1'
const at = (file: string, snippet: string, line: number, tool: ReaderTool = 'eslint', rule = 'no-x'): Diagnostic => ({ tool, rule, file, line, snippet })
const key = (d: Diagnostic) => diagnosticKey(d)
let n = 0
const set = (repo: TestRepo, plan: string, spots: Diagnostic[], over: Record<string, unknown> = {}): void => {
  const id = `l-${(++n).toString(16).padStart(8, '0')}`
  appendEntry(repo.root, LEDGER_STREAM, { t: 'ledger-open', id, key: id.slice(2).padEnd(16, '0'), kind: 'tolerated-set', check: 'tolerated', plan, gate: 'implement',
    round: 1, run_id: 'r-1', tool: spots[0]!.tool, rule: spots[0]!.rule, origin: 'guard', anchor: 'src/token.ts',
    subject: { spots: Object.fromEntries(spots.map((d) => [key(d), { file: d.file, copies: 1 }])) }, ...over } as never)
}
const merged = (repo: TestRepo, plan: string) =>
  appendEntry(repo.root, plan, { t: 'status', artifact: plan, from: 'in-progress', to: 'done', cause: 'merge', pr: 3 } as never)
const commit = (repo: TestRepo, files: Record<string, string>): string => {
  for (const [p, body] of Object.entries(files)) repo.write(p, body)
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-qm', 'base', '--allow-empty')
  return git(repo.root, 'rev-parse', 'HEAD')
}
const cfg = (readers: Record<string, string> = { eslint: 'npx eslint -f json .', biome: 'npx biome lint --reporter=sarif' }) => ({ readers }) as unknown as Config
const reading = (repo: TestRepo, tools: Array<[ReaderTool, ToolReading]>) => ({ sets: applicableSets(repo.root, PLAN), tools: new Map(tools), wrote: [] })

const OLD1 = at('src/a.ts', 'old one', 3)
const OLD2 = at('src/a.ts', 'old two', 5)

describe('the tolerated check (row 284)', () => {
  it('growth is red and names each new spot, never an old one (row 284)', () => {
    const repo = tmpRepo()
    merged(repo, 'old-plan')
    set(repo, 'old-plan', [OLD1, OLD2])
    const base = commit(repo, { 'src/a.ts': 'x\nx\nold one\nx\nold two\n' })
    const c = toleratedCheck(repo.root, repo.root, cfg(), PLAN, base, 'implement', reading(repo, [['eslint', { ok: true, spots: [OLD1, at('src/a.ts', 'new one', 9)] }]]))
    expect(c.name).toBe('tolerated')
    expect(c.ok).toBe(false)
    expect(c.tolerated).toEqual([{ tool: 'eslint', rule: 'no-x', state: 'measured', spots: 2, allowed: 1,
      grown: { [key(at('src/a.ts', 'new one', 9))]: { file: 'src/a.ts', copies: 1 } }, lines: { [key(at('src/a.ts', 'new one', 9))]: 9 } }])
    expect(c.detail).toContain('eslint no-x: 1 new beside 1 tolerated')
    expect(c.detail).toContain('src/a.ts:9')
    expect(c.detail).not.toContain('src/a.ts:3')
    expect(c.detail).toContain('witness decide implement p1 --book tolerated')
  })

  it('a plan whose spots are all tolerated is green (row 284)', () => {
    const repo = tmpRepo()
    merged(repo, 'old-plan')
    set(repo, 'old-plan', [OLD1, OLD2])
    const base = commit(repo, { 'src/a.ts': 'old one\nold two\n' })
    const c = toleratedCheck(repo.root, repo.root, cfg(), PLAN, base, 'ship', reading(repo, [['eslint', { ok: true, spots: [OLD1, OLD2] }]]))
    expect(c.ok).toBe(true)
    expect(c.detail).toBe('eslint no-x: 2 spots, all tolerated')
  })

  it('a tolerated tool whose reader is unset, untrusted or unread reads not measured, never green (row 284)', () => {
    const repo = tmpRepo()
    set(repo, PLAN, [OLD1])
    const base = commit(repo, { 'src/a.ts': 'old one\n' })
    const one = (r: ToolReading) => toleratedCheck(repo.root, repo.root, cfg(), PLAN, base, 'implement', reading(repo, [['eslint', r]]))
    const unset = one({ ok: false, state: 'not-measured', why: 'reader-unset' })
    expect([unset.ok, unset.tolerated]).toEqual([false, [{ tool: 'eslint', rule: 'no-x', state: 'not-measured', why: 'reader-unset' }]])
    expect(unset.detail).toBe('eslint no-x: not measured — readers.eslint is not set — a tolerated set reads its spots there')
    const untrusted = one({ ok: false, state: 'untrusted', why: 'untrusted', cmd: 'npx eslint -f json .' })
    expect([untrusted.ok, untrusted.tolerated![0]!.state, untrusted.untrusted]).toEqual([false, 'untrusted', ['npx eslint -f json .']])
    const unread = one({ ok: false, state: 'not-measured', why: 'reader-unread' })
    expect([unread.ok, unread.tolerated![0]!.why]).toEqual([false, 'reader-unread'])
    expect(unread.detail).toContain('never green')
  })

  it('a Biome set whose biome.json does not extend the witness file reads biome-unwired (row 284, Review Focus 4)', () => {
    const repo = tmpRepo()
    const spot = at('src/a.ts', 'console.log(1)', 1, 'biome', 'lint/suspicious/noConsole')
    set(repo, PLAN, [spot])
    const base = commit(repo, { 'src/a.ts': 'console.log(1)\n', 'biome.json': '{ "extends": [] }\n' })
    const c = toleratedCheck(repo.root, repo.root, cfg(), PLAN, base, 'implement', reading(repo, [['biome', { ok: true, spots: [spot] }]]))
    expect(c.ok).toBe(false)
    expect(c.tolerated).toEqual([{ tool: 'biome', rule: 'lint/suspicious/noConsole', state: 'not-measured', why: 'biome-unwired' }])
    expect(c.detail).toContain('biome.json does not extend ./biome.witness.json — add it to "extends"')
  })

  it('a Biome reader that hides info diagnostics reads reader-hides-notes (row 284, Review Focus 4)', () => {
    const repo = tmpRepo()
    const spot = at('src/a.ts', 'console.log(1)', 1, 'biome', 'lint/suspicious/noConsole')
    set(repo, PLAN, [spot])
    const base = commit(repo, { 'src/a.ts': 'console.log(1)\n', 'biome.json': '{ "extends": ["./biome.witness.json"] }\n' })
    const one = (cmd: string) => toleratedCheck(repo.root, repo.root, cfg({ biome: cmd }), PLAN, base, 'implement', reading(repo, [['biome', { ok: true, spots: [spot] }]]))
    expect(one('npx biome lint --reporter=sarif --diagnostic-level=error').tolerated![0]).toMatchObject({ state: 'not-measured', why: 'reader-hides-notes' })
    expect(one('npx biome lint --reporter=sarif --diagnostic-level warn').tolerated![0]).toMatchObject({ state: 'not-measured', why: 'reader-hides-notes' })
    const shown = one('npx biome lint --reporter=sarif --diagnostic-level=info')
    expect([shown.ok, shown.tolerated![0]!.state]).toEqual([true, 'measured'])
  })

  it("a new spot on a line the base holds, under the plan's own guard set, names the re-proof (row 284, Review Focus 1)", () => {
    const repo = tmpRepo()
    set(repo, PLAN, [OLD1])
    const base = commit(repo, { 'src/a.ts': 'old one\nold nine\n' })
    const k9 = at('src/a.ts', 'old nine', 2)
    const c = toleratedCheck(repo.root, repo.root, cfg(), PLAN, base, 'ship', reading(repo, [['eslint', { ok: true, spots: [OLD1, k9] }]]))
    expect(c.ok).toBe(false)
    expect(c.detail).toContain("the base holds src/a.ts:2: re-prove the guard of 'src/token.ts'")
    expect(c.detail).toContain("witness guard p1 --finding 'src/token.ts'")
  })

  it('ten new spots are listed, the rest counted (row 284)', () => {
    const repo = tmpRepo()
    set(repo, PLAN, [OLD1])
    const base = commit(repo, { 'src/a.ts': 'old one\n' })
    const spots = Array.from({ length: 12 }, (_, i) => at('src/b.ts', `new ${i}`, i + 1))
    const c = toleratedCheck(repo.root, repo.root, cfg(), PLAN, base, 'implement', reading(repo, [['eslint', { ok: true, spots }]]))
    expect(c.detail).toContain('src/b.ts:10, and 2 more')
    expect(c.detail).not.toContain('src/b.ts:11')
  })
})
