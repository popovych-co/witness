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
  ctx.out('help: specflow diff <id> · specflow log <id>')
  return EXIT.OK
}
