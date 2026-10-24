import { createHash } from 'node:crypto'
import { carriedDecisions, decisionsSha } from './decisions.js'
import { latestRecap } from './journal.js'
import { effortOf } from './reviewed.js'
import type { CanonDoc } from './scan.js'
import { canonicalJson, canonicalSha } from './sha.js'

// Row 198. What a plan derives from: its parent's content and the decisions that content
// carries. Two pins, not one hashed value — `derives-from` stays the content sha because six
// readers resolve it in git history (Builder's call 1). Every pin comparer reads this one basis.
export interface Basis { spec: string; decisions?: string }

export function specBasis(root: string, doc: CanonDoc): Basis {
  const decisions = decisionsSha(carriedDecisions(root, doc)?.decisions ?? [])
  return { spec: canonicalSha(doc.meta, doc.body), ...(decisions !== undefined ? { decisions } : {}) }
}

export function planBasis(plan: CanonDoc): Basis {
  const decisions = plan.meta['decisions-from']
  return { spec: String(plan.meta['derives-from']), ...(typeof decisions === 'string' ? { decisions } : {}) }
}

// The terms that moved, spec first; [] is fresh. An absent pin equals an absent current term.
export function basisMoved(pinned: Basis, current: Basis): Array<'spec' | 'decisions'> {
  const moved: Array<'spec' | 'decisions'> = []
  if (pinned.spec !== current.spec) moved.push('spec')
  if (pinned.decisions !== current.decisions) moved.push('decisions')
  return moved
}

// The decisions term of a plan's reviewed identity (Builder's call 6): what its parent carries,
// and for a chore plan its chore's own decisions too, which the critic also reads. Never a pin —
// a chore's decisions in `decisions-from` would re-queue the parent spec forever (call 4).
// Undefined when neither carries any, so the identity's bytes are today's (c2).
export function planDecisionsTerm(root: string, plan: CanonDoc, parent: CanonDoc): string | undefined {
  const carried = carriedDecisions(root, parent)?.decisions ?? []
  const effort = effortOf(root, String(plan.meta.id))
  const recap = effort === undefined ? undefined : latestRecap(root, effort)
  const chore = recap?.class === 'chore' ? recap.decisions ?? [] : []
  if (chore.length === 0) return decisionsSha(carried)
  return createHash('sha256').update(canonicalJson({ parent: carried, chore })).digest('hex')
}

