import { afterAll, describe, expect, it } from 'vitest'
import { cliAct, type Act } from '../src/act.js'
import { grantAct } from '../src/allowlist.js'
import type { Entry } from '../src/journal.js'
import { satisfyCommand } from '../src/needs.js'
import { needYouRows, type NeedYou } from '../src/needs-you.js'
import { recommend, renderDecision } from '../src/recommend.js'
import { exitActs, reopenActs } from '../src/rounds.js'
import { shellLine } from '../src/toon.js'
import { commitEntry, RECAP, seededRepo } from './helpers.js'
import { dropStub, MODES, type Mode, PAYLOADS, type Pasteable, pasteIn, REF_PAYLOADS } from './shells.js'

// Row 239. A pasted line runs only what witness wrote. Each row builds lines with witness's own
// code around a hostile payload, and each line is pasted alone into every shell here: it must
// make no marker file and, where the row says, hand its stubs exactly the argv witness composed.
// A row's own payload list replaces PAYLOADS.
type Row = [name: string, build: (payload: string) => Pasteable[] | Promise<Pasteable[]>, payloads?: readonly string[]]

// One stopped plan run whose one blocking finding a reviewer anchored where it liked, at its
// round: three in a row reach the bound.
const anchoredRun = (anchor: string, round = 1): Entry => ({
  v: 1, t: 'gate-run', gate: 'plan', artifact: 'p1', round, run_id: `r-${round}`, reviewed_sha: `s${round}`, prompts_sha: 'ps',
  witness: '0', model: 'm', pin: 'm', harness: 'claude-code', checks: [], outcome: 'stopped',
  verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [{ blocking: true, anchor, claim: 'x' }] }],
} as unknown as Entry)
// The first `n` rounds of that run's game, and the same first round parked by a stop.
const rounds = (p: string, n: number): Entry[] => Array.from({ length: n }, (_, i) => anchoredRun(`p1 > ## Notes ${p}`, i + 1))
const parked = (p: string): Entry[] =>
  [...rounds(p, 1), { v: 1, t: 'human-decision', gate: 'plan', artifact: 'p1', round: 1, decision: 'stop' } as unknown as Entry]

// One act as the human pastes it: its line, which must hand `witness` exactly its argv.
const pasteable = (a: Act): Pasteable => ({ line: a.line, calls: [['witness', ...a.argv]] })

// K1: every runnable option the block offers, and its `run:` line, each as the human pastes it.
function decisionLines(p: string, target = 'p1', upstream = 'auth-refresh'): Pasteable[] {
  const d = recommend({ gate: 'plan', target, entries: [anchoredRun(`p1 > ## Notes ${p}`)], upstream, stale: false })!
  const run = renderDecision(d).find((l) => l.startsWith('run: '))
  if (run === undefined) throw new Error(`K1: the ${d.rule} block printed no run: line`)
  return [
    ...d.options.filter((o) => o.runnable).map((o) => ({ line: o.command, calls: [['witness', ...o.act!.argv]] })),
    { line: run.slice('run: '.length), calls: [['witness', ...d.options[0]!.act!.argv]] },
  ]
}

// K2: each act the exits name, below the bound and at it.
function exitLines(p: string): Pasteable[] {
  const atBound = exitActs('plan', `p1${p}`, rounds(p, 3), false, `up${p}`)
  if (atBound.at(-1)?.argv[0] !== 'abandon') throw new Error('K2: three rounds did not reach the bound')
  return [...exitActs('plan', `p1${p}`, rounds(p, 1), false, `up${p}`), ...atBound].map(pasteable)
}

// K3: the `next:` value offered for an effort stream committed by hand and named for the payload.
// A stream's slug is its file's name, and any stream that opens with a recap is an effort. The
// value is a shape: pasted, its `<spec-id>` redirect fails, so the row checks inertness only.
async function forgedNext(p: string): Promise<Pasteable[]> {
  const repo = await seededRepo({ noRecap: true })
  commitEntry(repo, `e${p}`, { t: 'recap', ...RECAP, effort: `e${p}` })
  const res = await repo.cli(['next'])
  const line = res.stdout.split('\n').find((l) => l.startsWith('next: '))?.slice('next: '.length)
  if (line === undefined || !line.includes('witness write <spec-id> --effort ')) {
    throw new Error(`K3: next offered no write shape\n${res.stdout}${res.stderr}`)
  }
  return [{ line }]
}

