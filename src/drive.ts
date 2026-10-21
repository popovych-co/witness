import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, main, type Ctx } from './cli.js'
import type { Config } from './config.js'
import { resolveJudge } from './harness.js'
import { renderRefusal } from './refusal.js'
import { loadCanon } from './scan.js'
import { resolveSpawn } from './spawn.js'
import { computeNext, type NextAction } from './verbs/next.js'
import { DRIVE_ENV, TARGETLESS } from './drive-presence.js'
import { ASK_STREAM } from './ask.js'
import type { KeptStop } from './autonomy.js'
import { effortStreams, readStream } from './journal.js'
import { effortOf } from './reviewed.js'
import { pendingTxn } from './txn.js'
import { realClock, type Clock } from './usage.js'

// D145. What drive does with the action `next` just derived. One step per turn of the
// loop, and the loop's whole vocabulary — spawn a session, stop for a human, hand the
// work to a conversation, report the merge, or find nothing to do.
export type DriveStep =
  | { kind: 'spawn'; home: string; stage?: string; target?: string; model?: string }
  | { kind: 'decision'; gate?: string; target?: string; block?: string[] }
  | { kind: 'conversation'; line: string }
  | { kind: 'merge'; line: string }
  | { kind: 'idle' }

// A conversation is a stage whose product IS the exchange with a human: brainstorm has no
// artifact to author headlessly, and design authoring/showing needs eyes on a rendered
// page. Drive prints the handoff and gets out of the way rather than spawning a session
// that would talk to nobody.
function isConversation(action: NextAction): boolean {
  if (action.stage === 'brainstorm') return true
  if (action.line.startsWith('witness recap')) return true
  return action.line.startsWith('witness design ')
    && (action.line.includes('--open') || action.line.includes('--file'))
}

// The rule table is an ORDERED FIRST-MATCH list, on `recommend.ts`'s precedent: a
// misrouted action is attributable to one line here rather than to a weighting. Pure over
// the NextAction shape — no I/O — so every branch is one `expect` away.
//
// Row 180. Under autonomy nothing is a conversation: brainstorm, `witness recap` and design
// authoring run headless (A2), and A1 answers the choose block and the recovery fork with
// the policy's pick. A block that still reaches drive under a runnable line spawns, and the
// session's own `next` takes it, so no block stops an unattended run. `witness decide`
// lines stay decisions in both modes.
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
  // D121: a block is the CLI saying the human is choosing, not being told — so a runnable
  // line under a block (the recovery fork, `N ready — ranked below`) is still a stop.
  // Below the decide rule so a gate decision keeps its gate/target rather than its block.
  if (action.block !== undefined && !opts.autonomy) {
    return { kind: 'decision', target: action.target, block: action.block }
  }
  if (!opts.autonomy && isConversation(action)) return { kind: 'conversation', line }
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
  const hxR = resolveJudge(ctx.env, cfg.raw)
  if (!hxR.ok) { renderRefusal(hxR.violations).forEach((l) => ctx.err(l)); return end('spawn-failed') }
  const { cmd, args, env } = hxR.value.harness.worker.spawn(opts.manual ? MANUAL_PROMPT : SESSION_PROMPT, step.model)
  // Test-only seam, on WITNESS_TRUST_CMDS' precedent (decide.ts): the suite points this at
  // a scripted fake that performs real CLI acts. Never documented for users — a spawn
  // binary chosen by ambient env is exactly the identity confusion row 90 removed.
  const bin = ctx.env.WITNESS_DRIVE_AGENT_BIN ?? cmd
  // Row 164: on Windows the agent CLI may be a `.cmd` shim, which only cmd.exe can start.
  // Row 180: the marker is the child's target and its recursion guard in one.
  const run = resolveSpawn(bin, args, {
    ...ctx.env, ...env, WITNESS_BIN: localBin(ctx), [DRIVE_ENV]: step.target ?? TARGETLESS,
  })
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
    const child = spawn(run.value.file, run.value.args, {
      cwd: step.home,
      env: run.value.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: run.value.windowsVerbatimArguments,
    })
    let outcome: SpawnOutcome = 'exited'
    let code: number | null = null
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    let grace: NodeJS.Timeout | undefined
    const stop = (o: SpawnOutcome) => {
      outcome = o
      child.kill('SIGTERM')
      // A session that ignores SIGTERM is exactly the session the ceiling exists for.
      killTimer = setTimeout(() => child.kill('SIGKILL'), TERM_GRACE_MS)
    }
    const onAbort = () => stop('stopped')
    const settle = (o: SpawnOutcome) => {
      if (settled) return
      settled = true
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

// Row 180. A target drive stops working on for the rest of the run — none of these ends
// the run. Held in memory and never journaled (D145): the report reads them at the end.
export type AsideKind = 'kept' | 'decision' | 'conversation' | 'merge' | 'stuck' | 'capped'
export interface Aside { target: string; kind: AsideKind; line: string; why: string; gate?: string; stop?: KeptStop }

const STREAM_PREFIX = /^\[\d+ [^\]]*\] /

const streamLines = (root: string, id: string): number => readStream(root, id).length

// Row 181. Did anything happen for THIS target? A whole-journal count is satisfied by any
// other lane's progress, so a stalled flow beside a busy one would spawn until the ceiling.
// A target's key is its line, its stream and its owning effort's stream; target-less work
// (brainstorm, the recovery fork) keys on the effort count and the asks stream, because a
// rejected recap check grows the asks and an accepted one births an effort.
function progressKey(root: string, action: NextAction): string {
  if (action.target === undefined) {
    return [action.line, effortStreams(root).length, streamLines(root, ASK_STREAM)].join('\u0000')
  }
  const effort = effortOf(root, action.target)
  return [action.line, streamLines(root, action.target), effort ? streamLines(root, effort) : 0].join('\u0000')
}

