import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, main, type Ctx } from './cli.js'
import { canonPaths, loadConfig, loadLocalConfig, type Config } from './config.js'
import { withoutSession } from './context.js'
import { detectionVariables, resolveJudge } from './harness.js'
import { ok, refuse, renderRefusal, v, type Result } from './refusal.js'
import { findById, loadCanon } from './scan.js'
import { NO_CONSOLE_ENV, resolveSpawn, spawn, treeStop } from './spawn.js'
import { computeNext, conversationStage, type NextAction } from './verbs/next.js'
import { DRIVE_DEADLINE_ENV, DRIVE_ENV, DRIVE_LOG, DRIVE_LOG_ENV, TARGETLESS } from './drive-presence.js'
import { ASK_STREAM } from './ask.js'
import { KEPT_STOP_NAMES, unmetNeedLine, type KeptStop } from './autonomy.js'
import { unmetNeeds } from './needs.js'
import { capHit, parkAtCap, type TargetUse } from './caps.js'
import { effortStreams, readStream } from './journal.js'
import { movesFlow } from './progress.js'
import { sourced, type RunCommand } from './allowlist.js'
import { effortOf } from './reviewed.js'
import { pendingTxn } from './txn.js'
import {
  duration, limitIn, realClock, sessionLimit, SINGLE_WAIT_MAX_MS, TOTAL_WAIT_MAX_MS, waitFor, type Clock, type Limit,
} from './usage.js'
import { keepAwake } from './awake.js'
import { driveReport, runStart } from './drive-report.js'
import { notify } from './notify.js'
import { writeLive, type EndReason, type LiveAside } from './live.js'
import { needsYou, needsYouToken, WAIT_LABEL, type NeedYou } from './needs-you.js'

