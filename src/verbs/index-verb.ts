import { dirname } from 'node:path'
import { EXIT, type Ctx } from '../cli.js'
import { primaryRoot } from '../gitio.js'
import { renderRefusal } from '../refusal.js'
import { loadCanon } from '../scan.js'
import { rows } from '../toon.js'

export async function run(ctx: Ctx): Promise<number> {
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const canon = loadCanon(rootRes.value)
  const specs = canon.docs.filter((d) => d.rel.startsWith(`${canon.paths.specs}/`))
  const groups = new Map<string, typeof specs>()
  for (const doc of specs) {
    const dir = dirname(doc.rel)
    if (!groups.has(dir)) groups.set(dir, [])
    groups.get(dir)!.push(doc)
  }
  for (const dir of [...groups.keys()].sort()) {
    const items = groups.get(dir)!.sort((a, b) => String(a.meta.id).localeCompare(String(b.meta.id)))
    rows(dir, ['id', 'summary', 'ui', 'status', 'depends'], items.map((d) => ({
      id: d.meta.id,
      summary: d.meta.summary ?? '',
      ui: d.meta.ui === true ? 'ui' : '',
      status: d.meta.status,
      depends: Array.isArray(d.meta.depends) ? (d.meta.depends as string[]).join(' ') : '',
    }))).forEach(ctx.out)
  }
  // Row 132. `witness read <id>` replaced the plan skill's `cat plans/…`; this replaced its
  // `ls plans/`. One table keyed by parent, because the question a planner asks is "which
  // plans has this spec already had" — a spec accumulates them over its life. Emitted only
  // when plans exist: a repo mid-decompose owes no plans, and an empty table is a row
  // every `index` run would pay for.
  const plans = canon.docs.filter((d) => d.meta.type === 'plan')
  if (plans.length > 0) {
    const byParent = plans.sort((a, b) =>
      String(a.meta.parent).localeCompare(String(b.meta.parent))
      || String(a.meta.id).localeCompare(String(b.meta.id)))
    rows('plans', ['id', 'parent', 'status'], byParent.map((d) => ({
      id: d.meta.id, parent: d.meta.parent ?? '', status: d.meta.status,
    }))).forEach(ctx.out)
  }
  ctx.out('help: witness read <id> · witness diff <id> · witness log <id>')
  return EXIT.OK
}
