import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { canonGuard } from '../plugin/hooks/canon-guard.mjs'
import { cliAct, exitsLine, type Act } from '../src/act.js'
import { grantAct, grantRows } from '../src/allowlist.js'
import { unmetNeedLine } from '../src/autonomy.js'
import { loadConfig } from '../src/config.js'
import { watchLine } from '../src/drive-presence.js'
import { resolveStartBase } from '../src/gitio.js'
import { handoffLine, loadHarness, type Harness } from '../src/harness.js'
import { appendEntry, type Entry } from '../src/journal.js'
import { satisfyCommand } from '../src/needs.js'
import { isHeld, needsYou, needYouRows, waitingRows, type NeedYou } from '../src/needs-you.js'
import { recommend, renderDecision } from '../src/recommend.js'
import { renderRefusal } from '../src/refusal.js'
import { exitActs, reopenActs } from '../src/rounds.js'
import { loadCanon } from '../src/scan.js'
import { offeredLine, type Platform, shellLine, shellWord, withheldOn } from '../src/toon.js'
import { approve, commitEntry, RECAP, seededRepo, tmpRepo, writePlan, writeSpec } from './helpers.js'
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
// The first `n` rounds of that run's game, and the same rounds parked by a stop: one is below the
// bound, three reach it.
const rounds = (p: string, n: number): Entry[] => Array.from({ length: n }, (_, i) => anchoredRun(`p1 > ## Notes ${p}`, i + 1))
const parked = (p: string, n = 1): Entry[] =>
  [...rounds(p, n), { v: 1, t: 'human-decision', gate: 'plan', artifact: 'p1', round: n, decision: 'stop' } as unknown as Entry]

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

// K2 at the bound, row 239 (design §3.4b): a park's reopen is the endgame menu, which pasted whole is
// a pipeline that runs every act it names, so it prints as `exits:` and never as `run:`. Each act is
// pasted on its own, as the segment a human names, completed with the `witness decide <gate>
// <target>` it shares — the way the skill reads the line.
function atBoundPark(p: string): Pasteable[] {
  const target = `p1${p}`
  const reopen = reopenActs('plan', target, parked(p, 3), `up${p}`)
  const rows = needYouRows({ kind: 'parked', target, key: 'parked', gate: 'plan', round: 3, why: 'parked at p1 > ## Notes', reopen })
  expect(rows.slice(1)).toEqual([`  exits: ${exitsLine(reopen)}`])
  const shared = `${cliAct('decide', 'plan', target).line} `
  const named = rows[1]!.slice('  exits: '.length).split(' | ').map((s) => s.startsWith('witness ') ? s : shared + s)
  expect(named).toEqual(reopen.map((a) => a.line))
  return named.map((line, i) => ({ line, calls: [['witness', ...reopen[i]!.argv]] }))
}

