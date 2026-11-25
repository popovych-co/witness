// Row 269 (the trust design §3.3, the map's C18, C22). A ledger item ends by observation — at the
// merge stamp, from the shipped tree's lint, or at the abandon of its plan — or by a human at a
// terminal (`witness dismiss ledger`).
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { Ctx } from '../src/cli.js'
import { appendEntry, readStream } from '../src/journal.js'
import { ledgerItems, mergeCloses, newItemId } from '../src/ledger.js'
import { loadCanon } from '../src/scan.js'
import { lazyStamp } from '../src/stamp.js'
import { LEDGER_STREAM } from '../src/streams.js'
import { switchOffKey } from '../src/switch-offs.js'
import { createHash } from 'node:crypto'
import { hiddenInTree, loosenedKey } from '../src/diagnostics.js'
import { bookedRows } from '../src/verbs/dashboard.js'
import { run as dismiss } from '../src/verbs/dismiss.js'
import {
  crashCli, fakeCtx, fakeScenario, gateEnv, ghState, seededRepo, shippableRepo, type TestRepo,
} from './helpers.js'

const T = 'b'.repeat(40)

// A ledger line committed as the act that writes it commits it.
const line = (repo: TestRepo, stream: string, entry: Record<string, unknown>) => {
  appendEntry(repo.root, stream, entry as never)
  repo.git('add', '.witness/journal'); repo.git('commit', '-q', '-m', `${stream} line`)
}
const item = (repo: TestRepo, over: Record<string, unknown>): string => {
  const id = newItemId()
  line(repo, LEDGER_STREAM, {
    t: 'ledger-open', id, key: '0'.repeat(16), kind: 'booked-check', check: 'lint', plan: 'p1', gate: 'ship',
    round: 1, run_id: 'r-1', part: 'biome', part_key: `biome@${'a'.repeat(40)}.000000000000`, subject: { whole: true }, ...over,
  })
  return id
}
// The plan's last ship round, lint's parts as given, on the tree that merges.
const shipRun = (repo: TestRepo, planId: string, parts: Array<Record<string, unknown>>) => line(repo, planId, {
  t: 'gate-run', gate: 'ship', artifact: planId, round: 9, run_id: 'r-ship', reviewed_sha: 'c'.repeat(40), reviewed_tree: T,
  prompts_sha: 'p', witness: '0', model: 'm', pin: 'm', outcome: 'stopped', checks: [{ name: 'lint', ok: true, parts }],
})
// A plan merged before this one: its stream ends `done` by a merge.
const mergedPlan = (repo: TestRepo, id: string) => line(repo, id, { t: 'status', artifact: id, from: 'in-progress', to: 'done', cause: 'merge', pr: 3 })

async function mergedSeed() {
  const seed = await shippableRepo()
  seed.repo.setMeta(seed.planId, { pr: 7 })
  const scenario = fakeScenario()
  ghState(scenario, 7, 'MERGED')
  const ctx = fakeCtx(seed.repo.root, { env: gateEnv(scenario) })
  const stamp = () => lazyStamp(seed.repo.root, ctx, loadCanon(seed.repo.root))
  return { ...seed, scenario, ctx, stamp }
}

const byId = (root: string, id: string) => ledgerItems(root).find((i) => i.id === id)!
const closes = (root: string) => readStream(root, LEDGER_STREAM).filter((e) => e.t === 'ledger-closed')

