import { describe, expect, it } from 'vitest'
import { BASE_LINT, baseLintKey, baseLintKind } from '../src/base-lint.js'
import { loadConfig, type Config } from '../src/config.js'
import { diagnosticKey } from '../src/diagnostics.js'
import { journalShard } from '../src/jobs.js'
import { appendEntry } from '../src/journal.js'
import { bookLines, bookingsOf, newItemId } from '../src/ledger.js'
import type { GateRunEntry } from '../src/rounds.js'
import { lintCheck } from '../src/lint-lane.js'
import { boundReader } from '../src/lint-parts.js'
import { LEDGER_STREAM } from '../src/streams.js'
import { fakeCtx, fakeLint, fixtureEnv, patchConfig, seededRepo, type TestRepo } from './helpers.js'

// Row 270 (the trust design §3.2's waiver, §3.3). The lint lane reads the plan's own open bookings,
// and a reader-bound red part reads the plan's own errors whatever its base (the map's C20).

const cfgOf = (root: string): Config => { const r = loadConfig(root); if (!r.ok) throw new Error('config'); return r.value }
const PLAN = 'p1'
const KEY_NEW = diagnosticKey({ tool: 'biome', rule: 'lint/test/noBad', file: 'src/new.ts', snippet: 'BAD' })

// fake-lint's `check` part `biome` with a reader, `ui` opaque. The base holds src/old.ts with one BAD
// line (none under `green`); the plan's one error, src/new.ts, sits in the root's working tree.
async function bench(opts: { green?: boolean; reader?: 'sarif' | 'many' } = {}) {
  const repo = await seededRepo()
  const cmd = fakeLint(repo)
  patchConfig(repo, { ship: { lint: { biome: cmd.check, ui: cmd.check } }, readers: { biome: cmd[opts.reader ?? 'sarif'] } })
  if (opts.green !== true) repo.write('src/old.ts', 'BAD\n')
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'base')
  const base = repo.git('rev-parse', 'HEAD')
  repo.write('src/new.ts', 'BAD\n')
  const ctx = fakeCtx(repo.root, { env: fixtureEnv() })
  const keyOn = (commit: string, name: string) => {
    const cfg = cfgOf(repo.root)
    const part = cfg.ship.lint!.find((p) => p.name === name)!
    return baseLintKey(part, boundReader(cfg, part)?.cmd, commit)
  }
  // drive's job, run here in-process, and its shard journaled as drive journals it
  const lintBaseOn = (commit: string, name: string) => {
    const key = keyOn(commit, name)
    const r = baseLintKind.run(repo.root, ctx, cfgOf(repo.root), { kind: BASE_LINT, key, shards: 1 }, 1)
    if (r.outcome !== 'done') throw new Error(r.why)
    journalShard(repo.root, { kind: BASE_LINT, key, shard: 1, of: 1, outcome: 'done', ms: 1, result: r.result })
    return key
  }
  const lintBase = (name: string) => lintBaseOn(base, name)
  const checkOn = (commit: string) => lintCheck(repo.root, repo.root, ctx, cfgOf(repo.root), commit, PLAN)
  const check = () => checkOn(base)
  return { repo, base, keyOn, lintBase, lintBaseOn, check, checkOn }
}
const baseRed = () => bench()
const greenBase = () => bench({ green: true })

// A ledger line committed as a booking commits it: the state-path audit refuses a later journal
// write over an uncommitted one.
const ledgerLine = (repo: TestRepo, entry: Record<string, unknown>) => {
  appendEntry(repo.root, LEDGER_STREAM, entry as never)
  repo.git('add', '.witness/journal'); repo.git('commit', '-q', '-m', 'ledger')
}
const item = (repo: TestRepo, over: Record<string, unknown>) => ledgerLine(repo, {
  t: 'ledger-open', id: newItemId(), key: '0'.repeat(16), kind: 'booked-check', check: 'lint', plan: PLAN, gate: 'implement',
  round: 1, run_id: 'r-1', part: 'biome', part_key: 'x', subject: { whole: true }, ...over,
})

