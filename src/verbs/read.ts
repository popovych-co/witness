import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { controlsBlock, designRel, elementIds } from '../design.js'
import { serializeDoc } from '../fm.js'
import { primaryRoot } from '../gitio.js'
import { renderRefusal, v } from '../refusal.js'
import { findById, loadCanon } from '../scan.js'
import { latestRecap } from '../journal.js'
import { decisionLines, recapLines } from '../decisions.js'
import { rows } from '../toon.js'

interface Anchor { anchor: string; lines: string }

// Row 132. `--outline` + `--lines` rather than `--section <anchor>`, deliberately: the
// implement skill's fat-artifact rule was *grep for the anchors, then read those offsets*
// — two moves, and deleting the worktree copy breaks both, so the verb must replace both.
// A `--section` extractor would need a hand-written tag-depth scanner over HTML with no
// parser dependency, and its failure mode is a SILENT mis-slice. Line ranges cannot
// mis-slice: at worst a range is wider or narrower than the reader wanted, and they can see
// that in what comes back.
//
// Spans, never element extents. An HTML anchor runs from its own line to the line before
// the next anchor (the last one to EOF), because knowing where `<footer id="save-bar">`
// CLOSES needs the parser this verb refuses to grow.
function htmlOutline(lines: string[]): Anchor[] {
  const hits: Array<{ id: string; line: number }> = []
  lines.forEach((l, i) => { for (const id of elementIds(l)) hits.push({ id, line: i + 1 }) })
  return hits.map((h, i) => {
    const next = hits[i + 1]?.line ?? lines.length + 1
    return { anchor: h.id, lines: `${h.line}-${Math.max(h.line, next - 1)}` }
  })
}

// Markdown headings, nesting by level: a `##` span covers its `###` children, so one range
// is the whole section a reader asked for. A `#` inside a fenced code block reads as a
// heading here — an outline that names one anchor too many costs a reader one glance, and
// the ranges it produces still slice exactly what they say.
function mdOutline(lines: string[]): Anchor[] {
  const heads: Array<{ level: number; text: string; line: number }> = []
  lines.forEach((l, i) => {
    const m = /^(#{1,6})\s+\S/.exec(l)
    if (m) heads.push({ level: m[1]!.length, text: l.trim(), line: i + 1 })
  })
  return heads.map((h, i) => {
    const closer = heads.slice(i + 1).find((x) => x.level <= h.level)
    return { anchor: h.text, lines: `${h.line}-${closer ? closer.line - 1 : lines.length}` }
  })
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { design: { type: 'boolean' }, outline: { type: 'boolean' }, lines: { type: 'string' }, decisions: { type: 'boolean' } },
  })
  const id = positionals[0]
  if (!id) { ctx.err('usage: witness read <id> [--design] [--outline] [--lines <a>-<b>] [--decisions]'); return EXIT.REFUSED }
  // Row 198. A separate mode, never mixed into the artifact's lines: those are one array behind
  // whole, outline and slice, and an extra row would shift every range `--outline` names.
  const mixed = [values.design && '--design', values.outline && '--outline', values.lines !== undefined && '--lines'].filter(Boolean)
  if (values.decisions && mixed.length > 0) {
    renderRefusal([v('--decisions', 'exclusive', mixed.join(' '),
      "witness read <id> --decisions alone — a separate mode, never mixed into the artifact's lines")]).forEach(ctx.err)
    return EXIT.REFUSED
  }

  // primaryRoot, never ctx.cwd: this verb exists BECAUSE a worktree carries no canon, so
  // reading relative to where it was typed is the exact bug it closes.
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootR.value
  const canon = loadCanon(root)
  const doc = findById(canon, id)
  // Before the unknown-id refusal: an effort slug is the one non-canon id this mode takes (§11).
  if (values.decisions) {
    if (doc?.meta.type === 'plan') {
      renderRefusal([v('id', 'not-a-spec', `${id} is a plan`, `its parent's — witness read ${String(doc.meta.parent)} --decisions`)]).forEach(ctx.err)
      return EXIT.REFUSED
    }
    const recap = doc === undefined ? latestRecap(root, id) : undefined
    if (doc === undefined && recap === undefined) {
      renderRefusal([v('id', 'unknown-id', id, 'an id from witness index — or an effort slug with --decisions')]).forEach(ctx.err)
      return EXIT.REFUSED
    }
    ;(doc !== undefined ? decisionLines(root, doc) : recapLines(recap!)).forEach(ctx.out)
    return EXIT.OK
  }
  if (!doc) {
    renderRefusal([v('id', 'unknown-id', id, 'an id from witness index')]).forEach(ctx.err)
    return EXIT.REFUSED
  }

  let text: string
  if (values.design) {
    const rel = designRel(canon.paths, id)
    const abs = join(root, rel)
    // One refusal for both causes, because the design skill reads it as one signal: no
    // artifact here yet means "new screen", and a plan id was never going to have one.
    if (doc.meta.type !== 'spec' || !existsSync(abs)) {
      renderRefusal([v('design', 'no-design', `${id} — ${rel} absent`,
        'a ui spec whose design stage has run — witness design <spec-id> --file <html>')]).forEach(ctx.err)
      return EXIT.REFUSED
    }
    text = readFileSync(abs, 'utf8')
  } else {
    text = serializeDoc({ meta: doc.meta, body: doc.body })
  }

  // ONE line array behind all three modes. Whole, outline and slice must count lines the
  // same way, or an outline range names offsets `--lines` would resolve to other content.
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  if (values.outline) {
    const outline = values.design ? htmlOutline(lines) : mdOutline(lines)
    rows('outline', ['anchor', 'lines'], outline as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
    // Row 215. A look's controls after its anchors: what each closed or hidden state holds, which
    // no picture of the page shows. Listed, never sliced — the ranges above stay the one map.
    if (values.design) controlsBlock(text).forEach(ctx.out)
    return EXIT.OK
  }

  if (values.lines !== undefined) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(values.lines)
    const from = m ? Number(m[1]) : 0
    const to = m?.[2] !== undefined ? Number(m[2]) : from
    if (!m || from < 1 || to < from) {
      renderRefusal([v('lines', 'bad-range', values.lines,
        'a 1-indexed inclusive range, low end first — e.g. --lines 12-48')]).forEach(ctx.err)
      return EXIT.REFUSED
    }
    // A start past the last line prints nothing, and silence is the one answer a caller
    // cannot act on. Name the count so the retry is computable. An end past it is fine —
    // asking for more lines than exist is not a mistake.
    if (from > lines.length) {
      renderRefusal([v('lines', 'bad-range', `${values.lines} — the artifact has ${lines.length} lines`,
        'a range that starts inside the artifact — witness read <id> --outline names them')]).forEach(ctx.err)
      return EXIT.REFUSED
    }
    ctx.out(lines.slice(from - 1, to).join('\n'))
    return EXIT.OK
  }

  ctx.out(lines.join('\n'))
  return EXIT.OK
}