describe('an item ends by observation (row 269)', () => {
  it('a booking the plan fixed before merging closes at its merge stamp, keyed by the shipped tree', async () => {
    const s = await mergedSeed()
    const id = item(s.repo, { plan: s.planId })
    shipRun(s.repo, s.planId, [{ part: 'biome', state: 'green' }])
    expect(s.stamp().stamped).toHaveLength(1)
    expect(byId(s.repo.root, id)).toMatchObject({ state: 'closed', end: { by: 'merge', plan: s.planId, pr: 7, tree: T } })
    expect(s.repo.git('log', '-1', '--name-only', '--format=%s')).toContain('.witness/journal/ledger.jsonl')   // the stamp's own commit
  }, 120_000)

  it('a booking that shipped stays open, and closes at a later merge whose lint finds the part green', async () => {
    const s = await mergedSeed()
    const shipped = item(s.repo, { plan: s.planId })
    shipRun(s.repo, s.planId, [{ part: 'biome', state: 'booked', items: [shipped] }])
    s.stamp()
    expect(byId(s.repo.root, shipped).state).toBe('open')
    // main's debt: an earlier plan's booking, closed once this plan ships the part green
    const t = await mergedSeed()
    mergedPlan(t.repo, 'old-plan')
    const debt = item(t.repo, { plan: 'old-plan' })
    shipRun(t.repo, t.planId, [{ part: 'biome', state: 'green' }])
    t.stamp()
    expect(byId(t.repo.root, debt)).toMatchObject({ state: 'closed', end: { by: 'merge', plan: t.planId } })
  }, 240_000)

  it("another plan's merge never closes an item of a plan still in flight", async () => {
    const s = await mergedSeed()
    const flight = item(s.repo, { plan: 'flight-plan' })
    shipRun(s.repo, s.planId, [{ part: 'biome', state: 'green' }])
    s.stamp()
    expect(byId(s.repo.root, flight).state).toBe('open')
  }, 120_000)

  it('a per-diagnostic item the lane cleared closes; a whole-part item on a part still red stays', async () => {
    const s = await mergedSeed()
    const a = item(s.repo, { plan: s.planId, subject: { diagnostics: { ['a'.repeat(16)]: 1 } } })
    const b = item(s.repo, { plan: s.planId })
    shipRun(s.repo, s.planId, [{ part: 'biome', state: 'new', new: 1, cleared: [a] }])
    s.stamp()
    expect(byId(s.repo.root, a).state).toBe('closed')
    expect(byId(s.repo.root, b).state).toBe('open')
  }, 120_000)

  it('no observation closes nothing: a plan whose ship rounds never ran lint leaves every item open', async () => {
    const s = await mergedSeed()
    const id = item(s.repo, { plan: s.planId })
    s.stamp()
    expect(byId(s.repo.root, id).state).toBe('open')
  }, 120_000)

  it('abandoning the booking plan closes its open items in the same transaction', async () => {
    const { repo, planId } = await shippableRepo()
    const one = item(repo, { plan: planId })
    const two = item(repo, { plan: planId, part: 'tsc' })
    const other = item(repo, { plan: 'other-plan' })
    const r = await repo.cli(['abandon', planId])
    expect(r.code, r.stderr).toBe(0)
    for (const id of [one, two]) expect(byId(repo.root, id)).toMatchObject({ state: 'closed', end: { by: 'abandon', plan: planId } })
    expect(byId(repo.root, other).state).toBe('open')
    expect(repo.git('log', '-1', '--name-only', '--format=%s')).toContain('.witness/journal/ledger.jsonl')
  }, 120_000)

  it('a merge stamp or an abandon killed after its lines land is completed once (Done-when)', async () => {
    const s = await mergedSeed()
    const id = item(s.repo, { plan: s.planId })
    shipRun(s.repo, s.planId, [{ part: 'biome', state: 'green' }])
    expect(await crashCli(s.repo.root, ['next'], 'merge-stamp', gateEnv(s.scenario))).toBe(9)
    expect((await s.repo.cli(['recover', '--complete'])).code).toBe(0)
    expect(closes(s.repo.root).filter((e) => e.id === id)).toHaveLength(1)
    s.stamp()
    expect(closes(s.repo.root)).toHaveLength(1)
    const { repo, planId } = await shippableRepo()
    const gone = item(repo, { plan: planId })
    expect(await crashCli(repo.root, ['abandon', planId], 'abandon-commit')).toBe(9)
    expect((await repo.cli(['recover', '--complete'])).code).toBe(0)
    expect(closes(repo.root).filter((e) => e.id === gone)).toHaveLength(1)
    await repo.cli(['abandon', planId])
    expect(closes(repo.root)).toHaveLength(1)
  }, 240_000)
})

