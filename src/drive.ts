import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { cliAct, type Act } from './act.js'
import { EXIT, main, type Ctx } from './cli.js'
import { canonPaths, loadConfig, loadLocalConfig, type Config } from './config.js'
import { sessionHash, withoutSession } from './context.js'
import { detectionVariables, resolveJudge } from './harness.js'
import { ok, refuse, renderRefusal, v, type Result } from './refusal.js'
import { findById, loadCanon, type Canon } from './scan.js'
import { NO_CONSOLE_ENV, resolveSpawn, spawn, type ResolvedSpawn } from './spawn.js'
import { LIVE_GROUPS, TERM_GRACE_MS, localBin, selfArgv, signalSession } from './self.js'
import { contained, containmentLine, JOB_HOST_ENV, jobHost } from './contain.js'
import { behindJob, releaseDeadTurn, sweepTurnQueue, turnTickets } from './runner-lock.js'
import { startJob, type JobEnd, type RunningJob } from './drive-jobs.js'
import { jobsBlocked } from './jobs.js'
import { computeNext, conversationStage, heldPlan, type NextAction } from './verbs/next.js'
import { shownView, type DecisionAct } from './verbs/decide.js'
import { decideViewLines } from './decide-view.js'
import { renderDecision, type Decision, type Option } from './recommend.js'
import { entryDetail } from './verbs/log.js'
import { DRIVE_DEADLINE_FILE_ENV, deadlineFile, removeDeadline, sweepDeadlines, writeDeadline } from './deadline.js'
import { DRIVE_DEADLINE_ENV, DRIVE_ENV, DRIVE_LOG, DRIVE_LOG_ENV, TARGETLESS, driveHolder } from './drive-presence.js'
import { LOCK_WAIT_MS, isAlive, pause } from './lock.js'
import { BUSY_DIR, busyHolder, sweepDeadBusy } from './busy.js'
import { unparkAt } from './rounds.js'
import { latestOutcome } from './ship-outcome.js'
import { stateFloor } from './floor.js'
import { compareTriple, version } from './version.js'
import { ASK_STREAM } from './ask.js'
import { KEPT_STOP_NAMES, unmetNeedLine, type KeptStop } from './autonomy.js'
import { unmetNeeds } from './needs.js'
import { capHit, parkAtCap, type TargetUse } from './caps.js'
import { effortStreams, journalActs, journalRel, readStream, type Entry } from './journal.js'
import { movesFlow } from './progress.js'
import { sourced, type RunCommand } from './allowlist.js'
import { effortOf } from './reviewed.js'
import { pendingTxn } from './txn.js'
import { logSafe, shellWords } from './toon.js'
import { lineSink, passthrough, type WorkerLine, type WorkerStream } from './worker-stream.js'
import { endedHow, endingStatus, endWatch, failedNow, type EndCause } from './session-end.js'
import {
  duration, limitIn, realClock, sessionLimit, SINGLE_WAIT_MAX_MS, TOTAL_WAIT_MAX_MS, waitFor, type Clock, type Limit,
} from './usage.js'
import { keepAwake } from './awake.js'
import { monotonicTicker, sessionClock, type Ticker } from './session-clock.js'
import { driveReport, runStart } from './drive-report.js'
import { notify } from './notify.js'
import { writeLive, type EndReason, type LiveAside } from './live.js'
import { needsYou, needsYouToken, needYouRows, WAIT_LABEL, type NeedYou } from './needs-you.js'

// D145. What drive does with the action `next` just derived. One step per turn of the
// loop, and the loop's whole vocabulary — spawn a session, stop for a human, hand the
// work to a conversation, report the merge, or find nothing to do.
export type DriveStep =
  | { kind: 'spawn'; home: string; stage?: string; target?: string; model?: string }
  | { kind: 'decision'; gate?: string; target?: string; block?: Decision }
  | { kind: 'conversation'; line: string }
  | { kind: 'merge'; line: string }
  // Row 242: a recorded hold only the human can fix — never a merge command.
  | { kind: 'fix'; line: string }
  // Row 205. A config command the step runs is untrusted on this machine: the human's grant.
  | { kind: 'kept'; stop: 'trust-grant'; line: string }
  | { kind: 'idle' }

// The rule table is an ORDERED FIRST-MATCH list, on `recommend.ts`'s precedent: a
// misrouted action is attributable to one line here rather than to a weighting. Pure over
// the NextAction shape — no I/O — so every branch is one `expect` away.
//
// Row 194. A conversation (`conversationStage`) is one in both modes: brainstorm, `witness
// recap` and design authoring and showing are exchanges with a human, so drive prints the
// handoff and gets out of the way rather than spawning a session that would talk to nobody.
// Row 180: under autonomy A1 answers the choose block and the recovery fork with the policy's
// pick. A block that still reaches drive under a runnable line spawns, and the session's own
// `next` takes it, so no block stops an unattended run. `witness decide` lines stay decisions
// in both modes.
export function classifyAction(action: NextAction, root: string, opts: { autonomy?: boolean } = {}): DriveStep {
  const { line } = action
  // Row 239. A decision is a `decide` act: tier 2's pending decision and the bound endgame both
  // name `witness decide <gate> <target> --show` (the plan's B8), and the gate and the target are
  // the act's first two words after the verb, as `decide`'s own positional parser reads them.
  if (action.act?.argv[0] === 'decide') {
    return { kind: 'decision', gate: action.act.argv[1], target: action.act.argv[2] ?? action.target }
  }
  // Row 205 (issue #56). A step whose runner, ship lanes or cmd: need this machine does not
  // trust would only be refused inside the session — the refusal journaled nothing, so drive
  // respawned it to the cap. In both modes it waits for the human, and no session is spent.
  if (action.trust !== undefined && action.trust.length > 0) return { kind: 'kept', stop: 'trust-grant', line }
  // D121: a block is the CLI saying the human is choosing, not being told — so a runnable
  // line under a block (the recovery fork, `N ready — ranked below`) is still a stop.
  // Below the decide rule so a gate decision keeps its gate/target rather than its block.
  if (action.block !== undefined && !opts.autonomy) {
    return { kind: 'decision', target: action.target, block: action.block }
  }
  if (conversationStage(action)) return { kind: 'conversation', line }
  // The merge is GitHub's act, not witness's — a flow at `watch` has nothing left for an
  // agent to do. In practice this line arrives in the spawned ship session's OUTPUT
  // (ship.ts:277) rather than in a routing row, which is why the loop reads the child's
  // stream for it too; both readers exist because either surface can carry it.
  // Row 242. A hold is classified from its record (`held`), never from ship's words: the merge sniff
  // that read `merge PR` retired with it.
  if (action.held !== undefined) return { kind: action.held.outcome === 'fix' ? 'fix' : 'merge', line }
  // `witness check` is computeNext's terminal answer in two states: canon errors that
  // stopped routing early (bare line), and an exhausted ladder (line + a "nothing is
  // owed" note, D157). Idle PRINTS the line rather than swallowing it: a human who sees
  // `drive: idle — witness check` runs the verb, and the note has already told the
  // routed session which state it is in. Spawning a session to guess would burn a
  // context on a diagnosis one command answers.
  if (line === 'witness check' && action.stage === undefined) return { kind: 'idle' }
  return { kind: 'spawn', home: action.home ?? root, stage: action.stage, target: action.target, model: action.model }
}

export type SpawnStep = Extract<DriveStep, { kind: 'spawn' }>
export type SpawnOutcome = 'exited' | 'timeout' | 'spawn-failed' | 'stopped'
// How a session ended. `tail` is the last three non-empty lines it printed on either pipe,
// unprefixed, which is where a usage limit shows (row 182); `code` is null when it was
// killed; `ms` runs from spawn to settle, less the time the host slept (row 210). `failed`: its
// stream says its last answer was an error, which pi's JSON mode reports at exit 0 (row 214).
// `ending`: drive stopped it after its turn ended, or as a run that never started (row 245); it is
// then `exited` with the code its harness gives that ending, never the stop's own status, and its
// `failed` and `tail` are what they were when the stop was sent (S4-A).
// `ms` is the session's awake time; `heldMs` the part of it spent waiting behind a job for the test
// turn (row 256), absent when none.
export interface SessionEnd {
  outcome: SpawnOutcome; code: number | null; tail: string[]; ms: number; failed: boolean; ending?: EndCause; heldMs?: number
}

// Row 256 (amends row 183). What a session costs its target's `drive.caps.wallClockMs`: its awake
// time less the time it waited behind a job, which no session spent — as a host sleep is not.
export function chargedMs(end: SessionEnd): number {
  return Math.max(0, end.ms - (end.heldMs ?? 0))
}
const TAIL_LINES = 3

// The prompt every spawned session gets. Not a plan, not a stage instruction: the same
// slash command a human types, which routes through `next` in the session's own home —
// so a child rediscovers its work from state rather than from what drive believed a
// moment ago. That is what makes a killed drive costless to re-run (north star 6).
const SESSION_PROMPT = '/witness'
// A `--manual` run's sessions arm the engine the same way: every gate they run stops.
const MANUAL_PROMPT = '/witness --manual'

// How long a dead session's pipes get to drain before drive stops waiting on the grandchildren
// that inherited them. TERM_GRACE_MS and LIVE_GROUPS live in self.ts (row 257: jobs share them).
export const EXIT_GRACE_MS = 2_000
// Row 214. How long a session may print nothing before drive says it still runs, and what on —
// then again after each further stretch as long. Awake time, on the session's own clock (row
// 210). A constant, not a setting, on row 202's precedent: no `migrate` for an upgrade.
export const SESSION_QUIET_MS = 300_000
// Local wall-clock time, `HH:MM:SS`: what a human at the terminal reads `started` and `ended` by.
const clockTime = (): string => new Date().toTimeString().slice(0, 8)

// Moved to self.ts with the job runner (row 257); re-exported for the console tests.
export { signalSession }

