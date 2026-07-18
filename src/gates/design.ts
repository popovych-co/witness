import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serializeDoc } from '../fm.js'
import { designPairSha, designRel, designUnseen, elementIds, htmlSha, validateDesignArtifact } from '../design.js'
import { registerGate, type GateInput, type MetaStamp } from '../gate.js'
import { latestRecap } from '../journal.js'
import { ok, refuse, v, type Result } from '../refusal.js'
import { effortOf } from '../reviewed.js'
import type { GateCheck } from '../rounds.js'
import { findById } from '../scan.js'
import { canonicalSha, short } from '../sha.js'

registerGate({
  gate: 'design',
  targetKind: 'spec',

  async resolve(root, _ctx, canon, cfg, specId): Promise<Result<GateInput>> {
    const spec = findById(canon, specId)
    if (!spec || spec.meta.type !== 'spec') {
      return refuse([v('spec', 'unknown-spec', specId, 'a specs/ doc id')])
    }
    const effort = effortOf(root, specId)
    const recap = effort ? latestRecap(root, effort) : undefined
    const rel = designRel(cfg.paths, specId)
    const abs = join(root, rel)
    const html = existsSync(abs) ? readFileSync(abs, 'utf8') : undefined

    // Sight is a PRECONDITION of gating, not a byproduct of it. Refusing here costs no
    // reviewer call and keeps `resolve` pure — the rejected shape spawned the opener from
    // this function, which fires on the four runGate paths that write no entry (resume,
    // changed-nothing, bound, malformed-streak), producing a window the journal never
    // learns about. An agent that drops the show step now hits a loud refusal its repair
    // loop already handles, instead of silently gating something nobody was shown.
    const unseen = designUnseen(root, cfg.paths, specId)
    if (unseen !== undefined) {
      return refuse([v('design', 'design-unseen', `no sight witnessed for ${short(unseen)}`,
        `a human shown this artifact — run: specflow design ${specId} --open`)])
    }

    const checks: GateCheck[] = []
    checks.push({ name: 'ui-flag', ok: spec.meta.ui === true, detail: spec.meta.ui === true ? 'ui: true' : 'spec is not ui-flagged' })
    checks.push({ name: 'feature-class', ok: recap?.class === 'feature', detail: `effort class: ${recap?.class ?? 'none'}` })
    checks.push({ name: 'artifact', ok: html !== undefined, detail: html !== undefined ? rel : `${rel} missing — run: specflow design ${specId} --file <html>` })
    const template = html !== undefined ? validateDesignArtifact(html) : []
    checks.push({ name: 'template', ok: html !== undefined && template.length === 0,
      detail: template.length ? template.map((x) => x.rule).join(' · ') : 'self-contained, id-attributed' })

    // With no artifact, reviewer input is empty ids + the spec — the checks already
    // fail-stop; still produce a well-formed GateInput so the gate stops cleanly.
    const ids = html !== undefined ? elementIds(html) : []
    const promptBody = [
      `### Design artifact: ${rel}`, html ?? '(missing — no artifact to review)',
      `### Parent spec: ${specId}`, serializeDoc({ meta: spec.meta, body: spec.body }),
    ].join('\n\n')

    return ok<GateInput>({
      class: (recap?.class ?? 'feature') as GateInput['class'],
      reviewedSha: html !== undefined ? designPairSha(html, spec) : canonicalSha(spec.meta, spec.body),
      artifactSha: html !== undefined ? htmlSha(html) : undefined,
      reviewed: { kind: 'design', artifact: { ids }, spec: { id: specId, body: spec.body } },
      promptBody,
      checks,
      standingStop: 'design always stops — a human approves every screen (same footing as ship)',
      stamps: [],
    })
  },

  approveMeta(root, canon, cfg, specId): MetaStamp[] {
    const spec = findById(canon, specId)
    if (!spec || spec.meta.type !== 'spec') return []
    const abs = join(root, designRel(cfg.paths, specId))
    if (!existsSync(abs)) return []
    const sha = htmlSha(readFileSync(abs, 'utf8'))
    return [{
      artifact: specId,
      patch: { design: { sha, spec: canonicalSha(spec.meta, spec.body) } },
      entryType: 'design-stamp',
    }]
  },
})
