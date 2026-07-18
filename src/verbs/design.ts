import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { designPending, designRel, designStamp, htmlSha, validateDesignArtifact } from '../design.js'
import { writeDoc } from '../fm.js'
import { dirtyStatePaths, primaryRoot, stateCommit } from '../gitio.js'
import { appendEntry, entryLine, journalRel, latestRecap } from '../journal.js'
import { acquireLock } from '../lock.js'
import { openArtifact } from '../opener.js'
import { renderRefusal, v } from '../refusal.js'
import { effortOf } from '../reviewed.js'
import { findById, loadCanon, type CanonDoc } from '../scan.js'
import { canonicalSha, short } from '../sha.js'
import { kv } from '../toon.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { file: { type: 'string' }, reconfirm: { type: 'boolean' }, open: { type: 'boolean' } },
  })
  const specId = positionals[0]
  if (!specId) { ctx.err('usage: specflow design <spec-id> --file <html> | --reconfirm | --open'); return EXIT.REFUSED }

  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach(ctx.err); return EXIT.REFUSED }

  const canon = loadCanon(root)
  const spec = findById(canon, specId)
  if (!spec || spec.meta.type !== 'spec') {
    renderRefusal([v('spec', 'unknown-spec', specId, 'a specs/ doc id')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  if (values.open) return openOnly(ctx, root, designRel(cfgR.value.paths, specId), specId)
  if (spec.meta.ui !== true) {
    renderRefusal([v('spec', 'not-ui', specId, 'a ui-flagged spec — set ui: true at decompose to earn a design stage')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const effort = effortOf(root, specId)
  if (!effort || latestRecap(root, effort)?.class !== 'feature') {
    renderRefusal([v('effort', 'not-feature', String(effort ?? 'none'), 'a feature-class effort — fix/chore specs ride straight to plan')]).forEach(ctx.err)
    return EXIT.REFUSED
  }

  const rel = designRel(cfgR.value.paths, specId)
  const stream = journalRel(specId)
  const specSha = canonicalSha(spec.meta, spec.body)

  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    if (values.reconfirm) return reconfirm(ctx, root, spec, specSha)
    return persist(ctx, root, spec, effort, rel, stream, specSha, values.file)
  } finally {
    lock.value()
  }
}

// The one place anything is ever spawned at a human. Journals a sha-keyed witness that
// `gate design`, `decide --approve` and `next` all consult. Deliberately reachable for
// any registered artifact — re-showing a file that exists needs no ui/feature eligibility,
// and gating it on those would dead-end the very refusals that point here.
function openOnly(ctx: Ctx, root: string, rel: string, id: string): number {
  const abs = join(root, rel)
  if (!existsSync(abs)) {
    renderRefusal([v('design', 'no-artifact', rel,
      `a registered design — run: specflow design ${id} --file <html>`)]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const sha = htmlSha(readFileSync(abs, 'utf8'))
  const { outcome, command } = openArtifact(ctx.env, abs)
  if (outcome === 'failed') {
    renderRefusal([v('design', 'opener-failed', `${command} did not resolve`,
      `a working platform opener, or SPECFLOW_OPENER — meanwhile open it yourself: file://${abs}`)]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  // `by` is the account and machine the spawn happened on — not a claim about who looked.
  // It answers "was this shown on my box or someone else's" on a shared branch, which is
  // the most the CLI can honestly know.
  const by = `${userInfo().username}@${hostname()}`
  const stream = journalRel(id)
  const entry = { t: 'design-shown' as const, artifact: id, sha, opener: command, by }
  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    const res = withTxn(root, {
      op: `design-open(${id})`, files: [stream], journal: { stream: id, line: entryLine(entry) },
    }, () => {
      appendEntry(root, id, entry)
      crashPoint(ctx.env, 'design-shown')
      return stateCommit(root, [stream], `design-shown(${id}): ${short(sha)}`)
    })
    if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return EXIT.REFUSED }
  } finally {
    lock.value()
  }
  ctx.out(kv('shown', id))
  ctx.out(kv('path', rel))
  ctx.out(kv('sha', short(sha)))
  ctx.out(kv('opener', command))
  ctx.out(`next: specflow gate design ${id}`)
  return EXIT.OK
}

function persist(
  ctx: Ctx, root: string, spec: CanonDoc, effort: string,
  rel: string, stream: string, specSha: string, file: string | undefined,
): number {
  if (!file) {
    renderRefusal([v('--file', 'required', 'absent', 'a scratch HTML file — or --reconfirm')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  let html: string
  try {
    html = readFileSync(resolve(ctx.cwd, file), 'utf8')
  } catch (e) {
    renderRefusal([v('--file', 'input-unreadable', String((e as Error).message).slice(0, 120), 'a readable HTML file')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const problems = validateDesignArtifact(html)
  if (problems.length) { renderRefusal(problems).forEach(ctx.err); return EXIT.REFUSED }

  const unrelated = dirtyStatePaths(root).filter((p) => p !== rel && p !== stream)
  if (unrelated.length) {
    renderRefusal(unrelated.map((p) => v(p, 'unrelated-dirty', 'uncommitted change on a state path', 'revert or adopt it, then re-run'))).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const sha = htmlSha(html)
  const id = String(spec.meta.id)
  const entry = { t: 'design-write' as const, effort, artifact: id, sha, spec: specSha }
  const res = withTxn(root, {
    op: `design(${id})`, files: [rel, stream], journal: { stream: id, line: entryLine(entry) },
  }, () => {
    mkdirSync(join(root, dirname(rel)), { recursive: true })
    writeFileSync(join(root, rel), html)
    crashPoint(ctx.env, 'design-artifact')
    appendEntry(root, id, entry)
    crashPoint(ctx.env, 'design-journal')
    return stateCommit(root, [rel, stream], `design(${id}): ${short(sha)}`)
  })
  if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return EXIT.REFUSED }
  ctx.out(kv('design', id))
  ctx.out(kv('path', rel))
  ctx.out(kv('sha', short(sha)))
  ctx.out(`next: specflow gate design ${id}`)
  return EXIT.OK
}

function reconfirm(ctx: Ctx, root: string, spec: CanonDoc, specSha: string): number {
  const id = String(spec.meta.id)
  const stamp = designStamp(spec)
  if (!stamp) {
    renderRefusal([v('design', 'no-stamp', id, 'an approved design (specflow gate design <id>) — nothing to reconfirm')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  if (!designPending(root, spec)) {
    renderRefusal([v('design', 'not-pending', 'stamp already current', 'a stale stamp — reconfirm applies only after a feature amendment with no visual delta')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const stream = journalRel(id)
  const nextMeta = { ...spec.meta, design: { sha: stamp.sha, spec: specSha } }
  const entry = { t: 'design-reconfirm' as const, artifact: id, sha: stamp.sha, spec: specSha }
  const res = withTxn(root, {
    op: `design-reconfirm(${id})`, files: [spec.rel, stream],
    journal: { stream: id, line: entryLine(entry) },
  }, () => {
    writeDoc(join(root, spec.rel), { meta: nextMeta, body: spec.body })
    appendEntry(root, id, entry)
    crashPoint(ctx.env, 'design-reconfirm')
    return stateCommit(root, [spec.rel, stream], `design-reconfirm(${id}): no visual delta`)
  })
  if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return EXIT.REFUSED }
  ctx.out(kv('reconfirmed', id))
  ctx.out(kv('design', `re-pinned to ${short(specSha)} (artifact unchanged)`))
  return EXIT.OK
}