describe('the lint lane reads bookings (row 270)', () => {
  it("a reader-bound part red on a green base reads the plan's errors: red, its count, its rules and its book (C20)", async () => {
    const b = await greenBase()
    b.lintBase('biome')
    const c = await b.check()
    expect(c.parts!.find((x) => x.part === 'biome'))
      .toMatchObject({ state: 'red', new: 1, rules: ['lint/test/noBad'], book: { [KEY_NEW]: 1 } })
    expect(c.detail).toContain('biome: red — 1 new, the base green: src/new.ts:1 lint/test/noBad')
  }, 60_000)

  it("chat mode: a reader-bound part whose base is not measured books every error the plan's tree reports (C20)", async () => {
    const b = await baseRed()                           // no lintBase: the base is not measured
    const p = (await b.check()).parts!.find((x) => x.part === 'biome')!
    expect(p.state).toBe('not-measured')
    expect(Object.values(p.book!).reduce((a, n) => a + n, 0)).toBe(2)   // src/old.ts's BAD and the plan's
  }, 60_000)

  it("a part red on the base too keeps only the plan's new keys bookable (row 263)", async () => {
    const b = await baseRed(); b.lintBase('biome')
    expect((await b.check()).parts!.find((x) => x.part === 'biome')).toMatchObject({ state: 'new', new: 1, book: { [KEY_NEW]: 1 } })
  }, 60_000)

  it('a per-diagnostic booking covers exactly its keys: booked, and a further error stays red alone (Review Focus 1)', async () => {
    const b = await baseRed(); b.lintBase('biome')
    item(b.repo, { subject: { diagnostics: { [KEY_NEW]: 1 } } })
    const first = await b.check()
    expect(first.parts!.find((x) => x.part === 'biome')).toMatchObject({ state: 'booked', booked: 1 })
    expect(first.detail).toMatch(/biome: ok — booked: 1 diagnostic \(l-[0-9a-f]{8}\)/)
    b.repo.write('src/more.ts', 'BAD\n')
    const c = await b.check()
    const p = c.parts!.find((x) => x.part === 'biome')!
    expect(p).toMatchObject({ state: 'new', new: 1, booked: 1 })
    expect(Object.keys(p.book!)).not.toContain(KEY_NEW)
    expect(c.detail).toContain("biome: red — 1 new beside the base's 1: src/more.ts:1 lint/test/noBad")
    expect(c.detail).not.toContain('src/new.ts')
    expect(c.ok).toBe(false)
  }, 60_000)

  it('a whole-part booking holds at the base it was booked against, never after the base moves (C19, Review Focus 2)', async () => {
    const b = await baseRed(); const key = b.lintBase('ui'); b.lintBase('biome')
    item(b.repo, { part: 'ui', part_key: key })
    item(b.repo, { subject: { diagnostics: { [KEY_NEW]: 1 } } })
    const held = await b.check()
    expect(held.parts!.map((x) => x.state)).toEqual(['booked', 'booked'])          // biome, ui
    expect(held.ok).toBe(true)
    expect(held.detail).toMatch(/ui: ok — booked whole until main moves \(l-[0-9a-f]{8}\)/)
    b.repo.git('commit', '--allow-empty', '-q', '-m', 'main moved')
    const next = b.repo.git('rev-parse', 'HEAD')
    b.lintBaseOn(next, 'biome'); b.lintBaseOn(next, 'ui')                         // the new base, read as drive would
    const moved = await b.checkOn(next)
    expect(moved.parts!.find((x) => x.part === 'ui')!.state).toBe('not-judged')   // asked again
    expect(moved.parts!.find((x) => x.part === 'biome')!.state).toBe('booked')    // its keys still hold
  }, 120_000)

  it("another plan's item, a closed item and a dismissed item waive nothing", async () => {
    const b = await baseRed(); const key = b.lintBase('ui')
    item(b.repo, { part: 'ui', part_key: key, plan: 'other-plan' })
    const closed = newItemId(); item(b.repo, { id: closed, part: 'ui', part_key: key })
    ledgerLine(b.repo, { t: 'ledger-closed', id: closed, by: 'merge', plan: 'p0', pr: 1 })
    const dismissed = newItemId(); item(b.repo, { id: dismissed, part: 'ui', part_key: key })
    ledgerLine(b.repo, { t: 'ledger-dismissed', id: dismissed, cause: 'judged-wrong', note: 'no' })
    expect((await b.check()).parts!.find((x) => x.part === 'ui')!.state).toBe('not-judged')
  }, 60_000)

  it('cleared names the open per-diagnostic items whose every key this tree lacks', async () => {
    const b = await baseRed(); b.lintBase('biome')
    const gone = newItemId(); item(b.repo, { id: gone, plan: 'other-plan', subject: { diagnostics: { ffffffffffffffff: 1 } } })
    item(b.repo, { plan: 'other-plan', subject: { diagnostics: { [KEY_NEW]: 1 } } })
    expect((await b.check()).parts!.find((x) => x.part === 'biome')!.cleared).toEqual([gone])
  }, 60_000)

  it('an opaque part offers no book, and neither does a part past 500 distinct errors (a whole part only)', async () => {
    const b = await baseRed(); b.lintBase('ui')
    expect((await b.check()).parts!.find((x) => x.part === 'ui')!.book).toBeUndefined()
    // fake-lint's `many` reader: 2,001 distinct errors on a green base — `book` absent, `new` counted
    const m = await bench({ green: true, reader: 'many' })
    const key = m.keyOn(m.base, 'biome')
    journalShard(m.repo.root, { kind: BASE_LINT, key, shard: 1, of: 1, outcome: 'done', ms: 1,
      result: { exit: 0, tree: m.repo.git('rev-parse', 'HEAD^{tree}'), commit: m.base } })
    const p = (await m.check()).parts!.find((x) => x.part === 'biome')!
    expect(p).toMatchObject({ state: 'red', new: 2_001 })
    expect(p.book).toBeUndefined()
  }, 120_000)
})

