import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { SESSION_QUIET_MS, spawnSession, type SessionEnd } from '../src/drive.js'
import type { Ticker } from '../src/session-clock.js'
import { duration, sessionLimit } from '../src/usage.js'
import type { WorkerStream } from '../src/worker-stream.js'
import { awaitGone, fakeCtx, fakeScenario, orphansIn, seededRepo, type TestRepo } from './helpers.js'

// Row 245 (issue #80). A drive session ends when its turn ends, not when its process exits: a pi
// whose extension leaks a handle lives on after `agent_settled` (P5) and held its target until the
// timeout. Each fake prints a harness's NDJSON, then lingers as that pi did (`sleep 600`), and
// records the sleep's pid so the test can see that drive's stop took it too (no orphans).
//
// Awake time is scaled, never drive.test's fastTicker, whose virtual time per real millisecond is
// unbounded: here a check fires `ms / scale` real milliseconds after it is armed. A session runs at
// × 100 (a 60 s grace is 600 ms real, the 5 min never-started window 3 s), because a real wait must
// fall inside a window: the fake's own sleeps, and its start, which the never-started window
// times from spawn — at × 1000 that window is 300 ms real, less than a loaded machine may take to
// start a process. × 1000 is kept where the expected end does not hang on when the session
// starts. Every session ends within a few real seconds, so no test holds its worker's event loop
// (row 213), and a session that never ends meets its (scaled) timeout well inside the test's own.

const STEP = { kind: 'spawn', home: '', stage: 'implement', target: 'p1' } as const
const PREFIX = '[1 implement/p1] '

const scaledTicker = (scale: number): Ticker => {
  const t0 = performance.now()
  return {
    now: () => (performance.now() - t0) * scale,
    after: (ms, fn) => { const t = setTimeout(fn, ms / scale); return () => clearTimeout(t) },
  }
}

// One record as a /bin/sh line: what a harness in its streaming mode writes.
const say = (event: object): string => `printf '%s\\n' '${JSON.stringify(event).replaceAll("'", "'\\''")}'`
// The linger: the process stays after its turn, and the sleep's pid is kept for the orphan check.
const LINGER = 'sleep 600 & echo "sleep $!" >> "$FAKE_PIDS"; wait'

