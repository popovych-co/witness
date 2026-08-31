import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, main, type Ctx } from './cli.js'
import type { Config } from './config.js'
import { resolveJudge } from './harness.js'
import { renderRefusal } from './refusal.js'
import { loadCanon } from './scan.js'
import { computeNext, flowAction, resolveFlow, type NextAction } from './verbs/next.js'

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
export function classifyAction(action: NextAction, root: string): DriveStep {
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
  if (action.block !== undefined) {
    return { kind: 'decision', target: action.target, block: action.block }
  }
  if (isConversation(action)) return { kind: 'conversation', line }
  // The merge is GitHub's act, not witness's — a flow at `watch` has nothing left for an
  // agent to do. In practice this line arrives in the spawned ship session's OUTPUT
  // (ship.ts:277) rather than in a routing row, which is why the loop reads the child's
  // stream for it too; both readers exist because either surface can carry it.
  if (line.includes('merge PR') || (action.note?.includes('merge PR') ?? false)) {
    return { kind: 'merge', line: action.note?.includes('merge PR') ? action.note : line }
  }
  // `witness check` is computeNext's terminal answer. It carries two states that the
  // action alone cannot tell apart — nothing to route, and canon errors that stopped
  // routing early — so idle PRINTS the line rather than swallowing it: a human who sees
  // `drive: idle — witness check` runs the verb that distinguishes them. Spawning a
  // session to guess would burn a context on a diagnosis one command answers.
  if (line === 'witness check' && action.stage === undefined) return { kind: 'idle' }
  return { kind: 'spawn', home: action.home ?? root, stage: action.stage, target: action.target, model: action.model }
}

export type SpawnStep = Extract<DriveStep, { kind: 'spawn' }>
export type SpawnOutcome = 'exited' | 'timeout' | 'spawn-failed'

// The prompt every spawned session gets. Not a plan, not a stage instruction: the same
// slash command a human types, which routes through `next` in the session's own home —
// so a child rediscovers its work from state rather than from what drive believed a
// moment ago. That is what makes a killed drive costless to re-run (north star 6).
const SESSION_PROMPT = '/witness'

// How long a SIGTERMed session gets before SIGKILL, and how long a dead session's pipes
// get to drain before drive stops waiting on the grandchildren that inherited them.
const TERM_GRACE_MS = 5_000
const EXIT_GRACE_MS = 2_000

// This CLI, for the child. A spawned session shells out to `witness` through
// ${WITNESS_BIN:-npx …} in every stage skill, and an unset value means the child resolves
// the PUBLISHED version while its parent runs an unpublished one — which the state floor
// then refuses (cli-behind-state). calibrate.ts:517 sets it for its worker for exactly
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
  step: SpawnStep, cfg: Config, ctx: Ctx, spawnN: number,
): Promise<SpawnOutcome> {
  const hxR = resolveJudge(ctx.env, cfg.raw)
  if (!hxR.ok) { renderRefusal(hxR.violations).forEach((l) => ctx.err(l)); return 'spawn-failed' }
  const { cmd, args, env } = hxR.value.harness.worker.spawn(SESSION_PROMPT, step.model)
  // Test-only seam, on WITNESS_TRUST_CMDS' precedent (decide.ts): the suite points this at
  // a scripted fake that performs real CLI acts. Never documented for users — a spawn
  // binary chosen by ambient env is exactly the identity confusion row 90 removed.
  const bin = ctx.env.WITNESS_DRIVE_AGENT_BIN ?? cmd
  const prefix = `[${spawnN} ${step.stage ?? 'drive'}/${step.target ?? step.home.split('/').pop() ?? '-'}] `
  const out = lineSink(prefix, (l) => ctx.out(l))
  const err = lineSink(prefix, (l) => ctx.out(l))
  return await new Promise<SpawnOutcome>((resolve) => {
    const child = spawn(bin, args, {
      cwd: step.home,
      env: { ...ctx.env, ...env, WITNESS_BIN: localBin(ctx) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let outcome: SpawnOutcome = 'exited'
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    let grace: NodeJS.Timeout | undefined
    const settle = (o: SpawnOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(grace)
      out.flush()
      err.flush()
      child.stdout.destroy()
      child.stderr.destroy()
      resolve(o)
    }
    const timer = setTimeout(() => {
      outcome = 'timeout'
      child.kill('SIGTERM')
      // A session that ignores SIGTERM is exactly the session the ceiling exists for.
      killTimer = setTimeout(() => child.kill('SIGKILL'), TERM_GRACE_MS)
    }, cfg.drive.sessionTimeoutMs)
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
    child.on('exit', () => {
      clearTimeout(killTimer)
      grace = setTimeout(() => settle(outcome), EXIT_GRACE_MS)
    })
    child.on('close', () => settle(outcome))
  })
}

export interface DriveFlags { flow?: string; maxSpawns?: number }

// Twenty sessions per invocation, held in MEMORY and nowhere else (north star 2): a
// ceiling that persisted would be state drive must clean up, and re-running is how a
// human says "keep going". It is a runaway guard, not a budget — the no-progress check
// below is what catches the common case long before this does.
export const DEFAULT_MAX_SPAWNS = 20

// Did anything happen? Every act a session performs appends to a journal stream, so the
// total line count is the cheapest honest answer — derived, never stored, and blind to
// which stream grew, which is right: any growth anywhere means the repo moved.
function journalTotal(root: string): number {
  const dir = join(root, '.witness', 'journal')
  if (!existsSync(dir)) return 0
  let total = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue
    total += readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l !== '').length
  }
  return total
}

const STREAM_PREFIX = /^\[\d+ [^\]]*\] /

