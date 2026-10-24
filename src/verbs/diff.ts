import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXIT, type Ctx } from '../cli.js'
import { serializeDoc } from '../fm.js'
import { primaryRoot, tryGit } from '../gitio.js'
import { baseForSpec, contentAtSha } from '../history.js'
import { basisMoved, specBasis } from '../basis.js'
import { carriedDecisions, decisionDelta } from '../decisions.js'
import { renderRefusal, v } from '../refusal.js'
import { findById, loadCanon } from '../scan.js'
import { canonicalSha, short, VOLATILE_FIELDS } from '../sha.js'
import { kv, rows } from '../toon.js'

function canonicalRender(meta: Record<string, unknown>, body: string): string {
  const kept = Object.fromEntries(
    Object.entries(meta).filter(([k]) => !(VOLATILE_FIELDS as readonly string[]).includes(k)),
  )
  return serializeDoc({ meta: kept, body })
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const id = argv[0]
  if (!id) {
    renderRefusal([v('id', 'required', 'absent', 'witness diff <spec-id>')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value
  const canon = loadCanon(root)
  const spec = findById(canon, id)
  if (!spec || spec.meta.type !== 'spec') {
    renderRefusal([v('id', 'unknown-spec', id, 'a spec id from witness index')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const current = canonicalSha(spec.meta, spec.body)
  const base = baseForSpec(root, canon, id)
  if (base.kind === 'empty') {
    ctx.out(kv('base', 'empty (never realized)'))
    ctx.out(kv('sha', short(current)))
    ctx.out('delta: full content is the delta — new spec')
    const carried = carriedDecisions(root, spec)?.decisions.length ?? 0
    if (carried > 0) ctx.out(`decisions: ${carried} carried — all are the delta · witness read ${id} --decisions`)
    return EXIT.OK
  }
  ctx.out(kv('base', `plan-pin ${base.planId} @ ${short(base.sha!)}`))
  // Row 198. The delta is against the base plan's whole basis: its content pin and the
  // decisions the spec carried when it was derived.
  const moved = basisMoved({ spec: base.sha!, ...(base.decisions ? { decisions: base.decisions } : {}) }, specBasis(root, spec))
  if (moved.length === 0) {
    ctx.out('delta: none — no delta since the last plan')
    return EXIT.OK
  }
  const decisionsBlock = (): void => {
    if (!moved.includes('decisions')) return
    const delta = decisionDelta(root, base, spec)
    if (delta === undefined) {
      ctx.out(`decisions: moved since ${base.planId} — witness read ${id} --decisions`)
      return
    }
    ctx.out(`decisions: moved since ${base.planId}`)
    rows('decisions-delta', ['id', 'change', 'text'], delta).forEach(ctx.out)
  }
  if (!moved.includes('spec')) {
    ctx.out('delta: decisions only — the spec content is unchanged since the last plan')
    decisionsBlock()
    return EXIT.OK
  }
  const baseDoc = contentAtSha(root, spec.rel, base.sha!)
  if (!baseDoc) {
    rows('findings', ['field', 'rule', 'detail'], [
      { field: spec.rel, rule: 'pin-unresolvable', detail: `no committed version of ${id} hashes to ${short(base.sha!)}` },
    ]).forEach(ctx.out)
    return EXIT.FINDINGS
  }
  const tmp = mkdtempSync(join(tmpdir(), 'witness-diff-'))
  writeFileSync(join(tmp, 'base.md'), canonicalRender(baseDoc.meta, baseDoc.body))
  writeFileSync(join(tmp, 'current.md'), canonicalRender(spec.meta, spec.body))
  const diff = tryGit(root, 'diff', '--no-index', '--', join(tmp, 'base.md'), join(tmp, 'current.md'))
  ctx.out(diff.out)
  decisionsBlock()
  return EXIT.OK
}
