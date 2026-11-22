import { existsSync } from 'node:fs'
import { planDecisionsTerm } from './basis.js'
import type { Config } from './config.js'
import { designCurrentSha } from './design.js'
import { diffBase } from './evidence.js'
import { heldIn } from './held.js'
import { diffReviewedSha, effortReviewedSha, implementReviewedSha, planPairSha } from './reviewed.js'
import { findById, type Canon } from './scan.js'
import { worktreePath } from './worktree.js'

// D75. The sha a gate's `resolve` would report for its content as it stands now, without resolve's
// work — `decide --approve` refuses to stamp bytes no gate read, and every screen reads staleness
// against it. One definition for both readers: the gate registry's `currentSha` (gate.ts) and
// `next`'s parked rows (row 244, S2-5), which cannot import the registry, since gate.ts imports
// next.ts. `undefined` means the sha CANNOT be computed (no worktree, a missing parent, no config
// for a gate that needs one) and must never read as "moved". Row 247: a plan whose worktree holds a
// crashed verify-red's set-aside state has no sha — the plan's content is in the held ref, not the tree.
export function contentSha(root: string, canon: Canon, cfg: Config | undefined, gate: string, target: string): string | undefined {
  switch (gate) {
    case 'decompose':
      return effortReviewedSha(root, canon, target).sha
    case 'plan': {
      const plan = findById(canon, target)
      const parent = plan ? findById(canon, String(plan.meta.parent)) : undefined
      return plan && parent ? planPairSha(plan, parent, planDecisionsTerm(root, plan, parent)) : undefined
    }
    case 'design': {
      const spec = findById(canon, target)
      if (cfg === undefined || !spec || spec.meta.type !== 'spec') return undefined
      return designCurrentSha(root, cfg.paths, spec)
    }
    case 'implement':
    case 'ship': {
      const wt = worktreePath(root, target)
      const plan = findById(canon, target)
      if (cfg === undefined || !existsSync(wt) || (gate === 'implement' && !plan)) return undefined
      if (heldIn(root, target, wt)) return undefined
      const baseR = diffBase(wt, cfg)
      // An unresolvable base must not un-settle a gate or invert a screen's staleness.
      if (!baseR.ok) return undefined
      return gate === 'implement' ? implementReviewedSha(wt, baseR.value, plan!) : diffReviewedSha(wt, baseR.value)
    }
    default:
      return undefined
  }
}