describe('witness dismiss ledger (row 269)', () => {
  const at = (root: string, answer: string, out: string[] = [], err: string[] = [], env: Record<string, string> = {}): Ctx & { asked: string[] } => {
    const asked: string[] = []
    return { ...fakeCtx(root, { tty: true, env, out: (l) => out.push(l), err: (l) => err.push(l) }), ask: async (q) => { asked.push(q); return answer }, asked }
  }
  const args = (item: string, more: string[] = ['--cause', 'judged-wrong', '--note', 'the error is ours']) => ['ledger', '--item', item, ...more]

  it('ends an open item at a terminal by index or id, saying why, after asking', async () => {
    const repo = await seededRepo()
    const first = item(repo, {})
    const second = item(repo, { part: 'tsc' })
    const out: string[] = []
    const ctx = at(repo.root, 'y', out)
    expect(await dismiss(ctx, args('2'))).toBe(0)
    expect(byId(repo.root, second)).toMatchObject({ state: 'dismissed', end: { cause: 'judged-wrong', note: 'the error is ours' } })
    expect(ctx.asked[0]).toContain(`dismiss ${second}`)
    expect(out.join('\n')).toContain(`dismissed: ${second} — judged-wrong`)
    expect(await dismiss(at(repo.root, 'y'), args(first, ['--cause', 'rule-retired', '--note', 'the part is gone']))).toBe(0)
    expect(byId(repo.root, first).state).toBe('dismissed')
    expect(repo.git('log', '-1', '--format=%s')).toBe(`dismiss(ledger): ${first} rule-retired`)
  }, 120_000)

  it('refuses in a session, without a terminal, for an unknown, closed or dismissed item, and without a cause or a note — writing nothing', async () => {
    const repo = await seededRepo()
    const open = item(repo, {})
    const closed = item(repo, {})
    line(repo, LEDGER_STREAM, { t: 'ledger-closed', id: closed, by: 'merge', plan: 'p2', pr: 4 })
    const count = () => readStream(repo.root, LEDGER_STREAM).length
    const before = count()
    const refused = async (ctx: Ctx, argv: string[], rule: string) => {
      const err: string[] = []
      expect(await dismiss({ ...ctx, err: (l) => err.push(l) }, argv)).toBe(2)
      expect(err.join('\n')).toContain(rule)
    }
    await refused(at(repo.root, 'y', [], [], { WITNESS_DRIVE: 'p1' }), args(open), 'dismiss-in-session')
    await refused(fakeCtx(repo.root), args(open), 'dismiss-needs-terminal')
    await refused(at(repo.root, 'y'), args('l-ffffffff'), 'unknown-item')
    await refused(at(repo.root, 'y'), args(closed), 'already-closed')
    await refused(at(repo.root, 'y'), args(open, ['--cause', 'later', '--note', 'x']), 'cause-required')
    await refused(at(repo.root, 'y'), args(open, ['--cause', 'declined']), 'note-required')
    await refused(at(repo.root, 'n'), args(open), 'dismiss-declined')
    expect(count()).toBe(before)
    expect(await dismiss(at(repo.root, 'y'), args(open))).toBe(0)
    await refused(at(repo.root, 'y'), args(open), 'already-dismissed')
  }, 120_000)

  it('a ledger stream another history holds refuses the dismissal, writing nothing', async () => {
    const repo = await seededRepo()
    line(repo, LEDGER_STREAM, { t: 'recap', effort: 'ledger' })
    const err: string[] = []
    expect(await dismiss(at(repo.root, 'y', [], err), args('1'))).toBe(2)
    expect(err.join('\n')).toContain('stream-taken')
  }, 120_000)

  it('a kill after the line lands is completed once', async () => {
    // A child process has no terminal, so the crash the transaction records is staged as its marker
    // says: the dismissal's one ledger line appended, the commit not made.
    const repo = await seededRepo()
    const id = item(repo, {})
    const entry = { t: 'ledger-dismissed', id, cause: 'declined', note: 'not ours' }
    const written = appendEntry(repo.root, LEDGER_STREAM, entry as never)
    repo.write('.witness/txn.json', JSON.stringify({ op: 'dismiss(ledger)', files: ['.witness/journal/ledger.jsonl'], journalMulti: [{ stream: LEDGER_STREAM, line: written }] }))
    expect((await repo.cli(['recover', '--complete'])).code).toBe(0)
    expect(readStream(repo.root, LEDGER_STREAM).filter((e) => e.t === 'ledger-dismissed')).toHaveLength(1)
    const err: string[] = []
    expect(await dismiss(at(repo.root, 'y', [], err), args(id))).toBe(2)
    expect(err.join('\n')).toContain('already-dismissed')
  }, 120_000)
})

describe('status lists open bookings (row 269)', () => {
  it('status lists open bookings with their plan, check and what they hold, and the dismissal (rows 269, 274)', async () => {
    const repo = await seededRepo()
    item(repo, {})
    item(repo, { part: 'tsc', subject: { diagnostics: { ['a'.repeat(16)]: 2, ['b'.repeat(16)]: 1 } } })
    const gone = item(repo, { part: 'ui' })
    line(repo, LEDGER_STREAM, { t: 'ledger-dismissed', id: gone, cause: 'declined', note: 'x' })
    const out = (await repo.cli(['status'])).stdout
    expect(out).toMatch(/^booked\[2\]\{item,plan,check,holds,since\}:$/m)
    expect(out).toMatch(/^ {2}l-[0-9a-f]{8},p1,lint\/biome,whole part at aaaaaaa,ship r1$/m)
    expect(out).toMatch(/^ {2}l-[0-9a-f]{8},p1,lint\/tsc,3 diagnostics,ship r1$/m)
    expect(out).not.toContain(gone)
    expect(out).toContain('help: witness dismiss ledger --item <id|index> --cause <rule-retired|declined|judged-wrong> --note "<why>" — at your own terminal')
  }, 120_000)
})

// Row 274 (§3.3). The second kind, wherever a human reads the ledger.
const offItem = (repo: TestRepo, over: Record<string, unknown> = {}): string => {
  const id = newItemId()
  line(repo, LEDGER_STREAM, {
    t: 'ledger-open', id, key: '0'.repeat(16), kind: 'booked-switch-off', check: 'switch-offs', plan: 'p1', gate: 'implement',
    round: 2, run_id: 'r-1', file: 'src/a.ts', token: 'eslint-disable-next-line', subject: { lines: { ['1'.repeat(16)]: 1 } }, ...over,
  })
  return id
}

