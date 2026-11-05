import { join } from 'node:path'
import { cliAct } from '../act.js'
import { adoptedCommitsFor, lastWitnessed, positionOf, untrailedCommitsFor } from '../adopt.js'
import { EXIT, type Ctx } from '../cli.js'
import { canonPaths } from '../config.js'
import { runCriteria, type CriterionOutcome } from '../criteria.js'
import { clearDrift, stampDrift } from '../drift.js'
import { readDoc } from '../fm.js'
import { dirtyStatePaths, primaryRoot, stateCommit } from '../gitio.js'
import { appendEntry, entryLine, journalRel } from '../journal.js'
import { acquireLock } from '../lock.js'
import { renderRefusal, v, type Violation } from '../refusal.js'
import { idRetired, pathRetired } from '../departure.js'
import { findById, findCycle, loadCanon } from '../scan.js'
import { validateDoc } from '../schemas.js'
import { canonicalJson, canonicalSha, short, VOLATILE_FIELDS } from '../sha.js'
import { kv, shellLine } from '../toon.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const [rel] = argv.filter((a) => !a.startsWith('--'))
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value
  const paths = canonPaths(root)
  if (!rel || !(rel.startsWith(`${paths.specs}/`) || rel.startsWith(`${paths.plans}/`)) || !rel.endsWith('.md')) {
    renderRefusal([v('path', 'usage', String(rel ?? ''), `witness adopt <${paths.specs}/... | ${paths.plans}/...>.md`)]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked

  const raw = readDoc(join(root, rel))
  if (!raw.ok) { renderRefusal(raw.violations).forEach(ctx.err); return EXIT.REFUSED }
  const { meta, body } = raw.value
  const violations = validateDoc(meta, body)
  const canon = loadCanon(root)
  const id = String(meta.id)
  if (canon.docs.filter((d) => String(d.meta.id) === id).length > 1) {
    violations.push(v('id', 'duplicate-id', id, 'one doc per id'))
  }
  // D166. Adopt runs the checks write runs: a hand-made doc may not take a retired id either.
  const taken = idRetired(root, id, String(meta.type))
  if (taken) violations.push(taken)
  // D167. Nor land on a path another id was last witnessed at — the same check `write` runs on a
  // create. A doc witnessed where it sits passes on its own id, so any amendment stays adoptable.
  const retired = pathRetired(root, canon, rel, id)
  if (retired) violations.push(retired)
  for (const dep of Array.isArray(meta.depends) ? (meta.depends as string[]) : []) {
    if (!findById(canon, dep)) violations.push(v('depends', 'unknown-dep', dep, 'an existing doc id'))
  }
  const cycle = findCycle(canon)
  if (cycle) violations.push(v('depends', 'cycle', cycle.join(' -> '), 'an acyclic graph'))
  violations.push(...positionMoves(root, rel, id, meta))
  if (violations.length) {
    renderRefusal(violations).forEach(ctx.err)
    // Row 239. `rel` is the caller's argument, a repo file name a commit chose: the revert is
    // another tool's command, through the one renderer.
    ctx.err(`help: fix the file and re-run, or revert instead: ${shellLine(['git', 'checkout', 'HEAD', '--', rel])}`)
    return EXIT.REFUSED
  }

  const witnessed = lastWitnessed(root, rel)
  const currentSha = canonicalSha(meta, body)
  const changed = witnessed?.sha !== currentSha
  const criteriaChanged = JSON.stringify(meta.criteria ?? null) !== JSON.stringify(witnessed?.criteria ?? null)
  const absolved = adoptedCommitsFor(root, id)   // final review F1: absolved for this doc, not any
  const commits = untrailedCommitsFor(root, rel).filter((sha) => !absolved.has(sha))
  const dirty = dirtyStatePaths(root).includes(rel)
  if (!changed && !dirty && commits.length === 0) {
    ctx.out(kv('adopt', `${id}: nothing to adopt — content matches the last witnessed state`))
    return EXIT.OK
  }

  const doc = findById(canon, id)
  const isLiveSpec = doc?.meta.type === 'spec' && doc.meta.status === 'live'
  let reverify: { ok: boolean; criteria: CriterionOutcome[] } | undefined
  if (isLiveSpec && changed && doc) {
    const lane = await runCriteria(root, ctx, doc)
    if (!lane.ok) { renderRefusal(lane.violations).forEach(ctx.err); return EXIT.REFUSED }
    reverify = { ok: lane.value.ok, criteria: lane.value.criteria }
  }
  const unreviewed = isLiveSpec && changed && !criteriaChanged

  const entry = {
    t: 'adopt' as const,
    artifact: id,
    sha: currentSha,
    commits,
    ...(reverify ? { reverify } : {}),
    ...(unreviewed ? { unreviewed_amendment: true } : {}),
  }
  const flagTouched = doc && reverify !== undefined
  const files = [...new Set([...(dirty || flagTouched ? [rel] : []), journalRel(id)])]
  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    const marker = { op: `adopt(${id})`, files, journalMulti: [{ stream: id, line: entryLine(entry) }] }
    const committed = withTxn(root, marker, () => {
      if (doc && reverify && !reverify.ok) stampDrift(root, doc, currentSha)
      else if (doc && reverify?.ok && doc.meta.drift !== undefined) clearDrift(root, doc)
      appendEntry(root, id, entry)
      crashPoint(ctx.env, 'adopt-journal')
      return stateCommit(root, files, `adopt(${id}): ${short(currentSha)}`)
    })
    if (!committed.ok) { renderRefusal(committed.violations).forEach(ctx.err); return EXIT.REFUSED }
  } finally {
    lock.ok && lock.value()
  }
  ctx.out(kv('adopt', `${id} · ${short(currentSha)} · ${commits.length} commit(s) absolved${unreviewed ? ' · unreviewed-amendment' : ''}`))
  const held = reverify ? reverify.criteria.filter((c) => c.held !== undefined).length : 0
  if (reverify) ctx.out(kv('reverify', reverify.ok ? `lane green${held > 0 ? ` · ${held} held` : ''} — stays live` : 'lane RED — drift stamped immediately (hand-edit, no debounce)'))
  // Row 239. The log the help names is an act's line.
  ctx.out(`help: history: ${cliAct('log', id).line}`)
  return reverify && !reverify.ok ? EXIT.FINDINGS : EXIT.OK
}

