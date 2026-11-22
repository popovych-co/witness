import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Ctx } from './cli.js'
import { validatePin, type Harness } from './harness.js'
import type { PolicyPin } from './journal.js'
import type { ParsedPin } from './pin.js'
import { ok, refuse, v, type Result, type Violation } from './refusal.js'
import { resolveSpawn, spawn } from './spawn.js'
import { contained, jobHost } from './contain.js'
import { DRIVE_DEADLINE_ENV, driveChild } from './drive-presence.js'
import { monotonicTicker, type Ticker } from './session-clock.js'
import { END_GRACE_MS, endWatch } from './session-end.js'
import { duration, limitIn, realClock, SINGLE_WAIT_MAX_MS, waitFor, type Clock, type Limit } from './usage.js'
import type { Reviewed } from './verdict.js'
import { lineSink } from './worker-stream.js'

// Rows 216/217. The kind of content a lens is handed: what a gate declares its lenses read, what
// a debt's raising lens read, and what decides a reviewer's tools.
export type ContentKind = Reviewed['kind']

// Row 217. A reviewer reads; it never acts. It gets read-only file tools only when its content
// names files it must open — screenshots, by path — and otherwise none: everything else it may
// consider is inline in its prompt.
export type ToolPolicy = 'none' | 'read'
export function toolsFor(reviewed: Reviewed): ToolPolicy {
  return reviewed.kind === 'screens' ? 'read' : 'none'
}

export const PROMPT_NAMES = [
  'slicing-critic', 'plan-critic', 'code-reviewer', 'silent-failure-hunter',
  'type-design', 'pr-test', 'drift-reviewer', 'design-critic', 'design-reviewer',
] as const

export interface LensDoc { path: string; contents: string }
export interface Lens { name: string; contents: string; docs?: LensDoc[] }

export function promptsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')
}

export function resolvePrompt(name: string): Result<Lens> {
  const path = join(promptsDir(), `${name}.md`)
  if (!existsSync(path)) {
    return refuse([v('reviewers', 'unknown-reviewer', name,
      `a lens file at prompts/${name}.md (shipped: ${PROMPT_NAMES.join(' ')})`)])
  }
  return ok({ name, contents: readFileSync(path, 'utf8') })
}

// docs.<key> → which lenses at which gates consume it. The design-stage plan
// extends this map (design → design-critic / design-reviewer); keys here must
// stay in lockstep with DOC_KEYS in config.ts — no key without a consumer.
const DOC_CONSUMERS: Record<string, { lenses: string[]; gates: string[] }> = {
  conventions: { lenses: ['code-reviewer'], gates: ['implement', 'ship'] },
  design: { lenses: ['design-critic', 'design-reviewer'], gates: ['design', 'implement'] },
}

export function docKeysFor(gate: string, lens: string): string[] {
  return Object.entries(DOC_CONSUMERS)
    .filter(([, c]) => c.lenses.includes(lens) && c.gates.includes(gate))
    .map(([k]) => k)
}

export function loadLensDocs(root: string, paths: string[]): Result<LensDoc[]> {
  const docs: LensDoc[] = []
  const violations: Violation[] = []
  for (const p of paths) {
    const abs = join(root, p)
    if (!existsSync(abs)) {
      violations.push(v('docs', 'doc-missing', p,
        'an existing file — gates inject configured docs fail-closed; fix the path or restore the file'))
      continue
    }
    docs.push({ path: p, contents: readFileSync(abs, 'utf8') })
  }
  return violations.length ? refuse(violations) : ok(docs)
}

export function docsBlock(docs: LensDoc[]): string {
  if (docs.length === 0) return ''
  return `## Repo conventions (injected from docs config)\n\n${
    docs.map((d) => `### ${d.path}\n\n${d.contents}`).join('\n\n')
  }\n\n`
}

// Row 83: settled content policies, injected into every battery for the plan. The
// contradiction channel is reviewer self-report — deterministic semantic matching of a
// freeform finding against a pin is not honestly implementable, so the schema carries it.
export function pinsBlock(pins: PolicyPin[]): string {
  if (pins.length === 0) return ''
  return `## Settled policy pins (human decisions — do not re-litigate)\n\n` +
    `The human has pinned these content policies for this plan. They are settled: a finding that merely disagrees with a pin is not a finding. If a defect you must report can only be fixed by violating a pin, report it AND set \`"contradicts_pin": <pin number>\` on that finding — the gate escalates the conflict to the human. Where pins conflict, the later pin wins.\n\n` +
    pins.map((p) => `${p.ordinal}. ${p.text}`).join('\n') + '\n\n'
}