// One headless session, in the action's home, streamed to the driver's terminal.
//
// The harness is the JUDGE ladder's answer (declared first, detection as fallback), not
// the driver's: this is a programmatic spawn like the reviewer battery, not a statement
// about which CLI a human is typing at. Ambient detection deciding what drive spawns would
// make the same repo drive differently from two terminals.
//
// Row 214: `next` is the line drive derived for this session, shown on its `started` line; `hear`
// gets every line the child wrote, shown or not — what the CLI printed, wherever it landed;
// `progress` is what its flow journaled since the last poll (journalWatch), as lines, asked with
// the session's id once its stream has named it; `root`
// is the repo, whose drive sessions a harness that can be told where to keep them keeps in a
// folder of their own (D2); `stream` replaces the harness's renderer, a test seam on `ticker`'s
// precedent.
export async function spawnSession(
  step: SpawnStep, cfg: Config, ctx: Ctx, spawnN: number,
  opts: {
    manual?: boolean; signal?: AbortSignal; ticker?: Ticker; hear?: (line: string) => void; root?: string
    stream?: WorkerStream; next?: string; progress?: (session?: string) => string[]
    deadline?: { root: string; token: string; behind: () => string | undefined }
  } = {},
): Promise<SessionEnd> {
  const t0 = Date.now()
  const end = (outcome: SpawnOutcome, code: number | null = null, tail: string[] = []): SessionEnd =>
    ({ outcome, code, tail, ms: Math.max(1, Date.now() - t0), failed: false })
  if (opts.signal?.aborted) return end('stopped')
  const hxR = resolveJudge(ctx.env, cfg.harness)
  if (!hxR.ok) { renderRefusal(hxR.violations).forEach((l) => ctx.err(l)); return end('spawn-failed') }
  const { harness } = hxR.value
  const transcripts = opts.root !== undefined ? harness.worker.transcripts?.(ctx.env, opts.root) : undefined
  const { cmd, args, env } = harness.worker.spawn(opts.manual ? MANUAL_PROMPT : SESSION_PROMPT, step.model, transcripts)
  // Test-only seam, on WITNESS_TRUST_CMDS' precedent (decide.ts): the suite points this at
  // a scripted fake that performs real CLI acts. Never documented for users — a spawn
  // binary chosen by ambient env is exactly the identity confusion row 90 removed.
  const bin = ctx.env.WITNESS_DRIVE_AGENT_BIN ?? cmd
  // Row 180: the marker is the child's target and its recursion guard in one.
  //
  // Row 191 §4.9: a drive started from a chat session's shell inherits that session's reading
  // and session variable, and the child is a session of its own that its harness names itself.
  // The session check already makes a stale reading harmless; leaving both out is the second
  // guard. The verb drops them on entry too; this holds for any other caller.
  //
  // Every harness's detection variable goes too, from the child alone (final review minor 5): its
  // harness sets its own, and an inherited one named the chat's harness to a child of another — a
  // claude child of a drive typed in a Pi chat detected Pi, read its own reading as stale and
  // relayed with /new. Drive keeps them: the judge above, whose worker this is, may be detection's.
  const inherited = withoutSession(ctx.env)
  for (const variable of detectionVariables()) delete inherited[variable]
  const childEnv: Record<string, string | undefined> = {
    ...inherited, ...env, WITNESS_BIN: localBin(ctx), [DRIVE_ENV]: step.target ?? TARGETLESS,
    // The earliest wall-clock time drive may stop this session — a sleep moves drive's stop
    // later, never earlier (row 210).
    [DRIVE_DEADLINE_ENV]: String(t0 + cfg.drive.sessionTimeoutMs),
    // Row 256: where drive moves that deadline while the session waits behind a job.
    ...(opts.deadline !== undefined ? { [DRIVE_DEADLINE_FILE_ENV]: deadlineFile(opts.deadline.root, opts.deadline.token) } : {}),
  }
  // Row 218: on Windows the session starts inside a job (src/contain.ts), and tells everything
  // under it what drive found, so no run or reviewer the session starts probes again.
  const host = jobHost(ctx.env)
  if (process.platform === 'win32') childEnv[JOB_HOST_ENV] = host.ok ? 'job' : 'none'
  // Row 164: on Windows the agent CLI may be a `.cmd` shim, which only cmd.exe can start.
  const run = resolveSpawn(bin, args, childEnv)
  if (!run.ok) { renderRefusal(run.violations).forEach((l) => ctx.err(l)); return end('spawn-failed') }
  const spawned = contained(run.value, host)
  const prefix = `[${spawnN} ${step.stage ?? 'drive'}/${step.target ?? step.home.split('/').pop() ?? '-'}] `
  const tail: string[] = []
  // Row 214. Three readers of one stream: the human (every shown line, under the prefix), the
  // merge sniff (`hear`: shown lines, each line of a tool's output and stderr, unprefixed — what
  // the CLI printed, wherever it landed) and row 182's limit check (the tail: the child's own
  // lines, never drive's about it). Every line a child wrote is spelled out before anyone reads
  // it (logSafe): the stream's lines by the renderer, stderr by `passthrough`.
  const stream = opts.stream ?? harness.worker.stream(step.home)
  // Row 245. The end watch: a grace after the stream's end signal, and for pi, which can sit on a
  // startup handle with nothing but its header (P31, P49), the never-started window. The window is
  // drive's alone: a claude session names its run at `system:init`.
  const watch = endWatch(stream, { neverStartedMs: harness.name === 'pi' ? SESSION_QUIET_MS : undefined })
  // How the end watch ended the session, once drive sent that stop, with the stream's error flag as
  // it stood then (S4-A).
  let ending: { cause: EndCause; atDeadline: boolean; failed: boolean } | undefined
  // Awake time on the session's clock once the child runs: what the quiet line measures in (row
  // 210). `started` prints before the clock exists, at 0.
  let awakeNow = (): number => 0
  // Row 256: the awake time held behind a job so far, on the same clock.
  let heldNow = (): number => 0
  // A held stretch: the job it waits behind, and the held time when it began. Its end — or the
  // session's end inside one — says how long the session waited, and the deadline file follows
  // the held time while it grows.
  let heldJob: string | undefined
  let stretch: { job: string; from: number } | undefined
  let heldWritten = 0
  const waitedLine = () => {
    if (stretch === undefined) return
    emit(`waited ${duration(heldNow() - stretch.from)} behind job ${stretch.job} — not counted against drive.sessionTimeoutMs`)
    stretch = undefined
  }
  const followHeld = () => {
    if (opts.deadline === undefined) return
    const held = heldNow()
    if (held > heldWritten) {
      stretch ??= { job: heldJob ?? 'unknown', from: heldWritten }
      heldWritten = held
      writeDeadline(opts.deadline.root, opts.deadline.token, t0 + cfg.drive.sessionTimeoutMs + held)
    } else {
      waitedLine()
    }
  }
  // The id the session's stream named last: whose journal entries are its own.
  let session: string | undefined
  // When a line was last printed, in awake time, and how many quiet lines followed it.
  let lastHeard = 0
  let quiet = 0
  // D7. The one place a line is printed under the session's prefix, so the one place it is spelled
  // out (logSafe: a renderer's lines already are, and spelling twice changes nothing). Any line
  // but the quiet line itself ends the quiet. Drive's own lines (started, session, still running,
  // ended, host slept) never enter the tail: only `show` puts the child's there.
  const emit = (l: string, quietLine = false) => {
    ctx.out(prefix + logSafe(l))
    if (!quietLine) { lastHeard = awakeNow(); quiet = 0 }
  }
  // The child's own lines: into the tail row 182 reads (`tailed`), and to the merge sniff.
  const show = (l: string, tailed: boolean) => {
    if (tailed && l.trim() !== '') { tail.push(l); if (tail.length > TAIL_LINES) tail.shift() }
    emit(l)
    opts.hear?.(l)
  }
  // A renderer never throws (row 214), and drive holds it to that: a throw here is in a pipe's
  // 'data' listener, which takes drive down and leaves the session running unwatched (P16). The
  // record is then shown as any record that is no event is.
  //
  // Row 245: the watch hears each record once the stream has read it, before its lines are shown.
  // Lines that arrive while a grace runs are shown but stay out of the tail, so a leaky tail's
  // chatter never hides the limit the turn ended on. That is decided per record: its lines stay out
  // only when a grace ran before it and still runs after it, so the record that starts a grace (a
  // claude error result carrying a limit) and the one that cancels it keep theirs (S4-1).
  //
  // Once the watch's stop is sent, what the session writes is its reaction to SIGTERM: shown, but
  // never heard by the watch and never in the tail, so a pi's aborted answer neither cancels the
  // grace nor lands its lines where row 182 reads a limit (S4-A).
  const out = lineSink((record) => {
    const before = watch.graceRunning()
    let said: WorkerLine[]
    try {
      said = stream.line(record)
    } catch {
      said = [{ kind: 'show', text: passthrough(record) }]
    }
    if (ending === undefined) watch.heard(awakeNow())
    const tailed = ending === undefined && !(before && watch.graceRunning())
    for (const w of said) {
      if (w.kind === 'show') show(w.text, tailed)
      else if (w.kind === 'heard') opts.hear?.(w.text)
      else {
        session = w.id
        emit(`session ${w.id}${transcripts !== undefined ? ` · ${transcripts}` : ''}`)
      }
    }
  })
  // stderr never moves the grace: its lines stay out of the tail while one runs, and after the
  // watch's stop.
  const err = lineSink((record) => show(passthrough(record), ending === undefined && !watch.graceRunning()))
  // D8. A session that printed nothing for SESSION_QUIET_MS of awake time says it still runs, how
  // long of its limit, and what it waits on — its oldest open call, else the model — then again
  // after each further SESSION_QUIET_MS. `quiet` names the stretch it crossed, never the measured
  // time, which drifts with how late each check fires. A harness whose events this CLI no longer
  // reads still gets the line. The check runs in the clock's timer, so it catches everything: a
  // throw there takes drive down and leaves the session unwatched (P16). The clock is re-armed
  // before it runs, so a check that failed costs one line, never the limit.
  const tick = (awake: number) => {
    try {
      for (const l of opts.progress?.(session) ?? []) emit(l)
      const n = Math.floor((awake - lastHeard) / SESSION_QUIET_MS)
      if (n <= quiet) return
      quiet = n
      const what = stream.inFlight()
      // Row 256: the time counted against the limit, and what was not.
      const held = heldNow()
      const notCounted = held > 0 ? ` · not counted: ${duration(held)} behind a job` : ''
      emit(`still running · ${duration(awake - held)} of ${duration(cfg.drive.sessionTimeoutMs)}${notCounted} · quiet ${duration(n * SESSION_QUIET_MS)}${what !== undefined ? ` · in: ${what}` : ''}`, true)
    } catch { /* the next check says it */ }
  }
  return await new Promise<SessionEnd>((resolve) => {
    // Final review F11: its own process group, so a stop reaches the tools, shells and gates
    // the session started, not just the agent — an orphan would keep writing state after
    // drive moved on. Windows has no groups to signal: there the stop is a tree kill from the
    // shim down, because libuv's job object lets the agent under the shim break away (row 201).
    // Since row 218 the tree's root is the job host, and killing it closes the job, which takes
    // what no tree walk reaches: a process whose parent already exited.
    const grouped = process.platform !== 'win32'
    const child = spawn(spawned.file, spawned.args, {
      cwd: step.home,
      env: spawned.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: spawned.windowsVerbatimArguments,
      detached: grouped,
    })
    const signal = (sig: NodeJS.Signals) => signalSession(child, grouped, spawned.env, sig)
    if (grouped && child.pid !== undefined) LIVE_GROUPS.add(child.pid)
    // Only a session that started says so: a binary that is not there reports spawn-failed alone.
    if (child.pid !== undefined) emit(`started ${clockTime()}${opts.next !== undefined ? ` · next: ${opts.next}` : ''}`)
    let outcome: SpawnOutcome = 'exited'
    let code: number | null = null
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    let exitGrace: NodeJS.Timeout | undefined
    let stopSent = false
    // The process is gone (`exit`), and drive waits at most EXIT_GRACE_MS for its pipes to close.
    let exited = false
    // One stop per session: SIGTERM, then SIGKILL TERM_GRACE_MS later. A later stop only renames how
    // it ended, and only a lost lease's does (`stopped`, which the loop reports once, at the end).
    const stop = (o: SpawnOutcome) => {
      outcome = o
      if (stopSent) return
      stopSent = true
      signal('SIGTERM')
      // A session that ignores SIGTERM is exactly the session the ceiling exists for.
      killTimer = setTimeout(() => signal('SIGKILL'), TERM_GRACE_MS)
    }
    const onAbort = () => stop('stopped')
    // Row 245. The end watch's stop is the timeout's (the process group, or on Windows the job
    // host's tree), and the session is `exited`. Once drive has sent a stop, neither the watch nor
    // the deadline renames it: a grace that falls due while a session ignores a lost lease's
    // SIGTERM leaves it `stopped` (S4-4). The stream's error flag is read as the stop is sent. A
    // process that already exited on its own is never stopped: its own exit code stands, though a
    // child it left holds its pipes while the grace or the never-started window falls due (S4-B).
    const endStop = (cause: EndCause, atDeadline: boolean) => {
      if (stopSent || exited) return
      ending = { cause, atDeadline, failed: failedNow(stream) }
      stop('exited')
    }
    const settle = (o: SpawnOutcome) => {
      if (settled) return
      settled = true
      if (child.pid !== undefined) LIVE_GROUPS.delete(child.pid)
      clock.stop()
      clearTimeout(killTimer)
      clearTimeout(exitGrace)
      opts.signal?.removeEventListener('abort', onAbort)
      out.flush()
      err.flush()
      child.stdout.destroy()
      child.stderr.destroy()
      const ms = Math.max(1, clock.awakeMs())
      const heldMs = clock.heldMs()
      // Row 256: a stretch the session ended inside says so, and the moved deadline goes with it.
      if (heldMs > heldWritten) stretch ??= { job: heldJob ?? 'unknown', from: heldWritten }
      if (o !== 'spawn-failed') waitedLine()
      if (opts.deadline !== undefined) removeDeadline(opts.deadline.root, opts.deadline.token)
      // Row 245. Stopped by the end watch, it is classified with the status its harness gives that
      // ending, never the stop's own (P46), and its error flag is the one read at the stop (S4-A).
      const ended = o === 'exited' && ending !== undefined ? ending : undefined
      if (ended !== undefined) code = endingStatus(harness.name, ended.cause, ended.failed)
      const failed = ending?.failed ?? stream.failed()
      // How it ended, in awake time. A spawn that failed never started, and said so already.
      // `(error)`: the stream says its last answer was an error, which pi's JSON mode reports at
      // exit 0 (D5).
      if (o !== 'spawn-failed') {
        // What it journaled since the last check, before how it ended.
        try {
          for (const l of opts.progress?.(session) ?? []) emit(l)
        } catch { /* what it journaled is in its stream; `ended` still says how it went */ }
        const how = ended !== undefined ? endedHow(ended.cause, ended.atDeadline, failed)
          : o === 'timeout' ? 'timed out' : o === 'stopped' ? 'stopped'
          : code === null ? 'killed' : `exit ${code}${failed ? ' (error)' : ''}`
        emit(`ended ${clockTime()} · ${how} · ${duration(ms)}`)
      }
      resolve({
        outcome: o, code, tail: [...tail], ms, failed, ...(ended !== undefined ? { ending: ended.cause } : {}),
        ...(heldMs > 0 ? { heldMs } : {}),
      })
    }
    // Row 245: the end signal never stops the timeout. A deadline that falls inside a grace ends the
    // session clean, as its turn's end; one after a stop drive already sent changes nothing, and
    // neither does one after the process exited by itself: it is no timeout (S4-B).
    const clock = sessionClock(cfg.drive.sessionTimeoutMs, opts.ticker ?? monotonicTicker, {
      expire: () => {
        if (stopSent || exited) return
        if (watch.graceRunning()) endStop('turn-ended', true)
        else stop('timeout')
      },
      slept: (ms) => emit(`host slept ${duration(ms)} — not counted against drive.sessionTimeoutMs`),
      // Row 256: held while the session waits behind a job for the test turn.
      held: () => {
        const job = opts.deadline?.behind()
        if (job !== undefined) heldJob = job
        return job !== undefined
      },
      // The watch first: once the grace or the never-started window is due, the session is stopped.
      tick: (awake) => {
        followHeld()
        const cause = watch.due(awake)
        if (cause !== undefined) endStop(cause, false)
        else tick(awake)
      },
    })
    awakeNow = () => clock.awakeMs()
    heldNow = () => clock.heldMs()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => out.push(c))
    child.stderr.on('data', (c: string) => err.push(c))
    child.on('error', (e) => {
      ctx.err(`${prefix}spawn-failed: ${e.message}`)
      settle('spawn-failed')
    })
    // `close` (stdio drained) is the clean end and the one that keeps every last line.
    // `exit` (the process itself is gone) is the BOUND on it: an agent session spawns its
    // own children — tools, git, node — and they inherit these pipes, so a killed parent
    // whose grandchild survives holds stdout open forever. Waiting for `close` alone is
    // therefore a hang with no timeout above it, which is the one failure a timeout must
    // not have. Measured here: SIGTERM to a shell whose `sleep` survived it.
    child.on('exit', (c) => {
      exited = true
      code = c
      // What a session started goes with it, however it ended (row 218): a stopped session's
      // group dies even if the agent exited on SIGTERM before its children did, and so does the
      // group of one that exited on its own and left a child running. On win32 the job closed
      // with the host, and signalSession sends nothing to a child that has exited.
      signal('SIGKILL')
      clearTimeout(killTimer)
      exitGrace = setTimeout(() => settle(outcome), EXIT_GRACE_MS)
    })
    child.on('close', () => settle(outcome))
  })
}