// Row 220 (#65). Position — status, drift, pr, design — is written by the CLI's own transitions
// alone, and the content sha leaves it out, so a hand edit of position alone read as unchanged
// and adopt absolved it. Measured against the doc's last witnessed state (a trailered commit, or
// one an earlier adopt absolved), followed through a hand move, when that state is this id's; a doc adopt
// has never seen is born draft, with no stamps. Every moved field is named in the one refusal.
function positionMoves(root: string, rel: string, id: string, meta: Record<string, unknown>): Violation[] {
  const base = lastWitnessed(root, rel, adoptedCommitsFor(root, id), { follow: true })
  const seen = base !== undefined && base.id === id ? base : undefined
  const was = seen?.position ?? positionOf({ status: 'draft' })
  const now = positionOf(meta)
  const shown = (x: unknown): string => (x === undefined ? '(none)' : typeof x === 'string' ? x : canonicalJson(x))
  // Row 239: the revert is another tool's command, through the one renderer, as adopt's help.
  return VOLATILE_FIELDS.filter((f) => canonicalJson(was[f]) !== canonicalJson(now[f])).map((f) =>
    v(f, 'position-moved', `${shown(was[f])} → ${shown(now[f])}`, seen !== undefined
      ? `position is written by the CLI — set ${f} back to ${shown(was[f])}, or revert the file: ${shellLine(['git', 'checkout', short(seen.commit), '--', rel])}`
      : `position is written by the CLI — a doc adopt has never seen is born ${f === 'status' ? 'status: draft' : `draft, with no ${f}`}`))
}