// D145. What drive does with the action `next` just derived. One step per turn of the
// loop, and the loop's whole vocabulary — spawn a session, stop for a human, hand the
// work to a conversation, report the merge, or find nothing to do.
export type DriveStep =
  | { kind: 'spawn'; home: string; stage?: string; target?: string; model?: string }
  | { kind: 'decision'; gate?: string; target?: string; block?: string[] }
  | { kind: 'conversation'; line: string }
  | { kind: 'merge'; line: string }
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
  // Both decision surfaces render `witness decide <gate> <target> …`: tier 2's pending
  // decision (`--show`) and the bound endgame (`liveExits`, which joins several decide
  // verbs with ` | `). The first two tokens after the verb are the gate and the target in
  // both, because `decide`'s own positional parser reads them the same way.
  if (line.startsWith('witness decide ')) {
    const [, , gate, target] = line.split(' ')
    return { kind: 'decision', gate, target: target ?? action.target }
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
  if (line.includes('merge PR') || (action.note?.includes('merge PR') ?? false)) {
    return { kind: 'merge', line: action.note?.includes('merge PR') ? action.note : line }
  }
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
// killed; `ms` runs from spawn to settle.
export interface SessionEnd { outcome: SpawnOutcome; code: number | null; tail: string[]; ms: number }
const TAIL_LINES = 3

// The prompt every spawned session gets. Not a plan, not a stage instruction: the same
// slash command a human types, which routes through `next` in the session's own home —
// so a child rediscovers its work from state rather than from what drive believed a
// moment ago. That is what makes a killed drive costless to re-run (north star 6).
const SESSION_PROMPT = '/witness'
// A `--manual` run's sessions arm the engine the same way: every gate they run stops.
const MANUAL_PROMPT = '/witness --manual'

// How long a SIGTERMed session gets before SIGKILL, and how long a dead session's pipes
// get to drain before drive stops waiting on the grandchildren that inherited them.
const TERM_GRACE_MS = 5_000
// The process groups of the sessions now running (F11): a second signal to drive kills them
// before drive itself goes, so nothing a session started outlives the run.
const LIVE_GROUPS = new Set<number>()
const EXIT_GRACE_MS = 2_000

// This CLI, for the child. A spawned session shells out to `witness` through
// ${WITNESS_BIN:-npx …} in every stage skill, and an unset value means the child resolves
// the PUBLISHED version while its parent runs an unpublished one — which the state floor
// then refuses (cli-behind-state). calibrate.ts:520 sets it for its worker for exactly
// this reason. An explicitly set value wins: a session that already knows its bin is
// stating a fact drive has no better answer for.
function localBin(ctx: Ctx): string {
  return ctx.env.WITNESS_BIN ?? `node ${join(dirname(fileURLToPath(import.meta.url)), 'bin.js')}`
}

// Line-buffered because a pipe's chunks split wherever the kernel felt like it: printing
// chunks would interleave two streams mid-word and prefix half a line. Every complete
// line is prefixed and forwarded as it arrives — drive is a terminal a human is watching,
// and the child's own output IS the progress report (addendum §4).
function lineSink(prefix: string, emit: (line: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let buf = ''
  return {
    push: (chunk: string) => {
      buf += chunk
      const parts = buf.split('\n')
      buf = parts.pop() ?? ''
      for (const line of parts) emit(prefix + line)
    },
    flush: () => {
      if (buf !== '') { emit(prefix + buf); buf = '' }
    },
  }
}

// How drive stops a session it started: its process group (F11), or on Windows, which has no
// groups to signal, its process tree (row 201).
export function signalSession(
  child: ReturnType<typeof spawn>, grouped: boolean, env: Record<string, string | undefined>, sig: NodeJS.Signals,
): void {
  try {
    if (grouped && child.pid !== undefined) process.kill(-child.pid, sig)
    else if (child.pid === undefined) child.kill(sig)
    else if (child.exitCode === null && child.signalCode === null) {
      // Only while it runs: Node closes the handle before it reports the exit, and from then on
      // the pid may name another process, which a tree kill would take down with its own.
      const stop = treeStop(child.pid, env)
      spawn(stop.file, stop.args, { stdio: 'ignore' }).on('error', () => {})
    }
  } catch { /* already gone */ }
}

// One headless session, in the action's home, streamed to the driver's terminal.
//
// The harness is the JUDGE ladder's answer (declared first, detection as fallback), not
// the driver's: this is a programmatic spawn like the reviewer battery and the
// calibration worker, not a statement about which CLI a human is typing at. Ambient
// detection deciding what drive spawns would make the same repo drive differently from
// two terminals.
export async function spawnSession(
  step: SpawnStep, cfg: Config, ctx: Ctx, spawnN: number, opts: { manual?: boolean; signal?: AbortSignal } = {},
): Promise<SessionEnd> {
  const t0 = Date.now()
  const end = (outcome: SpawnOutcome, code: number | null = null, tail: string[] = []): SessionEnd =>
    ({ outcome, code, tail, ms: Math.max(1, Date.now() - t0) })
  if (opts.signal?.aborted) return end('stopped')
  const hxR = resolveJudge(ctx.env, cfg.harness)
  if (!hxR.ok) { renderRefusal(hxR.violations).forEach((l) => ctx.err(l)); return end('spawn-failed') }
  const { cmd, args, env } = hxR.value.harness.worker.spawn(opts.manual ? MANUAL_PROMPT : SESSION_PROMPT, step.model)
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
    [DRIVE_DEADLINE_ENV]: String(t0 + cfg.drive.sessionTimeoutMs),
  }
  // Row 164: on Windows the agent CLI may be a `.cmd` shim, which only cmd.exe can start.
  const run = resolveSpawn(bin, args, childEnv)
  if (!run.ok) { renderRefusal(run.violations).forEach((l) => ctx.err(l)); return end('spawn-failed') }
  const prefix = `[${spawnN} ${step.stage ?? 'drive'}/${step.target ?? step.home.split('/').pop() ?? '-'}] `
  const tail: string[] = []
  const emit = (l: string) => {
    if (l.trim() !== '') { tail.push(l); if (tail.length > TAIL_LINES) tail.shift() }
    ctx.out(prefix + l)
  }
  const out = lineSink('', emit)
  const err = lineSink('', emit)
  return await new Promise<SessionEnd>((resolve) => {
    // Final review F11: its own process group, so a stop reaches the tools, shells and gates
    // the session started, not just the agent — an orphan would keep writing state after
    // drive moved on. Windows has no groups to signal: there the stop is a tree kill from the
    // shim down, because libuv's job object lets the agent under the shim break away (row 201).
    const grouped = process.platform !== 'win32'
    const child = spawn(run.value.file, run.value.args, {
      cwd: step.home,
      env: run.value.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: run.value.windowsVerbatimArguments,
      detached: grouped,
    })
    const signal = (sig: NodeJS.Signals) => signalSession(child, grouped, run.value.env, sig)
    if (grouped && child.pid !== undefined) LIVE_GROUPS.add(child.pid)
    let outcome: SpawnOutcome = 'exited'
    let code: number | null = null
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    let grace: NodeJS.Timeout | undefined
    const stop = (o: SpawnOutcome) => {
      outcome = o
      signal('SIGTERM')
      // A session that ignores SIGTERM is exactly the session the ceiling exists for.
      killTimer = setTimeout(() => signal('SIGKILL'), TERM_GRACE_MS)
    }
    const onAbort = () => stop('stopped')
    const settle = (o: SpawnOutcome) => {
      if (settled) return
      settled = true
      if (child.pid !== undefined) LIVE_GROUPS.delete(child.pid)
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(grace)
      opts.signal?.removeEventListener('abort', onAbort)
      out.flush()
      err.flush()
      child.stdout.destroy()
      child.stderr.destroy()
      resolve(end(o, code, [...tail]))
    }
    const timer = setTimeout(() => stop('timeout'), cfg.drive.sessionTimeoutMs)
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
      code = c
      // A stopped session's group goes with it: what it started dies even if the agent
      // exited on SIGTERM before its children did.
      if (outcome === 'timeout' || outcome === 'stopped') signal('SIGKILL')
      clearTimeout(killTimer)
      grace = setTimeout(() => settle(outcome), EXIT_GRACE_MS)
    })
    child.on('close', () => settle(outcome))
  })
}

