import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { designGateSha, designRel, designReviewed, htmlSha, validateDesignArtifact } from '../design.js'
import { sessionMarker } from '../drive-presence.js'
import { findingRows, malformedRows, type ChangeClass } from '../gate.js'
import { primaryRoot } from '../gitio.js'
import { latestRecap } from '../journal.js'
import { renderRefusal, v } from '../refusal.js'
import { reviewOnce } from '../review.js'
import { effortOf } from '../reviewed.js'
import { findById, loadCanon } from '../scan.js'
import { short } from '../sha.js'
import { kv, rows } from '../toon.js'
import { guardTxn } from '../txn.js'

const USAGE = 'usage: witness review design <spec-id> [--file <html>]'

// Row 215. The design gate's reviewers on demand: the gate's full-review question about a look —
// the registered one, or a page not registered yet — journaling nothing, taking no lock, needing
// no sight and settling nothing. Advice, never evidence (row 48): sight stays the precondition of
// gating and approving (rows 72, 194), and a review does neither.
export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { file: { type: 'string' } } })
  if (positionals.length !== 2) { ctx.err(USAGE); return EXIT.REFUSED }
  const [gate, specId] = positionals as [string, string]
  if (gate !== 'design') {
    renderRefusal([v('gate', 'review-scope', gate,
      "design — only the design gate's reviewers run on demand: witness review design <spec-id>")]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  // A drive session's own chat never reviews; a reviewer never reaches this line (row 217's guard).
  const marker = sessionMarker(ctx.env)
  if (marker !== undefined) {
    renderRefusal([v('review', 'review-in-session', `${marker} is set`,
      "a human's chat — a session drive started never runs a review")]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach(ctx.err); return EXIT.REFUSED }
  const cfg = cfgR.value
  await import('../gates/index.js')

  const spec = findById(loadCanon(root), specId)
  if (!spec || spec.meta.type !== 'spec') {
    renderRefusal([v('spec', 'unknown-spec', specId, 'a specs/ doc id')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  if (spec.meta.ui !== true) {
    renderRefusal([v('spec', 'not-ui', specId, 'a ui-flagged spec — set ui: true at decompose to earn a design stage')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const rel = designRel(cfg.paths, specId)
  const registered = existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : undefined
  let html: string
  let path: string
  if (values.file !== undefined) {
    const abs = resolve(ctx.cwd, values.file)
    try {
      if (!statSync(abs).isFile()) {
        renderRefusal([v('--file', 'input-unreadable', `${abs} is not a regular file`, 'a readable HTML file')]).forEach(ctx.err)
        return EXIT.REFUSED
      }
      html = readFileSync(abs, 'utf8')
    } catch {
      renderRefusal([v('--file', 'input-unreadable', abs, 'a readable HTML file')]).forEach(ctx.err)
      return EXIT.REFUSED
    }
    path = abs
  } else {
    if (registered === undefined) {
      renderRefusal([v('design', 'no-design', `${specId} — ${rel} absent`,
        'a registered look — or a page: witness review design <spec-id> --file <html>')]).forEach(ctx.err)
      return EXIT.REFUSED
    }
    html = registered
    path = rel
  }
  const problems = validateDesignArtifact(html)
  if (problems.length) { renderRefusal(problems).forEach(ctx.err); return EXIT.REFUSED }

  // The gate's battery for the effort's class; no recap reads as feature, as the gate's does.
  const effort = effortOf(root, specId)
  const cls = ((effort ? latestRecap(root, effort)?.class : undefined) ?? 'feature') as ChangeClass
  const { reviewed, promptBody } = designReviewed(html, spec)
  const runR = await reviewOnce(ctx, root, cfg, 'design', specId, { cls, reviewedSha: designGateSha(html, spec), reviewed, promptBody })
  if (!runR.ok) { renderRefusal(runR.violations).forEach(ctx.err); return EXIT.REFUSED }
  const r = runR.value

  const sha = htmlSha(html)
  const blocking = r.verdicts.flatMap((rv) => rv.findings).filter((f) => f.blocking).length
  ctx.out(kv('review', `design ${specId}`))
  ctx.out(kv('look', `${path} · ${short(sha)} · ${registered !== undefined && htmlSha(registered) === sha ? 'registered' : 'not registered'}`))
  ctx.out(kv('model', r.model))
  if (r.answered) {
    ctx.out(kv('answered', `gate round ${r.answered.round} · run ${r.answered.run} — the gate judged these bytes in full under this setup; nobody was asked again`))
  } else if (r.earlier) {
    ctx.out(kv('earlier', `gate round ${r.earlier.round} judged these bytes ${r.earlier.why} — ${r.earlier.blocking} blocking`))
  }
  const findings = findingRows(r.verdicts)
  if (findings.length) rows('findings', ['reviewer', 'blocking', 'pin', 'anchor', 'claim'], findings).forEach(ctx.out)
  if (r.malformed.length) rows('malformed', ['reviewer', 'field', 'rule'], malformedRows(r.malformed)).forEach(ctx.out)
  ctx.out(kv('outcome', r.malformed.length ? 'malformed — a reviewer answered twice with an invalid verdict; run the review again'
    : blocking > 0 ? `${blocking} blocking` : 'clean'))
  ctx.out(kv('note', "a review journals nothing and decides nothing — only the gate's verdict counts"))
  return r.malformed.length || blocking > 0 ? EXIT.FINDINGS : EXIT.OK
}