// pi `--mode json` (P4): the header, one turn that answers `text`, and the settle.
const header = say({ type: 'session', version: 3, id: 'S-1', timestamp: '2026-11-19T10:00:00.000Z', cwd: '/r' })
const answer = (text: string, stopReason = 'stop', errorMessage?: string): string[] => [
  say({ type: 'message_start', message: { role: 'assistant', content: [] } }),
  say({ type: 'message_end', message: { role: 'assistant', content: text === '' ? [] : [{ type: 'text', text }], stopReason, ...(errorMessage !== undefined ? { errorMessage } : {}) } }),
]
const piTurn = (text: string, stopReason = 'stop', errorMessage?: string): string[] => [
  say({ type: 'agent_start' }),
  say({ type: 'turn_start' }),
  say({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '/witness' }] } }),
  say({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: '/witness' }] } }),
  ...answer(text, stopReason, errorMessage),
  say({ type: 'turn_end' }),
  say({ type: 'agent_end', messages: [] }),
  say({ type: 'agent_settled' }),
]
// claude `--output-format stream-json`: init, one answer, and its result.
const claudeTurn = (text: string, result: { is_error: boolean; result: string }): string[] => [
  say({ type: 'system', subtype: 'init', session_id: 'C-1', cwd: '/r', tools: ['Bash'], model: 'claude-opus-4-6' }),
  say({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
  say({ type: 'result', subtype: result.is_error ? 'error_during_execution' : 'success', ...result }),
]

const ENDED = (how: string): RegExp =>
  new RegExp(`^\\[1 implement/p1\\] ended \\d\\d:\\d\\d:\\d\\d · ${how.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · \\S+$`)
const GRACE = 'turn ended · the process did not exit — stopped after 60s'

let repo: TestRepo
let base: Config
const pidFiles: string[] = []
beforeAll(async () => {
  repo = await seededRepo()
  const r = loadConfig(repo.root)
  if (!r.ok) throw new Error(`config refused: ${JSON.stringify(r.violations)}`)
  base = r.value
})
// A test that failed before its session ended leaves no sleep behind either.
afterEach(() => {
  for (const pid of pidFiles.splice(0).flatMap(orphansIn)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
})

// The fake, written and run once before its session: macOS checks a new executable at its first
// exec (measured here: 130-590 ms before a fresh script's first line, 4 ms on its next run), which
// would otherwise be timed as the session's own start.
interface Fake { bin: string; pids: string }
function fake(body: string[]): Fake {
  const dir = fakeScenario()
  const pids = join(dir, 'pids')
  pidFiles.push(pids)
  const bin = join(dir, 'agent')
  writeFileSync(bin, `#!/bin/sh\n[ "$1" = --warm ] && exit 0\n${body.join('\n')}\n`, { mode: 0o755 })
  spawnSync(bin, ['--warm'], { stdio: 'ignore' })
  return { bin, pids }
}

interface Run { end: SessionEnd; lines: string[] }
async function session(script: Fake | string[], o: {
  harness?: 'pi' | 'claude-code'; scale?: number; timeoutMs?: number; signal?: AbortSignal
  stream?: WorkerStream; onLine?: (l: string) => void
} = {}): Promise<Run> {
  const { bin, pids } = Array.isArray(script) ? fake(script) : script
  const lines: string[] = []
  const ctx = fakeCtx(repo.root, {
    env: { PATH: process.env.PATH ?? '', WITNESS_DRIVE_AGENT_BIN: bin, FAKE_PIDS: pids },
    out: (l) => { lines.push(l); o.onLine?.(l) },
  })
  const cfg: Config = { ...base, harness: o.harness ?? 'pi', drive: { ...base.drive, sessionTimeoutMs: o.timeoutMs ?? 600_000 } }
  const end = await spawnSession({ ...STEP, home: repo.root }, cfg, ctx, 1, { ticker: scaledTicker(o.scale ?? 100), signal: o.signal, stream: o.stream })
  // Drive's stop reaches what the session started: its process group (F11, row 218).
  if (process.platform !== 'win32') {
    for (const pid of orphansIn(pids)) expect(await awaitGone(pid), `pid ${pid} outlived its session`).toBe(true)
  }
  return { end, lines }
}

describe('a drive session ends when its turn ends (row 245, #80)', () => {
  it('a pi worker that settles and lingers ends 60 s later: exited, code 0, turn-ended line (P5)', async () => {
    const { end, lines } = await session([header, ...piTurn('Done.'), LINGER])
    expect(end).toMatchObject({ outcome: 'exited', code: 0, ending: 'turn-ended', failed: false, tail: ['Done.'] })
    expect(lines.at(-1)).toMatch(ENDED(GRACE))
    // Stopped by the grace, never by the timeout (10 min awake).
    expect(end.ms).toBeGreaterThanOrEqual(60_000)
    expect(end.ms).toBeLessThan(600_000)
    expect(lines.some((l) => l.includes('timed out'))).toBe(false)
  }, 30_000)

  // The chatty loop's real sleeps land inside the 600 ms (real) grace.
  it('a chatty leaky tail never cancels the grace and never enters the tail (P17)', async () => {
    const chatty = [
      '( i=0; while :; do i=$((i+1))',
      '  echo "chatty-stdout tick $i"; echo "chatty-stderr tick $i" >&2',
      `  ${say({ type: 'queue_update', steering: [], followUp: [] })}`,
      `  ${say({ type: 'entry_appended', entry: { type: 'custom', customType: 'leaky' } })}`,
      `  ${say({ type: 'session_info_changed', name: 'leaky' })}`,
      '  sleep 0.05; done ) &',
      'echo "chatty $!" >> "$FAKE_PIDS"',
    ]
    const { end, lines } = await session([header, ...piTurn('Done.'), ...chatty, LINGER])
    expect(end).toMatchObject({ outcome: 'exited', code: 0, ending: 'turn-ended' })
    expect(lines.at(-1)).toMatch(ENDED(GRACE))
    // Shown as they came, on both pipes …
    expect(lines).toContain(`${PREFIX}chatty-stdout tick 1`)
    expect(lines).toContain(`${PREFIX}chatty-stderr tick 1`)
    // … but the tail row 182 reads stopped at the settle, and the grace ran once.
    expect(end.tail).toEqual(['Done.'])
    expect(end.ms).toBeLessThan(120_000)
  }, 30_000)

  // The fake's real sleeps place the turn_start inside the first grace and the second answer past
  // where that grace would have ended (60 s = 600 ms real).
  it('a turn_start inside the grace cancels it; the next settle arms it again', async () => {
    const { end, lines } = await session([
      header, ...piTurn('First.'),
      'echo "a line inside the grace"',
      'sleep 0.2',                                    // 20 s awake: inside the first grace
      say({ type: 'turn_start' }),                    // cancels it
      'sleep 0.8',                                    // 80 s more: past where the first grace ended
      ...answer('Second.'),
      say({ type: 'turn_end' }), say({ type: 'agent_end', messages: [] }),
      say({ type: 'agent_settled' }),                 // arms it again
      LINGER,
    ])
    // The session lived past the first grace: the cancel held, so it printed its second answer.
    expect(lines).toContain(`${PREFIX}Second.`)
    expect(end).toMatchObject({ outcome: 'exited', code: 0, ending: 'turn-ended' })
    expect(lines.at(-1)).toMatch(ENDED(GRACE))
    // The line inside the grace stayed out of the tail; the cancel resumed it.
    expect(lines).toContain(`${PREFIX}a line inside the grace`)
    expect(end.tail).toEqual(['First.', 'Second.'])
  }, 30_000)

  // A 50 s timeout is 500 ms real, and the warmed fake's settle lands well inside it.
  it('a deadline inside the grace ends clean: "stopped at the deadline", outcome exited, never timeout', async () => {
    const { end, lines } = await session([header, ...piTurn('Done.'), LINGER], { timeoutMs: 50_000 })
    expect(end).toMatchObject({ outcome: 'exited', code: 0, ending: 'turn-ended', tail: ['Done.'] })
    expect(lines.at(-1)).toMatch(ENDED('turn ended · the process did not exit — stopped at the deadline'))
    expect(end.ms).toBeGreaterThanOrEqual(50_000)
    expect(lines.some((l) => l.includes('timed out'))).toBe(false)
  }, 30_000)

  it('a pi with no run-starting record within 5 min awake: never started, code 1 (P31, P49)', async () => {
    const shapes: Array<[string, string[]]> = [
      // P31: no login and a leaky extension — only the session header.
      ['the header alone (P31)', [header]],
      // P49: an extension names the session and appends an entry before pi's auth check fails.
      ['extension records before an auth failure (P49)', [
        'echo \'Warning: Model "claude-x" not found for provider "anthropic". Using custom model id.\' >&2',
        header,
        'echo "No API key found for anthropic." >&2',
        say({ type: 'session_info_changed', name: 'pass4-J' }),
        say({ type: 'entry_appended', entry: { type: 'custom', customType: 'pass4-J', data: { n: 1 } } }),
        say({ type: 'message_start', message: { role: 'custom', customType: 'note', content: 'hi', display: true } }),
        'echo "an extension says hello"',
      ]],
      // The window runs from spawn: a pi that leaks before it writes its header is caught too.
      ['nothing at all', []],
    ]
    // Side by side: each waits out the whole window (3 s real).
    const fakes = shapes.map(([, records]) => fake([...records, LINGER]))
    const runs = await Promise.all(fakes.map((f) => session(f)))
    shapes.forEach(([name], i) => {
      const { end, lines } = runs[i]!
      expect(end, name).toMatchObject({ outcome: 'exited', code: 1, ending: 'never-started' })
      expect(lines.at(-1), name).toMatch(ENDED(`never started · stopped after ${duration(SESSION_QUIET_MS)}`))
      expect(end.ms, name).toBeGreaterThanOrEqual(SESSION_QUIET_MS)
      expect(end.ms, name).toBeLessThan(600_000)
    })
    // P49's records came inside the window, and none of them counted as a start.
    expect(runs[1]!.lines).toContain(`${PREFIX}No API key found for anthropic.`)
    expect(runs[1]!.lines).toContain(`${PREFIX}an extension says hello`)
  }, 30_000)

  // Drive's never-started window is pi's (§4.3 "Drive sessions only"): claude names its run at
  // `system:init`, and one that never does stays on the timeout.
  it('a claude session that never starts is left to its timeout', async () => {
    const { end, lines } = await session(['echo "starting"', LINGER], { harness: 'claude-code', scale: 1000 })
    expect(end.outcome).toBe('timeout')
    expect(end.ending).toBeUndefined()
    expect(lines.at(-1)).toMatch(/\] ended \d\d:\d\d:\d\d · timed out · \S+$/)
  }, 30_000)

  // The handler's real sleep (8 s awake) stays inside the 5 min window (3 s real).
  it('an 8 s before_agent_start handler is not "never started" (P27)', async () => {
    const { end, lines } = await session([header, 'sleep 0.08', ...piTurn('Done.'), LINGER])
    expect(end).toMatchObject({ outcome: 'exited', code: 0, ending: 'turn-ended' })
    expect(lines.at(-1)).toMatch(ENDED(GRACE))
  }, 30_000)

  // The window asks whether a run started, never how long it has run: a first turn on one long call
  // runs past 5 min awake and meets its timeout (400 s: 4 s real) as before row 245.
  it('a pi whose run started is never "never started", however long its turn', async () => {
    const { end, lines } = await session([
      header, say({ type: 'agent_start' }), say({ type: 'turn_start' }),
      say({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'cargo test' } }),
      LINGER,
    ], { timeoutMs: 400_000 })
    expect(end.outcome).toBe('timeout')
    expect(end.ending).toBeUndefined()
    expect(lines.at(-1)).toMatch(/\] ended \d\d:\d\d:\d\d · timed out · \S+$/)
  }, 30_000)

  it('the recorded code is never the stop\'s own status (P46)', async () => {
    const shapes: Array<[string, string[], 'pi' | 'claude-code']> = [
      // P46: a lingering pi stopped after agent_settled exits by SIGTERM (code null).
      ['a pi that dies by the signal', [header, ...piTurn('Done.'), LINGER], 'pi'],
      // A Windows job kill reads as exit 1; an agent's own SIGTERM handler may exit with anything.
      ['a pi that exits 1 on the stop', ["trap 'exit 1' TERM", header, ...piTurn('Done.'), LINGER], 'pi'],
      ['a claude session that exits 143 on the stop', ["trap 'exit 143' TERM", ...claudeTurn('Done.', { is_error: false, result: 'Done.' }), LINGER], 'claude-code'],
    ]
    for (const [name, body, harness] of shapes) {
      const { end, lines } = await session(body, { harness })
      expect(end, name).toMatchObject({ outcome: 'exited', code: 0, ending: 'turn-ended', failed: false })
      expect(lines.at(-1), name).toMatch(ENDED(GRACE))
    }
  }, 30_000)

  it('the stream\'s error flag keeps " (error)" on the turn-ended line', async () => {
    // pi's JSON mode exits 0 on an error answer (row 214): the code stays 0, the flag says it.
    const pi = await session([header, ...piTurn('', 'error', '529 overloaded'), LINGER])
    expect(pi.end).toMatchObject({ outcome: 'exited', code: 0, ending: 'turn-ended', failed: true })
    expect(pi.lines.at(-1)).toMatch(ENDED(`${GRACE} (error)`))
    // claude exits 1 after an error result, so that is the status its ending is recorded with.
    const claude = await session([...claudeTurn('Trying.', { is_error: true, result: 'API Error: 500 Internal server error' }), LINGER], { harness: 'claude-code' })
    expect(claude.end).toMatchObject({ outcome: 'exited', code: 1, ending: 'turn-ended', failed: true })
    expect(claude.lines.at(-1)).toMatch(ENDED(`${GRACE} (error)`))
  }, 30_000)

  // S4-1: a record's lines stay out of the tail only when a grace ran before it and still runs
  // after it, so the result that starts the grace keeps the limit only it carries.
  it('the record that starts a grace (a claude error result) keeps its usage-limit line in the tail', async () => {
    const limit = 'Claude AI usage limit reached|1792440000'
    const { end, lines } = await session([...claudeTurn('Working.', { is_error: true, result: limit }), 'echo "after the turn"', LINGER], { harness: 'claude-code' })
    expect(end).toMatchObject({ outcome: 'exited', code: 1, ending: 'turn-ended', failed: true })
    expect(end.tail).toEqual(['Working.', limit])
    expect(lines).toContain(`${PREFIX}after the turn`)
    expect(sessionLimit(end, Date.parse('2026-10-19T12:00:00Z'))).toMatchObject({ kind: 'usage', resetAt: 1792440000_000 })
  }, 30_000)

  // P28: pi 0.85.1 restarts a turn for a follow-up sent from an agent_settled handler, then cuts it
  // off. The agent_start cancels the grace, and the session meets its timeout, as before row 245.
  it('a follow-up that pi cuts off after agent_settled still meets the timeout (P28)', async () => {
    // A 2 min timeout: past where the grace would have stopped it, had the agent_start not cancelled it.
    const { end, lines } = await session([header, ...piTurn('Done.'), say({ type: 'agent_start' }), LINGER], { timeoutMs: 120_000 })
    expect(end.outcome).toBe('timeout')
    expect(end.ending).toBeUndefined()
    expect(lines.at(-1)).toMatch(/\] ended \d\d:\d\d:\d\d · timed out · \S+$/)
  }, 30_000)

  // The end watch runs in a pipe listener and the clock's timer (P16), so it never throws: a stream
  // that cannot answer reads as not ended and started, and the timeout alone holds — past the
  // 5 min never-started window, which a stream that cannot say it started must not trip.
  it('a stream that cannot answer leaves the session to its timeout', async () => {
    const fail = (): never => { throw new Error('boom') }
    const stream: WorkerStream = { line: () => [], inFlight: () => undefined, failed: () => false, ended: fail, started: fail }
    const { end, lines } = await session([header, ...piTurn('Done.'), LINGER], { stream, scale: 1000 })
    expect(end.outcome).toBe('timeout')
    expect(end.ending).toBeUndefined()
    expect(lines.at(-1)).toMatch(/\] ended \d\d:\d\d:\d\d · timed out · \S+$/)
  }, 30_000)

  // S4-4: a stop drive already sent is how the session ended. A session that ignores SIGTERM runs
  // on until drive's SIGKILL 5 s later (real time), and neither the grace nor the never-started
  // window falling due meanwhile, nor the deadline, changes it. The four sessions run side by side,
  // their fakes warmed first, so the test waits out one SIGKILL, not four.
  it.skipIf(process.platform === 'win32')('a session that ignores the stop keeps the ending drive first gave it', async () => {
    const stubborn = (...body: string[]): Fake => fake(["trap '' TERM", ...body, LINGER])
    const fakes = [stubborn(header, ...piTurn('Done.')), stubborn('echo "waiting on a login"'), stubborn(header, ...piTurn('Done.')), stubborn(header)]
    // The lease is lost (drive's abort) once the session printed `line`; the deadline is 2 s real.
    const aborted = (f: Fake, line: string): Promise<Run> => {
      const abort = new AbortController()
      return session(f, { timeoutMs: 200_000, signal: abort.signal, onLine: (l) => { if (l === `${PREFIX}${line}`) abort.abort() } })
    }
    const [afterSettle, beforeRun, grace, never] = await Promise.all([
      aborted(fakes[0]!, 'Done.'),                                  // then the grace falls due, then the deadline
      aborted(fakes[1]!, 'waiting on a login'),                     // no grace: then the deadline
      session(fakes[2]!, { timeoutMs: 200_000 }),                   // the grace's stop, then the deadline
      // × 1000: never-started's stop at 300 ms real, then the deadline at 1 s.
      session(fakes[3]!, { scale: 1000, timeoutMs: 1_000_000 }),
    ])
    for (const [name, run] of [['aborted after its settle', afterSettle], ['aborted before its run', beforeRun]] as const) {
      expect(run.end.outcome, name).toBe('stopped')
      expect(run.end.ending, name).toBeUndefined()
      expect(run.lines.at(-1), name).toMatch(/\] ended \d\d:\d\d:\d\d · stopped · \S+$/)
    }
    expect(grace.end).toMatchObject({ outcome: 'exited', code: 0, ending: 'turn-ended' })
    expect(grace.lines.at(-1)).toMatch(ENDED(GRACE))
    expect(never.end).toMatchObject({ outcome: 'exited', code: 1, ending: 'never-started' })
    expect(never.lines.at(-1)).toMatch(ENDED(`never started · stopped after ${duration(SESSION_QUIET_MS)}`))
  }, 40_000)
})