export function promptsSha(lenses: Lens[], extra?: string): string {
  const h = createHash('sha256')
  for (const l of [...lenses].sort((a, b) => a.name.localeCompare(b.name))) {
    h.update(`lens ${l.name} ${l.contents.length}\n`)
    h.update(l.contents)
    h.update('\n')
    // injected docs are part of what the reviewer read — an edited doc is a
    // different reviewer, exactly like an edited lens (verdict-cache key)
    for (const d of l.docs ?? []) {
      h.update(`doc ${d.path} ${d.contents.length}\n`)
      h.update(d.contents)
      h.update('\n')
    }
  }
  // policy pins are part of what every reviewer read — a changed pin-set re-arms review
  if (extra !== undefined && extra !== '') {
    h.update(`pins ${extra.length}\n`)
    h.update(extra)
    h.update('\n')
  }
  return h.digest('hex')
}

// The two machine-resolved knobs, split out: every reviewer lane resolves them once at
// its verb boundary (row 90) and threads them down through the fan-out.
export interface InvokeExtras {
  timeoutMs?: number
  extensions?: readonly string[]
}

// `lens` reaches the reviewer as WITNESS_LENS, the way runners get WITNESS_SCREENS_DIR: the
// battery launches its lenses at once, so call order no longer says which lens a call was.
// `pinField` is the setting `model` came from, so a pin this harness cannot run is refused under
// the key the reader edits (row 212), never the retired `gates.model`.
// `tools` (row 217): what the reviewer may use — none unless its content names files to read.
// `noWait` (rows 182, 245): a usage limit refuses at once, as outside drive, even inside a drive
// session — drift's lane, which never waits. `ticker` is the clock the end watch's grace runs on, a
// test seam on spawnSession's precedent.
export interface InvokeOpts extends InvokeExtras {
  cwd: string; prompt: string; model?: string; pinField?: string; lens?: string; clock?: Clock; tools?: ToolPolicy
  noWait?: true
  ticker?: Ticker
}

// Row 182. Inside a drive session a usage-limited reviewer call waits for the reset and
// retries, at most this long in all per invocation. Outside drive it refuses at once: an
// attended gate must never block silently for hours. So does a call made with `noWait`.
export const REVIEWER_WAIT_MAX_MS = SINGLE_WAIT_MAX_MS
const OUTSIDE_DRIVE_WANT = 'wait for the reset — witness drive waits it out on its own'
// How long before its session's deadline a reviewer stops waiting: room to journal and exit.
const SESSION_MARGIN_MS = 60_000

const REVIEWER_TIMEOUT_MS = 600_000
// One stalled call must not cost a whole run: a battery launches every lens at once, and
// treating one transient stall as fatal throws away every verdict already paid for.
// Retries are bounded so a genuinely wedged binary still ends.
const TIMEOUT_RETRIES = 2
const MAX_OUTPUT = 64 * 1024 * 1024
const TERM_GRACE_MS = 5_000
// setTimeout clamps a delay above 2^31-1 ms to 1 ms, which would turn a "never time out"
// config into an instant timeout on every call.
const MAX_TIMER_MS = 2 ** 31 - 1
const EXIT_GRACE_MS = 2_000

interface Prepared {
  cmd: string
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
  windowsVerbatimArguments: boolean
  timeout: number
}

// What one spawn did. `stoppedAfterTurn` (row 245): the end watch stopped it after its turn ended
// (its grace ran out, or its timeout fell inside the grace), so `status` is the stop's own and says
// nothing about the answer; then `failed` is the stream's error flag and `stdout` what it had
// written, both read when the stop was sent. `epipe`: it closed its stdin before reading the whole
// prompt.
interface Attempt {
  timedOut: boolean
  stoppedAfterTurn: boolean
  failed: boolean
  epipe: boolean
  error?: Error
  status: number | null
  stdout: string
  stderr: string
}

