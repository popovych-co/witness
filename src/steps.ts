import type { Entry } from './journal.js'
import { v, type Violation } from './refusal.js'
import type { CanonDoc } from './scan.js'

// Row 191 §4.3. The relay lands on step boundaries, so where a plan stands is a CLI fact read
// from its stream, not the agent's inference: a criteria step closes at its witnessed red→green,
// a scaffolding step at its `step-close`. `closedAt` is the index, in the plan's stream, of the
// entry that closed the step.
export type StepKind = 'criteria' | 'scaffolding'
export interface StepState { id: string; kind: StepKind; closedAt?: number }
export type Progress = { known: true; steps: StepState[]; done: number; next?: StepState } | { known: false }

const manifest = (plan: CanonDoc): StepState[] =>
  (Array.isArray(plan.meta.steps) ? (plan.meta.steps as unknown[]) : [])
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s) => ({ id: String(s.id), kind: s.scaffolding === true ? 'scaffolding' : 'criteria' }))

// A cycle can be a plan step's only where the plan has a criteria step for it to name. A plan
// whose spec's criteria an earlier plan realized has none (an empty criteria delta), so none of
// its evidence is a step's: it owes no `--step`, and its untagged evidence hides no step's close.
const hasCriteriaStep = (plan: CanonDoc): boolean => manifest(plan).some((s) => s.kind === 'criteria')

const outcomes = (e: Entry): Array<{ ok: boolean }> => (Array.isArray(e.tests) ? (e.tests as Array<{ ok: boolean }>) : [])

// A red that passed observed nothing missing: the behavior it asserts was already there. It opens
// no cycle (Plan's call 3), it is no act of the session's, and drive counts it as no progress
// (final review I3): a session that only re-runs one has done nothing, and must not read as busy.
export const vacuousEvidence = (e: Entry): boolean => e.t === 'test-evidence' && e.vacuous === true

// Plan's call 3: a vacuous red opens no cycle. It needs a failing test, as `evidenceForDiff`'s
// `!vacuous` does. A green with no outcome at all observed nothing, so it closes nothing.
const opensCycle = (e: Entry): boolean =>
  e.t === 'test-evidence' && e.phase === 'red' && e.vacuous !== true && outcomes(e).some((t) => !t.ok)
const closesCycle = (e: Entry): boolean =>
  e.t === 'test-evidence' && e.phase === 'green' && outcomes(e).length > 0 && outcomes(e).every((t) => t.ok)

// The first passing green tagged with the step that follows a failing red tagged with it, or the
// step's first `step-close`. What is recorded for the step afterwards (a re-recorded green, a
// second cycle) changes nothing. It reads the step alone, whether or not the plan's progress is
// known: `step-close` asks it directly, since a legacy plan's untagged evidence hides its
// criteria closes but never a scaffolding one.
export function closingIndex(step: Pick<StepState, 'id' | 'kind'>, entries: Entry[]): number | undefined {
  let opened = false
  for (const [i, e] of entries.entries()) {
    if (e.step !== step.id) continue
    if (step.kind === 'scaffolding') {
      if (e.t === 'step-close') return i
    } else if (opensCycle(e)) {
      opened = true
    } else if (opened && closesCycle(e)) {
      return i
    }
  }
  return undefined
}

const isImplementGateRun = (e: Entry): boolean => e.t === 'gate-run' && e.gate === 'implement'

export function implementGated(entries: Entry[]): boolean {
  return entries.some(isImplementGateRun)
}

// Row 191 §4.3, legacy plans. Evidence naming no step before the first implement gate run comes
// from a CLI older than `--step`, and it may have closed any criteria step, so none can be
// counted. After that gate an untagged cycle is a fix round, which closes no step. On a plan with
// no criteria step there is nothing such evidence could have closed, so it leaves that plan known.
function predatesTags(plan: CanonDoc, entries: Entry[]): boolean {
  if (!hasCriteriaStep(plan)) return false
  const gate = entries.findIndex(isImplementGateRun)
  return (gate === -1 ? entries : entries.slice(0, gate))
    .some((e) => e.t === 'test-evidence' && typeof e.step !== 'string')
}

export function stepProgress(plan: CanonDoc, entries: Entry[]): Progress {
  if (predatesTags(plan, entries)) return { known: false }
  const steps = manifest(plan).map((s) => {
    const at = closingIndex(s, entries)
    return at === undefined ? s : { ...s, closedAt: at }
  })
  const next = steps.find((s) => s.closedAt === undefined)
  return { known: true, steps, done: steps.filter((s) => s.closedAt !== undefined).length, ...(next ? { next } : {}) }
}

// The step the entry at `index` closed, if it closed one: what tells a closing green from a
// re-record or a fix round.
export function closedAt(p: Progress, index: number): string | undefined {
  return p.known ? p.steps.find((s) => s.closedAt === index)?.id : undefined
}