// K6: every command an inbox row offers, its `run:` or `then:` label cut, beside the act it prints.
const OFFERED = /^ {2}(?:run|then): /
function inboxLines(p: string): Pasteable[] {
  const target = `p1${p}`
  const show = cliAct('decide', 'plan', target, '--show')
  const open = cliAct('design', target, '--open')
  const look = cliAct('decide', 'design', target, '--show')
  const satisfy = cliAct('satisfy', target, '--need', `n${p}`)
  const retry = cliAct('retry', target)
  const reopen = reopenActs('plan', target, parked(p), `up${p}`)
  const items: Array<[NeedYou, Act[]]> = [
    [{ kind: 'decision', target, key: 'decision', gate: 'plan', show }, [show]],
    [{ kind: 'design-look', target, key: 'design-look', open, show: look }, [open, look]],
    [{ kind: 'need', target, key: 'need', need: `n${p}`, text: 'prod access', holds: [], satisfy }, [satisfy]],
    [{ kind: 'stuck', target, key: 'stuck', retry }, [retry]],
    [{ kind: 'parked', target, key: 'parked', gate: 'plan', round: 1, why: 'parked at p1 > ## Notes', reopen }, reopen],
  ]
  return items.flatMap(([item, acts]) => {
    const lines = needYouRows(item).filter((r) => OFFERED.test(r)).map((r) => r.replace(OFFERED, ''))
    if (lines.length !== acts.length) throw new Error(`K6: the ${item.kind} rows offered ${lines.length} commands`)
    return lines.map((line, i) => ({ line, calls: [['witness', ...acts[i]!.argv]] }))
  })
}

const ROWS: Row[] = [
  ['quoter: a POSIX word', (p) => [{ line: shellLine(['witness', 'x', p], 'darwin'), calls: [['witness', 'x', p]] }]],
  // zsh reads a bare `=ls` as the path of `ls`
  ['quoter: a word starting with =', (p) => [{ line: shellLine(['witness', p], 'darwin'), calls: [['witness', p]] }], ['=ls']],
  // PowerShell's quoting, pasted into a POSIX shell (Git Bash), is lossy for `'`: inert only
  ['quoter: the Windows form in a POSIX shell', (p) => [{ line: shellLine(['witness', 'x', p], 'win32') }]],
  ["K1 the decision block, a reviewer's anchor", decisionLines],
  ['K1 the decision block, a hostile target and upstream', (p) => decisionLines(p, `p1${p}`, `up${p}`)],
  ['K2 exits below and at the bound', exitLines],
  ['K2 a reopen', (p) => reopenActs('plan', `p1${p}`, parked(p), `up${p}`).map(pasteable)],
  ['K3 a next: shape from a forged effort stream', forgedNext],
  ['K6 an inbox row', inboxLines],
  ['K7 a satisfy', (p) => [{ line: satisfyCommand(`p1${p}`, `n${p}`), calls: [['witness', 'satisfy', `p1${p}`, '--need', `n${p}`]] }]],
  ['K10 a trust grant', (p) => [{ line: grantAct(`p1${p}`, { cmd: p })!.line, calls: [['witness', 'trust', `p1${p}`, '--cmd', p]] }]],
]

// Row 239. Where each payload was built to bite (the inventory's "Which payload bites where"), as
// the line that puts it there. Pasted there, a payload must run its code in some shell here, or
// every row above would pass it vacuously. P6 breaks out of double quotes only where history
// expands, as in a human's paste. The table holds every payload, in order.
const bare = (p: string): string => `witness x ${p}`
const doubled = (p: string): string => `witness x "${p}"`
const single = (p: string): string => `witness x '${p}'`
const INTERACTIVE = MODES.filter((m) => m.endsWith('-i'))
const BITES: ReadonlyArray<readonly [payload: string, line: (p: string) => string, modes: readonly Mode[]]> = [
  ['$(touch M1)', bare, MODES],
  ['`touch M2`', bare, MODES],
  ['"; touch M3; "', doubled, MODES],
  ["'; touch M4; '", single, MODES],
  [';touch M5;', bare, MODES],
  ['!#;touch M6;#', doubled, INTERACTIVE],
  ['main$(touch${IFS}M7)', bare, MODES],
  ['main$(touch${=IFS}M8)', bare, MODES],
  ...REF_PAYLOADS.map((p) => [p, bare, MODES] as const),
]