describe('a switch-off item where a human reads it (row 274)', () => {
  it('status names a switch-off item by its token and file, spelled out, its copies past one (Review Focus 3)', async () => {
    const repo = await seededRepo()
    const lint = item(repo, {})
    const a = offItem(repo)
    const odd = offItem(repo, { file: `src/we${String.fromCodePoint(0x202e)}ird.ts`, subject: { lines: { ['1'.repeat(16)]: 1, ['2'.repeat(16)]: 2 } } })
    expect(bookedRows(repo.root)).toEqual([
      { item: lint, plan: 'p1', check: 'lint/biome', holds: 'whole part at aaaaaaa', since: 'ship r1' },
      { item: a, plan: 'p1', check: 'switch-offs', holds: 'eslint-disable-next-line in src/a.ts', since: 'implement r2' },
      { item: odd, plan: 'p1', check: 'switch-offs', holds: 'eslint-disable-next-line in src/we\\u{202e}ird.ts ×3', since: 'implement r2' },
    ])
  }, 120_000)

  it("the dismissal's question names a switch-off item and says it stops waiving from the next gate run", async () => {
    const repo = await seededRepo()
    const id = offItem(repo)
    const asked: string[] = []
    const ctx = { ...fakeCtx(repo.root, { tty: true }), ask: async (q: string) => { asked.push(q); return 'n' } } as Ctx
    await dismiss(ctx, ['ledger', '--item', id, '--cause', 'judged-wrong', '--note', 'remove it'])
    expect(asked[0]).toBe(`dismiss ${id} — switch-offs · eslint-disable-next-line in src/a.ts · p1: judged-wrong\ndismiss? the booking stops waiving from the next gate run [y/N]`)
  }, 120_000)

  it('the lint observation reads lint items only; a switch-off item of the plan stays open (M-g)', async () => {
    const repo = await seededRepo()
    const lintId = item(repo, { plan: 'p1' })
    offItem(repo, { plan: 'p1' })
    shipRun(repo, 'p1', [{ part: 'biome', state: 'green' }])
    expect(mergeCloses(repo.root, 'p1', 7).map((c) => c.id)).toEqual([lintId])
  }, 120_000)
})