interface Lane { action: NextAction; end: Promise<SessionEnd>; merged?: string }

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
  let spawns = 0
  let stop: 'ceiling' | 'spawn-failed' | undefined
  let idle: string | undefined
  const pausedUntil = 0

  const admits = (t: string | undefined): boolean => {
    const k = t ?? TARGETLESS
    return !lanes.has(k) && !aside.has(k) && (flags.flow === undefined || t === flags.flow)
  }
  const setAside = (key: string, a: Omit<Aside, 'target'>) => { aside.set(key, { target: key, ...a }) }
  const stuck = (key: string, action: NextAction) => {
    ctx.out(`drive: no progress — ${action.line}`)
    ctx.out(`help: ${action.target ?? 'untargeted work'} is set aside for this run — read its stream above`)
    setAside(key, { kind: 'stuck', line: action.line, why: `no progress on ${action.line}` })
  }
  // A decision is an act too, and it gets the same convergence guard as a spawn: a decision
  // that executes and journals nothing would otherwise re-render its own block forever.
  const unmoved = (key: string, action: NextAction): boolean => {
    const pk = progressKey(root, action)
    if (pendingTxn(root) === undefined && progress.get(key) === pk) { stuck(key, action); return true }
    progress.set(key, pk)
    return false
  }

  const standAside = async (step: Exclude<DriveStep, { kind: 'spawn' | 'idle' }>, action: NextAction, key: string) => {
    if (step.kind === 'conversation') {
      ctx.out(`drive: conversation — ${step.line}`)
      ctx.out('help: this stage is an exchange with a human — run it in a chat session, then re-run witness drive')
      setAside(key, { kind: 'conversation', line: step.line, why: 'an exchange with a human' })
      return
    }
    if (step.kind === 'merge') {
      ctx.out(`drive: merge — ${step.line}`)
      setAside(key, { kind: 'merge', line: step.line, why: 'the merge is a human\'s' })
      return
    }
    // Task 9 settles an autonomous decision in front of the fill. Until then it waits.
    if (autonomous) {
      setAside(key, { kind: 'decision', line: action.line, why: action.line, ...(step.gate ? { gate: step.gate } : {}) })
      return
    }
    if (unmoved(key, action)) return
    const r = await resolveDecision(step, action, ctx)
    if (r === 'stands') setAside(key, { kind: 'decision', line: action.line, why: action.line, ...(step.gate ? { gate: step.gate } : {}) })
    if (r === 'refused') setAside(key, { kind: 'stuck', line: action.line, why: `decision refused on ${action.line}` })
  }

  const launch = (step: SpawnStep, action: NextAction, n: number): Lane => {
    const lane: Lane = { action, end: Promise.resolve(undefined as unknown as SessionEnd) }
    // The merge is announced by the SHIP SESSION's own output (ship.ts), not by a routing
    // row — a flow whose PR is open routes to `witness ship` forever, and only the child
    // knows it printed "merge PR". `mergeOwnPr` prints it only when it leaves the merge to a
    // human, so under autonomy this fires only where a human merges.
    const childCtx: Ctx = {
      ...ctx,
      out: (l) => { if (l.includes('merge PR')) lane.merged = l.replace(STREAM_PREFIX, ''); ctx.out(l) },
    }
    lane.end = spawnSession(step, cfg, childCtx, n, { manual: flags.manual })
    return lane
  }

  const settle = (key: string, lane: Lane, end: SessionEnd) => {
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

  for (;;) {
    // Task 9's settle pass runs here under autonomy: A1's settleOwed over what `admits` covers
    while (!stop && lanes.size < parallel && clock.now() >= pausedUntil) {
      const action = computeNext(root, ctx, loadCanon(root), cfg, { scope: admits })
      const key = action.target ?? TARGETLESS
      if (lanes.has(key) || aside.has(key)) break         // a global rung, already in hand
      const step = classifyAction(action, root, { autonomy: autonomous })
      if (step.kind === 'idle') { idle = action.line; break }
      idle = undefined
      if (step.kind !== 'spawn') { await standAside(step, action, key); continue }
      if (spawns >= ceiling) {
        stop = 'ceiling'
        ctx.out(`drive: spawn ceiling reached (${ceiling}) — ${action.line}`)
        ctx.out('help: re-run witness drive to continue, or raise --max-spawns')
        break
      }
      // Task 9's waiting-need check, then Task 10's caps, go here: a cap outranks a stall in the report
      if (unmoved(key, action)) continue
      spawns += 1
      lanes.set(key, launch(step, action, spawns))
    }
    if (lanes.size === 0) {
      if (!stop && pausedUntil > clock.now()) { await clock.sleep(pausedUntil - clock.now()); continue }
      break
    }
    const { key, end } = await Promise.race([...lanes].map(([k, l]) => l.end.then((e) => ({ key: k, end: e }))))
    settle(key, lanes.get(key)!, end)                     // Task 11 reads limits here
    lanes.delete(key)
  }

  if (idle !== undefined) ctx.out(`drive: idle — ${idle}`)
  const failed = [...aside.values()].some((a) => a.kind === 'stuck' || a.kind === 'capped')
  return failed || stop !== undefined ? EXIT.FINDINGS : EXIT.OK
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