// Row 239. A row's pastes run at most this many at a time, each result at its job's index. A job
// that fails starts no more, and the first failure throws once every running job has settled, so
// no paste outlives its test.
const AT_ONCE = 8
async function pooled<T, R>(jobs: readonly T[], run: (job: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let next = 0
  let failed: { error: unknown } | undefined
  const lane = async (): Promise<void> => {
    while (failed === undefined && next < jobs.length) {
      const at = next++
      try { out[at] = await run(jobs[at]!) } catch (error) { failed ??= { error } }
    }
  }
  await Promise.all(Array.from({ length: AT_ONCE }, lane))
  if (failed !== undefined) throw failed.error
  return out
}

describe.skipIf(MODES.length === 0)('a pasted line runs only what witness wrote (row 239)', () => {
  afterAll(dropStub)

  // Without it, a broken harness would pass every row. Each mode must see a line that does run
  // code, and an interactive one must expand history, as a human's paste meets it: there `!#`
  // inserts the line typed so far, opening quote included, so `;touch M6;` runs outside quotes.
  it('the harness sees a line that does run code', async () => {
    for (const mode of MODES) {
      expect(await pasteIn(mode, 'witness x $(touch M1)'), mode).toEqual({ markers: ['M1'], calls: [['witness', 'x']] })
    }
    for (const mode of MODES.filter((m) => m.endsWith('-i'))) {
      expect((await pasteIn(mode, 'witness x "!#;touch M6;\\"')).markers, mode).toEqual(['M6'])
    }
  })

  // Row 239. A payload may put its effect in the background, after the shell has exited: the
  // paste waits for the pipes the background job holds, as spawnSync did, so its marker is found.
  it.skipIf(!MODES.includes('bash'))('a line that backgrounds its effect is still caught (row 239)', async () => {
    expect(await pasteIn('bash', 'witness x; (sleep 0.3; touch M9) &')).toEqual({ markers: ['M9'], calls: [['witness', 'x']] })
  })

  it('each payload runs its code where it is meant to bite (row 239)', async () => {
    expect(BITES.map(([p]) => p)).toEqual([...PAYLOADS, ...REF_PAYLOADS])
    const zsh = MODES.some((m) => m.startsWith('zsh'))
    for (const [p, line, modes] of BITES) {
      // `${=IFS}` is zsh's form, which bash and dash refuse as a bad substitution: with no zsh
      // here it bites nowhere, and CI's Ubuntu has none.
      if (p.includes('${=IFS}') && !zsh) continue
      const marker = /M\d/.exec(p)![0]
      const fired: Mode[] = []
      for (const mode of modes) {
        if ((await pasteIn(mode, line(p))).markers.includes(marker)) fired.push(mode)
      }
      expect(fired, line(p)).not.toEqual([])
    }
  }, 120_000)

  // Built once per payload, in turn (a build may need a repo, which is async), then pasted alone
  // into every mode. Row 239: a row pastes a line into a shell once. Pasted again with no `cwd`, it
  // would run the same way, so a repeat is checked against the first paste's result. Those pastes
  // run `AT_ONCE` at a time; a line with a `cwd` always pastes, and in turn, since its markers are
  // scanned under that directory and deleted after each paste.
  it.each(ROWS)('%s', async (_, build, payloads = PAYLOADS) => {
    const items: Array<{ mode: Mode; x: Pasteable }> = []
    for (const p of payloads) {
      const xs = await build(p)
      for (const mode of MODES) for (const x of xs) items.push({ mode, x })
    }
    const key = ({ mode, x }: { mode: Mode; x: Pasteable }): string => `${mode}\0${x.line}`
    const once = [...new Map(items.filter(({ x }) => x.cwd === undefined).map((i) => [key(i), i])).values()]
    const pastes = await pooled(once, ({ mode, x }) => pasteIn(mode, x.line))
    const seen = new Map(once.map((i, at) => [key(i), pastes[at]!]))
    for (const i of items) {
      const pasted = i.x.cwd === undefined ? seen.get(key(i))! : await pasteIn(i.mode, i.x.line, i.x.cwd)
      expect(pasted.markers, `${i.mode}: ${i.x.line}`).toEqual([])
      if (i.x.calls !== undefined) expect(pasted.calls, `${i.mode}: ${i.x.line}`).toEqual(i.x.calls)
    }
  }, 120_000)
})
