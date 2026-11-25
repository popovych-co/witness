// Row 269 (the trust design §3.3, the map's C18, C22). A ledger item ends by observation — at the
// merge stamp, from the shipped tree's lint, or at the abandon of its plan — or by a human at a
// terminal (`witness dismiss ledger`).
import { describe, expect, it } from 'vitest'
import type { Ctx } from '../src/cli.js'
import { appendEntry, readStream } from '../src/journal.js'
import { ledgerItems, mergeCloses, newItemId } from '../src/ledger.js'
import { loadCanon } from '../src/scan.js'
import { lazyStamp } from '../src/stamp.js'
import { LEDGER_STREAM } from '../src/streams.js'
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
