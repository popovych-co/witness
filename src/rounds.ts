import type { Entry } from './journal.js'
import type { Violation } from './refusal.js'
import type { CoverageItem, Finding } from './verdict.js'

export interface GateCheck { name: string; ok: boolean; detail?: string }
export interface ReviewerVerdict { reviewer: string; coverage: CoverageItem[]; findings: Finding[] }

export interface GateRunEntry {
  v: 1
  t: 'gate-run'
  gate: string
  artifact: string
  round: number
  run_id: string
  reviewed_sha: string
  prompts_sha: string
  specflow: string
  model: string
  calibration: 'shipped' | 'local' | 'none'
  cached?: boolean
  manual?: boolean
  fallback?: string[]
  rerolled?: string[]
  standing?: string
  artifact_sha?: string
  checks: GateCheck[]
  verdicts?: ReviewerVerdict[]
  malformed?: Array<{ reviewer: string; violations: Violation[] }>
  outcome: 'passed' | 'stopped' | 'malformed'
}

export interface DecisionEntry {
  v: 1
  t: 'human-decision'
  gate: string
  artifact: string
  round: number
  decision: 'approve' | 'revise' | 'revise-upstream' | 'stop' | 'abandon-effort'
  override?: boolean
  note?: string
  upstream?: { artifact: string; gate: string }
  caused_by?: { artifact: string; gate: string; round: number }
}

export interface GateKey {
  reviewed_sha: string
  gate: string
  prompts_sha: string
  model: string
  specflow: string
}

const isRun = (e: Entry | undefined, gate: string): e is GateRunEntry & Entry =>
  e !== undefined && e.t === 'gate-run' && (e as unknown as GateRunEntry).gate === gate
const isDecision = (e: Entry | undefined, gate: string): e is DecisionEntry & Entry =>
  e !== undefined && e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === gate

export function keyOf(run: GateRunEntry): GateKey {
  const { reviewed_sha, gate, prompts_sha, model, specflow } = run
  return { reviewed_sha, gate, prompts_sha, model, specflow }
}

export function sameKey(a: GateKey, b: GateKey): boolean {
  return a.reviewed_sha === b.reviewed_sha && a.gate === b.gate &&
    a.prompts_sha === b.prompts_sha && a.model === b.model && a.specflow === b.specflow
}

export function gateRuns(entries: Entry[], gate: string): GateRunEntry[] {
  return entries.filter((e): e is GateRunEntry & Entry => isRun(e, gate))
}

export function lastGateRun(entries: Entry[], gate: string): GateRunEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRun(entries[i], gate)) return entries[i] as unknown as GateRunEntry
  }
  return undefined
}

export const ROUND_BOUND = 3

// a "reset" opens a fresh round budget: human approve, a passed run, or a
// revise-upstream (the plan itself changes — a new plan version is a new game;
// upstream churn is bounded by the upstream gate's own bound)
function lastResetIndex(entries: Entry[], gate: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (isDecision(e, gate)) {
      const d = (e as unknown as DecisionEntry).decision
      if (d === 'approve' || d === 'revise-upstream') return i
    }
    if (isRun(e, gate) && (e as unknown as GateRunEntry).outcome === 'passed') return i
  }
  return -1
}

export function roundsSinceApprove(entries: Entry[], gate: string): number {
  const since = lastResetIndex(entries, gate)
  let n = 0
  for (let i = since + 1; i < entries.length; i++) {
    const e = entries[i]
    // malformed = the battery failed to emit a legal verdict — specflow's
    // failure, not the artifact's; it never spends the human's budget
    if (isRun(e, gate) && (e as unknown as GateRunEntry).outcome !== 'malformed') n++
  }
  return n
}

export function boundReached(entries: Entry[], gate: string): boolean {
  return roundsSinceApprove(entries, gate) >= ROUND_BOUND
}

export function pendingDecision(entries: Entry[], gate: string): GateRunEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (isDecision(e, gate)) return undefined
    if (isRun(e, gate)) {
      const run = e as unknown as GateRunEntry
      return run.outcome === 'passed' ? undefined : run
    }
  }
  return undefined
}

export type AppendKind =
  | { kind: 'resume'; entry: GateRunEntry }
  | { kind: 'changed-nothing'; entry: GateRunEntry }
  | { kind: 'cached'; from: GateRunEntry }
  | { kind: 'fresh' }

export function appendKind(entries: Entry[], gate: string, key: GateKey): AppendKind {
  let lastRunIdx = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRun(entries[i], gate)) { lastRunIdx = i; break }
  }
  if (lastRunIdx >= 0) {
    const last = entries[lastRunIdx] as unknown as GateRunEntry
    if (sameKey(keyOf(last), key)) {
      const revised = entries.slice(lastRunIdx + 1).some((e) =>
        isDecision(e, gate) &&
        ['revise', 'revise-upstream'].includes((e as unknown as DecisionEntry).decision))
      return revised ? { kind: 'changed-nothing', entry: last } : { kind: 'resume', entry: last }
    }
  }
  for (let i = lastRunIdx - 1; i >= 0; i--) {
    const e = entries[i]
    if (!isRun(e, gate)) continue
    const run = e as unknown as GateRunEntry
    if (run.outcome !== 'malformed' && run.verdicts && sameKey(keyOf(run), key)) {
      return { kind: 'cached', from: run }
    }
  }
  return { kind: 'fresh' }
}