export interface DriveFlags { flow?: string; maxSpawns?: number; manual?: boolean }

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
  for (const dir of [join(root, '.witness', 'journal'), join(root, p.specs), join(root, p.plans), join(root, p.designs)]) {
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
// once a human moves it; drive's own verdicts (stuck, capped) and the merge stay aside.
export type AsideKind = 'kept' | 'decision' | 'conversation' | 'merge' | 'stuck' | 'capped'
export interface Aside {
  target: string; kind: AsideKind; line: string; why: string; gate?: string; stop?: KeptStop; key0?: string
  trust?: RunCommand[]   // row 205: a trust grant's commands, each with its source
}

const STREAM_PREFIX = /^\[\d+ [^\]]*\] /
// What `mergeOwnPr` prints when it leaves the merge to a human (ship.ts), and nothing else.
const MERGE_LINE = /^ship: "?merge PR #(\d+) on GitHub when ready/

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

interface Lane { action: NextAction; end: Promise<SessionEnd>; merged?: string }

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
  let spawns = 0
  let stop: 'ceiling' | 'spawn-failed' | 'usage' | 'autonomy-off' | 'idle-limit' | undefined
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

  // Final review F2. A lane holds its whole flow: a spec and the plans written for it. The
  // plan queue's lane is keyed by the spec, and its session writes the plan and keeps working
  // on it (witness-plan gates it in the same session), so the new plan's id must not read as
  // a free target meanwhile — nor a spec while one of its plans runs. Read from the canon of
  // this fill, so a plan written a moment ago belongs to its spec's lane at once.
  let canonNow = loadCanon(root)
  const family = (t: string): string[] => {
    const doc = findById(canonNow, t)
    if (doc?.meta.type === 'plan') return [t, String(doc.meta.parent)]
    if (doc?.meta.type === 'spec') {
      return [t, ...canonNow.docs.filter((d) => d.meta.type === 'plan' && String(d.meta.parent) === t).map((d) => String(d.meta.id))]
    }
    return [t]
  }
  const admits = (t: string | undefined): boolean => {
    const k = t ?? TARGETLESS
    if (lanes.has(k) || aside.has(k) || (flags.flow !== undefined && t !== flags.flow)) return false
    if (t === undefined) return true
    const mine = family(t)
    return ![...lanes.keys()].some((l) => mine.includes(l) || family(l).includes(t))
  }
  const setAside = (key: string, a: Omit<Aside, 'target'>) => { aside.set(key, { target: key, ...a }) }
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
  const takeBack = () => {
    for (const [key, a] of aside) {
      if (a.key0 === undefined) continue
      const now = ownNext(key)
      if (!ownAnswer(key, now) || keyOf(now) === a.key0) continue
      aside.delete(key)
      pauseSince = undefined                               // a human act: the idle clock starts over
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
      const now = ownNext(key)
      if (!ownAnswer(key, now) || keyOf(now) === a.key0) continue
      if (conversationStage(now)) aside.set(key, { ...a, kind: 'conversation', line: now.line, key0: keyOf(now) })
      else if (!now.line.startsWith('witness decide ')) aside.delete(key)
    }
  }
  const stuck = (key: string, action: NextAction) => {
    ctx.out(`drive: no progress — ${action.line}`)
    ctx.out(`help: ${action.target ?? 'untargeted work'} is set aside for this run — read its stream above`)
    setAside(key, { kind: 'stuck', line: action.line, why: `no progress on ${action.line}` })
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
    if (step.kind === 'merge') {
      ctx.out(`drive: merge — ${step.line}`)
      setAside(key, { kind: 'merge', line: step.line, why: 'the merge is a human\'s' })
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
    if (r === 'refused') setAside(key, { kind: 'stuck', line: action.line, why: `decision refused on ${action.line}` })
  }

  const launch = (step: SpawnStep, action: NextAction, n: number): Lane => {
    const lane: Lane = { action, end: Promise.resolve(undefined as unknown as SessionEnd) }
    // The merge is announced by the SHIP SESSION's own output (ship.ts), not by a routing
    // row — a flow whose PR is open routes to `witness ship` forever, and only the child
    // knows it printed "merge PR". `mergeOwnPr` prints it only when it leaves the merge to a
    // human, so under autonomy this fires only where a human merges.
    // Final review F10: only the CLI's own line counts, and only for a flow with a PR — agent
    // prose that mentions a merge must never hand a human `gh pr merge` for a flow without one.
    const pr = action.target !== undefined ? findById(canonNow, action.target)?.meta.pr : undefined
    const childCtx: Ctx = {
      ...ctx,
      out: (l) => {
        const line = l.replace(STREAM_PREFIX, '')
        if (pr !== undefined && MERGE_LINE.exec(line)?.[1] === String(pr)) lane.merged = line
        ctx.out(l)
      },
    }
    lane.end = spawnSession(step, cfg, childCtx, n, { manual: flags.manual, signal: abort.signal })
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

  const settle = (key: string, lane: Lane, end: SessionEnd) => {
    if (end.outcome === 'stopped') return                // the signal's, reported once at the end
    if (limited(key, end)) return
    const u = use.get(key) ?? { spawns: 0, ms: 0 }
    use.set(key, { spawns: u.spawns + 1, ms: u.ms + end.ms })
    if (end.outcome === 'timeout') {
      ctx.out(`drive: spawn-timeout — ${lane.action.line}`)
      setAside(key, { kind: 'stuck', line: lane.action.line, why: `spawn-timeout on ${lane.action.line}` })
      return
    }
    if (end.outcome === 'spawn-failed') {
      ctx.out(`drive: spawn-failed — ${lane.action.line}`)
      stop ??= 'spawn-failed'                            // this machine can spawn nothing
      return
    }
    if (lane.merged !== undefined) {
      ctx.out(`drive: merge — ${lane.merged}`)
      setAside(key, { kind: 'merge', line: lane.merged, why: 'the merge is a human\'s' })
    }
  }

  // Row 180. Under autonomy each round starts with one settle pass over every target no
  // session holds and nothing has set aside — a running session settles its own target
  // through its gate and its scoped `next`, so each stop has exactly one settler. Whatever
  // the pass leaves for a human, drive sets aside. The pass never waits inside a reviewer
  // (F6: that wait was silent, uncounted and deaf to a signal): an arbiter refused by a usage
  // limit becomes drive's own pause, and the stop is judged again after it.
  const routed = new Map<string, string>()            // target → the re-run its settle routed
  const settlePass = async () => {
    const { settleOwed, settledLine } = await import('./settle.js')
    for (const r of await settleOwed(ctx, root, cfg, { scope: admits })) {
      const s = r.settled
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
        setAside(r.target, { kind: 'decision', line: `witness decide ${r.gate} ${r.target} --show`, why: s.why, gate: r.gate, key0: keyOf(ownNext(r.target)) })
      } else if (s.kind === 'routed') {
        routed.set(r.target, s.line.replace(/^autonomy: re-run owed — /, ''))
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
    const parked = await parkAtCap(ctx, root, action.target, hit)
    if (parked.parked) {
      ctx.out(`drive: parked — ${action.target} · ${hit.note}`)
      const gate = hit.gate ?? lastRunGate(readStream(root, action.target))
      setAside(key, { kind: 'capped', line: action.line, why: hit.note, ...(gate ? { gate } : {}) })
    } else {
      const why = `${hit.note} · ${parked.why}`
      ctx.out(`drive: capped — ${action.target} · ${why}`)
      setAside(key, { kind: 'capped', line: action.line, why })
    }
    return true
  }

  const start = runStart(root)
  let awake = keepAwake(ctx.env, process.platform, process.pid)
  let awakeHeld = true
  ctx.out(awake.command !== undefined
    ? `keep-awake: ${awake.command} — a closed lid on battery still sleeps`
    : `keep-awake: none on ${process.platform} — keep the host awake yourself`)
  // Row 182, amended by row 202: held while a session runs, released while drive waits on the
  // human — a paused drive lets the machine sleep — and taken again before the next spawn.
  const holdAwake = () => {
    if (awakeHeld) return
    awake = keepAwake(ctx.env, process.platform, process.pid)
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
    const asides: LiveAside[] = [...aside.values()].filter((a) => !notice(a)).map((a) => ({
      target: a.target, kind: a.kind, ...(a.gate !== undefined ? { gate: a.gate } : {}), ...(a.stop !== undefined ? { stop: a.stop } : {}),
    }))
    writeLive(root, { pid: process.pid, asides, ...(ended !== undefined ? { ended } : {}) })
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
  const owed = (): NeedYou[] => needsYou(root, ctx, cfg, loadCanon(root), [...aside.values()])

  // Row 202. Everything left waits on the human: say what, notify, let the machine sleep, and
  // watch for the act. A change runs a round as usual (take-back, settle pass, fill); a change
  // that releases nothing re-enters the pause silently. True to run a round, false to end.
  const idleMax = idleMaxOf(ctx.env)
  let pauseSince: number | undefined
  let pausePrinted: string | undefined
  const pauseForHuman = async (): Promise<boolean> => {
    const items = owed().filter((i) => i.notice !== true)
    const token = needsYouToken(items)
    if (token !== pausePrinted) {
      ctx.out(`drive: waiting on you — ${items.length} item(s)`)
      items.flatMap((i) => i.rows).forEach((l) => ctx.out(l))
      pausePrinted = token
    }
    notifyNew(items)
    releaseAwake()
    publish()
    pauseSince ??= clock.now()
    const signature = watchSignature(root)
    for (;;) {
      if (clock.now() - pauseSince >= idleMax) {
        ctx.out(`drive: idle limit — waited ${duration(idleMax)} on you · the run ends`)
        stop = 'idle-limit'
        return false
      }
      await Promise.race([clock.sleep(PAUSE_POLL_MS), aborted])
      if (signalled !== undefined) return false
      if (watchSignature(root) !== signature) return true
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
  try {
    for (;;) {
      stillAutonomous()
      canonNow = loadCanon(root)
      // A run that is stopping fills nothing more, so a target released now would be set aside
      // by nobody and drop out of the report; it stays where it is, and the report derives it.
      if (!stop && !signalled) takeBack()
      if (autonomous && !stop && !signalled && clock.now() >= pausedUntil) await settlePass()
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
        if (step.kind === 'decision' && autonomous && rerun !== undefined) {
          step = conversationStage({ line: rerun }) ? { kind: 'conversation', line: rerun } : { kind: 'spawn', home: root, target: action.target }
        }
        if (step.kind !== 'spawn') { await standAside(step, action, key); continue }
        if (spawns >= ceiling) {
          stop = 'ceiling'
          ctx.out(`drive: spawn ceiling reached (${ceiling}) — ${action.line}`)
          ctx.out('help: re-run witness drive to continue, or raise --max-spawns')
          break
        }
        if (waitingNeed(action, key)) continue
        // A cap outranks a stall in the report, and no session is spent past it.
        if (await capped(action, key)) continue
        if (unmoved(key, action)) continue
        spawns += 1
        holdAwake()
        pauseSince = undefined
        lanes.set(key, launch(step, action, spawns))
      }
      if (autonomous) {
        publish()
        notifyNew(owed().filter((i) => i.kind !== 'pending-txn' && !busy(i.target)))
      }
      if (lanes.size === 0) {
        if (!stop && !signalled && pausedUntil > clock.now()) {
          await Promise.race([clock.sleep(pausedUntil - clock.now()), aborted])
          continue
        }
        // Row 202. Not --manual: there the human is at drive's prompt, and the run ends as before.
        if (autonomous && !stop && !signalled && [...aside.values()].some((a) => !notice(a)) && await pauseForHuman()) continue
        break
      }
      const { key, end } = await Promise.race([...lanes].map(([k, l]) => l.end.then((e) => ({ key: k, end: e }))))
      settle(key, lanes.get(key)!, end)                     // a usage limit pauses every lane here
      lanes.delete(key)
    }

    if (signalled !== undefined) ctx.out(`drive: stopped — signal ${signalled}`)
    else if (idle !== undefined) ctx.out(`drive: idle — ${idle}`)
    // Row 184. One report when nothing else can move, and for an autonomous run one
    // notification — a human at a TTY prompt is already watching.
    // The idle limit is no failure: the run waited on the human as long as it could.
    const stopped = signalled !== undefined ? `signal ${signalled}` : stop === 'idle-limit' ? undefined : stop
    refreshAside()
    const report = driveReport(root, ctx, cfg, start, [...aside.values()], { autonomous, ...(stopped ? { stopped } : {}) })
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

// Row 180. `--detach`: this CLI again, as `witness drive <args>`, in the background at the
// root, appending to `.witness/drive.log`. With WITNESS_BIN set it runs through
// `exec <bin> "$@"`, so the printed pid is the CLI's own and no shell sits between it and a
// `kill`. The child takes the drive lock itself and records its log there.
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
  writeSync(fd, `--- witness drive ${new Date().toISOString()} ---\n`)
  const [file, argv] = ctx.env.WITNESS_BIN !== undefined
    ? ['/bin/sh', ['-c', `exec ${ctx.env.WITNESS_BIN} "$@"`, 'witness', 'drive', ...args]]
    : [process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'bin.js'), 'drive', ...args]]
  try {
    const child = spawn(file, argv as string[], {
      cwd: root, detached: true, stdio: ['ignore', fd, fd],
      env: { ...ctx.env, [DRIVE_LOG_ENV]: log, [NO_CONSOLE_ENV]: '1' } as NodeJS.ProcessEnv,
    })
    if (child.pid === undefined) return refuse([v('--detach', 'spawn-failed', file, 'a runnable witness CLI')])
    child.on('error', () => {})
    child.unref()
    return ok({ pid: child.pid, log })
  } finally {
    closeSync(fd)
  }
}

export interface BlockOption {
  n: number
  command: string
  recommended: boolean
  runnable: boolean
}

// Read back what `renderDecision` printed (recommend.ts:33): a `<n> · [recommended ·]
// <depth>[ · not runnable]` tag line, then the command indented under it. Parsed rather
// than recomputed on purpose — the human decides against the bytes on their screen, so
// the option drive runs must be the option they read, not a second derivation of it.
export function parseBlock(lines: string[]): BlockOption[] {
  const out: BlockOption[] = []
  lines.forEach((line, i) => {
    const m = /^(\d+) · (.+)$/.exec(line)
    if (!m) return
    const command = (lines[i + 1] ?? '').trim()
    if (!command.startsWith('witness ')) return
    const tags = m[2]!.split(' · ')
    out.push({
      n: Number(m[1]), command,
      recommended: tags.includes('recommended'), runnable: !tags.includes('not runnable'),
    })
  })
  return out
}

// D143's exclusions, verbatim: an obligation-minting override (D122's ledger must not
// open on an "ok"), terminal acts, and trust grants (D154). `decide` refuses these with
// `nod-cannot` anyway — drive names the act instead of burning the round-trip.
function nodExcluded(command: string): string | undefined {
  if (command.startsWith('witness abandon ')) return 'witness abandon'
  return ['--override', '--stop', '--trust-cmds'].find((f) => command.includes(f))
}

const AFFIRMATIONS = new Set(['y', 'yes', 'ok', 'okay', 'go'])

// The option verbs a human can name instead of a number — `approve`, `revise`, `stop`,
// `abandon`, `override`, `repair`. Ambiguity is reported, never guessed: two options can
// share a verb (a plain approve beside an approve --trust-cmds), and picking one for the
// human is authoring their decision.
function byVerb(word: string, options: BlockOption[]): BlockOption[] {
  return options.filter((o) => o.command.includes(`--${word}`) || o.command.startsWith(`witness ${word} `))
}

type Pick = { command: string } | { refuse: string }

function selectOption(answer: string, options: BlockOption[]): Pick {
  if (answer.startsWith('witness ')) return { command: answer }    // typed out, byte-for-byte
  if (AFFIRMATIONS.has(answer.toLowerCase())) {
    const rec = options.find((o) => o.recommended)
    if (!rec) return { refuse: 'this block carries no recommendation — name the option (D143)' }
    if (!rec.runnable) return { refuse: 'the recommended option needs an id you must fill in — type it out' }
    const excluded = nodExcluded(rec.command)
    if (excluded !== undefined) {
      return { refuse: `nod-cannot: ${excluded} is never taken on an affirmation — name the option (D143)` }
    }
    return { command: `${rec.command} --via affirmation` }
  }
  if (/^\d+$/.test(answer)) {
    const picked = options.find((o) => o.n === Number(answer))
    if (!picked) return { refuse: `no option ${answer} in this block` }
    if (!picked.runnable) return { refuse: `option ${answer} needs an id you must fill in — type it out` }
    return { command: picked.command }
  }
  const matches = byVerb(answer.toLowerCase(), options)
  if (matches.length === 1) return { command: matches[0]!.command }
  if (matches.length > 1) {
    return { refuse: `${answer} matches options ${matches.map((o) => o.n).join(', ')} — name the number` }
  }
  return { refuse: `not an option: ${answer} — answer with a number, an option verb, or the command itself` }
}

// Split a rendered command into argv, honoring the double quotes `--note "…"` arrives in.
// The block emits commands raw for exactly this reason (recommend.ts:31).
export function splitArgv(command: string): string[] {
  const argv: string[] = []
  let cur = ''
  let quoted = false
  let started = false
  for (const ch of command) {
    if (ch === '"') { quoted = !quoted; started = true; continue }
    if (ch === ' ' && !quoted) {
      if (started) { argv.push(cur); cur = ''; started = false }
      continue
    }
    cur += ch
    started = true
  }
  if (started) argv.push(cur)
  return argv
}

// How many times drive re-asks before leaving the stop standing. A human who cannot name
// an option in three tries is being asked the wrong question, and a prompt that never
// gives up is a worse treadmill than the one drive exists to end.
const ASK_LIMIT = 3

// The judgment stop, in the driver's own terminal. Rendering goes through the decide
// verb's `--show` so the block a human reads here is byte-identical to the one they would
// read in a chat session — D143 is one rule across surfaces, not two implementations.
//
// `executed` when the decision ran (the loop derives again), `stands` when the human left it
// standing, `refused` when the render or the chosen command refused.
async function resolveDecision(
  step: Extract<DriveStep, { kind: 'decision' }>, action: NextAction, ctx: Ctx,
): Promise<'executed' | 'stands' | 'refused'> {
  const rendered: string[] = []
  const echo: Ctx = {
    ...ctx,
    out: (l) => { rendered.push(l); ctx.out(l) },
    err: (l) => { rendered.push(l); ctx.err(l) },
  }
  if (step.block !== undefined) {
    step.block.forEach((l) => echo.out(l))
  } else if (step.gate !== undefined && step.target !== undefined) {
    const code = await main(echo, ['decide', step.gate, step.target, '--show'])
    if (code !== EXIT.OK) return 'refused'
  } else {
    ctx.out(`drive: decision — ${action.line}`)
  }
  const options = parseBlock(rendered)
  for (let asked = 0; asked < ASK_LIMIT; asked++) {
    const answer = (await ctx.ask('decide>')).trim()
    // Empty is a human declining to decide now. One re-ask (the prompt may have scrolled
    // past the block), then the stop stands — it is not drive's to resolve.
    if (answer === '') {
      if (asked > 0) break
      ctx.out('help: answer with an option number, an option verb, or a bare y to take the recommendation — empty leaves the stop standing')
      continue
    }
    const pick = selectOption(answer, options)
    if ('refuse' in pick) { ctx.out(`help: ${pick.refuse}`); continue }
    ctx.out(`drive: running — ${pick.command}`)
    const code = await main(ctx, splitArgv(pick.command).slice(1))
    if (code !== EXIT.OK) {
      ctx.out(`drive: decision refused — ${pick.command}`)
      return 'refused'
    }
    return 'executed'
  }
  ctx.out(`drive: decision stands — ${action.line}`)
  return 'stands'
}
