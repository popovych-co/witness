import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { arbitrate } from '../src/arbiter.js'
import { runBattery } from '../src/battery.js'
import { loadConfig } from '../src/config.js'
import { loadHarness, type Harness } from '../src/harness.js'
import { SESSION_DEFAULT } from '../src/model.js'
import { invokeReviewerAsync, type InvokeOpts } from '../src/reviewer.js'
import type { Ticker } from '../src/session-clock.js'
import { END_GRACE_MS } from '../src/session-end.js'
import { awaitGone, callCount, fakeClock, fakeCtx, fakeScenario, gateEnv, orphansIn, putVerdict, seededRepo, writeSpec } from './helpers.js'

// Row 245 (issue #80, design §4.3 "Reviewers and the arbiter"). A reviewer's attempt ends when its
// turn ends, not when its process exits: the async invoker watches the harness's stream (pi's event
// stream, claude's json envelope) for the end signal, gives the same 60 s grace drive does, then the
// timeout's stop. Stopped after its turn, the attempt is classified with the status the harness gives
// that ending (pi 0; claude 1 after an error envelope), never the stop's own (P46). A reviewer that
// never starts stays on the timeout and retry path. Drift runs on this invoker too, with `noWait`, so
// row 182's "the sync lane never waits" holds without a sync lane.

// Every reviewer call goes through here and is recorded, so a test reads which lane asked and how.
const invoked = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('../src/reviewer.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/reviewer.js')>()
  return {
    ...real,
    invokeReviewerAsync: (...args: Parameters<typeof real.invokeReviewerAsync>) => {
      invoked.calls.push({ ...args[2] })
      return real.invokeReviewerAsync(...args)
    },
  }
})

const harness = (name: 'pi' | 'claude-code'): Harness => {
  const r = loadHarness(name)
  if (!r.ok) throw new Error('registry')
  return r.value
}
const pi = harness('pi')
const claude = harness('claude-code')

const VERDICT = { coverage: [], findings: [] }
const rec = (o: object): string => JSON.stringify(o)
const assistant = (text: string, stopReason = 'stop') => ({ role: 'assistant', content: text === '' ? [] : [{ type: 'text', text }], stopReason })
// One pi turn in `--mode json`, from its run's start to its settle (P4, P18).
const piTurn = (text: string): string[] => [
  rec({ type: 'agent_start' }), rec({ type: 'turn_start' }),
  rec({ type: 'message_start', message: { role: 'assistant', content: [] } }),
  rec({ type: 'message_end', message: assistant(text) }), rec({ type: 'turn_end', message: assistant(text) }),
  rec({ type: 'agent_end', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }, assistant(text)] }),
  rec({ type: 'agent_settled' }),
]
// A pi turn whose answer is a provider error: pi's JSON mode writes it in-stream (row 89).
const piErrorTurn = (message: string): string[] => {
  const failed = { role: 'assistant', content: [], stopReason: 'error', errorMessage: message }
  return [
    rec({ type: 'agent_start' }), rec({ type: 'turn_start' }), rec({ type: 'message_end', message: failed }),
    rec({ type: 'agent_end', messages: [failed] }), rec({ type: 'agent_settled' }),
  ]
}
// claude's `--output-format json` envelope, one line ending in LF, as claude 2.1.330 writes it.
const envelope = (result: string, isError = false): string =>
  rec({ type: 'result', subtype: 'success', is_error: isError, result })

// A shell argument holding `s` verbatim.
const sq = (s: string): string => {
  if (s.includes("'")) throw new Error(`a fake's record holds a quote: ${s}`)
  return `'${s}'`
}
const say = (lines: string[], fd = 1): string => `printf '%s\\n' ${lines.map(sq).join(' ')}${fd === 2 ? ' >&2' : ''}`

