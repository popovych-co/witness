import { ok, refuse, v, type Result } from '../refusal.js'
import { serializeDoc } from '../fm.js'
import { canonicalSha, short } from '../sha.js'
import { latestRecap } from '../journal.js'
import { baseForSpec } from '../history.js'
import { findById } from '../scan.js'
import { effortOf, planPairSha } from '../reviewed.js'
import { validateDoc } from '../schemas.js'
import { registerGate, type GateInput } from '../gate.js'
import { designPending, designStamp } from '../design.js'
import type { GateCheck } from '../rounds.js'

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
        'a plan written via specflow write --effort <slug> (class is read from the effort stream)')])
    }
    const recap = latestRecap(root, effort)
    const parent = findById(canon, String(plan.meta.parent))
    if (!parent) {
      return refuse([v('parent', 'unknown-parent', String(plan.meta.parent), 'an existing canon doc')])
    }

    const checks: GateCheck[] = []
    const schemaProblems = validateDoc(plan.meta, plan.body).map((x) => `${x.field}:${x.rule}`)
    checks.push({ name: 'schema', ok: schemaProblems.length === 0, detail: schemaProblems.slice(0, 5).join(' · ') })

    const parentStatus = String(parent.meta.status)
    const parentOk = parent.meta.type === 'principles'
      ? parentStatus === 'approved'
      : parentStatus === 'approved' || parentStatus === 'live'
    checks.push({ name: 'parent-approved', ok: parentOk,
      detail: `${String(parent.meta.id)} is ${parentStatus}` })

    const parentSha = canonicalSha(parent.meta, parent.body)
    const pin = String(plan.meta['derives-from'])
    checks.push({ name: 'pin-fresh', ok: pin === parentSha,
      detail: pin === parentSha
        ? `pin ${short(parentSha)}`
        : `derives-from ${short(pin)} but parent is at ${short(parentSha)} — rewrite the plan (specflow write re-stamps the pin)` })

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

    return ok<GateInput>({
      class: ((recap?.class as GateInput['class']) ?? 'feature'),
      reviewedSha: planPairSha(plan, parent),
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
      stamps: [{ artifact: planId, to: 'approved' }],
    })
  },

  approveStamps(_root, canon, planId) {
    const doc = findById(canon, planId)
    return doc && String(doc.meta.status) === 'draft' ? [{ artifact: planId, to: 'approved' }] : []
  },
})