// Every reviewer lane — the battery, the arbiter and drift — runs on one invoker, so none can drift
// from the others: the pin check, the spawn resolution, and below, the mapping from what happened
// to a row.
function prepareInvocation(ctx: Ctx, harness: Harness, opts: InvokeOpts): Result<Prepared> {
  let pin: ParsedPin | undefined
  if (opts.model !== undefined) {
    const pinR = validatePin(harness, opts.pinField ?? 'model', opts.model)
    if (!pinR.ok) return refuse(pinR.violations)
    pin = pinR.value
  }
  const { cmd, args, env } = harness.reviewer.spawn(pin, opts.extensions, opts.tools ?? 'none')
  // Row 164: on Windows the CLI may be a `.cmd` shim, which only cmd.exe can start. The
  // prompt rides stdin, so the shim's second parse of the command line never sees it. A
  // reviewer that cannot be started is an invocation failure on every platform: the
  // resolution's own got/want, under the rule a missing binary has always reported.
  // Row 191 §4.6: a reviewer is a harness session of its own, and on Claude Code the context
  // adapter loads in it like in any other; WITNESS_REVIEWER keeps its warning out of a review.
  const run = resolveSpawn(cmd, args, {
    ...ctx.env, ...env, WITNESS_REVIEWER: '1', ...(opts.lens !== undefined ? { WITNESS_LENS: opts.lens } : {}),
  })
  if (!run.ok) return refuse(run.violations.map((x) => ({ ...x, rule: 'reviewer-invocation' })))
  // Row 218. On Windows a stop — the timeout's kill, and row 245's after a turn — ends one process,
  // which was the `cmd.exe` shim: the agent under it kept running, and spending. Started in a job,
  // the stop is the host's, and the job takes the agent and whatever it started with it.
  const spawned = contained(run.value, jobHost(ctx.env))
  return ok({
    cmd, file: spawned.file, args: spawned.args, env: spawned.env as NodeJS.ProcessEnv,
    windowsVerbatimArguments: spawned.windowsVerbatimArguments,
    timeout: opts.timeoutMs ?? REVIEWER_TIMEOUT_MS,
  })
}

// Row 245 (P46). The status a harness gives a turn that ended, for an attempt stopped after it: pi's
// JSON mode exits 0 on an error answer too (its envelope carries the error), and claude's json mode
// exits 1 on an error envelope. Drive records a session stopped after its turn by the same rule.
function endingStatus(harness: Harness, failed: boolean): number {
  return harness.name !== 'pi' && failed ? 1 : 0
}

function classifyAttempt(harness: Harness, p: Prepared, attempt: number, r: Attempt): 'retry' | Result<{ text: string }> {
  // A stall is NOT the missing-binary case. Reporting it as one sent the last
  // reader hunting a PATH problem on a machine where the reviewer answered in 6s.
  if (r.timedOut) {
    if (attempt < TIMEOUT_RETRIES) return 'retry'
    return refuse([v(p.cmd, 'reviewer-timeout',
      `no response in ${p.timeout}ms after ${attempt + 1} attempts`,
      'a reviewer that answers within the timeout — raise gates.reviewerTimeoutMs in witness.config.yaml if the model is simply slow')])
  }
  // Stopped after its turn, it is read by the status its harness gives that ending, never by the
  // stop's own (null, SIGTERM's 143, or exit 1 from a Windows job kill), which would read as
  // reviewer-invocation.
  const status = r.stoppedAfterTurn ? endingStatus(harness, r.failed) : r.status
  // Exit 0 after closing its stdin early means the reviewer answered without reading the whole
  // prompt — a verdict on content it never saw, so it fails closed; and so does a clean ending
  // after a stop (S4-2). A nonzero status is the answer.
  const error = r.error ?? (r.epipe && status === 0
    ? new Error(`${r.stoppedAfterTurn ? 'ended its turn' : 'exited 0'} before reading the whole prompt (EPIPE)`)
    : undefined)
  if (error) {
    return refuse([v(p.cmd, 'reviewer-invocation', String(error.message),
      `a runnable ${p.cmd} binary on PATH — gates invoke reviewers headlessly; witness check probes this`)])
  }
  if (status !== 0) {
    // Final review F12: claude exits 1 on an is_error envelope, so a provider failure (a usage
    // limit included) sits on stdout under a non-zero exit. The envelope's own refusal names
    // it; anything else is the bare exit it always was.
    const envelope = harness.reviewer.parseEnvelope(r.stdout)
    if (!envelope.ok && envelope.violations[0]?.rule === 'reviewer-invocation') return envelope
    return refuse([v(p.cmd, 'reviewer-invocation',
      `exit ${String(status)}: ${r.stderr.slice(0, 200)}`, `${p.cmd} print mode exiting 0`)])
  }
  return harness.reviewer.parseEnvelope(r.stdout)
}