// Whether an evidence run saw the suite. Every run executes the parent tag's whole suite, so one
// that did is the suite's state at that run, whatever step it names or none. A vacuous red saw
// nothing of this tree: the behavior it asserts was already there, or verify-red ran it against the
// base. An entry with no outcome saw nothing at all.
const sawSuite = (e: Entry): boolean => e.t === 'test-evidence' && e.vacuous !== true && outcomes(e).length > 0

// Row 191 §1–§2, D192. The red in flight, the one reading the step row, the evidence row, `next`'s
// hand-over and the verdict at a step close all share: the plan's latest run that saw the suite saw
// a failure, a red with a failing test or a green that did not pass. A passing green ends it
// whatever step it names, or none: read per step, the red the skill tags on a legacy plan, whose
// routed green names no step, stayed open for good (D191's re-review). A green that fails after a
// passing one re-opens it: read from the latest red alone, `next` routed that green while the
// verdict let the slice end (D192). Whether a red is open, whatever step it names or none (a fix
// round's, a legacy cycle's): what keeps `next` from handing over, and a step close from ending the
// slice, mid-red.
export function redInFlight(entries: Entry[]): boolean {
  const last = entries.filter(sawSuite).at(-1)
  return last !== undefined && outcomes(last).some((t) => !t.ok)
}

// The step of the red in flight: the latest genuine red's, when it names one. One red is open at a
// time, so its step is the open step. Which steps are closed is another question (closingIndex): a
// criteria step closes only at a green tagged with it after its own red.
function stepInFlight(entries: Entry[]): string | undefined {
  if (!redInFlight(entries)) return undefined
  const step = entries.filter(opensCycle).at(-1)?.step
  return typeof step === 'string' ? step : undefined
}

// A cycle is open on the step while the red in flight is its own.
export function openRed(entries: Entry[], stepId: string): boolean {
  return stepInFlight(entries) === stepId
}

// Row 191 §1–§2 (final review I1). The step of the red in flight, when it names a criteria step of
// the plan: recorded out of order ahead of an unclosed step, or re-opened on a closed one, its green
// is owed before anything else. Read whether or not the plan's progress is known. A criteria step
// alone, because `test-evidence` refuses any other a green: a red on a step an amend removed or
// turned into scaffolding routes nothing.
export function redOpenStep(plan: CanonDoc, entries: Entry[]): string | undefined {
  const step = stepInFlight(entries)
  return manifest(plan).find((s) => s.kind === 'criteria' && s.id === step)?.id
}

// The step's latest red passed: the behavior it asserts already exists, as when the
// implementation was written first, so a plain red on it can only come back vacuous again.
export function lastRedVacuous(entries: Entry[], stepId: string): boolean {
  return entries.filter((e) => e.t === 'test-evidence' && e.phase === 'red' && e.step === stepId).at(-1)?.vacuous === true
}

export function stepsLine(p: Progress): string {
  if (!p.known) return 'unknown (evidence predates step tags)'
  return `${p.done}/${p.steps.length} done${p.next ? ` · next ${p.next.id}` : ''}`
}

// `--step` names a step of this plan, of the kind the verb closes: evidence closes a criteria
// step, `step-close` a scaffolding one, and a close always names its step.
export function checkStep(plan: CanonDoc, entries: Entry[], step: string | undefined, verb: 'evidence' | 'close'): Violation[] {
  const id = String(plan.meta.id)
  const steps = manifest(plan)
  if (step === undefined) {
    if (verb === 'evidence') {
      // Plan's call 4: owed where the CLI can tell it is. Before the first implement gate every
      // cycle on a plan whose progress is known is a step's, and one forgotten flag would turn
      // that knowledge off for good. After the gate an untagged cycle is a fix round, a legacy
      // plan's evidence never named its steps, and a plan with no criteria step has no step a
      // cycle could be.
      if (!hasCriteriaStep(plan) || implementGated(entries)) return []
      const p = stepProgress(plan, entries)
      return p.known
        ? [v('--step', 'step-required', 'absent', `--step <id> — every cycle before the first implement gate is a plan step's · steps ${stepsLine(p)}`)]
        : []
    }
    const scaffolding = steps.filter((s) => s.kind === 'scaffolding').map((s) => s.id).join(' · ')
    return [v('--step', 'required', 'absent', `witness step-close ${id} --step <id> — a scaffolding step of ${id}: ${scaffolding || '(none)'}`)]
  }
  const s = steps.find((x) => x.id === step)
  if (s === undefined) return [v('--step', 'unknown-step', step, `a step of ${id}: ${steps.map((x) => x.id).join(' · ')}`)]
  if (verb === 'evidence' && s.kind === 'scaffolding') {
    return [v('--step', 'scaffolding-step', step, `witness step-close ${id} --step ${step} — a scaffolding step closes without evidence`)]
  }
  if (verb === 'close' && s.kind === 'criteria') {
    return [v('--step', 'criteria-step', step, `witness test-evidence ${id} --phase red --step ${step} — a criteria step closes at its red→green`)]
  }
  return []
}
