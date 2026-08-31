import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { resolveJudge } from './harness.js'
import { renderRefusal } from './refusal.js'
import type { NextAction } from './verbs/next.js'

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
    const timer = setTimeout(() => {
      outcome = 'timeout'
      child.kill('SIGTERM')
    }, cfg.drive.sessionTimeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => out.push(c))
    child.stderr.on('data', (c: string) => err.push(c))
    child.on('error', (e) => {
      clearTimeout(timer)
      ctx.err(`${prefix}spawn-failed: ${e.message}`)
      resolve('spawn-failed')
    })
    child.on('close', () => {
      clearTimeout(timer)
      out.flush()
      err.flush()
      resolve(outcome)
    })
  })
}