// A fake reviewer binary, alone on PATH under the harness's name. Each call appends `call <pid>`
// to the pid file; a body that lingers `exec`s its sleep, so that pid is the lingering process and
// the reviewer's stop reaches it. A body that starts anything else records it too. `reaction`, if
// given, is what the fake writes to stdout when it is stopped (the file `reaction` beside it).
const pidFiles: string[] = []
function fake(bin: 'pi' | 'claude', body: string, reaction?: string): { env: Record<string, string>; pids: string; calls: () => number } {
  const dir = mkdtempSync(join(tmpdir(), 'witness-turn-end-'))
  const pids = join(dir, 'pids')
  pidFiles.push(pids)
  writeFileSync(join(dir, bin), `#!/bin/sh\necho "call $$" >> ${sq(pids)}\n${body}\n`)
  chmodSync(join(dir, bin), 0o755)
  if (reaction !== undefined) writeFileSync(join(dir, 'reaction'), `${reaction}\n`)
  return {
    env: { PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '' },
    pids,
    calls: () => existsSync(pids) ? readFileSync(pids, 'utf8').split('\n').filter((l) => l.startsWith('call ')).length : 0,
  }
}

// A fake that says `said`, then lingers until it is stopped, writes its reaction and exits `code`.
// Its trap and its sleep are in place before it says anything, so no stop can find it without
// them; the shell runs a trap only once `wait` is interrupted, never during a foreground sleep.
const STOPPABLE = (said: string, code: number): string => [
  `trap 'kill $s; cat "$(dirname "$0")/reaction"; exit ${code}' TERM`,
  'sleep 60 &',
  's=$!',
  'echo "sleep $s" >> "$(dirname "$0")/pids"',
  said,
  'wait $s',
].join('\n')