// The reviewer invoker: the battery's lenses run at once, so a reviewer call cannot block the
// process. Settles on `close`, bounded by `exit` plus a grace, for D145's reason: a reviewer CLI
// spawns its own children, they inherit stdout, and a killed parent whose grandchild
// survives would otherwise hold the pipe — and this call — open with no timeout above it.
//
// Row 182: drift's lane passes `noWait` and never waits; the battery and the arbiter wait a limit
// out inside drive.
export async function invokeReviewerAsync(ctx: Ctx, harness: Harness, opts: InvokeOpts): Promise<Result<{ text: string }>> {
  const pR = prepareInvocation(ctx, harness, opts)
  if (!pR.ok) return pR
  const p = pR.value
  const clock = opts.clock ?? realClock
  const inDrive = driveChild(ctx.env) !== undefined
  let waited = 0
  let streak = 0
  for (let attempt = 0; ; ) {
    const r = await spawnAttempt(harness, p, opts)
    const c = classifyAttempt(harness, p, attempt, r)
    if (c === 'retry') { attempt += 1; continue }
    const limit = usageLimitOf(c, clock.now())
    if (!limit) return c
    // Outside drive, and on a lane that never waits, the limit refuses at once, saying to wait for
    // the reset: drift's lane says so inside drive too.
    if (!inDrive || opts.noWait === true) return refuse([v(p.cmd, 'usage-limit', limit.text, OUTSIDE_DRIVE_WANT)])
    // A wait spends no timeout retry: the same model is asked again after the reset.
    const wait = waitFor(limit, streak, clock.now())
    // Inside a drive session the wait must also end before drive kills the session (F14).
    const deadline = Number(ctx.env[DRIVE_DEADLINE_ENV])
    const outlives = Number.isFinite(deadline) && clock.now() + wait + SESSION_MARGIN_MS > deadline
    if (waited + wait > REVIEWER_WAIT_MAX_MS || outlives) {
      return refuse([v(p.cmd, 'usage-limit', limit.text,
        'a reset inside the 6h reviewer wait and this session\'s time — re-run the gate after it')])
    }
    ctx.err(`reviewer: usage limit — waiting ${duration(wait)} · ${limit.text}`)
    await clock.sleep(wait)
    waited += wait
    streak += 1
  }
}

// Only a provider failure is read — a refusal's got, never verdict text: a finding that
// quotes a limit message stays a finding.
function usageLimitOf(r: Result<{ text: string }>, now: number): Limit | undefined {
  if (r.ok) return undefined
  const row = r.violations.find((x) => x.rule === 'reviewer-invocation')
  return row ? limitIn(row.got, now) : undefined
}

