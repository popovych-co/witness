import { carriedDecisions, decisionsSha } from './decisions.js'
import type { CanonDoc } from './scan.js'
import { canonicalSha } from './sha.js'

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