describe('the lint lane reads bookings — slice 2 review (row 270)', () => {
  it('a booked line duplicated is booked again as a new item, never by reusing the one the part already applies (I1)', async () => {
    const b = await baseRed(); b.lintBase('biome')
    const first = newItemId(); item(b.repo, { id: first, subject: { diagnostics: { [KEY_NEW]: 1 } } })
    b.repo.write('src/new.ts', 'BAD\nBAD\n')                                 // the same key, twice
    const c = await b.check()
    const part = c.parts!.find((x) => x.part === 'biome')!
    expect(part).toMatchObject({ state: 'new', book: { [KEY_NEW]: 1 }, booked: 1, items: [first] })
    const run = { v: 1, t: 'gate-run', gate: 'implement', artifact: PLAN, round: 2, run_id: 'r-2', checks_only: true, checks: [c] } as unknown as GateRunEntry
    const lines = bookLines(b.repo.root, PLAN, 'implement', run, bookingsOf(run, 'lint').filter((x) => x.part === 'biome'))
    expect(lines).toHaveLength(1)
    expect(lines[0]!.id).not.toBe(first)
    expect(lines[0]!.entry).toMatchObject({ subject: { diagnostics: { [KEY_NEW]: 1 } } })
    ledgerLine(b.repo, lines[0]!.entry as unknown as Record<string, unknown>)
    expect((await b.check()).parts!.find((x) => x.part === 'biome')).toMatchObject({ state: 'booked', booked: 2, items: [first, lines[0]!.id] })
  }, 60_000)
})
