import { join } from 'node:path'
import { adoptedCommits, lastWitnessed, untrailedCommitsFor } from '../adopt.js'
import { EXIT, type Ctx } from '../cli.js'
import { runCriteria } from '../criteria.js'
import { clearDrift, stampDrift } from '../drift.js'
import { readDoc } from '../fm.js'
import { dirtyStatePaths, primaryRoot, stateCommit } from '../gitio.js'
import { appendEntry, entryLine, journalRel } from '../journal.js'
import { acquireLock } from '../lock.js'
import { renderRefusal, v } from '../refusal.js'
import { findById, findCycle, loadCanon } from '../scan.js'
import { validateDoc } from '../schemas.js'
import { canonicalSha, short } from '../sha.js'
import { kv } from '../toon.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const [rel] = argv.filter((a) => !a.startsWith('--'))
  if (!rel || !(rel.startsWith('specs/') || rel.startsWith('plans/')) || !rel.endsWith('.md')) {
    renderRefusal([v('path', 'usage', String(rel ?? ''), 'specflow adopt <specs/... | plans/...>.md')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value
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
  for (const dep of Array.isArray(meta.depends) ? (meta.depends as string[]) : []) {
    if (!findById(canon, dep)) violations.push(v('depends', 'unknown-dep', dep, 'an existing doc id'))
  }
  const cycle = findCycle(canon)
  if (cycle) violations.push(v('depends', 'cycle', cycle.join(' -> '), 'an acyclic graph'))
  if (violations.length) {
    renderRefusal(violations).forEach(ctx.err)
    ctx.err(`help: fix the file and re-run, or revert instead: git checkout HEAD -- ${rel}`)
    return EXIT.REFUSED
  }

  const witnessed = lastWitnessed(root, rel)
  const currentSha = canonicalSha(meta, body)
  const changed = witnessed?.sha !== currentSha
  const criteriaChanged = JSON.stringify(meta.criteria ?? null) !== JSON.stringify(witnessed?.criteria ?? null)
  const commits = untrailedCommitsFor(root, rel).filter((sha) => !adoptedCommits(root).has(sha))
  const dirty = dirtyStatePaths(root).includes(rel)
  if (!changed && !dirty && commits.length === 0) {
    ctx.out(kv('adopt', `${id}: nothing to adopt — content matches the last witnessed state`))
    return EXIT.OK
  }

  const doc = findById(canon, id)
  const isLiveSpec = doc?.meta.type === 'spec' && doc.meta.status === 'live'
  let reverify: { ok: boolean; criteria: unknown } | undefined
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
  if (reverify) ctx.out(kv('reverify', reverify.ok ? 'lane green — stays live' : 'lane RED — drift stamped immediately (hand-edit, no debounce)'))
  ctx.out('help: history: specflow log ' + id)
  return reverify && !reverify.ok ? EXIT.FINDINGS : EXIT.OK
}
