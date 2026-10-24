import { createHash } from 'node:crypto'
import { writeAct } from './abandon.js'
import { effortStreams, latestRecap, readStream, type Entry } from './journal.js'
import type { CanonDoc } from './scan.js'
import { canonicalJson, canonicalSha } from './sha.js'

// Row 198. A recap's numbered decision: one settled answer that shapes at least one spec.
// Not `Decision` — recommend.ts already names its ranked option block that.
export interface RecapDecision { id: string; text: string }

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
