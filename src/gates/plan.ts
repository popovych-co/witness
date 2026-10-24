import { ok, refuse, v, type Result } from '../refusal.js'
import { serializeDoc } from '../fm.js'
import { canonicalJson, canonicalSha, short } from '../sha.js'
import { contextDigest } from '../delta.js'
import { snapshotFiles } from '../snapshot.js'
import { latestRecap } from '../journal.js'
import { baseForSpec } from '../history.js'
import { findById, plannableParent, type CanonDoc } from '../scan.js'
import { effortOf, planPairSha } from '../reviewed.js'
import { validateDoc } from '../schemas.js'
import { registerGate, type GateInput } from '../gate.js'
import { designPending, designStamp } from '../design.js'
import { basisMoved, planBasis, planDecisionsTerm, specBasis } from '../basis.js'
import type { GateCheck } from '../rounds.js'

// D167. One derivation for the gate's stamp and `decide`'s: a pass approves a draft and nothing
// else. Row 95 keeps an in-flight status through a re-author, and a passing re-gate must not
// take it back — nor stamp a finished plan approved again.
const draftApproval = (plan: CanonDoc): Array<{ artifact: string; to: string }> =>
  String(plan.meta.status) === 'draft' ? [{ artifact: String(plan.meta.id), to: 'approved' }] : []

registerGate({
  gate: 'plan',
  targetKind: 'plan',

  async resolve(root, _ctx, canon, _cfg, planId): Promise<Result<GateInput>> {
    const plan = findById(canon, planId)
    if (!plan || plan.meta.type !== 'plan') {
      return refuse([v('plan', 'unknown-plan', planId, 'a plans/ doc id')])
    }
    const effort = effortOf(root, planId)
    if (!effort) {
      return refuse([v('plan', 'no-effort', planId,
        'a plan written via witness write --effort <slug> (class is read from the effort stream)')])
    }
    const recap = latestRecap(root, effort)
    const parent = findById(canon, String(plan.meta.parent))
    if (!parent) {
      return refuse([v('parent', 'unknown-parent', String(plan.meta.parent), 'an existing canon doc', 'witness index')])
    }

    const checks: GateCheck[] = []
    const schemaProblems = validateDoc(plan.meta, plan.body).map((x) => `${x.field}:${x.rule}`)
    checks.push({ name: 'schema', ok: schemaProblems.length === 0, detail: schemaProblems.slice(0, 5).join(' · ') })

    const parentStatus = String(parent.meta.status)
    const parentOk = plannableParent(parent)
    checks.push({ name: 'parent-approved', ok: parentOk,
      detail: `${String(parent.meta.id)} is ${parentStatus}` })

    // Row 198. Fresh iff neither pin moved: the parent's content, nor the decisions it carries.
    const pinned = planBasis(plan)
    const current = specBasis(root, parent)
    const parentSha = current.spec
    const moved = basisMoved(pinned, current)
    const pin7 = (x: string | undefined) => (x === undefined ? 'none' : short(x))
    const clause = {
      spec: `derives-from ${short(pinned.spec)} but parent is at ${short(current.spec)} — rewrite the plan (witness write re-stamps the pin)`,
      decisions: `decisions-from ${pin7(pinned.decisions)} but ${String(parent.meta.id)} carries decisions at ${pin7(current.decisions)} — rewrite the plan (witness write re-stamps the pins)`,
    }
    checks.push({ name: 'pin-fresh', ok: moved.length === 0,
      detail: moved.length === 0
        ? `pin ${short(parentSha)}${current.decisions !== undefined ? ` · decisions ${short(current.decisions)}` : ''}`
        : moved.map((m) => clause[m]).join(' · ') })

    if (parent.meta.ui === true) {
      const stamp = designStamp(parent)
      const planPin = plan.meta['design-from']
      const okPin = stamp !== undefined && !designPending(root, parent) && planPin === stamp.sha
      checks.push({ name: 'design-pin', ok: okPin,
        detail: okPin ? `design ${short(stamp!.sha)}`
          : !stamp ? `${String(parent.meta.id)} has no approved design — gate design first`
          : designPending(root, parent) ? `${String(parent.meta.id)} design is stale — re-approve or reconfirm`
          : `design-from ${short(String(planPin ?? 'absent'))} ≠ current design ${short(stamp.sha)}` })
    }

    const base = baseForSpec(root, canon, String(parent.meta.id), planId)
    const promptBody = [
      `### Parent spec: ${String(parent.meta.id)}`, serializeDoc({ meta: parent.meta, body: parent.body }),
      `### Delta base`, base.kind === 'empty'
        ? 'new spec — the delta is the whole spec'
        : `previous plan ${base.planId} pinned ${short(base.sha ?? '')} — the plan must realize what changed since`,
      `### Plan: ${planId}`, serializeDoc({ meta: plan.meta, body: plan.body }),
    ].join('\n\n')

    const tree = snapshotFiles(root, [{ name: `${planId}.md`, content: serializeDoc({ meta: plan.meta, body: plan.body }) }])

    return ok<GateInput>({
      class: ((recap?.class as GateInput['class']) ?? 'feature'),
      reviewedSha: planPairSha(plan, parent, planDecisionsTerm(root, plan, parent)),
      ...(tree ? { snapshot: { tree, context: contextDigest(parentSha, canonicalJson(base)) } } : {}),
      artifactSha: canonicalSha(plan.meta, plan.body),
      reviewed: {
        kind: 'docs',
        docs: [
          { id: planId, body: plan.body },
          { id: String(parent.meta.id), body: parent.body },
        ],
      },
      promptBody,
      checks,
      stamps: draftApproval(plan),
    })
  },

  currentSha(root, canon, _cfg, planId) {
    const plan = findById(canon, planId)
    const parent = plan ? findById(canon, String(plan.meta.parent)) : undefined
    return plan && parent ? planPairSha(plan, parent, planDecisionsTerm(root, plan, parent)) : undefined
  },

  upstreamOf(_root, canon, planId) {
    const plan = findById(canon, planId)
    return plan && plan.meta.type === 'plan' ? String(plan.meta.parent) : undefined
  },

  approveStamps(_root, canon, planId) {
    const doc = findById(canon, planId)
    return doc ? draftApproval(doc) : []
  },
})