afterEach(() => {
  for (const f of pidFiles.splice(0)) {
    for (const pid of orphansIn(f)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
})

// A clock the test moves: the grace's timer fires only when the test advances past it.
function manualTicker() {
  let now = 0
  const timers: Array<{ at: number; ms: number; fn: () => void; live: boolean }> = []
  const ticker: Ticker = {
    now: () => now,
    after: (ms, fn) => {
      const t = { at: now + ms, ms, fn, live: true }
      timers.push(t)
      return () => { t.live = false }
    },
  }
  return {
    ticker,
    timers,
    graces: () => timers.filter((t) => t.ms === END_GRACE_MS),
    advance(ms: number) {
      now += ms
      for (const t of timers.filter((x) => x.live && x.at <= now)) { t.live = false; t.fn() }
    },
    // A timer that fires `by` ms before its clock says it is due, as a timer and a clock that round
    // apart can.
    fireEarly(t: { at: number; fn: () => void; live: boolean }, by: number) {
      now = t.at - by
      t.live = false
      t.fn()
    },
  }
}

async function until(what: string, pred: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

function track<T>(p: Promise<T>): { done: () => boolean; p: Promise<T> } {
  let done = false
  void p.then(() => { done = true })
  return { done: () => done, p }
}

// Every pid the fake recorded runs no more: the stop reached what lingered.
async function allGone(pids: string): Promise<void> {
  for (const pid of orphansIn(pids)) expect(await awaitGone(pid), `pid ${pid}`).toBe(true)
}

const ask = (h: Harness, env: Record<string, string>, opts: Partial<InvokeOpts> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'witness-reviewed-'))
  return invokeReviewerAsync(fakeCtx(root, { env }), h, { cwd: root, prompt: 'LENS\nBODY', timeoutMs: 20_000, ...opts })
}

describe('a reviewer ends with its turn (row 245)', () => {
  // P46: a lingering pi stopped after agent_settled dies by SIGTERM (code null). A pi whose stop
  // makes it write an aborted answer and exit 1 is the same ending: what it wrote after the stop is
  // no part of its turn. P17: the leaky tail's chatter never cancels the grace.
  it.each([
    ['dies by SIGTERM', `${say(piTurn(rec(VERDICT)))}\nprintf 'extension: still here\\n'\nprintf 'extension: leak\\n' >&2\n${say([rec({ type: 'queue_update' })])}\nexec sleep 60`, undefined],
    ['writes an aborted answer and exits 1 on the stop', STOPPABLE(say(piTurn(rec(VERDICT))), 1),
      [rec({ type: 'message_end', message: assistant('', 'aborted') }), rec({ type: 'agent_end', messages: [assistant('', 'aborted')] })].join('\n')],
  ])('a pi reviewer that settles and lingers is stopped after the grace, and its verdict reads ok, not reviewer-timeout (P46) · %s', async (_how, body, reaction) => {
    const f = fake('pi', `cat > /dev/null\n${body}`, reaction)
    const t = manualTicker()
    const r = track(ask(pi, f.env, { ticker: t.ticker }))
    await until('the grace', () => t.graces().length === 1)
    await pause(300)                                   // the chatter after the settle is read
    expect(t.graces().map((g) => g.live)).toEqual([true])
    t.advance(END_GRACE_MS - 1)
    await pause(200)
    expect(r.done()).toBe(false)                       // not before the grace is over
    t.advance(1)
    const res = await r.p
    expect(res.ok && JSON.parse(res.value.text)).toEqual(VERDICT)
    expect(f.calls()).toBe(1)
    await allGone(f.pids)
  }, 20_000)

  it('a claude reviewer whose envelope is complete but whose process lingers: stopped, envelope parsed', async () => {
    const f = fake('claude', `cat > /dev/null\n${say([envelope(rec(VERDICT))])}\nexec sleep 60`)
    const t = manualTicker()
    const r = track(ask(claude, f.env, { ticker: t.ticker }))
    await until('the grace', () => t.graces().length === 1)
    await pause(100)
    expect(r.done()).toBe(false)
    t.advance(END_GRACE_MS)
    const res = await r.p
    expect(res.ok && JSON.parse(res.value.text)).toEqual(VERDICT)
    expect(f.calls()).toBe(1)
    await allGone(f.pids)
  }, 20_000)

  // The second shape answers the stop with a success envelope and exit 143: the status and the
  // stdout are what the turn ended on, read when the stop was sent. The third also read only part of
  // its prompt: its error envelope's status (1, read at the stop) is the answer, not the broken pipe.
  const ERROR_ENVELOPE = say([envelope('Invalid API key · Please run /login', true)])
  it.each([
    ['dies by SIGTERM', `cat > /dev/null\n${ERROR_ENVELOPE}\nexec sleep 60`, undefined, 'x'],
    ['answers the stop with a success envelope and exits 143',
      `cat > /dev/null\n${STOPPABLE(ERROR_ENVELOPE, 143)}`, envelope(rec(VERDICT)), 'x'],
    ['read part of its prompt, then answers the stop with a success envelope',
      `head -c 65536 > /dev/null\n${STOPPABLE(ERROR_ENVELOPE, 143)}`, envelope(rec(VERDICT)), 'x'.repeat(4 * 1024 * 1024)],
  ])('a claude error envelope after a stop is the envelope\'s refusal, never reviewer-invocation from SIGTERM · %s', async (_how, body, reaction, prompt) => {
    const f = fake('claude', body, reaction)
    const t = manualTicker()
    const r = track(ask(claude, f.env, { ticker: t.ticker, prompt }))
    await until('the grace', () => t.graces().length === 1)
    await pause(300)                                   // a broken pipe is reported
    t.advance(END_GRACE_MS)
    const res = await r.p
    expect(!res.ok && res.violations.map((x) => [x.rule, x.got, x.want])).toEqual([[
      'reviewer-invocation', 'Invalid API key · Please run /login',
      'claude print mode answering without an error envelope — check auth and usage for that account',
    ]])
    expect(f.calls()).toBe(1)
    await allGone(f.pids)
  }, 20_000)

  // P31, P49: a header, an extension's own records and a missing key, while a startup handle leaks.
  // The reviewer's watch has no never-started window: only the timeout ends it, and it is retried.
  it('a reviewer that never starts stays on the timeout and retry path', async () => {
    const f = fake('pi', [
      'cat > /dev/null',
      say([
        rec({ type: 'session', version: 3, id: 'ses-1' }),
        rec({ type: 'message_start', message: { role: 'custom', customType: 'note', content: 'loaded' } }),
        rec({ type: 'message_end', message: { role: 'custom', customType: 'note', content: 'loaded' } }),
        rec({ type: 'entry_appended' }),
      ]),
      say(['No API key found for anthropic.'], 2),
      'exec sleep 60',
    ].join('\n'))
    const t = manualTicker()
    const res = await ask(pi, f.env, { ticker: t.ticker, timeoutMs: 300 })
    expect(!res.ok && res.violations.map((x) => [x.rule, x.got])).toEqual([['reviewer-timeout', 'no response in 300ms after 3 attempts']])
    expect(f.calls()).toBe(3)
    expect(t.timers).toEqual([])                       // nothing was ever timed on the watch's clock
    await allGone(f.pids)
  }, 20_000)

  // §4.3 "The timeout keeps running": a deadline inside the grace ends the attempt as its turn's end.
  it('a deadline that falls inside the grace ends the attempt clean, never as a timeout or a retry', async () => {
    const f = fake('pi', `cat > /dev/null\n${say(piTurn(rec(VERDICT)))}\nexec sleep 60`)
    const t = manualTicker()
    const t0 = Date.now()
    const res = await ask(pi, f.env, { ticker: t.ticker, timeoutMs: 1_500 })
    expect(t.graces()).toHaveLength(1)                 // armed, and never advanced to: the deadline ended it
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_450)
    expect(res.ok && JSON.parse(res.value.text)).toEqual(VERDICT)
    expect(f.calls()).toBe(1)
    await allGone(f.pids)
  }, 20_000)

  it('a grace timer that fires early waits out the rest of the grace', async () => {
    const f = fake('pi', `cat > /dev/null\n${say(piTurn(rec(VERDICT)))}\nexec sleep 60`)
    const t = manualTicker()
    const r = track(ask(pi, f.env, { ticker: t.ticker }))
    await until('the grace', () => t.graces().length === 1)
    t.fireEarly(t.graces()[0]!, 5)
    expect(t.timers.filter((x) => x.live).map((x) => x.ms)).toEqual([5])
    await pause(200)
    expect(r.done()).toBe(false)
    t.advance(5)
    const res = await r.p
    expect(res.ok && JSON.parse(res.value.text)).toEqual(VERDICT)
    await allGone(f.pids)
  }, 20_000)

  // S4-5: the watch hears each record, so a run start and a settle that arrive in one chunk cancel
  // the grace and arm a new one. The answer is the second turn's.
  it('a run that starts again inside the grace cancels it, and its settle arms a new one, within one chunk', async () => {
    const second = { coverage: [], findings: [{ blocking: false, anchor: 'a.md', claim: 'second turn' }] }
    const f = fake('pi', [
      'cat > /dev/null',
      say(piTurn(rec(VERDICT))),
      'sleep 0.5',
      say(piTurn(rec(second)).slice(1)),               // turn_start … agent_settled, in one write
      'exec sleep 60',
    ].join('\n'))
    const t = manualTicker()
    const r = track(ask(pi, f.env, { ticker: t.ticker }))
    await until('the second grace', () => t.graces().length === 2)
    expect(t.graces().map((g) => g.live)).toEqual([false, true])
    t.advance(END_GRACE_MS)
    const res = await r.p
    expect(res.ok && JSON.parse(res.value.text)).toEqual(second)
    await allGone(f.pids)
  }, 20_000)

  // S4-2: a reviewer that answered without reading its whole prompt fails closed whether it exits 0
  // or is stopped after its turn.
  it('a reviewer whose stdin closed early, and which then settles and lingers, fails closed (S4-2)', async () => {
    const f = fake('pi', `head -c 65536 > /dev/null\n${say(piTurn(rec(VERDICT)))}\nexec sleep 60`)
    const t = manualTicker()
    const r = track(ask(pi, f.env, { ticker: t.ticker, prompt: `${'x'.repeat(4 * 1024 * 1024)}\nTAIL-THE-REVIEWER-NEVER-SAW\n` }))
    await until('the grace', () => t.graces().length === 1)
    await pause(300)                                   // the broken pipe is reported
    t.advance(END_GRACE_MS)
    const res = await r.p
    expect(!res.ok && res.violations[0]!.rule).toBe('reviewer-invocation')
    expect(!res.ok && res.violations[0]!.got).toContain('before reading the whole prompt')
    await allGone(f.pids)
  }, 20_000)

  // Row 182 through row 245: a limit the stopped reviewer answered with is still a limit, waited out
  // inside drive and asked again — never an invocation failure read off the stop.
  it('inside drive, a pi reviewer stopped after a usage-limit answer waits for the reset and is asked again', async () => {
    const LIMIT = "You\u2019ve hit your session limit · resets 2pm (America/Los_Angeles)"
    const f = fake('pi', [
      'cat > /dev/null',
      `if [ "$(grep -c '^call ' "$(dirname "$0")/pids")" -eq 1 ]; then`,
      `  ${say(piErrorTurn(LIMIT))}`,
      '  exec sleep 60',
      'fi',
      say(piTurn(rec(VERDICT))),
    ].join('\n'))
    const t = manualTicker()
    const clock = fakeClock(Date.parse('2026-10-19T19:30:00Z'))
    const r = track(ask(pi, { ...f.env, WITNESS_DRIVE: 'p1' }, { ticker: t.ticker, clock }))
    await until('the grace', () => t.graces().length === 1)
    t.advance(END_GRACE_MS)
    const res = await r.p
    expect(res.ok && JSON.parse(res.value.text)).toEqual(VERDICT)
    expect(clock.slept).toEqual([5_460_000])
    expect(f.calls()).toBe(2)
    await allGone(f.pids)
  }, 20_000)

  // The interface's "pi: 0": a pi stopped after its turn reads exactly as the same pi exiting 0 by
  // itself — here an error answer to a prompt it read only part of, which fails closed either way.
  it.each([
    ['exits 0 by itself', 'exit 0', false],
    ['settles and lingers until it is stopped', 'exec sleep 60', true],
  ])('a pi stopped after its turn reads as the same pi exiting 0 by itself (pi: 0) · %s', async (_how, end, lingers) => {
    const f = fake('pi', `head -c 65536 > /dev/null\n${say(piErrorTurn('500 Internal server error'))}\n${end}`)
    const t = manualTicker()
    const r = track(ask(pi, f.env, { ticker: t.ticker, prompt: 'x'.repeat(4 * 1024 * 1024) }))
    if (lingers) {
      await until('the grace', () => t.graces().length === 1)
      await pause(300)                                 // the broken pipe is reported
      t.advance(END_GRACE_MS)
    }
    const res = await r.p
    expect(!res.ok && res.violations.map((x) => [x.rule, x.got.replace(/^(exited 0|ended its turn) /, '')]))
      .toEqual([['reviewer-invocation', 'before reading the whole prompt (EPIPE)']])
    await allGone(f.pids)
  }, 20_000)

  // Task 16's review, held here: a reviewer whose process exited on its own is never stopped, so its
  // own exit code stands — here while a child it left holds stdout past the grace, or past its
  // timeout (1.5 s, inside the 2 s the invoker waits for stdout to close after an exit).
  it.each([
    ['past the grace', 20_000],
    ['past its timeout', 1_500],
  ])('a reviewer that exits on its own after its settle keeps its own exit code · %s', async (_how, timeoutMs) => {
    const f = fake('pi', [
      'cat > /dev/null',
      say(piTurn(rec(VERDICT))),
      'sleep 0.3',
      'sleep 5 &',
      'echo "holder $!" >> "$(dirname "$0")/pids"',
      'exit 3',
    ].join('\n'))
    const t = manualTicker()
    const r = track(ask(pi, f.env, { ticker: t.ticker, timeoutMs }))
    await until('the grace', () => t.graces().length === 1)
    const agent = orphansIn(f.pids)[0]!
    expect(await awaitGone(agent)).toBe(true)          // exited by itself; the holder keeps stdout open
    t.advance(END_GRACE_MS)
    const res = await r.p
    expect(!res.ok && res.violations.map((x) => [x.rule, x.got.split(':')[0]])).toEqual([['reviewer-invocation', 'exit 3']])
    expect(f.calls()).toBe(1)
  }, 20_000)
  // And with no turn at all: an exit is an answer, and a timeout that falls while a child it left
  // still holds stdout is no stall to retry.
  it('a reviewer that exited on its own is never timed out: its own exit code stands', async () => {
    const f = fake('pi', ['cat > /dev/null', 'sleep 5 &', 'echo "holder $!" >> "$(dirname "$0")/pids"', 'exit 3'].join('\n'))
    const res = await ask(pi, f.env, { ticker: manualTicker().ticker, timeoutMs: 1_500 })
    expect(!res.ok && res.violations.map((x) => [x.rule, x.got.split(':')[0]])).toEqual([['reviewer-invocation', 'exit 3']])
    expect(f.calls()).toBe(1)
  }, 20_000)
})

