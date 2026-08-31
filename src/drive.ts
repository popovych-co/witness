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