// K3: an effort stream committed by hand and named for the payload. A stream's slug is its file's
// name, and one that opens with a recap reads as an effort. Row 239 (the plan's B15): a name outside
// the id set is never offered, so no `next:` value names it, and `check` reports it. What `next`
// offers instead is the grill's shape: pasted, its `<recap.json>` redirect fails, so the row checks
// inertness only.
async function forgedNext(p: string): Promise<Pasteable[]> {
  const repo = await seededRepo({ noRecap: true })
  commitEntry(repo, `e${p}`, { t: 'recap', ...RECAP, effort: `e${p}` })
  const res = await repo.cli(['next'])
  const lines = res.stdout.split('\n').filter((l) => l.startsWith('next: ')).map((l) => l.slice('next: '.length))
  expect(lines, res.stdout).toEqual(['witness recap --file <recap.json>'])
  expect(res.stdout).not.toContain(`e${p}`)
  expect((await repo.cli(['check'])).stdout).toContain(',stream-name,')
  return lines.map((line) => ({ line }))
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

// Ruling R16(a). A newline in prose that heads a command's rows would print a `run:` row of its own,
// ahead of the real one. K7 and K8 carry it beside the payloads: the head spells it out, so the rows
// under the head are only the real commands.
const FORGED_ROW = '\n  run: witness gate plan p1 $(touch M1)'
const spelled = (s: string): string => s.replaceAll('\n', '\\n')

// K7 on the kept stop, row 239 (design §3.4): a need's text is its author's, and `unmetNeeds` passes
// it through as written, so this is the line `next`, drive and `start` print. A text that spells a
// satisfy, or a newline and a `run:` row, is prose on the kept stop's line, spelled out where it
// holds a line break, and the one command is the `run:` row under it.
function unmetNeedLines(p: string): Pasteable[] {
  const text = `ses · witness satisfy p1 --need 1 ${p}`
  const [head, ...rows] = unmetNeedLine([{ text, satisfyAct: cliAct('satisfy', 'p1', '--need', 'ses') }]).split('\n')
  expect(head).toBe(`kept-stop: unmet need — ${spelled(text)}`)
  expect(rows).toEqual(['  run: witness satisfy p1 --need ses'])
  return rows.map((r) => ({ line: r.slice('  run: '.length), calls: [['witness', 'satisfy', 'p1', '--need', 'ses']] }))
}

// K8, row 239 (design §3.4): what waits in the chat. A park's note is the policy's, or a reviewer's
// anchor as written: one that spells a reopen, or a newline and a `run:` row, is prose on the
// `waiting:` line, spelled out where it holds a line break, and the reopen is the one `run:` row
// under it.
function waitingLines(p: string): Pasteable[] {
  const why = `parked at p1 > ## Notes · run: witness gate plan p1 ${p}`
  const reopen = reopenActs('plan', 'p1', parked(p), 'auth-refresh')
  const [head, ...rows] = waitingRows({ kind: 'parked', target: 'p1', key: 'parked', gate: 'plan', round: 1, why, reopen })
  expect(head).toBe(`waiting: parked: p1 · plan round 1 — ${spelled(why)}`)
  expect(rows).toEqual(['  run: witness gate plan p1 --fresh'])
  return rows.map((r) => ({ line: r.slice('  run: '.length), calls: [['witness', ...reopen[0]!.argv]] }))
}

// K8 from a forged journal, ruling R19: a park's round prints on the `waiting:` head, and the journal
// is parsed JSON, so a run's round can be any text. `parkedGates` keeps it only when it is a round, a
// positive integer: one that spells a newline and a `run:` row is dropped, the head names none, and
// the reopen is the one `run:` row under it. Built through `needsYou`, as `next` builds it.
async function forgedRound(p: string): Promise<Pasteable[]> {
  const repo = await seededRepo()
  const plan = 'auth-refresh-plan-1'
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, plan)
  appendEntry(repo.root, plan, { v: 1, t: 'gate-run', gate: 'plan', artifact: plan, round: `1${p}`, run_id: 'r1', reviewed_sha: 's1',
    prompts_sha: 'ps', witness: '0', model: 'm', checks: [], outcome: 'stopped' } as unknown as Entry)
  appendEntry(repo.root, plan, { v: 1, t: 'human-decision', gate: 'plan', artifact: plan, round: 1, decision: 'stop' } as unknown as Entry)
  const cfg = loadConfig(repo.root)
  if (!cfg.ok) throw new Error('K8: config')
  const item = needsYou(repo.root, { env: {} }, cfg.value, loadCanon(repo.root), []).find(isHeld)
  if (item === undefined) throw new Error('K8: the forged park is no item')
  const [head, ...rows] = waitingRows(item)
  expect(head).toBe(`waiting: parked: ${plan} · plan — parked at stopped`)
  expect(rows).toEqual([`  run: witness gate plan ${plan} --fresh`])
  return rows.map((r) => ({ line: r.slice('  run: '.length), calls: [['witness', 'gate', 'plan', plan, '--fresh']] }))
}