// Row 245 (issue #80). An attempt ends when the reviewer's turn ends, not when its process exits:
// a pi whose extension leaks a handle lives on after `agent_settled` (P5), and the call waited for
// the timeout and read the stop as a failure. The harness's stream (pi's events, claude's json
// envelope) is watched record by record. Once its end signal stands, the same END_GRACE_MS grace as
// drive's runs on `opts.ticker`; only a record that starts a run cancels it, and the next settle
// arms it again. Then the timeout's stop is sent. The timeout keeps running throughout, and a
// timeout that falls inside the grace ends the attempt as its turn's end, never as a stall.
//
// The watch has no never-started window: a reviewer that never starts stays on the timeout and
// retry path. Each record is heard once, as its LF arrives (lineSink): pi's records are NDJSON, and
// claude ends its json envelope with an LF (2.1.330). Nothing reads the stream once the process is
// gone, so the sink is never flushed.
//
// The stream's error flag and the stdout are read when the stop is sent, so what a harness does on
// SIGTERM (an aborted answer, a second envelope) is no part of the turn it ended. A process that
// already exited on its own is never stopped: its own exit code stands.
function spawnAttempt(harness: Harness, p: Prepared, opts: InvokeOpts): Promise<Attempt> {
  return new Promise<Attempt>((resolve) => {
    const child = spawn(p.file, p.args, {
      cwd: opts.cwd, env: p.env, stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: p.windowsVerbatimArguments,
    })
    const out: string[] = []
    const err: string[] = []
    let outBytes = 0
    let epipe = false
    let timedOut = false
    let error: Error | undefined
    let status: number | null = null
    let settled = false
    let exited = false
    let stopSent = false
    let killTimer: NodeJS.Timeout | undefined
    let grace: NodeJS.Timeout | undefined
    const ticker = opts.ticker ?? monotonicTicker
    const stream = harness.reviewer.stream(opts.cwd)
    const watch = endWatch(stream, {})
    let cancelGrace: (() => void) | undefined
    // The turn the end watch stopped it after, as it stood when the stop was sent.
    let ending: { failed: boolean; stdout: string } | undefined
    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(grace)
      cancelGrace?.()
      child.stdout.destroy()
      child.stderr.destroy()
      resolve({
        timedOut, stoppedAfterTurn: ending !== undefined, failed: ending?.failed ?? false, epipe, error, status,
        stdout: ending?.stdout ?? out.join(''), stderr: err.join(''),
      })
    }
    // One stop per attempt: SIGTERM, then SIGKILL TERM_GRACE_MS later.
    const stop = () => {
      stopSent = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), TERM_GRACE_MS)
    }
    const endStop = () => {
      if (stopSent || exited || settled) return
      let failed = false
      try {
        failed = stream.failed() === true
      } catch { /* a stream never throws (row 214); one that did reads as no error */ }
      ending = { failed, stdout: out.join('') }
      stop()
    }
    // The grace's timer: armed when the watch starts a grace, cancelled when a run start cancels it.
    // One that fires before the ticker reads the grace as over (a timer and a clock that round
    // apart) waits out the rest.
    const graceCheck = (from: number) => () => {
      cancelGrace = undefined
      const now = ticker.now()
      if (watch.due(now) === 'turn-ended') endStop()
      else if (watch.graceRunning() && !stopSent && !exited) {
        cancelGrace = ticker.after(Math.max(1, END_GRACE_MS - (now - from)), graceCheck(from))
      }
    }
    const sink = lineSink((record) => {
      try {
        stream.line(record)
      } catch { /* a stream never throws (row 214); one that did leaves the timeout in charge */ }
      const now = ticker.now()
      watch.heard(now)
      if (!watch.graceRunning()) {
        cancelGrace?.()
        cancelGrace = undefined
      } else if (cancelGrace === undefined && !stopSent && !exited && !settled) {
        cancelGrace = ticker.after(END_GRACE_MS, graceCheck(now))
      }
    })
    const timer = setTimeout(() => {
      if (stopSent || exited) return
      if (watch.graceRunning()) { endStop(); return }
      timedOut = true
      stop()
    }, Math.min(p.timeout, MAX_TIMER_MS))
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => {
      outBytes += Buffer.byteLength(c)
      if (outBytes > MAX_OUTPUT) {
        if (error === undefined) error = new Error('output exceeded 64 MiB')
        child.kill('SIGKILL')
        return
      }
      out.push(c)
      sink.push(c)
    })
    child.stderr.on('data', (c: string) => { err.push(c) })
    // A reviewer that exits before reading its whole prompt closes the pipe under us: a
    // nonzero exit is the answer, and a clean one is refused (classifyAttempt).
    child.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EPIPE') epipe = true
      else if (error === undefined) error = e
    })
    child.stdin.end(opts.prompt)
    child.on('error', (e) => { error = e; settle() })
    child.on('exit', (code) => {
      exited = true
      status = code
      clearTimeout(killTimer)
      cancelGrace?.()
      cancelGrace = undefined
      grace = setTimeout(settle, EXIT_GRACE_MS)
    })
    child.on('close', (code) => { status = code; settle() })
  })
}

export function parseVerdictText(text: string): Result<unknown> {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(text)
  const body = (fenced ? fenced[1] ?? '' : text).trim()
  try {
    return ok(JSON.parse(body))
  } catch {
    return refuse([v('verdict', 'verdict-unparseable', body.slice(0, 120),
      'a JSON object {coverage, findings} and nothing else')])
  }
}