// `signal`: a stop from outside the loop — the drive verb's, when the lease is lost (row 224).
export interface DriveFlags { flow?: string; maxSpawns?: number; manual?: boolean; signal?: AbortSignal }

// Twenty sessions per invocation, held in MEMORY and nowhere else (north star 2): a
// ceiling that persisted would be state drive must clean up, and re-running is how a
// human says "keep going". It is a runaway guard, not a budget — the no-progress check
// below is what catches the common case long before this does.
export const DEFAULT_MAX_SPAWNS = 20
// Row 183. Under autonomy the per-target caps are the bound and this ceiling is a backstop
// against accounting bugs: 200 is the 203 sessions fewhats ran in the whole 33-day evidence
// window (design §2).
export const AUTONOMY_MAX_SPAWNS = 200

// Row 202 (issue #56). When everything left waits on the human, an autonomous drive pauses
// instead of quitting: it polls what a human act writes every 5 s and gives up after 12 h with
// nothing moving. Constants, not settings (no `migrate` for an upgrade); the suite reaches them
// through the Clock seam, and a CLI-level test bounds the idle limit through an undocumented
// seam on WITNESS_KEEP_AWAKE_BIN's precedent.
export const PAUSE_POLL_MS = 5_000
// Row 257: how often drive looks at a job child still starting (before its box or its ticket), and
// how long a start may take before drive reads the child as waiting.
const JOB_START_POLL_MS = 250
const JOB_START_MS = 30_000
const DETACH_LOCK_WAIT_MS = 10_000
export const PAUSE_IDLE_MAX_MS = 43_200_000
const idleMaxOf = (env: Record<string, string | undefined>): number => {
  const v = env.WITNESS_DRIVE_IDLE_MAX_MS
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : PAUSE_IDLE_MAX_MS
}

// What a human act writes: the journal, canon, the committed config, the trust list and the
// machine config — each file's size and mtime, hashed. Never drive's own log or its live
// folder, which it writes itself while paused.
export function watchSignature(root: string): string {
  const p = canonPaths(root)
  const files: string[] = []
  // Row 240: the busy folder too — a take or a release is what frees a target drive skipped. The
  // repo lock is not watched: it is taken and released by every state write.
  for (const dir of [join(root, '.witness', 'journal'), join(root, p.specs), join(root, p.plans), join(root, p.designs), join(root, BUSY_DIR)]) {
    try {
      for (const n of readdirSync(dir, { recursive: true }) as string[]) files.push(join(dir, n))
    } catch { /* absent: nothing to watch there yet */ }
  }
  for (const f of ['witness.config.yaml', join('.witness', 'allow.json'), join('.witness', 'config.local.yaml')]) files.push(join(root, f))
  const parts = files.sort().map((f) => {
    try {
      const st = statSync(f)
      return st.isFile() ? `${f}:${st.size}:${st.mtimeMs}` : ''
    } catch {
      return `${f}:-`
    }
  })
  return createHash('sha1').update(parts.join('\n')).digest('hex')
}

// Row 180. A target drive stops working on — none of these ends the run. Held in memory and
// never journaled (D145): the report reads them at the end. Row 196: one set aside for a human
// (kept, decision, conversation) records `key0`, its progress key then, and is drive's again
// once a human moves it. Row 207: so do drive's own verdicts (stuck, capped) and the merge — a
// paused drive would otherwise hold them forever — moved by a grant, a satisfied need, a
// decision, the merge stamp, or the human's `witness retry` for a fix that leaves no record.
// Row 240: `retry` is drive's own timer, not a human's stop — a settle the door refused with exit
// 3, due again at `due`, with the act `kept` when its making cost a model call, and its `tries`.
// Never published, listed, notified or counted toward a pause for the human.
export type AsideKind = 'kept' | 'decision' | 'conversation' | 'merge' | 'fix' | 'stuck' | 'capped' | 'retry' | 'recheck'
export interface Aside {
  target: string; kind: AsideKind; line: string; why: string; gate?: string; stop?: KeptStop; key0?: string
  trust?: RunCommand[]   // row 205: a trust grant's commands, each with its source
  due?: number; kept?: DecisionAct; tries?: number
}

// Row 240 (design §4.1.4). A refused settle is tried again one lock wait later; the third door
// refusal in a row sets the stop aside for the human. A busy lock never reaches the door.
export const RETRY_DUE_MS = LOCK_WAIT_MS
export const RETRY_MAX = 3
// Row 242 (design §4.3.4). A transient ship hold is checked again 5 minutes after the first, the
// wait doubling to at most an hour; constants (n3), each re-check a session counted against the caps.
export const RECHECK_FIRST_MS = 300_000
export const RECHECK_MAX_MS = 3_600_000
// The kinds that are drive's own timers, never the human's: a settle's retry, a hold's re-check.
const isTimer = (a: { kind: AsideKind }): boolean => a.kind === 'retry' || a.kind === 'recheck'


const streamLines = (root: string, id: string): number => readStream(root, id).length


// Row 181. Did anything happen for THIS target? A whole-journal count is satisfied by any
// other lane's progress, so a stalled flow beside a busy one would spawn until the ceiling.
// A target's key is its line, its stream, and the entries in its owning effort's stream that
// are about its own flow (F5: one effort carries every sibling's writes). Target-less work
// (brainstorm, the recovery fork) keys on the effort count and the asks stream, because a
// queued ask grows the asks and a recap births an effort. A crashed
// transaction is part of the target-less key (F4): the recovery fork is judged like any other
// work, so a session that leaves the same crash behind is set aside instead of being
// respawned to the ceiling.
function progressKey(root: string, action: NextAction, family: (t: string) => string[]): string {
  if (action.target === undefined) {
    const txn = pendingTxn(root)
    return [action.line, effortStreams(root).length, streamLines(root, ASK_STREAM),
      txn ? JSON.stringify({ op: txn.op, files: txn.files }) : ''].join('\u0000')
  }
  const target = action.target
  const effort = effortOf(root, target)
  const flow = family(target)
  const own = readStream(root, target).filter(movesFlow).length
  const inEffort = effort !== undefined && effort !== target
    ? readStream(root, effort).filter((e) => movesFlow(e) && flow.includes(String((e as { artifact?: unknown }).artifact))).length
    : 0
  return [action.line, own, inEffort].join('\u0000')
}

