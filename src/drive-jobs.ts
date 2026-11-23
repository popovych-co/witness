import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { contained, JOB_HOST_ENV, jobHost } from './contain.js'
import { withoutSession } from './context.js'
import { DRIVE_DEADLINE_FILE_ENV } from './deadline.js'
import { DRIVE_DEADLINE_ENV, DRIVE_ENV } from './drive-presence.js'
import { detectionVariables } from './harness.js'
import { JOB_ENV, RESULT_MAX_BYTES, jobKinds, journalShard, nextShard, type JobOutcome } from './jobs.js'
import { renderRefusal } from './refusal.js'
import type { Canon } from './scan.js'
import { LIVE_GROUPS, TERM_GRACE_MS, localBin, selfArgv, signalSession } from './self.js'
import { monotonicTicker, sessionClock, type SessionClock, type Ticker } from './session-clock.js'
import { spawn } from './spawn.js'
import { logSafe } from './toon.js'
import { duration } from './usage.js'
import { lineSink } from './worker-stream.js'

// Row 257 (spec §3.5). Drive's side of a job: one shard at a time, beside the sessions, as a
// `witness job` child. The shard's box starts at the child's `running` line, so time queued for the
// test turn is never boxed, and counts awake time (row 210's clock). At the box's end drive stops the
// child's group (SIGTERM, then SIGKILL). How the shard ended is journaled by drive itself, in-process:
// a child stopped at its box dies at once (probe t2a-group-kill) and must never die mid-write, so
// this is the one exception to row 145's "children journal their own acts". A stop — drive's signal
// or a lost lease — journals nothing: the shard just runs again on the next drive.

// `end` resolves once the outcome is journaled, or once the child is gone after a stop; `refused`
// says why a journal write was refused or threw (drive then runs no more jobs this run). `running`:
// the shard has begun its box; `startedAt`: when it was spawned (epoch ms).
export interface JobEnd { refused?: string; rule?: string }
export interface RunningJob {
  kind: string; key: string; shard: number; of: number; end: Promise<JobEnd>; running(): boolean; startedAt: number
}

const WHY_MAX = 200
// How long a dead child's pipes get to drain before drive stops waiting (drive.ts's rule).
const EXIT_GRACE_MS = 2_000

type Said = { outcome: 'done'; result?: unknown } | { outcome: 'failed'; why: string }

// A result line: the protocol's shape, at most RESULT_MAX_BYTES, its `why` a short string.
function resultOf(line: string): Said | undefined {
  if (Buffer.byteLength(line, 'utf8') > RESULT_MAX_BYTES) return undefined
  let o: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(line)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    o = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  if (o.job !== 'result') return undefined
  if (o.outcome === 'done') return Object.hasOwn(o, 'result') ? { outcome: 'done', result: o.result } : { outcome: 'done' }
  if (o.outcome === 'failed' && typeof o.why === 'string' && o.why.length <= WHY_MAX) return { outcome: 'failed', why: o.why }
  return undefined
}

const isRunningLine = (line: string): boolean => {
  try { return (JSON.parse(line) as { job?: unknown } | null)?.job === 'running' } catch { return false }
}