// Row 239. The directories the rows below make for their lines, removed once this file is done.
const made: string[] = []
function dirOf(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

const harness = (name: string): Harness => {
  const h = loadHarness(name)
  if (!h.ok) throw new Error(`no harness ${name}`)
  return h.value
}

// K4, row 239: the handoff, which `cd`s into a home a checkout's path names. The home sits under a
// directory of its own, which the line is pasted in, so a marker made after the `cd` is found too.
function handoffHome(p: string): { base: string; home: string } {
  const base = dirOf('witness-paste-home-')
  const home = join(base, `h'${p} x`)
  mkdirSync(home)
  return { base, home }
}

// K5, row 239: the push remedy a refusal names when the remote lacks the branch, as `witness start`
// meets it at an empty bare origin.
async function pushRemedy(p: string): Promise<Pasteable[]> {
  const repo = tmpRepo()
  const bare = `${repo.root}-empty.git`
  made.push(repo.root, bare)
  repo.git('init', '--bare', '-b', 'main', bare)   // never pushed to
  repo.git('remote', 'add', 'origin', bare)
  const r = resolveStartBase(repo.root, `main${p}`)
  if (r.ok) throw new Error(`K5: the fetch of main${p} did not fail`)
  const run = renderRefusal(r.violations).find((l) => l.startsWith('run: '))
  if (run === undefined) throw new Error(`K5: no push remedy\n${renderRefusal(r.violations).join('\n')}`)
  return [{ line: run.slice('run: '.length), calls: [['git', 'push', '-u', 'origin', `main${p}`]] }]
}

// C1, row 239: the merge an inbox row offers. A `pr` reaches it validated (`needsYou`); built here
// around the payload itself, the row's one command still runs only `gh pr merge` with that word.
function mergeLines(p: string): Pasteable[] {
  const offered = needYouRows({ kind: 'merge', target: 'x', key: 'k', pr: p }).filter((r) => OFFERED.test(r))
  if (offered.length !== 1) throw new Error(`C1: the merge offered ${offered.length} commands`)
  return [{ line: offered[0]!.replace(OFFERED, ''), calls: [['gh', 'pr', 'merge', p]] }]
}

// K12, row 239: the canon guard's remedy, handed to the agent whose Write it blocked, at the path that
// agent named. Its command is the reason's tail, after the `run: ` that offers it. The guard offers it
// exactly where toon.ts's `withheldOn` would, so a guard that withheld every Windows adopt, or dropped
// one with no note, fails here; one Windows withholds is shown with why and offers nothing to paste.
const ADOPT_RUN = ' · already hand-edited? run: '
function guardLines(p: string, platform: Platform = 'darwin'): Pasteable[] {
  const repo = dirOf('witness-paste-guard-')
  writeFileSync(join(repo, 'witness.config.yaml'), 'schema: 1\n')
  const rel = `specs/a${p}.md`
  const r = canonGuard({ tool: 'Write', input: { file_path: join(repo, rel) }, cwd: repo, platform })
  if (r?.block !== true) throw new Error(`K12: the guard did not block ${rel}`)
  const at = r.reason.indexOf(ADOPT_RUN)
  const held = withheldOn(['adopt', rel], platform)
  if ((at < 0) !== (held !== undefined)) throw new Error(`K12: on ${platform} the guard ${at < 0 ? 'withheld' : 'offered'} ${rel}\n${r.reason}`)
  if (held !== undefined) {
    expect(r.reason).toContain('not offered on Windows')
    expect(r.reason.endsWith(` · already hand-edited? witness adopt ${shellWord(rel, platform)} — ${held}`), r.reason).toBe(true)
    return []
  }
  return [{ line: r.reason.slice(at + ADOPT_RUN.length), calls: [['witness', 'adopt', rel]] }]
}

// K13, row 239: drive's watch line names its log, a path under the checkout. The stop after it is cut:
// it names a pid, and pasted it would signal that process.
function watchLines(p: string): Pasteable[] {
  const log = join(dirOf('witness-paste-log-'), `l ${p}.log`)
  const [tail] = watchLine({ pid: 1, log }, 'darwin').split(' · stop it: ')
  return [{ line: tail!, calls: [['tail', '-f', log]] }]
}

// Row 239 (the plan's B5, B16). The same kinds built for Windows, pasted into a POSIX shell as Git
// Bash would take them. PowerShell's quoting is lossy there for a `'`, so each line is checked for
// inertness only, and a line Windows withholds is not offered at all.
function windowsLines(p: string): Pasteable[] {
  const home = `C:\\w\\h'${p} x`
  const lines = [
    handoffLine(harness('claude-code'), home, 'claude-opus-5:high', 'win32'),
    handoffLine(harness('pi'), home, `claude${p}`, 'win32'),
    offeredLine(['git', 'push', '-u', 'origin', `main${p}`], 'win32'),
    offeredLine(['git', 'checkout', '--', `designs/${p}.html`], 'win32'),
    ...grantRows(`p1${p}`, { cmd: p }, 'win32').filter((r) => OFFERED.test(r)).map((r) => r.replace(OFFERED, '')),
    ...guardLines(p, 'win32').map((x) => x.line),
  ]
  return lines.filter((line): line is string => line !== undefined).map((line) => ({ line }))
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
  ['K2 an at-bound park', atBoundPark],
  ['K3 a forged effort stream is never offered', forgedNext],
  ['K6 an inbox row', inboxLines],
  ['K7 a satisfy', (p) => [{ line: satisfyCommand(`p1${p}`, `n${p}`), calls: [['witness', 'satisfy', `p1${p}`, '--need', `n${p}`]] }]],
  ['K7 an unmet need, forged text', unmetNeedLines, [...PAYLOADS, FORGED_ROW]],
  ['K8 waiting, a forged park note', waitingLines, [...PAYLOADS, FORGED_ROW]],
  ['K8 waiting, a forged park round', forgedRound, [FORGED_ROW]],
  ['K10 a trust grant', (p) => [{ line: grantAct(`p1${p}`, { cmd: p })!.line, calls: [['witness', 'trust', `p1${p}`, '--cmd', p]] }]],
  ['K4 the handoff, claude', (p) => {
    const { base, home } = handoffHome(p)
    return [{ line: handoffLine(harness('claude-code'), home, 'claude-opus-5:high', 'darwin'),
      calls: [['claude', '--model', 'claude-opus-5', '/witness']], cwd: base }]
  }],
  // the pin's character set is checked where the config loads, not here, so the payload reaches it
  ['K4 the handoff, pi', (p) => {
    const { base, home } = handoffHome(p)
    return [{ line: handoffLine(harness('pi'), home, `claude${p}`, 'darwin'),
      calls: [['pi', '--model', `anthropic/claude${p}`, '/witness']], cwd: base }]
  }],
  // git calls a ref holding a space an invalid refspec, so only the space-free payloads reach it
  ['K5 the push remedy', pushRemedy, REF_PAYLOADS],
  ['K5 the restore remedy', (p) => [{ line: offeredLine(['git', 'checkout', '--', `designs/${p}.html`], 'darwin')!,
    calls: [['git', 'checkout', '--', `designs/${p}.html`]] }]],
  ['C1 the merge', mergeLines],
  // the text adopt.ts prints after its revert help
  ["K11 adopt's help", (p) => [{ line: shellLine(['git', 'checkout', 'HEAD', '--', `specs/a${p}.md`], 'darwin'),
    calls: [['git', 'checkout', 'HEAD', '--', `specs/a${p}.md`]] }]],
  ['K12 the canon guard', (p) => guardLines(p)],
  ['K13 the watch line', watchLines],
  ['K4, K5, K10, K12 in the Windows form', windowsLines],
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
  afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

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