// Row 274 (§3.3). A switch-off item booking one line, keyed as the check keys it.
const offLine = (repo: TestRepo, o: { plan: string; file: string; token: string; snippet: string }): string => {
  const id = newItemId()
  line(repo, LEDGER_STREAM, {
    t: 'ledger-open', id, key: '0'.repeat(16), kind: 'booked-switch-off', check: 'switch-offs', plan: o.plan, gate: 'ship',
    round: 1, run_id: 'r-1', file: o.file, token: o.token, subject: { lines: { [switchOffKey(o)]: 1 } },
  })
  return id
}
// A real tree in the repo holding `files`, built through a scratch index (no checkout moves).
const treeWith = (repo: TestRepo, files: Record<string, string>): string => {
  const env = { ...process.env, GIT_INDEX_FILE: `${repo.root}/.git/witness-test-index-${Math.random().toString(16).slice(2)}` }
  const git = (args: string[], input?: string) => execFileSync('git', args, { cwd: repo.root, env, input, encoding: 'utf8' }).trim()
  for (const [path, body] of Object.entries(files)) {
    const blob = git(['hash-object', '-w', '--stdin'], body)
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`])
  }
  return git(['write-tree'])
}
// The plan's last ship round, reviewed on `tree` cut from `base` (a commit; absent as on a round before
// unit review I1), no lint parts.
const shipRunAt = (repo: TestRepo, planId: string, tree: string | undefined, base?: string) => line(repo, planId, {
  t: 'gate-run', gate: 'ship', artifact: planId, round: 9, run_id: `r-ship-${Math.random().toString(16).slice(2, 8)}`, reviewed_sha: 'c'.repeat(40),
  ...(tree !== undefined ? { reviewed_tree: tree } : {}), ...(base !== undefined ? { reviewed_base: base } : {}),
  prompts_sha: 'p', witness: '0', model: 'm', pin: 'm', outcome: 'stopped', checks: [{ name: 'switch-offs', ok: true }],
})
// A commit whose tree holds `files`: the base a ship round's tree was cut from.
const baseWith = (repo: TestRepo, files: Record<string, string>): string =>
  execFileSync('git', ['commit-tree', treeWith(repo, files), '-m', 'base'], { cwd: repo.root, encoding: 'utf8' }).trim()
const HELD = { 'src/a.ts': '// @ts-ignore\nclean()\n', 'src/c.ts': '// @ts-ignore\n' }

describe('a booked switch-off ends by observation (row 274)', () => {
  it("closes at the first merge whose tree no longer holds the line (§3.3; the map's Done-when)", async () => {
    const s = await mergedSeed()
    mergedPlan(s.repo, 'old-plan')
    const id = offLine(s.repo, { plan: 'old-plan', file: 'src/a.ts', token: '@ts-ignore', snippet: '// @ts-ignore' })
    const tree = treeWith(s.repo, { 'src/a.ts': 'clean()\n' })
    shipRunAt(s.repo, s.planId, tree, baseWith(s.repo, HELD))
    expect(s.stamp().stamped).toHaveLength(1)
    expect(byId(s.repo.root, id)).toMatchObject({ state: 'closed', end: { by: 'merge', plan: s.planId, pr: 7, tree } })
  }, 120_000)

  it("stays open while the tree holds the line, re-indented too; the merging plan's own line stays open", async () => {
    const s = await mergedSeed()
    mergedPlan(s.repo, 'old-plan')
    const old = offLine(s.repo, { plan: 'old-plan', file: 'src/a.ts', token: '@ts-ignore', snippet: '// @ts-ignore' })
    const own = offLine(s.repo, { plan: s.planId, file: 'src/b.ts', token: 'eslint-disable-next-line', snippet: '// eslint-disable-next-line no-console' })
    shipRunAt(s.repo, s.planId, treeWith(s.repo, { 'src/a.ts': 'x()\n    // @ts-ignore\n', 'src/b.ts': '// eslint-disable-next-line no-console\nlog()\n' }), baseWith(s.repo, HELD))
    s.stamp()
    expect([byId(s.repo.root, old).state, byId(s.repo.root, own).state]).toEqual(['open', 'open'])
  }, 120_000)

  it('a plan in flight waits for its own merge; no readable tree observes nothing', async () => {
    const s = await mergedSeed()
    const flying = offLine(s.repo, { plan: 'other-plan', file: 'src/a.ts', token: '@ts-ignore', snippet: '// @ts-ignore' })
    mergedPlan(s.repo, 'old-plan')
    const gone = offLine(s.repo, { plan: 'old-plan', file: 'src/c.ts', token: '@ts-ignore', snippet: '// @ts-ignore' })
    shipRunAt(s.repo, s.planId, 'b'.repeat(40), baseWith(s.repo, HELD))    // a tree the repo cannot read
    expect(mergeCloses(s.repo.root, s.planId, 7)).toEqual([])
    shipRunAt(s.repo, s.planId, treeWith(s.repo, { 'src/z.ts': 'z()\n' }), baseWith(s.repo, HELD))
    expect(mergeCloses(s.repo.root, s.planId, 7).map((c) => c.id)).toEqual([gone])
    expect(byId(s.repo.root, flying).state).toBe('open')
    expect(closes(s.repo.root)).toEqual([])                         // mergeCloses reads; only the stamp writes
  }, 120_000)

  it('an extra token dropped from the config still waits for its line (Review Focus 5)', async () => {
    const s = await mergedSeed()
    mergedPlan(s.repo, 'old-plan')
    // the config names no checks.switchOffs: the observation reads the item's own token and key
    const id = offLine(s.repo, { plan: 'old-plan', file: 'src/a.ts', token: 'extra:istanbul ignore', snippet: '/* istanbul ignore next */' })
    const held = baseWith(s.repo, { 'src/a.ts': '/* istanbul ignore next */\nf()\n' })
    shipRunAt(s.repo, s.planId, treeWith(s.repo, { 'src/a.ts': '/* istanbul ignore next */\nf()\n' }), held)
    expect(mergeCloses(s.repo.root, s.planId, 7)).toEqual([])
    shipRunAt(s.repo, s.planId, treeWith(s.repo, { 'src/a.ts': 'f()\n' }), held)
    expect(mergeCloses(s.repo.root, s.planId, 7).map((c) => c.id)).toEqual([id])
  }, 240_000)

  it("another plan's item closes only where the merging round's base held its line (unit review I1)", async () => {
    const s = await mergedSeed()
    mergedPlan(s.repo, 'old-plan')
    const old = offLine(s.repo, { plan: 'old-plan', file: 'src/a.ts', token: '@ts-ignore', snippet: '// @ts-ignore' })
    const own = offLine(s.repo, { plan: s.planId, file: 'src/b.ts', token: '@ts-ignore', snippet: '// @ts-ignore' })
    const lacking = treeWith(s.repo, { 'src/a.ts': 'clean()\n', 'src/b.ts': 'b()\n' })
    // the merging tree lacks old-plan's line, but its base never held it (merged after the fork): no word on it
    shipRunAt(s.repo, s.planId, lacking, baseWith(s.repo, { 'src/a.ts': 'clean()\n' }))
    expect(mergeCloses(s.repo.root, s.planId, 7).map((c) => c.id)).toEqual([own])
    // a round from before the base was journaled observes the merging plan's own items only
    shipRunAt(s.repo, s.planId, lacking)
    expect(mergeCloses(s.repo.root, s.planId, 7).map((c) => c.id)).toEqual([own])
    // the base held it and the merging tree does not: this merge took it out
    shipRunAt(s.repo, s.planId, lacking, baseWith(s.repo, HELD))
    expect(mergeCloses(s.repo.root, s.planId, 7).map((c) => c.id).sort()).toEqual([old, own].sort())
  }, 120_000)

  it('reads the newest ship round only: one with no readable tree observes nothing (unit review M-a)', async () => {
    const s = await mergedSeed()
    mergedPlan(s.repo, 'old-plan')
    offLine(s.repo, { plan: 'old-plan', file: 'src/a.ts', token: '@ts-ignore', snippet: '// @ts-ignore' })
    shipRunAt(s.repo, s.planId, treeWith(s.repo, { 'src/a.ts': 'clean()\n' }), baseWith(s.repo, HELD))
    shipRunAt(s.repo, s.planId, undefined, baseWith(s.repo, HELD))       // what merged: no tree written
    expect(mergeCloses(s.repo.root, s.planId, 7)).toEqual([])
  }, 120_000)

  it("an abandoned plan's switch-off items close in the abandon", async () => {
    const { repo, planId } = await shippableRepo()
    const mine = offLine(repo, { plan: planId, file: 'src/a.ts', token: '@ts-ignore', snippet: '// @ts-ignore' })
    const r = await repo.cli(['abandon', planId])
    expect(r.code, r.stderr).toBe(0)
    expect(byId(repo.root, mine)).toMatchObject({ state: 'closed', end: { by: 'abandon', plan: planId } })
  }, 120_000)
})

const lossItem = (repo: TestRepo, over: Record<string, unknown> = {}): string => {
  const id = newItemId()
  line(repo, LEDGER_STREAM, { t: 'ledger-open', id, key: '0'.repeat(16), kind: 'booked-dropped', check: 'switch-offs', plan: 'p1',
    gate: 'implement', round: 2, run_id: 'r-1', spec: 'auth-refresh', base: { passed: 2, skipped: 0 }, subject: { cases: 1 }, ...over })
  return id
}
describe('a booked loss where a human reads it (row 276)', () => {
  it('status and the dismissal name a booked loss by its spec (row 276)', async () => {
    const repo = await seededRepo()
    const one = lossItem(repo)
    const two = lossItem(repo, { subject: { cases: 2 } })
    expect(bookedRows(repo.root)).toEqual([
      { item: one, plan: 'p1', check: 'switch-offs', holds: 'tests of auth-refresh, 1 case', since: 'implement r2' },
      { item: two, plan: 'p1', check: 'switch-offs', holds: 'tests of auth-refresh, 2 cases', since: 'implement r2' },
    ])
    const asked: string[] = []
    const ctx = { ...fakeCtx(repo.root, { tty: true }), ask: async (q: string) => { asked.push(q); return 'n' } } as Ctx
    await dismiss(ctx, ['ledger', '--item', one, '--cause', 'declined', '--note', 'restore them'])
    expect(asked[0]).toBe(`dismiss ${one} — switch-offs · tests of auth-refresh · p1: declined\ndismiss? the booking stops waiving from the next gate run [y/N]`)
  }, 120_000)
})

// The merging plan's ship round, its summary as given (none when undefined).
const shipSummary = (repo: TestRepo, planId: string, junit: Record<string, unknown> | undefined) => line(repo, planId, {
  t: 'gate-run', gate: 'ship', artifact: planId, round: 9, run_id: 'r-ship', reviewed_sha: 'c'.repeat(40), reviewed_tree: T,
  prompts_sha: 'p', witness: '0', model: 'm', pin: 'm', outcome: 'stopped', checks: [], ...(junit !== undefined ? { junit } : {}) })
const counts = (passed: number, skipped = 0) => ({ passed, failed: 0, skipped })

describe('a booked loss ends by observation (row 276)', () => {
  it("closes at its own plan's merge when the shipped summary has the cases back", async () => {
    const s = await mergedSeed()
    const id = lossItem(s.repo, { plan: s.planId })
    shipSummary(s.repo, s.planId, { ...counts(2), specs: { 'auth-refresh': counts(2) } })
    s.stamp()
    expect(byId(s.repo.root, id)).toMatchObject({ state: 'closed', end: { by: 'merge', plan: s.planId, pr: 7, tree: T } })
  }, 120_000)

  it("a plan's own loss stays open where the merged round, rebased onto more cases, still lost them (unit review I1)", async () => {
    const s = await mergedSeed()
    const id = lossItem(s.repo, { plan: s.planId })                        // booked against {2, 0} at implement
    shipSummary(s.repo, s.planId, { ...counts(4), specs: { 'auth-refresh': counts(4) }, base: { 'auth-refresh': { passed: 5, skipped: 0 } } })
    s.stamp()
    expect(byId(s.repo.root, id).state).toBe('open')
    const t = await mergedSeed()
    const back = lossItem(t.repo, { plan: t.planId })
    shipSummary(t.repo, t.planId, { ...counts(5), specs: { 'auth-refresh': counts(5) }, base: { 'auth-refresh': { passed: 5, skipped: 0 } } })
    t.stamp()
    expect(byId(t.repo.root, back)).toMatchObject({ state: 'closed', end: { by: 'merge', plan: t.planId } })
  }, 240_000)

  it('stays open while the shipped summary is still short — fewer passing, or more skipped', async () => {
    const s = await mergedSeed()
    const fewer = lossItem(s.repo, { plan: s.planId })
    const skips = lossItem(s.repo, { plan: s.planId, spec: 'other-spec', base: { passed: 2, skipped: 0 } })
    shipSummary(s.repo, s.planId, { ...counts(4, 2), specs: { 'auth-refresh': counts(1, 1), 'other-spec': counts(3, 1) } })
    s.stamp()
    expect(byId(s.repo.root, fewer).state).toBe('open')
    expect(byId(s.repo.root, skips).state).toBe('open')                    // more passing, but one skip more than the base
    expect(closes(s.repo.root)).toEqual([])
  }, 120_000)

  it("another merged plan's loss closes only where this round's base was short and the summary is not (Review Focus 5)", async () => {
    const a = await mergedSeed()
    mergedPlan(a.repo, 'old-plan')
    const restored = lossItem(a.repo, { plan: 'old-plan' })
    shipSummary(a.repo, a.planId, { ...counts(2), specs: { 'auth-refresh': counts(2) }, base: { 'auth-refresh': { passed: 1, skipped: 1 } } })
    a.stamp()
    expect(byId(a.repo.root, restored)).toMatchObject({ state: 'closed', end: { by: 'merge', plan: a.planId, pr: 7, tree: T } })
    const b = await mergedSeed()
    mergedPlan(b.repo, 'old-plan')
    const cutBefore = lossItem(b.repo, { plan: 'old-plan' })
    shipSummary(b.repo, b.planId, { ...counts(2), specs: { 'auth-refresh': counts(2) }, base: { 'auth-refresh': { passed: 2, skipped: 0 } } })
    b.stamp()
    expect(byId(b.repo.root, cutBefore).state).toBe('open')                // the base was not short: this merge restored nothing
    const c = await mergedSeed()
    mergedPlan(c.repo, 'old-plan')
    const noBase = lossItem(c.repo, { plan: 'old-plan' })
    shipSummary(c.repo, c.planId, { ...counts(2), specs: { 'auth-refresh': counts(2) } })
    c.stamp()
    expect(byId(c.repo.root, noBase).state).toBe('open')                   // no base counts for the spec: nothing observed
  }, 360_000)

  it('a ship round with no summary observes nothing; the abandon closes it', async () => {
    const s = await mergedSeed()
    const id = lossItem(s.repo, { plan: s.planId })
    shipSummary(s.repo, s.planId, undefined)
    s.stamp()
    expect(byId(s.repo.root, id).state).toBe('open')
    expect(closes(s.repo.root)).toEqual([])
    const { repo, planId } = await shippableRepo()
    const mine = lossItem(repo, { plan: planId })
    const r = await repo.cli(['abandon', planId])
    expect(r.code, r.stderr).toBe(0)
    expect(byId(repo.root, mine)).toMatchObject({ state: 'closed', end: { by: 'abandon', plan: planId } })
  }, 240_000)

  it("another plan still in flight waits for its own merge", async () => {
    const s = await mergedSeed()
    const inFlight = lossItem(s.repo, { plan: 'still-going' })
    shipSummary(s.repo, s.planId, { ...counts(2), specs: { 'auth-refresh': counts(2) }, base: { 'auth-refresh': { passed: 1, skipped: 0 } } })
    s.stamp()
    expect(byId(s.repo.root, inFlight).state).toBe('open')
  }, 120_000)
})

// Row 278. A booked hidden rule (one spot per entry) and a booked loosened part, as the booking writes them.
const looseItem = (repo: TestRepo, o: { plan: string; spots: Array<{ file: string; snippet: string; lineless?: true }> }): string => {
  const id = newItemId()
  const hidden = Object.fromEntries(o.spots.map((x) => [loosenedKey({ tool: 'biome', rule: 'lint/test/noBad', file: x.file, snippet: x.snippet }),
    { file: x.file, copies: 1, ...(x.lineless ? { lineless: true } : {}) }]))
  line(repo, LEDGER_STREAM, { t: 'ledger-open', id, key: '0'.repeat(16), kind: 'booked-loosened', check: 'switch-offs', plan: o.plan, gate: 'ship',
    round: 1, run_id: 'r-1', tool: 'biome', rule: 'lint/test/noBad', subject: { hidden } })
  return id
}
const SCRIPTS = { lint: 'node fake-lint.mjs check' }
const jsonId = (v: unknown) => `json:${createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)}`
const partItem = (repo: TestRepo, plan: string): string => {
  const id = newItemId()
  line(repo, LEDGER_STREAM, { t: 'ledger-open', id, key: '0'.repeat(16), kind: 'booked-loosened', check: 'switch-offs', plan, gate: 'ship',
    round: 1, run_id: 'r-1', part: 'lint', subject: { defs: { 'package.json#scripts': jsonId(SCRIPTS) } } })
  return id
}
const BADLINE = 'export const x = "BAD"'
const pkg = (scripts: unknown) => `${JSON.stringify({ name: 'x', scripts }, null, 2)}\n`

describe('a booked loosening ends by observation (row 278)', () => {
  it("the plan's own hidden item stays open at its merge while the merged tree holds the line, and closes once it does not (row 278)", async () => {
    const s = await mergedSeed()
    const id = looseItem(s.repo, { plan: s.planId, spots: [{ file: 'src/hidden.ts', snippet: BADLINE }] })
    shipRunAt(s.repo, s.planId, treeWith(s.repo, { 'src/hidden.ts': `  ${BADLINE}\n` }), baseWith(s.repo, {}))
    expect(mergeCloses(s.repo.root, s.planId, 7).map((c) => c.id)).not.toContain(id)
    const tree = treeWith(s.repo, { 'src/hidden.ts': 'export const x = "fine"\n' })
    shipRunAt(s.repo, s.planId, tree, baseWith(s.repo, {}))
    expect(mergeCloses(s.repo.root, s.planId, 7)).toContainEqual(expect.objectContaining({ id, by: 'merge', plan: s.planId, pr: 7, tree }))
  }, 120_000)

  it('a later merge that rewrites the line closes it — only where its base held the line (row 278)', async () => {
    const s = await mergedSeed()
    mergedPlan(s.repo, 'old-plan')
    const id = looseItem(s.repo, { plan: 'old-plan', spots: [{ file: 'src/hidden.ts', snippet: BADLINE }, { file: 'src/b.ts', snippet: BADLINE }] })
    const lacking = treeWith(s.repo, { 'src/hidden.ts': 'x\n', 'src/b.ts': 'y\n' })
    shipRunAt(s.repo, s.planId, lacking, baseWith(s.repo, { 'src/z.ts': 'z\n' }))          // a base that never held it: no word on it
    expect(mergeCloses(s.repo.root, s.planId, 7).map((c) => c.id)).not.toContain(id)
    shipRunAt(s.repo, s.planId, treeWith(s.repo, { 'src/hidden.ts': 'x\n', 'src/b.ts': `${BADLINE}\n` }), baseWith(s.repo, { 'src/hidden.ts': `${BADLINE}\n` }))
    expect(mergeCloses(s.repo.root, s.planId, 7).map((c) => c.id)).not.toContain(id)    // one spot still held
    shipRunAt(s.repo, s.planId, lacking, baseWith(s.repo, { 'src/b.ts': `${BADLINE}\n` }))
    expect(mergeCloses(s.repo.root, s.planId, 7).map((c) => c.id)).toContain(id)
  }, 120_000)

  it('a lineless hidden item closes only once its file is gone (row 278)', async () => {
    const s = await mergedSeed()
    const id = looseItem(s.repo, { plan: s.planId, spots: [{ file: 'src/fmt.ts', snippet: '', lineless: true }] })
    shipRunAt(s.repo, s.planId, treeWith(s.repo, { 'src/fmt.ts': '\n\n' }), baseWith(s.repo, {}))
    expect(mergeCloses(s.repo.root, s.planId, 7).map((c) => c.id)).not.toContain(id)
    shipRunAt(s.repo, s.planId, treeWith(s.repo, { 'src/other.ts': 'o\n' }), baseWith(s.repo, {}))
    expect(mergeCloses(s.repo.root, s.planId, 7).map((c) => c.id)).toContain(id)
  }, 120_000)

  it("a part item closes once a merged tree holds the base's check definitions again (row 278)", async () => {
    const s = await mergedSeed()
    const own = partItem(s.repo, s.planId)
    mergedPlan(s.repo, 'old-plan')
    const old = partItem(s.repo, 'old-plan')
    // a merge that edits the scripts again: both stay open
    shipRunAt(s.repo, s.planId, treeWith(s.repo, { 'package.json': pkg({ lint: 'true' }) }), baseWith(s.repo, { 'package.json': pkg({ lint: 'true' }) }))
    expect(mergeCloses(s.repo.root, s.planId, 7)).toEqual([])
    // the scripts restored: the plan's own closes; another plan's only where the base did not hold them
    const restored = treeWith(s.repo, { 'package.json': pkg(SCRIPTS) })
    shipRunAt(s.repo, s.planId, restored, baseWith(s.repo, { 'package.json': pkg(SCRIPTS) }))
    expect(mergeCloses(s.repo.root, s.planId, 7).map((c) => c.id)).toEqual([own])
    shipRunAt(s.repo, s.planId, restored, baseWith(s.repo, { 'package.json': pkg({ lint: 'true' }) }))
    expect(mergeCloses(s.repo.root, s.planId, 7).map((c) => c.id).sort()).toEqual([own, old].sort())
  }, 120_000)

  it('an unreadable tree, or a round with no tree, observes nothing (row 278)', async () => {
    const s = await mergedSeed()
    looseItem(s.repo, { plan: s.planId, spots: [{ file: 'src/hidden.ts', snippet: BADLINE }] })
    partItem(s.repo, s.planId)
    shipRunAt(s.repo, s.planId, 'b'.repeat(40), baseWith(s.repo, {}))
    expect(mergeCloses(s.repo.root, s.planId, 7)).toEqual([])
    shipRunAt(s.repo, s.planId, undefined, baseWith(s.repo, {}))
    expect(mergeCloses(s.repo.root, s.planId, 7)).toEqual([])
    expect(hiddenInTree(s.repo.root, 'b'.repeat(40), 'src/hidden.ts', 'biome', 'lint/test/noBad', new Set(['k']), false)).toBeUndefined()
  }, 120_000)

  it("the abandon closes the plan's loosened items (row 278)", async () => {
    const { repo, planId } = await shippableRepo()
    const mine = looseItem(repo, { plan: planId, spots: [{ file: 'src/hidden.ts', snippet: BADLINE }] })
    const part = partItem(repo, planId)
    const r = await repo.cli(['abandon', planId])
    expect(r.code, r.stderr).toBe(0)
    expect([byId(repo.root, mine).state, byId(repo.root, part).state]).toEqual(['closed', 'closed'])
  }, 120_000)
})