// Starts the next owed shard, or returns undefined when nothing is owed.
export function startJob(
  root: string, cfg: Config, ctx: Ctx, canon: Canon, opts: { signal: AbortSignal; ticker?: Ticker; skip?: ReadonlySet<string> },
): RunningJob | undefined {
  if (opts.signal.aborted) return undefined
  // Row 260: `skip` is the kinds whose commands are untrusted (`jobTrustOwed`).
  const next = nextShard(root, cfg, canon, jobKinds(ctx.env), opts.skip)
  if (next === undefined) return undefined
  const { kind, unit, shard } = next
  const of = unit.shards
  const label = `${kind.kind} ${unit.key} ${shard}/${of}`
  // A job is no session: it carries none of a session's marks, its harness's detection variables or
  // a deadline, and it names drive in WITNESS_JOB so `witness job` knows whose child it is.
  const env: Record<string, string | undefined> = withoutSession(ctx.env)
  for (const variable of detectionVariables()) delete env[variable]
  for (const mark of [DRIVE_ENV, DRIVE_DEADLINE_ENV, DRIVE_DEADLINE_FILE_ENV]) delete env[mark]
  env.WITNESS_BIN = localBin(ctx)
  env[JOB_ENV] = String(process.pid)
  const host = jobHost(ctx.env)
  if (process.platform === 'win32') env[JOB_HOST_ENV] = host.ok ? 'job' : 'none'
  // Only typed tokens reach the argv: a kind id, a key isJobKey admitted, two integers.
  const argv = selfArgv(ctx.env.WITNESS_BIN, ['job', kind.kind, unit.key, `${shard}/${of}`], env)
  if (!argv.ok) { renderRefusal(argv.violations).forEach((l) => ctx.err(l)); return undefined }
  const spawned = contained(argv.value, host)
  const grouped = process.platform !== 'win32'
  const boxMs = kind.boxMs(cfg)

  const startedAt = Date.now()
  let box: SessionClock | undefined
  const end = new Promise<JobEnd>((resolve) => {
    const child = spawn(spawned.file, spawned.args, {
      cwd: root, env: spawned.env, stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: spawned.windowsVerbatimArguments, detached: grouped,
    })
    if (grouped && child.pid !== undefined) LIVE_GROUPS.add(child.pid)
    ctx.out(`job: ${label} — started`)
    let said: Said | undefined
    let stopped = false
    let timedOut = false
    let stopSent = false
    let killTimer: NodeJS.Timeout | undefined
    let exitGrace: NodeJS.Timeout | undefined
    let code: number | null = null
    let signal: NodeJS.Signals | null = null
    let settled = false
    const stop = () => {
      if (stopSent) return
      stopSent = true
      signalSession(child, grouped, spawned.env, 'SIGTERM')
      killTimer = setTimeout(() => signalSession(child, grouped, spawned.env, 'SIGKILL'), TERM_GRACE_MS)
    }
    const onAbort = () => { stopped = true; stop() }
    opts.signal.addEventListener('abort', onAbort, { once: true })
    // stdout is the protocol: read, never shown. The last valid result line stands.
    const out = lineSink((line) => {
      if (box === undefined && isRunningLine(line)) {
        box = sessionClock(boxMs, opts.ticker ?? monotonicTicker, {
          expire: () => { timedOut = true; stop() },
          slept: (ms) => ctx.out(`[job ${kind.kind}] host slept ${duration(ms)} — not counted against its box`),
        })
        return
      }
      const r = resultOf(line)
      if (r !== undefined) said = r
    })
    // stderr is the child's own words: shown, spelled out (logSafe).
    const err = lineSink((line) => { if (line.trim() !== '') ctx.out(`[job ${kind.kind}] ${logSafe(line)}`) })
    const settle = () => {
      if (settled) return
      settled = true
      if (child.pid !== undefined) LIVE_GROUPS.delete(child.pid)
      clearTimeout(killTimer)
      clearTimeout(exitGrace)
      opts.signal.removeEventListener('abort', onAbort)
      out.flush()
      err.flush()
      child.stdout.destroy()
      child.stderr.destroy()
      box?.stop()
      const ms = box !== undefined ? Math.max(0, Math.round(box.awakeMs())) : 0
      if (stopped) {
        ctx.out(`job: ${label} — stopped`)
        resolve({})
        return
      }
      let entry: { outcome: JobOutcome; why?: string; result?: unknown }
      let line: string
      if (timedOut) {
        const why = `box ${duration(boxMs)} passed`
        entry = { outcome: 'timeout', why }
        line = `timed out · box ${duration(boxMs)}`
      } else if (said !== undefined && said.outcome === 'done') {
        entry = { outcome: 'done', ...(Object.hasOwn(said, 'result') ? { result: said.result } : {}) }
        line = `done · ${duration(ms)}`
      } else if (said !== undefined) {
        entry = { outcome: 'failed', why: said.why }
        line = `failed · ${logSafe(said.why)} · ${duration(ms)}`
      } else {
        const why = `exit ${code ?? signal ?? 'unknown'} without a result`
        entry = { outcome: 'failed', why }
        line = `failed · ${why}`
      }
      ctx.out(`job: ${label} — ${line}`)
      // A refusal is printed, and drive runs no more jobs this run: the shard would read missing and run
      // again at once, forever (slice 3 review). This runs in a child's listener, where a throw would
      // take drive down with every session unwatched (P16): it is caught and said the same way.
      let end: JobEnd = {}
      try {
        const j = journalShard(root, { kind: kind.kind, key: unit.key, shard, of, ...entry, ms })
        if (!j.ok) {
          renderRefusal(j.violations).forEach((l) => ctx.err(l))
          const first = j.violations[0]!
          end = { refused: `${first.rule}: ${logSafe(first.got)}`, rule: first.rule }
        }
      } catch (e) {
        end = { refused: `not journaled: ${logSafe(e instanceof Error ? e.message : String(e))}` }
      }
      resolve(end)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => out.push(c))
    child.stderr.on('data', (c: string) => err.push(c))
    child.on('error', () => settle())
    // `close` keeps every last line; `exit` bounds it, as a session's does: a grandchild that
    // inherited the pipes and survived would otherwise hold them open forever.
    child.on('exit', (c, sig) => {
      code = c
      signal = sig
      signalSession(child, grouped, spawned.env, 'SIGKILL')   // what the shard started goes with it
      clearTimeout(killTimer)
      exitGrace = setTimeout(settle, EXIT_GRACE_MS)
    })
    child.on('close', settle)
  })
  return { kind: kind.kind, key: unit.key, shard, of, end, running: () => box !== undefined, startedAt }
}