// Final review F2. A lane holds its whole flow: a spec and the plans written for it. Pure over the
// canon it is given: drive's fill reads it from the canon of this fill, the journal watch from a
// fresh one (row 214).
// Row 240 (design §4.1.2). Which owed stops drive's own settle pass judges: one in its scope (the
// `--flow` claim, else every target), not itself a lane (a session settles its own target), not
// set aside, and not busy to another live process. A lane's family members are admitted, which the
// fill's `admits` keeps out: a spec's stop would otherwise wait for every lane of its plans (P18).
export function settleAdmitsFor(t: string | undefined, s: {
  lanes: ReadonlyMap<string, unknown>; aside: ReadonlyMap<string, unknown>; flow?: string; busy: (t: string) => boolean
}): boolean {
  const k = t ?? TARGETLESS
  if (s.lanes.has(k) || s.aside.has(k)) return false
  if (s.flow !== undefined && t !== s.flow) return false
  return t === undefined || !s.busy(t)
}

export function flowOf(canon: Canon, t: string): string[] {
  const doc = findById(canon, t)
  if (doc?.meta.type === 'plan') return [t, String(doc.meta.parent)]
  if (doc?.meta.type === 'spec') {
    return [t, ...canon.docs.filter((d) => d.meta.type === 'plan' && String(d.meta.parent) === t).map((d) => String(d.meta.id))]
  }
  return [t]
}

// Row 214 (D9). What a session journals for its flow, as it lands: the target and its family
// (flowOf), each member's own stream, and the owning effort's entries about a member. The flow is
// read again from a fresh canon whenever the effort's stream moves, so the plan a spec's session
// writes mid-session joins it, from its first entry. Polled on the session clock's check and once
// before `ended`; drive journals nothing (row 145), so this only reads, and it never throws.
//
// Each stream has its own position, counted on all its entries — the filter (row 206's acts, the
// effort's about the flow) applies only to what is printed — and its own gate, size and mtime
// taken before the read: a stream caught mid-append fails to parse and keeps its old gate, so it
// is read again at the next check, once its line is whole. A stream that shrank starts over from
// where it stands. What the repo held before the session is the baseline, taken at creation, or
// for a stream that could not be read then, at the first check that can. The efforts read are
// every one that wrote a flow member — a fix routes to the spec it amends, so a later effort writes
// the spec again and plans it — collected again whenever a watched stream moves, so an amendment
// or an adopted target's first effort joins, from where its stream then stands. Once the
// session's id is known, an act it did not journal says so (its `ctx.session`, row 191 §4.8,
// absent or another's). An entry that cannot be rendered — a hand-edited line — is skipped, and
// costs no other entry its line.
export function journalWatch(root: string, target: string): (session?: string) => string[] {
  const at = new Map<string, { gate: string; seen: number }>()
  let moved = false                                       // a watched stream's gate moved this poll
  let flow = [target]
  let efforts: string[] = []                              // the efforts that wrote a flow member, read apart
  const derive = () => {
    try {
      flow = flowOf(loadCanon(root), target)
    } catch { /* the flow it had stands */ }
  }
  const gateOf = (id: string): string => {
    try {
      const st = statSync(join(root, journalRel(id)))
      return `${st.size}:${st.mtimeMs}`
    } catch {
      return '-'                                          // no stream yet
    }
  }
  // The entries a stream gained since it was last read; [] when its gate stands or it cannot be
  // read yet. `from0`: a member that joined the flow now, whose every entry is new.
  const read = (id: string, from0: boolean): Entry[] => {
    const gate = gateOf(id)
    const was = at.get(id)
    if (was?.gate === gate) return []
    moved = true
    let entries: Entry[]
    try {
      entries = readStream(root, id)
    } catch {
      return []                                           // an append in flight
    }
    at.set(id, { gate, seen: entries.length })
    const from = was === undefined ? (from0 ? 0 : entries.length) : Math.min(was.seen, entries.length)
    return entries.slice(from)
  }
  // An effort that is itself a flow member (a lane whose target is it) is read as one.
  const collect = (): string[] => {
    try {
      return effortStreams(root).filter((id) => !flow.includes(id) && readStream(root, id)
        .some((e) => e.t === 'write' && flow.includes(String((e as { artifact?: unknown }).artifact))))
    } catch {
      return efforts                                      // collected again when a stream moves
    }
  }
  derive()
  efforts = collect()
  const members = new Set(flow)                           // the flow at creation: a baseline, never news
  for (const id of [...flow, ...efforts]) read(id, false)
  const render = (e: Entry, mine: string | undefined, about?: readonly string[]): string[] => {
    try {
      if (!movesFlow(e)) return []
      if (about !== undefined && !about.includes(String((e as { artifact?: unknown }).artifact))) return []
      const by = (e as { ctx?: { session?: unknown } }).ctx?.session
      return [`journal: ${String(e.t)} ${entryDetail(e)}${mine !== undefined && by !== mine ? ' · not this session' : ''}`]
    } catch {
      return []
    }
  }
  return (session) => {
    try {
      const mine = session !== undefined ? sessionHash(session) : undefined
      moved = false
      const inEffort = efforts.flatMap((id) => read(id, false))
      if (moved) derive()
      const out = inEffort.flatMap((e) => render(e, mine, flow))
      for (const id of flow) {
        out.push(...read(id, !members.has(id) && !at.has(id)).flatMap((e) => render(e, mine)))
      }
      if (moved) {
        const now = collect()
        for (const id of now) if (!efforts.includes(id)) read(id, false)   // a new effort's baseline
        efforts = now
      }
      return out
    } catch {
      return []                                           // the next check reads it
    }
  }
}

// `streamAt`: the target's stream length when the lane started — what it journaled is after it.
// Row 257: the one job a drive runs, how to stop it alone, and how it ended once it has.
interface DriveJob { run: RunningJob; stop: AbortController; over?: JobEnd }
// `token`: the session's `<drive pid>-<spawn n>`, its deadline file's name (row 256).
interface Lane { action: NextAction; end: Promise<SessionEnd>; streamAt: number; token: string }

const lastRunGate = (entries: ReturnType<typeof readStream>): string | undefined => {
  const run = [...entries].reverse().find((e) => e.t === 'gate-run') as { gate?: unknown } | undefined
  return typeof run?.gate === 'string' ? run.gate : undefined
}