// The loop. Derive, classify, spawn, re-derive — and every turn reads the repo from disk,
// so nothing drive believed a moment ago can outlive a child that changed it.
//
// Deliberately no lazy merge-stamp here (`next` does one): drive journals nothing (§9).
// The spawned session runs `witness next` in its own home and stamps there, so a merged
// PR is observed on the very next derivation — by the CLI that owns that act.
export async function driveLoop(root: string, cfg: Config, ctx: Ctx, flags: DriveFlags): Promise<number> {
  const maxSpawns = flags.maxSpawns ?? DEFAULT_MAX_SPAWNS
  let spawns = 0
  let acted = false
  let prev: { line: string; journal: number } | undefined
  for (;;) {
    const canon = loadCanon(root)
    let action: NextAction
    if (flags.flow !== undefined) {
      const flowR = resolveFlow(canon, flags.flow)
      // `--flow` is a claim, and a false claim refuses — but only as a claim, at the door.
      // A flow that reached `done` UNDER drive is the loop succeeding: the merge stamp its
      // own child wrote is what made resolveFlow refuse, and reporting that as
      // `terminal-status` would end a completed run with a violations table.
      if (!flowR.ok) {
        if (acted && flowR.violations.some((x) => x.rule === 'terminal-status')) {
          ctx.out(`drive: flow finished — ${flags.flow}`)
          return EXIT.OK
        }
        renderRefusal(flowR.violations).forEach((l) => ctx.err(l))
        return EXIT.REFUSED
      }
      const judgeR = resolveJudge(ctx.env, cfg.raw)
      action = flowAction(root, cfg, flowR.value, judgeR.ok ? judgeR.value.harness.name : undefined)
        ?? { line: 'witness check', target: flags.flow }
    } else {
      action = computeNext(root, ctx, canon, cfg)
    }
    const step = classifyAction(action, root)
    if (step.kind === 'conversation') {
      ctx.out(`drive: conversation — ${step.line}`)
      ctx.out('help: this stage is an exchange with a human — run it in a chat session, then re-run witness drive')
      return EXIT.OK
    }
    if (step.kind === 'merge') { ctx.out(`drive: merge — ${step.line}`); return EXIT.OK }
    if (step.kind === 'idle') { ctx.out(`drive: idle — ${action.line}`); return EXIT.OK }
    const journal = journalTotal(root)
    // The convergence check, and the reason a crashed drive is safe to re-run: the same
    // action twice with nothing journalled in between means the session could not do what
    // the CLI asked. Spawning a third is how a loop burns a human's tokens all night.
    if (prev?.line === action.line && prev.journal === journal) {
      ctx.out(`drive: no progress — ${action.line}`)
      ctx.out('help: the last act left the repo where it found it — read the stream above, then act on that line yourself')
      return EXIT.FINDINGS
    }
    // A decision is an act too, and it gets the same convergence guard: a decision that
    // executes and journals nothing would otherwise re-render its own block forever.
    if (step.kind === 'decision') {
      prev = { line: action.line, journal }
      acted = true
      const settled = await resolveDecision(step, action, ctx)
      if (settled !== undefined) return settled
      continue
    }
    if (spawns >= maxSpawns) {
      ctx.out(`drive: spawn ceiling reached (${maxSpawns}) — ${action.line}`)
      ctx.out('help: re-run witness drive to continue, or raise --max-spawns')
      return EXIT.FINDINGS
    }
    prev = { line: action.line, journal }
    spawns += 1
    acted = true
    // The merge is announced by the SHIP SESSION's own output (ship.ts:277), not by a
    // routing row — a flow whose PR is open routes to `witness ship` forever, and only
    // the child knows it printed "merge PR". Sniffing the stream is what turns that into
    // a clean exit instead of a no-progress stop.
    let merged: string | undefined
    const childCtx: Ctx = {
      ...ctx,
      out: (l) => { if (l.includes('merge PR')) merged = l.replace(STREAM_PREFIX, ''); ctx.out(l) },
    }
    const outcome = await spawnSession(step, cfg, childCtx, spawns)
    if (outcome !== 'exited') {
      ctx.out(`drive: spawn-${outcome === 'timeout' ? 'timeout' : 'failed'} — ${action.line}`)
      return EXIT.FINDINGS
    }
    if (merged !== undefined) { ctx.out(`drive: merge — ${merged}`); return EXIT.OK }
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
// Returns undefined when the loop should continue (the decision executed), or the exit
// code drive should stop with.
async function resolveDecision(
  step: Extract<DriveStep, { kind: 'decision' }>, action: NextAction, ctx: Ctx,
): Promise<number | undefined> {
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
    if (code !== EXIT.OK) return EXIT.FINDINGS
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
      return EXIT.FINDINGS
    }
    return undefined
  }
  ctx.out(`drive: decision stands — ${action.line}`)
  return EXIT.OK
}
