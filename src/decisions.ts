import { createHash } from 'node:crypto'
import { writeAct } from './abandon.js'
import { effortStreams, latestRecap, readStream, type Entry, type RecapEntry } from './journal.js'
import { effortOf, effortWrites } from './reviewed.js'
import type { CanonDoc } from './scan.js'
import { canonicalJson, canonicalSha } from './sha.js'
import { kv, list, rows } from './toon.js'

// Row 198. A recap's numbered decision: one settled answer that shapes at least one spec.
// Not `Decision` — recommend.ts already names its ranked option block that.
export type RecapDecision = { id: string; text: string }

// Row 198 (Builder's call 2). What a doc carries is what the write that made its CURRENT
// content said it carries — D168's act, so this adds no second derivation. Two efforts can
// write identical content with different `carries`; the later act wins, and git is asked only
// in that rare case. An id the effort's latest recap no longer holds is history, not carried.
// A doc no journaled write made (a hand edit, an adopt) carries nothing.
export function carriedDecisions(root: string, doc: CanonDoc): { effort: string; decisions: RecapDecision[] } | undefined {
  const id = String(doc.meta.id)
  const sha = canonicalSha(doc.meta, doc.body)
  const madeIt = (e: Entry): boolean => e.t === 'write' && e.artifact === id && e.sha === sha
  const writers = effortStreams(root).filter((effort) => readStream(root, effort).some(madeIt))
  if (writers.length === 0) return undefined
  const effort = writers.length === 1 ? writers[0]! : writeAct(root, id, sha)?.effort ?? writers[0]!
  const carries = (readStream(root, effort).filter(madeIt).at(-1)?.carries ?? []) as string[]
  const decisions = (latestRecap(root, effort)?.decisions ?? []).filter((d) => carries.includes(d.id))
  return { effort, decisions }
}

// The pin a plan takes on what its parent carries — undefined for none, so a decision-free
// basis is exactly the spec sha (c2).
export function decisionsSha(decisions: readonly RecapDecision[]): string | undefined {
  if (decisions.length === 0) return undefined
  return createHash('sha256').update(canonicalJson(decisions)).digest('hex')
}

export type DecisionChange = { id: string; change: 'added' | 'changed' | 'removed'; text: string }

// Row 198. What moved in a spec's carried decisions since the base plan was derived: added,
// then changed, then removed, each by id; a removed row shows the text the plan was derived
// under. A base plan with no `decisions-from` was derived under none, so all it carries now is
// added. Undefined when the plan pinned decisions but its write journaled no texts — unknown,
// never guessed. One derivation for `witness diff` and the plan gate's delta block.
export function decisionDelta(root: string, base: { planId?: string; decisions?: string }, spec: CanonDoc): DecisionChange[] | undefined {
  const effort = base.planId === undefined ? undefined : effortOf(root, base.planId)
  const journaled = effort === undefined ? undefined : effortWrites(root, effort).get(base.planId!)?.decisions
  const before = journaled ?? (base.decisions === undefined ? [] : undefined)
  if (before === undefined) return undefined
  const now = carriedDecisions(root, spec)?.decisions ?? []
  const was = new Map(before.map((d) => [d.id, d.text]))
  const is = new Set(now.map((d) => d.id))
  const byId = (a: RecapDecision, b: RecapDecision) => a.id.localeCompare(b.id, undefined, { numeric: true })
  return [
    ...now.filter((d) => !was.has(d.id)).sort(byId).map((d) => ({ id: d.id, change: 'added' as const, text: d.text })),
    ...now.filter((d) => was.has(d.id) && was.get(d.id) !== d.text).sort(byId).map((d) => ({ id: d.id, change: 'changed' as const, text: d.text })),
    ...before.filter((d) => !is.has(d.id)).sort(byId).map((d) => ({ id: d.id, change: 'removed' as const, text: d.text })),
  ]
}

// Row 198. `witness read <spec> --decisions`: what the spec carries and the standing limits of
// the effort whose write made its content. Every row prints even when empty, so a reader can
// tell "none" from "not shown". One rendering for the verb and the plan critic's prompt.
export function decisionLines(root: string, doc: CanonDoc): string[] {
  const carried = carriedDecisions(root, doc)
  const recap = carried === undefined ? undefined : latestRecap(root, carried.effort)
  return [
    carried === undefined ? 'carried-by: none — no journaled write made this content' : kv('carried-by', carried.effort),
    ...rows('decisions', ['id', 'text'], carried?.decisions ?? []),
    ...rows('constraints', ['id', 'text'], recap?.constraints ?? []),
    ...rows('non_goals', ['id', 'text'], recap?.non_goals ?? []),
  ]
}

// `witness read <effort> --decisions`: the effort's whole latest recap — what a chore plan
// carries, since a chore writes no spec to carry it (§4.5).
export function recapLines(recap: RecapEntry): string[] {
  return [
    `effort: ${recap.effort} · ${recap.class}`,
    ...rows('goals', ['id', 'text'], recap.goals),
    ...rows('decisions', ['id', 'text'], recap.decisions ?? []),
    ...rows('constraints', ['id', 'text'], recap.constraints),
    ...rows('non_goals', ['id', 'text'], recap.non_goals),
    list('slices', recap.slices),
  ]
}