// The loop. Derive, classify, spawn, re-derive — and every turn reads the repo from disk,
// so nothing drive believed a moment ago can outlive a child that changed it.
//
// Row 181. Up to `drive.parallel` sessions at once, one per target: each fill asks the same
// ladder with the busy and set-aside targets filtered out, so D73's most-advanced-first
// order is the ladder's own. Serial whenever a human may be asked (autonomy off, --manual)
// or a flow is claimed (--flow): the decide> prompt and a claimed flow are one conversation.
//
// Deliberately no lazy merge-stamp here (`next` does one): drive journals nothing (§9).
// The spawned session runs `witness next` in its own home and stamps there, so a merged
// PR is observed on the very next derivation — by the CLI that owns that act.
export async function driveLoop(
  root: string, cfg: Config, ctx: Ctx, flags: DriveFlags, clock: Clock = realClock,
): Promise<number> {
  const autonomous = cfg.autonomy && !flags.manual
  const parallel = autonomous && flags.flow === undefined ? cfg.drive.parallel : 1
  const ceiling = flags.maxSpawns ?? (autonomous ? AUTONOMY_MAX_SPAWNS : DEFAULT_MAX_SPAWNS)
  const lanes = new Map<string, Lane>()
  const aside = new Map<string, Aside>()
  const progress = new Map<string, string>()
  const use = new Map<string, TargetUse>()                // row 183: this run's sessions and time, per target
  const unparksSeen = new Map<string, number>()           // row 241: human un-parks counted per target
  let spawns = 0
  let stop: 'ceiling' | 'spawn-failed' | 'usage' | 'autonomy-off' | 'idle-limit' | 'superseded' | undefined
  let idle: string | undefined
  // Row 182. A usage limit pauses every lane: nothing new starts until the reset, and the
  // running sessions finish, because they meet the same account. Every wait is printed, one
  // wait is at most 6 h, and a run waits at most 12 h in all.
  let pausedUntil = 0
  let waited = 0
  let streak = 0
  // A signal aborts every running session through spawnSession's `signal`, stops filling,
  // and ends the run. A second signal is the human insisting: the default action takes it.
  const abort = new AbortController()
  let signalled: NodeJS.Signals | undefined
  const onSignal = (sig: NodeJS.Signals) => {
    if (signalled !== undefined) {
      for (const pid of LIVE_GROUPS) { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
      process.removeListener(sig, onSignal)
      process.kill(process.pid, sig)
      return
    }
    signalled = sig
    abort.abort()
  }
  const aborted = new Promise<void>((done) => abort.signal.addEventListener('abort', () => done(), { once: true }))
  // Row 224. The lease lost — another drive holds the lock now: this run ends as a signal ends
  // it, every session stopped, so two drives never work the repo at once.
  const outside = () => { if (signalled === undefined) onSignal('SIGTERM') }
  if (flags.signal?.aborted) outside()
  else flags.signal?.addEventListener('abort', outside, { once: true })

  // Final review F2. A lane holds its whole flow: a spec and the plans written for it. The
  // plan queue's lane is keyed by the spec, and its session writes the plan and keeps working
  // on it (witness-plan gates it in the same session), so the new plan's id must not read as
  // a free target meanwhile — nor a spec while one of its plans runs. Read from the canon of
  // this fill, so a plan written a moment ago belongs to its spec's lane at once.
  let canonNow = loadCanon(root)
  const family = (t: string): string[] => flowOf(canonNow, t)
  // Row 240. This round's targets another live process holds — a settle lock or a ship marker —
  // skipped by the settle pass, the fill, `waitingNeed`, `capped` and `unmoved` alike, so none
  // reads it as a cap or as no progress. While one waits and no lane runs, drive polls.
  const busySeen = new Set<string>()
  const busyOther = (t: string): boolean => {
    if (busyHolder(root, 'settle', t) === undefined && busyHolder(root, 'ship', t) === undefined) return false
    busySeen.add(t)
    return true
  }
  const admits = (t: string | undefined): boolean => {
    const k = t ?? TARGETLESS
    if (lanes.has(k) || aside.has(k) || busySeen.has(k) || (flags.flow !== undefined && t !== flags.flow)) return false
    if (t === undefined) return true
    const mine = family(t)
    if ([...lanes.keys()].some((l) => mine.includes(l) || family(l).includes(t))) return false
    // Row 242: a plan whose merge ship journaled is over for drive, whatever its status says yet.
    if (ended(t) === 'merged') return false
    return !busyOther(t)
  }
  const settleAdmits = (t: string | undefined): boolean =>
    !busySeen.has(t ?? TARGETLESS) && settleAdmitsFor(t, { lanes, aside, ...(flags.flow !== undefined ? { flow: flags.flow } : {}), busy: busyOther })
  const setAside = (key: string, a: Omit<Aside, 'target'>) => { aside.set(key, { target: key, ...a }) }
  // Row 240. Drive's timers: the earliest due time, and each timer whose time came — only its aside
  // is deleted (row 207's release resets a target's use and must not be used), its kept act handed
  // to this round's settle pass.
  const nextDue = (): number | undefined => {
    let at: number | undefined
    for (const a of aside.values()) if (isTimer(a) && a.due !== undefined && (at === undefined || a.due < at)) at = a.due
    return at
  }
  const releaseDue = () => {
    for (const [k, a] of [...aside]) {
      if (!isTimer(a) || a.due === undefined || a.due > clock.now()) continue
      aside.delete(k)
      if (a.kept !== undefined) dueKept.set(k, a.kept)
    }
  }
  const humanAsides = (): Aside[] => [...aside.values()].filter((a) => !isTimer(a))
  // Row 196. A target's own next action, read with every other target filtered out: how the
  // settle pass, which holds no action, and `takeBack` derive the key a human may move.
  const ownNext = (key: string): NextAction =>
    computeNext(root, ctx, canonNow, cfg, { scope: key === TARGETLESS ? (t) => t === undefined : (t) => t === key })
  const keyOf = (action: NextAction): string => progressKey(root, action, family)
  // Whether `now` is this target's own answer: a pending transaction (a crash, or a lane caught
  // mid-write) and canon errors answer every scope with one global rung, which says nothing
  // about the target, so reading it as a move would release every aside at once.
  const ownAnswer = (key: string, now: NextAction): boolean =>
    pendingTxn(root) === undefined && (key === TARGETLESS || now.target === key)
  // Row 196. First in every round: each target set aside for a human whose key moved since
  // (an ask answered or queued, a need satisfied, a stop decided in a chat) leaves the aside
  // set and competes for a slot again. One whose next act is the human's again is set aside
  // anew, under its new key, by the settle pass or the fill that meets it.
  // Row 207: a release is a new chance, so the target's per-run use and its last key go too.
  const release = (key: string) => {
    aside.delete(key)
    use.delete(key)
    progress.delete(key)
    pauseSince = undefined                                 // a human act: the idle clock starts over
    // What this target needs of the human next is news (final review): a second trust grant,
    // a stuck again after a retry. Keys are `<kind>:<target>[:…]`, and ids carry no colon.
    for (const k of [...notified]) if (k.split(':')[1] === key) notified.delete(k)
  }
  // A plan that reached its end — merged, abandoned — is no flow any more: its scoped ladder
  // answers with a global rung, so `ownAnswer` would hold its aside forever.
  const ended = (key: string): string | undefined => {
    const doc = findById(canonNow, key)
    const status = String(doc?.meta.status)
    if (doc?.meta.type === 'plan' && (status === 'done' || status === 'abandoned')) return status
    // Row 242: a merge ship journaled ends the plan for drive at once, as a done plan does — no
    // session runs only to reach the lazy stamp.
    return doc?.meta.type === 'plan' && latestOutcome(readStream(root, key))?.outcome === 'merged' ? 'merged' : undefined
  }
  // Row 242. A merge or fix aside is drive's again the moment the plan stops being held — a later
  // entry, or a moved HEAD, which changes no progress key.
  const heldNow = (key: string) => {
    const doc = findById(canonNow, key)
    return doc?.meta.type === 'plan' ? heldPlan(root, cfg, doc) : undefined
  }
  const takeBack = () => {
    for (const [key, a] of aside) {
      if (a.key0 === undefined) continue
      if ((a.kind === 'merge' || a.kind === 'fix') && ended(key) === undefined && heldNow(key) === undefined) {
        release(key)
        ctx.out(`drive: taken back — ${key} · no longer held`)
        continue
      }
      const over = ended(key)
      if (over !== undefined) {
        release(key)
        ctx.out(`drive: released — ${key} · ${over}`)
        continue
      }
      const now = ownNext(key)
      if (!ownAnswer(key, now) || keyOf(now) === a.key0) continue
      release(key)
      ctx.out(`drive: taken back — ${key === TARGETLESS ? 'untargeted work' : key} · ${now.line}`)
    }
  }
  // Row 196 (spec §4.3). Once more before the report: a target still the human's is reported as
  // it is now, and one a human moved on to drive's work leaves the set — the report's
  // journal-derived rows (decisions, needs) name whatever else still waits.
  const refreshAside = () => {
    canonNow = loadCanon(root)
    for (const [key, a] of aside) {
      if (a.key0 === undefined) continue
      if (ended(key) !== undefined) { aside.delete(key); continue }
      const now = ownNext(key)
      if (!ownAnswer(key, now) || keyOf(now) === a.key0) continue
      if (conversationStage(now)) aside.set(key, { ...a, kind: 'conversation', line: now.line, key0: keyOf(now) })
      else if (!now.line.startsWith('witness decide ')) aside.delete(key)
    }
  }
  // Row 242 (R15). A target whose plan is held is the human's stop, never stuck.
  const asHeld = (key: string): boolean => {
    const rec = heldNow(key)
    if (rec === undefined) return false
    ctx.out(`drive: ${rec.outcome} — ${key} · ${logSafe(String(rec.reason))}`)
    setAside(key, { kind: rec.outcome === 'fix' ? 'fix' : 'merge', line: cliAct('ship', key).line, why: rec.reason, key0: keyOf(ownNext(key)) })
    return true
  }
  const stuck = (key: string, action: NextAction) => {
    if (asHeld(key)) return
    ctx.out(`drive: no progress — ${action.line}`)
    ctx.out(action.target !== undefined
      ? `help: ${action.target} is set aside until its record moves — read its stream above · after a fix witness cannot see: ${cliAct('retry', action.target).line}`
      : 'help: untargeted work is set aside until its record moves — read its stream above')
    setAside(key, { kind: 'stuck', line: action.line, why: `no progress on ${action.line}`, key0: keyOf(action) })
  }
  // A decision is an act too, and it gets the same convergence guard as a spawn: a decision
  // that executes and journals nothing would otherwise re-render its own block forever.
  const unmoved = (key: string, action: NextAction): boolean => {
    const pk = progressKey(root, action, family)
    if (progress.get(key) === pk) { stuck(key, action); return true }
    progress.set(key, pk)
    return false
  }

  const standAside = async (step: Exclude<DriveStep, { kind: 'spawn' | 'idle' }>, action: NextAction, key: string) => {
    if (step.kind === 'kept') {
      ctx.out(`drive: waits on you — ${action.target ?? 'untargeted work'} · ${KEPT_STOP_NAMES[step.stop]}`)
      setAside(key, {
        kind: 'kept', line: step.line, why: KEPT_STOP_NAMES[step.stop], stop: step.stop,
        ...(action.trust !== undefined ? { trust: action.trust } : {}), key0: keyOf(action),
      })
      return
    }
    if (step.kind === 'conversation') {
      ctx.out(`drive: conversation — ${step.line}`)
      ctx.out('help: run /witness in a chat — drive takes it back when you are done')
      setAside(key, { kind: 'conversation', line: step.line, why: 'an exchange with a human', key0: keyOf(action) })
      return
    }
    if (step.kind === 'merge' || step.kind === 'fix') {
      ctx.out(`drive: ${step.kind} — ${action.target ?? 'untargeted work'} · ${action.held !== undefined ? logSafe(String(action.held.reason)) : 'the merge is a human\'s'}`)
      setAside(key, { kind: step.kind, line: step.line, why: action.held?.reason ?? 'the merge is a human\'s', key0: keyOf(action) })
      return
    }
    // Under autonomy a `witness decide` line still reaching the fill is a stop the settle
    // pass did not settle. A re-run the CLI named is spawned (see the fill); anything else is
    // a `--manual` run's stop, which waits for the human and is never settled.
    if (autonomous) {
      ctx.out(`drive: waits on you — ${action.target ?? 'untargeted work'} · decision · ${action.line}`)
      setAside(key, { kind: 'decision', line: action.line, why: action.line, ...(step.gate ? { gate: step.gate } : {}), key0: keyOf(action) })
      return
    }
    if (unmoved(key, action)) return
    const r = await resolveDecision(step, action, ctx)
    if (r === 'stands') setAside(key, { kind: 'decision', line: action.line, why: action.line, ...(step.gate ? { gate: step.gate } : {}), key0: keyOf(action) })
    if (r === 'refused') setAside(key, { kind: 'stuck', line: action.line, why: `decision refused on ${action.line}`, key0: keyOf(action) })
  }

  // `next` is the line the session takes (D13): the action's, or the re-run a settle routed.
  const launch = (step: SpawnStep, action: NextAction, n: number, next: string): Lane => {
    const token = `${process.pid}-${n}`
    const lane: Lane = {
      action, end: Promise.resolve(undefined as unknown as SessionEnd),
      streamAt: action.target !== undefined ? readStream(root, action.target).length : 0, token,
    }
    // Row 242: a merge or fix left to the human is read from the record ship journals, so drive no
    // longer listens for ship's words (the merge sniff of rows 180 and 214 retired).
    // Row 214: what the session journals for its flow. Target-less work has no stream of its own
    // to watch (row 181 keys it on counts).
    const progress = action.target !== undefined ? journalWatch(root, action.target) : undefined
    // Row 256: the session's deadline file, and whether it waits behind a job for the test turn.
    const deadline = { root, token, behind: () => behindJob(root, token) }
    lane.end = spawnSession(step, cfg, ctx, n, { manual: flags.manual, signal: abort.signal, root, next, progress, deadline })
    return lane
  }

  // Every wait drive takes goes through here: printed, bounded and counted toward the total.
  const pauseFor = (limit: Limit): void => {
    const now = clock.now()
    const wait = waitFor(limit, streak, now)
    streak += 1
    if (wait > SINGLE_WAIT_MAX_MS) {
      ctx.out(`drive: usage limit — resets in ${duration(wait)} — beyond drive's 6h wait · ${limit.text}`)
      stop ??= 'usage'
      return
    }
    // Only the time a wait adds beyond a pause already running counts toward the total.
    const added = Math.max(0, now + wait - Math.max(pausedUntil, now))
    if (waited + added > TOTAL_WAIT_MAX_MS) {
      ctx.out(`drive: usage limit — waited ${duration(waited)} — the next wait passes drive's 12h bound · ${limit.text}`)
      stop ??= 'usage'
      return
    }
    ctx.out(`drive: usage limit — waiting ${duration(wait)} · ${limit.text}`)
    waited += added
    pausedUntil = Math.max(pausedUntil, now + wait)
  }

  // A session that ended on a limit counts toward no cap, and its target's next
  // consideration is not judged for progress: the session never got to act.
  const limited = (key: string, end: SessionEnd): boolean => {
    if (end.outcome !== 'exited' && end.outcome !== 'timeout') return false
    const limit = sessionLimit(end, clock.now())
    if (!limit) { streak = 0; return false }
    progress.delete(key)
    pauseFor(limit)
    return true
  }

  // Final review I3: an aside set when a lane ends keys on the target's state after the session,
  // as the settle pass's do — the line the lane started with may be one the session moved past,
  // which would read as a human's move at the next take-back.
  const keyAfter = (key: string): string => {
    canonNow = loadCanon(root)
    return keyOf(ownNext(key))
  }
  const settle = (key: string, lane: Lane, end: SessionEnd) => {
    if (end.outcome === 'stopped') return                // the signal's, reported once at the end
    if (limited(key, end)) return
    // Row 240. A target another live process holds when its lane ends — a human started `witness
    // ship` after drive spawned — ends like a usage-limited lane: its progress cleared, no cap
    // counted, never stuck. Read from the busy folder, never from the session's words.
    if (key !== TARGETLESS && busyOther(key)) { progress.delete(key); return }
    const u = use.get(key) ?? { spawns: 0, ms: 0 }
    use.set(key, { spawns: u.spawns + 1, ms: u.ms + chargedMs(end) })
    if (end.outcome === 'timeout') {
      if (asHeld(key)) return
      ctx.out(`drive: spawn-timeout — ${lane.action.line}`)
      setAside(key, { kind: 'stuck', line: lane.action.line, why: `spawn-timeout on ${lane.action.line}`, key0: keyAfter(key) })
      return
    }
    if (end.outcome === 'spawn-failed') {
      ctx.out(`drive: spawn-failed — ${lane.action.line}`)
      stop ??= 'spawn-failed'                            // this machine can spawn nothing
      return
    }
    // Row 242 (design §4.3.4). A lane that journaled a transient or pending record — now the
    // stream's latest entry — is re-checked by drive itself; one that wrote nothing takes the
    // no-progress path below and ends stuck: a session that never reached ship is no re-check.
    if (key !== TARGETLESS) {
      const entries = readStream(root, key)
      const rec = latestOutcome(entries)
      if (rec !== undefined && (rec.outcome === 'transient' || rec.outcome === 'pending') && entries.length > lane.streamAt) {
        const reason = logSafe(String(rec.reason))
        if (!autonomous) {
          // The human is at the terminal: the hold is theirs to look at, as stuck.
          ctx.out(`drive: ${rec.outcome} — ${key} · ${reason}`)
          setAside(key, { kind: 'stuck', line: lane.action.line, why: `${rec.outcome}: ${String(rec.reason)}`, key0: keyAfter(key) })
          return
        }
        const prev = recheckDelay.get(key)
        const delay = prev === undefined ? RECHECK_FIRST_MS : Math.min(prev * 2, RECHECK_MAX_MS)
        recheckDelay.set(key, delay)
        progress.delete(key)                              // the unchanged line never reads as stuck
        ctx.out(`drive: recheck — ${key} · ${reason} · again in ${duration(delay)}`)
        setAside(key, { kind: 'recheck', line: lane.action.line, why: String(rec.reason), due: clock.now() + delay })
        return
      }
      recheckDelay.delete(key)
    }

  }

  // Row 180. Under autonomy each round starts with one settle pass over every target no
  // session holds and nothing has set aside — a running session settles its own target
  // through its gate and its scoped `next`, so each stop has exactly one settler. Whatever
  // the pass leaves for a human, drive sets aside. The pass never waits inside a reviewer
  // (F6: that wait was silent, uncounted and deaf to a signal): an arbiter refused by a usage
  // limit becomes drive's own pause, and the stop is judged again after it.
  // target → the re-run its settle routed (row 239: its act; row 241: a plan step's whole row)
  const routed = new Map<string, { act: Act; row?: NextAction }>()
  const recheckDelay = new Map<string, number>()       // row 242: each target's last re-check wait
  // Row 240 (§4.1.4). Door refusals with exit 3 in a row, per target, and the acts kept from them
  // whose retry fell due this round.
  const retries = new Map<string, number>()
  const dueKept = new Map<string, DecisionAct>()
  const settlePass = async () => {
    const { settleOwed, settledLine } = await import('./settle.js')
    const reports = await settleOwed(ctx, root, cfg, { scope: settleAdmits, kept: dueKept })
    // A kept act stays until a settle of its target uses it: one busy this round is judged next.
    for (const r of reports) dueKept.delete(r.target)
    for (const r of reports) {
      const s = r.settled
      // Row 240: another process took the stop's settle lock after the scope was read.
      if (s.kind === 'busy') { busySeen.add(r.target); continue }
      if (s.kind === 'left' && s.code === EXIT.BLOCKED && s.limit === undefined) {
        const tries = (retries.get(r.target) ?? 0) + 1
        retries.set(r.target, tries)
        if (tries < RETRY_MAX) {
          ctx.out(`drive: retry — ${r.target} · ${s.why} · again in ${duration(RETRY_DUE_MS)}`)
          setAside(r.target, {
            kind: 'retry', line: cliAct('decide', r.gate, r.target, '--show').line, why: s.why, gate: r.gate,
            due: clock.now() + RETRY_DUE_MS, tries, ...(s.paid === true && s.act !== undefined ? { kept: s.act } : {}),
          })
          continue
        }
      }
      retries.delete(r.target)
      if (s.kind === 'left' && s.limit !== undefined) {
        pauseFor(limitIn(s.limit, clock.now()) ?? { kind: 'usage', text: s.limit })
        continue
      }
      const line = settledLine(r)
      if (line !== undefined) ctx.out(line)
      if (s.kind === 'kept') {
        ctx.out(`drive: waits on you — ${r.target} · ${KEPT_STOP_NAMES[s.stop]}`)
        const trust = s.untrusted !== undefined ? sourced(cfg, canonNow, r.target, s.untrusted) : undefined
        setAside(r.target, {
          kind: 'kept', line: s.line, why: KEPT_STOP_NAMES[s.stop], gate: r.gate, stop: s.stop,
          ...(trust !== undefined ? { trust } : {}), key0: keyOf(ownNext(r.target)),
        })
      } else if (s.kind === 'left') {
        ctx.out(`drive: waits on you — ${r.target} · decision · ${s.why}`)
        setAside(r.target, { kind: 'decision', line: cliAct('decide', r.gate, r.target, '--show').line, why: s.why, gate: r.gate, key0: keyOf(ownNext(r.target)) })
      } else if (s.kind === 'routed') {
        routed.set(r.target, { act: s.act, ...(s.row !== undefined ? { row: s.row } : {}) })
      }
    }
  }

  // Row 179's kept stop, in both modes: a start an unmet manual need blocks is set aside
  // without spawning a session only to be refused. Env and cmd needs stay `start`'s.
  const waitingNeed = (action: NextAction, key: string): boolean => {
    if (!action.line.startsWith('witness start ') || action.target === undefined) return false
    const needs = unmetNeeds(loadCanon(root)).filter((u) => u.doc === action.target && u.blocks === 'start')
    if (needs.length === 0) return false
    ctx.out(`drive: waits on you — ${action.target} · unmet need`)
    const line = unmetNeedLine(needs)
    ctx.out(line)
    setAside(key, { kind: 'kept', line, why: KEPT_STOP_NAMES['unmet-need'], stop: 'unmet-need', key0: keyOf(action) })
    return true
  }

  // Row 183. Checked before every spawn for a target, the first included. Target-less work
  // has no stream to count or park on; the ceiling bounds it.
  const capped = async (action: NextAction, key: string): Promise<boolean> => {
    if (action.target === undefined) return false
    const hit = capHit(readStream(root, action.target), use.get(key) ?? { spawns: 0, ms: 0 }, cfg.drive.caps)
    if (hit === undefined) return false
    // A parked cap carries its gate and the report reads it from the journal; an
    // unparkable one carries none and is reported with what it is, beside the stuck.
    const parked = await parkAtCap(ctx, root, action.target, hit, cfg)
    // Row 240: another process is deciding that stop now — nothing is set aside, and the target
    // is tried again next round.
    if (!parked.parked && parked.busy === true) { busySeen.add(key); return true }
    if (parked.parked) {
      ctx.out(`drive: parked — ${action.target} · ${hit.note}`)
      const gate = hit.gate ?? lastRunGate(readStream(root, action.target))
      setAside(key, { kind: 'capped', line: action.line, why: hit.note, ...(gate ? { gate } : {}), key0: keyOf(action) })
    } else {
      // Row 242: a hold drive kept re-checking until the cap names its last reason — the first wake it makes.
      const last = latestOutcome(readStream(root, action.target))
      const held = last !== undefined && (last.outcome === 'transient' || last.outcome === 'pending') ? ` · ${logSafe(String(last.reason))}` : ''
      const why = `${hit.note} · ${parked.why}${held}`
      ctx.out(`drive: capped — ${action.target} · ${why}`)
      setAside(key, { kind: 'capped', line: action.line, why, key0: keyOf(action) })
    }
    return true
  }

  const start = runStart(root)
  // Row 211. A helper that dies while drive still holds it says so; once a signal is stopping
  // drive, the helper's end is that signal's, and no news.
  const lostAwake = (why: string) => {
    if (signalled === undefined) ctx.out(`keep-awake: lost — ${why} · keep the host awake yourself`)
  }
  let awake = keepAwake(ctx.env, process.platform, process.pid, lostAwake)
  let awakeHeld = true
  ctx.out(awake.shown !== undefined
    ? `keep-awake: ${awake.shown}`
    : `keep-awake: none on ${process.platform} — keep the host awake yourself`)
  ctx.out(containmentLine(jobHost(ctx.env)))
  // Row 182, amended by row 202: held while a session runs, released while drive waits on the
  // human — a paused drive lets the machine sleep — and taken again before the next spawn.
  const holdAwake = () => {
    if (awakeHeld) return
    awake = keepAwake(ctx.env, process.platform, process.pid, lostAwake)
    awakeHeld = true
  }
  const releaseAwake = () => {
    if (!awakeHeld) return
    awake.stop()
    awakeHeld = false
  }

  // Row 203. Drive's set-asides, published for a chat waiting beside it: ids and kinds only. A
  // grill with nothing queued waits on nobody and is not published.
  const notice = (a: Aside): boolean => a.target === TARGETLESS && a.kind === 'conversation' && !/ --ask /.test(a.line)
  const publish = (ended?: EndReason) => {
    if (!autonomous) return
    const asides: LiveAside[] = humanAsides().filter((a) => !notice(a)).map((a) => ({
      target: a.target, kind: a.kind, ...(a.gate !== undefined ? { gate: a.gate } : {}), ...(a.stop !== undefined ? { stop: a.stop } : {}),
    }))
    // Row 240: drive's scope, and whether it still settles stops — false once it stopped for good.
    writeLive(root, {
      pid: process.pid, asides, ...(ended !== undefined ? { ended } : {}),
      ...(flags.flow !== undefined ? { scope: { flow: flags.flow } } : {}),
      deciding: ended === undefined && stop === undefined && signalled === undefined,
    })
  }
  // Row 203 (Q2). Each item that newly needs the human is notified once per run (n5), a burst
  // as one notification, started in the background so no round waits on it. Mid-run, an item
  // whose flow a session is working on is that session's to settle, and a crash is drive's own
  // to recover; both are said only once drive pauses.
  const notified = new Set<string>()
  const busy = (t: string): boolean => [...lanes.keys()].some((l) => l === t || family(l).includes(t) || family(t).includes(l))
  const notifyNew = (items: readonly NeedYou[]) => {
    const fresh = items.filter((i) => i.notice !== true && !notified.has(i.key))
    if (fresh.length === 0) return
    for (const i of fresh) notified.add(i.key)
    const named = fresh.slice(0, 3).map((i) => i.kind === 'pending-txn' ? WAIT_LABEL[i.kind] : `${WAIT_LABEL[i.kind]} · ${i.target}`)
    const local = loadLocalConfig(root)
    notify(local.ok ? local.value.notify : undefined, 'witness drive',
      `witness · ${basename(root)}: ${named.join(' · ')}${fresh.length > 3 ? ` (+${fresh.length - 3})` : ''}`,
      process.platform, { wait: false })
  }
  // Row 240: drive applies its own scope rule — a stop it will decide is no item for the human.
  const owed = (): NeedYou[] => needsYou(root, ctx, cfg, loadCanon(root), humanAsides(), {
    ...(flags.flow !== undefined ? { flow: flags.flow } : {}), deciding: stop === undefined && signalled === undefined,
  })

  // Row 202. Everything left waits on the human: say what, notify, let the machine sleep, and
  // watch for the act. A change runs a round as usual (take-back, settle pass, fill); a change
  // that releases nothing re-enters the pause silently. True to run a round, false to end.
  const idleMax = idleMaxOf(ctx.env)
  let pauseSince: number | undefined
  let pausePrinted: string | undefined
  // Final review (b) I3: the signature the round began with. A human act that lands during the
  // round — after its take-back, before the pause — differs from it, and resumes at once.
  let roundSignature = ''
  const pauseForHuman = async (): Promise<boolean> => {
    const items = owed().filter((i) => i.notice !== true)
    const token = needsYouToken(items)
    if (token !== pausePrinted) {
      ctx.out(`drive: waiting on you — ${items.length} item(s)`)
      items.flatMap((i) => needYouRows(i)).forEach((l) => ctx.out(l))
      pausePrinted = token
    }
    notifyNew(items)
    releaseAwake()
    publish()
    pauseSince ??= clock.now()
    const signature = roundSignature
    for (;;) {
      if (watchSignature(root) !== signature) return true
      // Row 240: drive's own timers wake it at their due times (the repo lock is outside the signature).
      const due = nextDue()
      if (due !== undefined && clock.now() >= due) return true
      // Row 242: drive's own timers are its own work — the idle limit does not run while one waits.
      if (due === undefined && clock.now() - pauseSince >= idleMax) {
        ctx.out(`drive: idle limit — waited ${duration(idleMax)} on you · the run ends`)
        stop = 'idle-limit'
        return false
      }
      await Promise.race([clock.sleep(due !== undefined ? Math.max(0, Math.min(PAUSE_POLL_MS, due - clock.now())) : PAUSE_POLL_MS), aborted])
      if (signalled !== undefined) return false
    }
  }
  // Final review F9. Autonomy is re-read from the committed config before every round, on
  // A1's precedent (ship re-reads it at merge time): a human who turns it off mid-run takes
  // the wheel at once — no stop of theirs is settled, and no new session starts.
  const stillAutonomous = (): boolean => {
    if (!autonomous || stop !== undefined) return true
    const now = loadConfig(root)
    if (now.ok && now.value.autonomy) return true
    ctx.out('drive: autonomy is off now — no new session starts')
    stop = 'autonomy-off'
    return false
  }

  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  publish()
  // Row 218. A runner turn whose holder died — a session drive stopped mid-run — is released
  // now and after every session, before Windows hands its pid to another process. Row 240: so are
  // the busy locks of dead holders, and this drive's own leftovers. Row 257: and after every job,
  // with the turn's stale tickets and the deadline files no running lane holds.
  const sweep = () => {
    releaseDeadTurn(root)
    sweepTurnQueue(root)
    sweepDeadBusy(root, { pid: process.pid })
    sweepDeadlines(root, new Set([...lanes.values()].map((l) => l.token)))
  }
  sweep()
  // Row 257. One job runs at a time, beside the lanes, in every drive: started after each round's
  // fill while the run is not stopping, and awaited with the lanes. Drive journals each shard's
  // outcome itself (drive-jobs.ts): a child stopped at its box dies at once and must never die
  // mid-write, the one exception to row 145's "children journal their own acts".
  //
  // Slice 3 review. A journal write refused or thrown turns jobs off for the rest of the run, said
  // once and on the report: the shard would read missing and run again at once, forever. A `jobs`
  // stream another history holds is found before any box is spent. With no lane running, drive never
  // waits on a job alone: a boxed job is awaited on the pause cadence, so take-back, the settle pass
  // and the fill still run, and a job still queued for the test turn — behind a holder that is not
  // drive's — is stopped when the run would end, journaling nothing; the next drive runs it.
  let job: DriveJob | undefined
  let jobsOff: string | undefined
  const jobsOffNow = (why: string) => {
    if (jobsOff !== undefined) return
    jobsOff = why
    ctx.out(`drive: jobs off for this run — ${why}`)
  }
  const beginJob = () => {
    if (job !== undefined || stop || signalled || jobsOff !== undefined) return
    const blocked = jobsBlocked(root)
    if (blocked !== undefined) { jobsOffNow(blocked); return }
    const ctl = new AbortController()
    const relay = () => ctl.abort()
    abort.signal.addEventListener('abort', relay, { once: true })
    const run = startJob(root, cfg, ctx, canonNow, { signal: ctl.signal })
    if (run === undefined) { abort.signal.removeEventListener('abort', relay); return }
    const j: DriveJob = { run, stop: ctl }
    void run.end.then((e) => { j.over = e; abort.signal.removeEventListener('abort', relay) })
    job = j
  }
  // A job whose end has come is cleared, its refusal read, and the leftovers swept.
  const reapJob = (): boolean => {
    if (job?.over === undefined) return false
    if (job.over.refused !== undefined) jobsOffNow(job.over.refused)
    job = undefined
    sweep()
    return true
  }
  // Queued for the test turn, or never got as far as saying where it is.
  const jobWaiting = (j: DriveJob): boolean =>
    !j.run.running() && (turnTickets(root).some((t) => t.job === j.run.kind) || Date.now() - j.run.startedAt >= JOB_START_MS)
  try {
    for (;;) {
      if (autonomous) roundSignature = watchSignature(root)
      busySeen.clear()
      stillAutonomous()
      // Row 240. Once a newer CLI has journaled, the state floor refuses this one at dispatch — and
      // this drive's sessions run its own bin. It ends rather than work beside its successor.
      const floor = stateFloor(root)
      if (stop === undefined && floor !== undefined && (compareTriple(floor.pin, version()) ?? 0) > 0) {
        ctx.out('drive: superseded — a newer witness CLI took over')
        stop = 'superseded'
      }
      canonNow = loadCanon(root)
      // A run that is stopping fills nothing more, so a target released now would be set aside
      // by nobody and drop out of the report; it stays where it is, and the report derives it.
      if (!stop && !signalled) takeBack()
      if (autonomous && !stop && !signalled) releaseDue()
      if (autonomous && !stop && !signalled && clock.now() >= pausedUntil) await settlePass()
      // Row 242 (design §4.3.2, Drive). Beside the settle pass: each held plan in scope is set aside as
      // its merge or fix stop, so a run left with only such stops pauses for the human (row 202).
      if (autonomous && !stop && !signalled) {
        for (const d of canonNow.docs.filter((x) => x.meta.type === 'plan')) {
          const t = String(d.meta.id)
          if (lanes.has(t) || aside.has(t) || (flags.flow !== undefined && t !== flags.flow)) continue
          asHeld(t)
        }
      }
      while (!stop && !signalled && lanes.size < parallel && clock.now() >= pausedUntil) {
        canonNow = loadCanon(root)
        const action = computeNext(root, ctx, canonNow, cfg, { scope: admits })
        const key = action.target ?? TARGETLESS
        if (lanes.has(key) || aside.has(key)) break         // a global rung, already in hand
        let step = classifyAction(action, root, { autonomy: autonomous })
        if (step.kind === 'idle') { idle = action.line; break }
        idle = undefined
        // A stop whose settle the CLI routed to a re-run: the target's own session runs it,
        // because its scoped `next` prints the re-run (A1) — unless the re-run is a step of the
        // design session, which is the chat's (row 194).
        const rerun = action.target !== undefined ? routed.get(action.target) : undefined
        // Row 214 (D13): such a session says it takes the re-run, not the decision line it replaced.
        // Only then: `routed` keeps a target's re-run for the whole run.
        let next = action.line
        if (step.kind === 'decision' && autonomous && rerun !== undefined) {
          // Row 241 (R12): a plan step's re-run runs at its row's home (the worktree), on its model.
          step = conversationStage({ line: rerun.act.line }) ? { kind: 'conversation', line: rerun.act.line }
            : rerun.row !== undefined
              ? { kind: 'spawn', home: rerun.row.home ?? root, stage: rerun.row.stage, target: action.target, model: rerun.row.model }
              : { kind: 'spawn', home: root, target: action.target }
          next = rerun.act.line
        }
        if (step.kind !== 'spawn') { await standAside(step, action, key); continue }
        if (spawns >= ceiling) {
          stop = 'ceiling'
          ctx.out(`drive: spawn ceiling reached (${ceiling}) — ${action.line}`)
          ctx.out('help: re-run witness drive to continue, or raise --max-spawns')
          break
        }
        if (waitingNeed(action, key)) continue
        // Row 241 (R11). A human un-park restarts the target's per-run spawns and wall clock, as
        // row 207's release does: an arbiter's park sets no aside, so no take-back would. Only an
        // un-park witness journaled counts — committed by a state commit, a human's, right after a
        // park — so a line a session merely appended to the journal restarts no cap.
        if (action.target !== undefined) {
          const acts = journalActs(root, action.target)
          const es = acts.map((a) => a.entry)
          const n = acts.filter((a, i) => !/^0+$/.test(a.commit) && unparkAt(es, i)).length
          const seen = unparksSeen.get(key)
          if (seen !== undefined && n > seen) use.delete(key)
          unparksSeen.set(key, n)
        }
        // A cap outranks a stall in the report, and no session is spent past it.
        if (await capped(action, key)) continue
        if (unmoved(key, action)) continue
        spawns += 1
        holdAwake()
        pauseSince = undefined
        lanes.set(key, launch(step, action, spawns, next))
      }
      reapJob()
      beginJob()
      if (autonomous) {
        publish()
        notifyNew(owed().filter((i) => i.kind !== 'pending-txn' && !busy(i.target) && !busySeen.has(i.target)))
      }
      if (lanes.size === 0) {
        // Every wait here also wakes when a job ends (slice 3 review).
        const jobEnd = job !== undefined ? [job.run.end] : []
        if (!stop && !signalled && pausedUntil > clock.now()) {
          await Promise.race([clock.sleep(pausedUntil - clock.now()), aborted, ...jobEnd])
          continue
        }
        // Row 240. A target another process holds is work in flight, not the human's: drive polls on
        // its pause cadence — no pause, no notification — until a take or a release frees it.
        if (!stop && !signalled && busySeen.size > 0) {
          await Promise.race([clock.sleep(PAUSE_POLL_MS), aborted, ...jobEnd])
          continue
        }
        // Row 257. A job in its box, or still starting, is drive's own work: awaited on the pause cadence
        // (a start on a short one), so the round still runs meanwhile. One queued for the turn is not.
        if (job !== undefined && job.over === undefined && !signalled && !jobWaiting(job)) {
          await Promise.race([job.run.end, clock.sleep(job.run.running() ? PAUSE_POLL_MS : JOB_START_POLL_MS), aborted])
          continue
        }
        // Row 202. Not --manual: there the human is at drive's prompt, and the run ends as before.
        const forHuman = humanAsides().some((a) => !notice(a))
        if (autonomous && !stop && !signalled && forHuman && await pauseForHuman()) continue
        // Row 240. Only drive's own timers wait: it sleeps until the earliest is due.
        const due = nextDue()
        if (autonomous && !stop && !signalled && !forHuman && due !== undefined) {
          await Promise.race([clock.sleep(Math.max(0, due - clock.now())), aborted, ...jobEnd])
          continue
        }
        break
      }
      const ended = await Promise.race([
        ...[...lanes].map(([k, l]) => l.end.then((e) => ({ key: k, end: e }))),
        ...(job !== undefined ? [job.run.end.then(() => undefined)] : []),
      ])
      if (ended === undefined) continue                     // the job's shard ended: reaped at the top
      const { key, end } = ended
      settle(key, lanes.get(key)!, end)                     // a usage limit pauses every lane here
      lanes.delete(key)
      sweep()
    }

    // The run ends: a job still queued for the turn (or one a signal already stopped) is stopped
    // and its child awaited; it journals nothing.
    if (job !== undefined && job.over === undefined) {
      job.stop.abort()
      await job.run.end
    }
    reapJob()
    if (signalled !== undefined) ctx.out(`drive: stopped — signal ${signalled}`)
    else if (idle !== undefined) ctx.out(`drive: idle — ${idle}`)
    // Row 184. One report when nothing else can move, and for an autonomous run one
    // notification — a human at a TTY prompt is already watching.
    // The idle limit is no failure: the run waited on the human as long as it could.
    const stopped = signalled !== undefined ? `signal ${signalled}` : stop === 'idle-limit' ? undefined : stop
    refreshAside()
    const report = driveReport(root, ctx, cfg, start, humanAsides(), {
      autonomous, ...(stopped ? { stopped } : {}), ...(jobsOff !== undefined ? { jobsOff } : {}),
    })
    report.lines.forEach((l) => ctx.out(l))
    if (autonomous) {
      const local = loadLocalConfig(root)
      const n = notify(local.ok ? local.value.notify : undefined, 'witness drive', report.summary)
      ctx.out(n.outcome === 'sent' ? `notify: sent via ${n.command}`
        : n.outcome === 'failed' ? `notify: ${n.command} not found — set notify: in .witness/config.local.yaml`
          : `notify: none on ${process.platform} — set notify: in .witness/config.local.yaml`)
    }
    const failed = [...aside.values()].some((a) => a.kind === 'stuck' || a.kind === 'capped')
    return failed || stopped !== undefined ? EXIT.FINDINGS : EXIT.OK
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    publish(signalled !== undefined ? 'signal' : stop ?? 'done')
    releaseAwake()
  }
}

// Row 223 (#68). What `--detach` starts. With no WITNESS_BIN, this CLI's own bin.js under this
// node. On posix a WITNESS_BIN runs through `/bin/sh -c 'exec <bin> "$@"'`, so the printed pid
// is the CLI's own and no shell sits between it and a `kill`. Windows has no /bin/sh: the bin
// is split as a command line (a quoted first word may carry spaces — an install under Program
// Files) and its first word resolved like every other spawn, an npm `.cmd` shim through
// System32's cmd.exe (row 201). A bin nothing answers to is refused here, not at the spawn.
export function detachArgv(
  bin: string | undefined, args: readonly string[], env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): Result<ResolvedSpawn> {
  return selfArgv(bin, ['drive', ...args], env, platform)
}

// Row 180. `--detach`: this CLI again, as `witness drive <args>`, in the background at the
// root, appending to `.witness/drive.log` — started as `detachArgv` says (row 223). The child
// takes the drive lock itself and records its log there.
export function detachDrive(root: string, ctx: Ctx, args: readonly string[]): Result<{ pid: number; log: string }> {
  const log = join(root, DRIVE_LOG)
  mkdirSync(dirname(log), { recursive: true })
  // The log is opened without following a symlink and must be a regular file: a link
  // planted at .witness/drive.log (a committed one, say) would otherwise have every session's
  // output — text an agent wrote — appended to whatever it points at, a shell rc included.
  let fd: number
  try {
    fd = openSync(log, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644)
  } catch (e) {
    return refuse([v(DRIVE_LOG, 'drive-log-unsafe', (e as NodeJS.ErrnoException).code ?? String(e),
      'a regular file at .witness/drive.log — remove whatever is there and run this again')])
  }
  if (!fstatSync(fd).isFile()) {
    closeSync(fd)
    return refuse([v(DRIVE_LOG, 'drive-log-unsafe', 'not a regular file',
      'a regular file at .witness/drive.log — remove whatever is there and run this again')])
  }
  const how = detachArgv(ctx.env.WITNESS_BIN, args, ctx.env)
  if (!how.ok) { closeSync(fd); return how }
  const { file, args: argv, env, windowsVerbatimArguments } = how.value
  writeSync(fd, `--- witness drive ${new Date().toISOString()} ---\n`)
  try {
    const child = spawn(file, argv, {
      cwd: root, detached: true, stdio: ['ignore', fd, fd], windowsVerbatimArguments,
      env: { ...env, [DRIVE_LOG_ENV]: log, [NO_CONSOLE_ENV]: '1' } as NodeJS.ProcessEnv,
    })
    if (child.pid === undefined) return refuse([v('--detach', 'spawn-failed', file, 'a runnable witness CLI')])
    child.on('error', () => {})
    child.unref()
    // Final review: return once the child holds the drive lock (or has died, or a bound passed),
    // so a chat's `wait` started right after it never reads the drive as stopped — the previous
    // run's end record would otherwise answer for a drive that is only starting.
    const deadline = Date.now() + DETACH_LOCK_WAIT_MS
    // Any live holder is this child's (detach refuses while a drive runs); under a WITNESS_BIN
    // wrapper the lock's pid may be a process the wrapper started.
    while (Date.now() < deadline && driveHolder(root) === undefined && isAlive(child.pid)) pause(50)
    return ok({ pid: child.pid, log })
  } finally {
    closeSync(fd)
  }
}

// D143's exclusions, verbatim: an obligation-minting override (D122's ledger must not
// open on an "ok"), terminal acts, and trust grants (D154). `decide` refuses these with
// `nod-cannot` anyway — drive names the act instead of burning the round-trip. Row 239: read
// off the act's words, so a flag is one only where the act holds it as one.
function nodExcluded(act: Act): string | undefined {
  if (act.argv[0] === 'abandon') return 'witness abandon'
  return ['--override', '--stop', '--trust-cmds'].find((f) => act.argv.includes(f))
}

const AFFIRMATIONS = new Set(['y', 'yes', 'ok', 'okay', 'go'])

// Row 239 (the plan's B10). An option a human can select at `decide>`: one the CLI built from an
// act, numbered by its place in the block, so an option without one (a choose block's spec) is
// skipped and the numbers stay the ones the block printed. The first is the recommendation.
// `runnable` reads the act's inputs, never `Option.runnable`: drive runs the argv with no shell,
// so a line withheld from a paste still runs here (the plan's B4).
interface Selectable { n: number; act: Act; recommended: boolean; runnable: boolean }
const selectable = (options: readonly Option[]): Selectable[] =>
  options.flatMap((o, i) => o.act ? [{ n: i + 1, act: o.act, recommended: i === 0, runnable: o.act.inputs.length === 0 }] : [])

// The option verbs a human can name instead of a number — `approve`, `revise`, `stop`,
// `abandon`, `override`, `repair`. Ambiguity is reported, never guessed: two options can
// share a verb (a plain approve beside an approve --trust-cmds), and picking one for the
// human is authoring their decision.
function byVerb(word: string, options: Selectable[]): Selectable[] {
  return options.filter((o) => o.act.argv.includes(`--${word}`) || o.act.argv[0] === word)
}

// What drive runs, as argv, and the line it says it runs.
type Pick = { argv: readonly string[]; line: string } | { refuse: string }

// An option with an input is the human's to fill: picked by a nod, a number or its verb, it is
// refused, never run with the placeholder for its word.
function taken(o: Selectable): Pick {
  return o.runnable ? { argv: o.act.argv, line: o.act.line } : { refuse: `option ${o.n} needs an id you must fill in — type it out` }
}

function selectOption(answer: string, options: Selectable[]): Pick {
  // Typed out, and read by the grammar its words are quoted for (`shellWords`), so a note typed
  // as `'it'\''s'` or `"don't ship"` is the one word it says. POSIX quoting alone, by design: on
  // Windows a word PowerShell's quoting wrote (`'o''b'`) reads back lossily (`ob`), and the
  // measured Windows pass owns that (residual R1).
  if (answer.startsWith('witness ')) {
    const words = shellWords(answer)
    return words === undefined ? { refuse: 'its quotes do not close — type the command again' } : { argv: words.slice(1), line: answer }
  }
  if (AFFIRMATIONS.has(answer.toLowerCase())) {
    const rec = options.find((o) => o.recommended)
    if (!rec) return { refuse: 'this block carries no recommendation — name the option (D143)' }
    if (!rec.runnable) return { refuse: 'the recommended option needs an id you must fill in — type it out' }
    const excluded = nodExcluded(rec.act)
    if (excluded !== undefined) {
      return { refuse: `nod-cannot: ${excluded} is never taken on an affirmation — name the option (D143)` }
    }
    // Row 239. `--via affirmation` is decide's record that a nod chose, so only a decide act
    // carries it; any other recommended act (the recovery fork's) runs exactly as named.
    if (rec.act.argv[0] !== 'decide') return { argv: rec.act.argv, line: rec.act.line }
    return { argv: [...rec.act.argv, '--via', 'affirmation'], line: `${rec.act.line} --via affirmation` }
  }
  if (/^\d+$/.test(answer)) {
    const picked = options.find((o) => o.n === Number(answer))
    return picked === undefined ? { refuse: `no option ${answer} in this block` } : taken(picked)
  }
  const matches = byVerb(answer.toLowerCase(), options)
  if (matches.length === 1) return taken(matches[0]!)
  if (matches.length > 1) {
    return { refuse: `${answer} matches options ${matches.map((o) => o.n).join(', ')} — name the number` }
  }
  return { refuse: `not an option: ${answer} — answer with a number, an option verb, or the command itself` }
}

// How many times drive re-asks before leaving the stop standing. A human who cannot name
// an option in three tries is being asked the wrong question, and a prompt that never
// gives up is a worse treadmill than the one drive exists to end.
const ASK_LIMIT = 3

// The judgment stop, in the driver's own terminal. The screen is the one `decide --show`
// prints, from the view it prints (`shownView`), so the block a human reads here is
// byte-identical to the one they would read in a chat session — D143 is one rule across
// surfaces, not two implementations. Row 239: an answer runs the chosen option's act as argv,
// from the same view, so no printed line is parsed back to learn what to run.
//
// `executed` when the decision ran (the loop derives again), `stands` when the human left it
// standing, `refused` when the render or the chosen command refused. Exported for its test. Row 244:
// a standing hand-back is an owed decision (`decisionOwed`), so tier 2 routes its `decide --show`
// here as it routes a pending stop, and the view rendered is the handed-back one.
export async function resolveDecision(
  step: Extract<DriveStep, { kind: 'decision' }>, action: NextAction, ctx: Ctx,
): Promise<'executed' | 'stands' | 'refused'> {
  let options: readonly Option[] = []
  if (step.block !== undefined) {
    renderDecision(step.block).forEach((l) => ctx.out(l))
    options = step.block.options
  } else if (step.gate !== undefined && step.target !== undefined) {
    const view = shownView(ctx, step.gate, step.target)
    if (view === undefined) return 'refused'
    decideViewLines(view).forEach((l) => ctx.out(l))
    // Row 244: a handed-back view's block numbers its options as an actionable one's does.
    if (view.state === 'actionable' || view.state === 'handed-back') options = view.block?.options ?? []
  } else {
    ctx.out(`drive: decision — ${action.line}`)
  }
  const picks = selectable(options)
  for (let asked = 0; asked < ASK_LIMIT; asked++) {
    const answer = (await ctx.ask('decide>')).trim()
    // Empty is a human declining to decide now. One re-ask (the prompt may have scrolled
    // past the block), then the stop stands — it is not drive's to resolve.
    if (answer === '') {
      if (asked > 0) break
      ctx.out('help: answer with an option number, an option verb, or a bare y to take the recommendation — empty leaves the stop standing')
      continue
    }
    const pick = selectOption(answer, picks)
    if ('refuse' in pick) { ctx.out(`help: ${pick.refuse}`); continue }
    ctx.out(`drive: running — ${pick.line}`)
    const code = await main(ctx, [...pick.argv])
    if (code !== EXIT.OK) {
      ctx.out(`drive: decision refused — ${pick.line}`)
      return 'refused'
    }
    return 'executed'
  }
  ctx.out(`drive: decision stands — ${action.line}`)
  return 'stands'
}