describe('drift and the arbiter run on the one invoker (rows 182, 245)', () => {
  // A limit that resets an hour from now: an invoker that waited inside drive would sleep the hour.
  it('drift: a usage-limited reviewer refuses at once (noWait)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const scenario = fakeScenario()
    putVerdict(scenario, VERDICT)
    const limit = `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`
    writeFileSync(join(scenario, 'claude-error'), limit)
    writeFileSync(join(scenario, 'claude-error-calls'), '1')
    const t0 = Date.now()
    const r = await repo.cli(['check', '--drift', '--deep', 'auth-refresh'], { env: gateEnv(scenario, { WITNESS_DRIVE: 'auth-refresh-plan-1' }) })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('usage-limit')
    expect(r.stderr).toContain(limit)
    expect(r.stderr).toContain('wait for the reset — witness drive waits it out on its own')
    expect(r.stderr).not.toContain('waiting')
    expect(callCount(scenario)).toBe(1)
    expect(Date.now() - t0).toBeLessThan(15_000)
  }, 30_000)

  it('drift and the battery share invokeReviewerAsync; reviewer.ts no longer exports invokeReviewer', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../src/reviewer.js')
    expect(Object.keys(actual)).not.toContain('invokeReviewer')
    expect(typeof actual.invokeReviewerAsync).toBe('function')

    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const scenario = fakeScenario()
    putVerdict(scenario, VERDICT)
    invoked.calls.length = 0
    await repo.cli(['check', '--drift', '--deep', 'auth-refresh'], { env: gateEnv(scenario) })
    expect(invoked.calls).toHaveLength(1)
    expect(invoked.calls[0]).toMatchObject({ cwd: repo.root, tools: 'read', noWait: true })
    expect(callCount(scenario)).toBe(1)

    const lensed = fakeScenario()
    putVerdict(lensed, VERDICT)
    invoked.calls.length = 0
    const run = await runBattery(fakeCtx(repo.root, { env: gateEnv(lensed) }), claude, SESSION_DEFAULT,
      [{ name: 'code-reviewer', prompt: 'LENS', reviewed: { kind: 'docs', docs: [] } }], { cwd: repo.root })
    expect(run.ok).toBe(true)
    expect(invoked.calls).toHaveLength(1)
    expect(invoked.calls[0]).toMatchObject({ cwd: repo.root, lens: 'code-reviewer' })
    expect(invoked.calls[0]!.noWait).toBeUndefined()   // the battery waits a limit out inside drive
    expect(callCount(lensed)).toBe(1)
  }, 30_000)

  // The arbiter is a lens in the judgment lane (row 172): its attempt ends with its turn the same way.
  it('the arbiter asks through invokeReviewerAsync too, without noWait', async () => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', 'schema: 1\n')
    const cfg = loadConfig(repo.root)
    if (!cfg.ok) throw new Error('config')
    const scenario = fakeScenario()
    putVerdict(scenario, { choice: 1, reason: 'the finding misreads the spec' }, 'arbiter')
    invoked.calls.length = 0
    const r = await arbitrate(fakeCtx(repo.root, { env: gateEnv(scenario) }), repo.root, cfg.value, {
      mode: 'decision', evidence: [{ title: 'The stop', body: 'gate: plan · target: p1' }],
      menu: [{ command: 'witness decide plan p1 --stop', depth: 'terminal', runnable: true, when: 'the work cannot converge' }],
    })
    expect(r.ok && r.value.choice).toBe(1)
    expect(invoked.calls).toHaveLength(1)
    expect(invoked.calls[0]).toMatchObject({ cwd: repo.root, lens: 'arbiter' })
    expect(invoked.calls[0]!.noWait).toBeUndefined()
  }, 30_000)
})
