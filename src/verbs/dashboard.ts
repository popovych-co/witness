import { EXIT, version, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { reconcileRows } from '../drift.js'
import { primaryRoot } from '../gitio.js'
import { effortAbandoned, effortStreams, latestRecap, readStream } from '../journal.js'
import { renderRefusal } from '../refusal.js'
import { findById, loadCanon, type Canon, type CanonDoc } from '../scan.js'
import { kv, rows } from '../toon.js'
import { pendingTxn } from '../txn.js'

function tally(docs: CanonDoc[]): string {
  const counts = new Map<string, number>()
  docs.forEach((d) => counts.set(String(d.meta.status), (counts.get(String(d.meta.status)) ?? 0) + 1))
  return [...counts.entries()].sort().map(([s, n]) => `${s} ${n}`).join(' · ') || 'none'
}

function blockedRows(canon: Canon, ctx: Ctx): Array<{ doc: string; why: string }> {
  const out: Array<{ doc: string; why: string }> = []
  for (const doc of canon.docs) {
    if (doc.meta.type === 'principles') continue
    if (doc.meta.status === 'live' || doc.meta.status === 'done' || doc.meta.status === 'abandoned') continue
    const id = String(doc.meta.id)
    const depends = Array.isArray(doc.meta.depends) ? (doc.meta.depends as string[]) : []
    for (const dep of depends) {
      const target = findById(canon, dep)
      if (!target) out.push({ doc: id, why: `depends: ${dep} (missing)` })
      else if (target.meta.status !== 'live') out.push({ doc: id, why: `depends: ${dep} (${String(target.meta.status)})` })
    }
    const needs = Array.isArray(doc.meta.needs) ? (doc.meta.needs as Array<Record<string, unknown>>) : []
    for (const n of needs) {
      if (typeof n.env === 'string' && !ctx.env[n.env]) out.push({ doc: id, why: `needs: ${n.env} unset` })
      if (typeof n.manual === 'string' && n.satisfied !== true) out.push({ doc: id, why: `needs: ${n.manual} unsatisfied` })
    }
  }
  return out
}

export async function run(ctx: Ctx, _argv: string[]): Promise<number> {
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value
  const cfg = loadConfig(root)
  ctx.out(kv('specflow', `${version()} · schema: ${cfg.ok ? cfg.value.schema : '?'}`))

  const txn = pendingTxn(root)
  if (txn) ctx.out(kv('pending-txn', txn.op))

  const canon = loadCanon(root)
  const efforts = effortStreams(root).filter((slug) => !effortAbandoned(readStream(root, slug)))
  const effortRows = efforts.map((slug) => {
    const recap = latestRecap(root, slug)
    const artifacts = new Set(
      readStream(root, slug).filter((e) => e.t === 'write').map((e) => String(e.artifact)),
    )
    const kinds = [...artifacts].map((a) => findById(canon, a)?.meta.type)
    return {
      slug,
      class: recap?.class ?? '?',
      specs: kinds.filter((k) => k === 'spec' || k === 'principles').length,
      plans: kinds.filter((k) => k === 'plan').length,
      writes: artifacts,
    }
  })
  if (effortRows.length) {
    rows('efforts', ['slug', 'class', 'specs', 'plans'], effortRows as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  }
  ctx.out(kv('canon', tally(canon.docs.filter((d) => d.rel.startsWith('specs/')))))
  ctx.out(kv('plans', tally(canon.docs.filter((d) => d.rel.startsWith('plans/')))))
  const blocked = blockedRows(canon, ctx)
  if (blocked.length) rows('blocked', ['doc', 'why'], blocked as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  const reconcile = reconcileRows(root, canon)
  if (reconcile.length) {
    rows('reconcile', ['spec', 'why', 'detail'], reconcile as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  }
  if (canon.docs.some((d) => (Array.isArray(d.meta.needs) ? (d.meta.needs as Array<Record<string, unknown>>) : []).some((n) => typeof n.cmd === 'string'))) {
    ctx.out('note: cmd needs are not executed at scan — run specflow check')
  }

  const hasErrors = canon.errors.length > 0 || canon.docs.some((d) => d.violations.length > 0)
  const emptyEffort = effortRows.find((e) => e.writes.size === 0)
  const next = txn
    ? 'specflow recover --complete | --rollback'
    : hasErrors
      ? 'specflow check'
      : efforts.length === 0
        ? 'specflow recap --file <recap.json>'
        : emptyEffort
          ? `specflow write --effort ${emptyEffort.slug} --meta <m.json> --body <b.md> <spec-id>`
          : reconcile.some((r) => r.why === 'drift' || r.why === 'unconfirmed')
            ? 'specflow check --drift'
            : 'specflow check'
  ctx.out(`next: ${next}`)
  ctx.out('help: specflow check · index · diff <id> · log <id>')
  return EXIT.OK
}
