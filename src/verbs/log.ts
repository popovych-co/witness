import { EXIT, type Ctx } from '../cli.js'
import { primaryRoot } from '../gitio.js'
import { readStream, streamExists, type Entry } from '../journal.js'
import { renderRefusal, v } from '../refusal.js'
import { short } from '../sha.js'
import { rows } from '../toon.js'

function detail(e: Entry): string {
  switch (e.t) {
    case 'recap': {
      const size = (k: string) => (Array.isArray(e[k]) ? (e[k] as unknown[]).length : 0)
      return `class=${String(e.class)} goals=${size('goals')} non_goals=${size('non_goals')} slices=${size('slices')}`
    }
    case 'write': {
      const covers = Array.isArray(e.covers) && e.covers.length ? ` covers=${(e.covers as string[]).join('+')}` : ''
      return `artifact=${String(e.artifact)} sha=${short(String(e.sha))}${covers}`
    }
    case 'write-refused': {
      const pairs = Array.isArray(e.rules)
        ? (e.rules as Array<{ field: string; rule: string }>).map((r) => `${r.field}:${r.rule}`).join('+')
        : ''
      return `artifact=${String(e.artifact)} rules=${pairs}`
    }
    default: {
      const { v: _v, t: _t, ...rest } = e
      return JSON.stringify(rest).slice(0, 100)
    }
  }
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const id = argv[0]
  if (!id || id.startsWith('--')) {
    renderRefusal([v('id', 'required', String(id ?? 'absent'), 'specflow log <id> (--all/--lineage land with re-slicing)')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  if (!streamExists(rootRes.value, id)) {
    renderRefusal([v('id', 'unknown-stream', id, 'an artifact or effort with a journal stream')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const entries = readStream(rootRes.value, id)
  rows('entries', ['n', 't', 'detail'], entries.map((e, i) => ({ n: i + 1, t: e.t, detail: detail(e) })))
    .forEach(ctx.out)
  return EXIT.OK
}
