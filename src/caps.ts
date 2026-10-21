import { EXIT, type Ctx } from './cli.js'
import type { DriveCaps } from './config.js'
import type { Entry } from './journal.js'
import { fellBack, gateRuns, lastGateRun, type DecisionEntry, type GateRunEntry } from './rounds.js'
import { duration } from './usage.js'
import { gateSettled } from './verbs/next.js'

// Row 183. Hard caps park a target that will not converge (design B5). Rounds and upstream
// resets are counted from the journal, so they hold across runs; spawns and session time are
// this run's, in memory, like D145's ceiling. A cap park restarts the journal count: a
// human who un-parks the flow starts it again.
export type CapName = 'rounds' | 'upstream' | 'spawns' | 'wall-clock'
export interface TargetUse { spawns: number; ms: number }
export interface CapHit { cap: CapName; gate?: string; note: string }

const isCapPark = (e: Entry): boolean => {
  if (e.t !== 'human-decision') return false
  const d = e as unknown as DecisionEntry
  return d.selected === 'policy' && typeof d.rule === 'string' && d.rule.startsWith('cap-')
}

// First hit wins, in this order: rounds · upstream · spawns · wall clock.
export function capHit(entries: Entry[], use: TargetUse, caps: DriveCaps): CapHit | undefined {
  let lastPark = -1
  entries.forEach((e, i) => { if (isCapPark(e)) lastPark = i })
  const since = entries.slice(lastPark + 1)
  // Every budget reset is ignored: this counts the rounds a gate ran, not its window. The
  // exemptions are `roundsSinceApprove`'s — a malformed or fallen-back round spends nothing.
  const gates = [...new Set(since.filter((e) => e.t === 'gate-run').map((e) => String((e as unknown as GateRunEntry).gate)))]
  for (const gate of gates) {
    const n = gateRuns(since, gate).filter((r) => r.outcome !== 'malformed' && !fellBack(r)).length
    // a gate that converged at the cap is not capped
    if (n >= caps.rounds && !gateSettled(entries, gate)) {
      return { cap: 'rounds', gate, note: `drive cap: ${gate} ran ${n} rounds across budget resets · drive.caps.rounds ${caps.rounds}` }
    }
  }
  const upstream = since.filter((e) => e.t === 'human-decision' &&
    (e as unknown as DecisionEntry).decision === 'revise-upstream').length
  if (upstream >= caps.upstream) {
    return { cap: 'upstream', note: `drive cap: ${upstream} upstream resets · drive.caps.upstream ${caps.upstream}` }
  }
  if (use.spawns >= caps.spawns) {
    return { cap: 'spawns', note: `drive cap: ${use.spawns} session(s) this run · drive.caps.spawns ${caps.spawns}` }
  }
  if (use.ms >= caps.wallClockMs) {
    return {
      cap: 'wall-clock',
      note: `drive cap: ${duration(use.ms)} of sessions this run · drive.caps.wallClockMs ${duration(caps.wallClockMs)}`,
    }
  }
  return undefined
}

// The park goes through A1's one door with `selected: 'policy'` and the cap as its rule.
// `park` anchors it on the gate's last run even after the author moved the tree. A target
// with no gate run has nothing to park on.
export async function parkAtCap(ctx: Ctx, root: string, target: string, hit: CapHit): Promise<'parked' | 'unparkable'> {
  const { readStream } = await import('./journal.js')
  const entries = readStream(root, target)
  const anyLast = [...entries].reverse().find((e) => e.t === 'gate-run') as unknown as GateRunEntry | undefined
  const gate = hit.gate ?? anyLast?.gate
  const last = gate !== undefined ? lastGateRun(entries, gate) : undefined
  if (gate === undefined || last === undefined) return 'unparkable'
  // Loaded on A1's precedent for settle.ts: decide.ts reaches the gate registry.
  const { applyDecision } = await import('./verbs/decide.js')
  const code = await applyDecision({ ...ctx, cwd: root }, {
    gate, target, decision: 'stop', note: hit.note, selected: 'policy', rule: `cap-${hit.cap}`, park: true, runId: last.run_id,
  })
  return code === EXIT.OK ? 'parked' : 'unparkable'
}
