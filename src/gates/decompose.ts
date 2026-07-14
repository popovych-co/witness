import { ok, refuse, v, type Result } from '../refusal.js'
import { serializeDoc } from '../fm.js'
import { canonicalJson, canonicalSha } from '../sha.js'
import { latestRecap, streamExists } from '../journal.js'
import { findCycle, findById, type CanonDoc } from '../scan.js'
import { effortReviewedSha, effortSpecs, effortWrites } from '../reviewed.js'
import { validateDoc } from '../schemas.js'
import { registerGate, type GateInput, type Stamp } from '../gate.js'
import type { GateCheck } from '../rounds.js'

function stampsFor(docs: CanonDoc[]): Stamp[] {
  return docs
    .filter((d) => String(d.meta.status) === 'draft')
    .map((d) => ({ artifact: String(d.meta.id), to: 'approved' }))
}

registerGate({
  gate: 'decompose',
  targetKind: 'effort',

  async resolve(root, _ctx, canon, _cfg, effort): Promise<Result<GateInput>> {
    if (!streamExists(root, effort)) {
      return refuse([v('effort', 'unknown-effort', effort, 'an effort born by specflow recap')])
    }
    const recap = latestRecap(root, effort)
    if (!recap) return refuse([v('effort', 'unknown-effort', effort, 'a stream whose first entry is a recap')])
    const writes = effortWrites(root, effort)
    const docs = effortSpecs(root, canon, effort)
    if (docs.length === 0) {
      return refuse([v('effort', 'nothing-to-gate', effort,
        `written specs — run: specflow write <id> --effort ${effort} --meta m.json --body b.md`)])
    }

    const checks: GateCheck[] = []
    const schemaProblems = docs.flatMap((d) =>
      validateDoc(d.meta, d.body).map((x) => `${String(d.meta.id)} ${x.field}:${x.rule}`))
    checks.push({ name: 'schema', ok: schemaProblems.length === 0, detail: schemaProblems.slice(0, 5).join(' · ') })

    const cycle = findCycle(canon)
    checks.push({ name: 'graph', ok: cycle === undefined, detail: cycle?.join(' → ') ?? '' })

    const goals = (recap.goals ?? []).map((g: { id: string }) => g.id)
    const covered = new Set<string>()
    const orphans: string[] = []
    for (const d of docs) {
      const covers = writes.get(String(d.meta.id))?.covers ?? []
      covers.forEach((g) => covered.add(g))
      if (covers.length === 0) orphans.push(String(d.meta.id))
    }
    const missing = goals.filter((g: string) => !covered.has(g))
    checks.push({ name: 'goal-coverage', ok: missing.length === 0,
      detail: missing.length ? `uncovered goals: ${missing.join(' ')}` : `${goals.length} goals covered` })
    checks.push({ name: 'spec-coverage', ok: orphans.length === 0,
      detail: orphans.length ? `specs covering no goal: ${orphans.join(' ')}` : 'every spec covers ≥ 1 goal' })

    const staleChildren = canon.docs
      .filter((p) => p.meta.type === 'plan' && String(p.meta.status) === 'in-progress')
      .filter((p) => docs.some((d) => String(d.meta.id) === String(p.meta.parent)))
      .filter((p) => {
        const parent = findById(canon, String(p.meta.parent))!
        return String(p.meta['derives-from']) !== canonicalSha(parent.meta, parent.body)
      })
      .map((p) => String(p.meta.id))
    checks.push({ name: 'amendment-ack', ok: staleChildren.length === 0,
      detail: staleChildren.length
        ? `amended under in-progress plans (approve = explicit ack): ${staleChildren.join(' ')}`
        : '' })

    const created = [...writes.values()].some((w) => w.created === true)
    const standingStop =
      recap.class === 'feature' ? 'feature scope approval — scope is approved as its concrete slicing'
      : recap.class === 'fix' && created
        ? 'fix created a new spec — misroute tripwire (young canon: expect new-spec stops at first)'
      : undefined

    const coverageTable = docs
      .map((d) => `${String(d.meta.id)}: covers ${(writes.get(String(d.meta.id))?.covers ?? []).join(' ') || '(none)'}`)
      .join('\n')
    const promptBody = [
      '### Confirmed scope recap (latest)', canonicalJson(recap),
      '### Goal coverage (journaled)', coverageTable,
      ...docs.flatMap((d) => [`### Spec: ${String(d.meta.id)}`, serializeDoc({ meta: d.meta, body: d.body })]),
    ].join('\n\n')

    const { sha } = effortReviewedSha(root, canon, effort)
    return ok<GateInput>({
      class: (recap.class ?? 'feature') as GateInput['class'],
      reviewedSha: sha,
      reviewed: { kind: 'docs', docs: docs.map((d) => ({ id: String(d.meta.id), body: d.body })) },
      promptBody,
      checks,
      standingStop,
      stamps: stampsFor(docs),
    })
  },

  approveStamps(root, canon, effort) {
    return stampsFor(effortSpecs(root, canon, effort))
  },
})
