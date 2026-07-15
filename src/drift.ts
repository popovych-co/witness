import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Ctx } from './cli.js'
import { EXIT } from './cli.js'
import { loadConfig } from './config.js'
import { runCriteria, type CriteriaResult } from './criteria.js'
import { serializeDoc, writeDoc } from './fm.js'
import { acquireLock } from './lock.js'
import { appendEntry, entryLine, journalRel, readStream, type Entry } from './journal.js'
import type { TestOutcome } from './junit.js'
import { primaryRoot, stateCommit } from './gitio.js'
import { refuse, renderRefusal, v, type Result, ok } from './refusal.js'
import { invokeClaude, parseVerdictText, resolvePrompt } from './reviewer.js'
import { runFullSuite, runnerConfig } from './runner.js'
import { findById, loadCanon, type Canon, type CanonDoc } from './scan.js'
import { canonicalSha } from './sha.js'
import { kv, rows } from './toon.js'
import { crashPoint, guardTxn, withTxn } from './txn.js'
import { parseVerdict, verdictViolations } from './verdict.js'

export const newRunId = (): string => `r-${randomBytes(4).toString('hex')}`

export function driftEntry(run: CriteriaResult, runId: string): { t: 'drift-check'; [k: string]: unknown } {
  return {
    t: 'drift-check',
    run_id: runId,
    artifact: run.spec,
    artifact_sha: run.sha,
    ok: run.ok,
    tags: run.tagCount,
    criteria: run.criteria.map((c) => ({ id: c.id, kind: c.kind, ok: c.ok, detail: c.detail })),
  }
}

export function trailingFails(entries: Entry[]): number {
  const checks = entries.filter((e) => e.t === 'drift-check')
  let n = 0
  for (let i = checks.length - 1; i >= 0 && checks[i]?.ok === false; i--) n++
  return n
}

export const liveSpecs = (canon: Canon): CanonDoc[] =>
  canon.docs.filter((d) => d.meta.type === 'spec' && d.meta.status === 'live')

const today = (): string => new Date().toISOString().slice(0, 10)

export function stampDrift(root: string, doc: CanonDoc, sha: string): void {
  writeDoc(join(root, doc.rel), { meta: { ...doc.meta, drift: { sha, at: today() } }, body: doc.body })
}

export function clearDrift(root: string, doc: CanonDoc): void {
  const meta = { ...doc.meta }
  delete meta.drift
  writeDoc(join(root, doc.rel), { meta, body: doc.body })
}

export function flapScore(entries: Entry[]): number {
  const checks = entries.filter((e) => e.t === 'drift-check').slice(-10)
  let flips = 0
  for (let i = 1; i < checks.length; i++) {
    if (checks[i]?.ok !== checks[i - 1]?.ok) flips++
  }
  return flips
}

export function reconcileRows(root: string, canon: Canon): Array<{ spec: string; why: string; detail: string }> {
  const out: Array<{ spec: string; why: string; detail: string }> = []
  for (const doc of liveSpecs(canon)) {
    const id = String(doc.meta.id)
    const entries = readStream(root, id)
    const flag = doc.meta.drift as { sha: string; at: string } | undefined
    if (flag) out.push({ spec: id, why: 'drift', detail: `${flag.sha.slice(0, 7)} since ${flag.at} — fix the code or amend the spec` })
    else if (trailingFails(entries) === 1) out.push({ spec: id, why: 'unconfirmed', detail: 'seen red once — one more red stamps drift' })
    const flips = flapScore(entries)
    if (flips >= 3) out.push({ spec: id, why: 'flapping', detail: `${flips} pass/fail flips in the last 10 runs — fix the test or the spec` })
    const last = entries.at(-1)
    if (last?.t === 'adopt' && last.unreviewed_amendment === true) {
      out.push({ spec: id, why: 'unreviewed-amendment', detail: 'prose changed without review — amend properly or accept' })
    }
  }
  return out
}

export async function driftSweep(root: string, ctx: Ctx, canon: Canon): Promise<Result<CriteriaResult[]>> {
  const specs = liveSpecs(canon)
  const cfg = loadConfig(root)
  if (!cfg.ok) return cfg
  const rcRes = runnerConfig(cfg.value)
  if (!rcRes.ok) return rcRes
  let suite: TestOutcome[] | undefined
  if (rcRes.value.mode === 'full-suite' && specs.length > 0) {
    const res = await runFullSuite(root, ctx, rcRes.value)
    if (res.ok) suite = res.value.tests
    // a refusal here (untrusted, no reports) falls through: each runCriteria call
    // re-attempts and reports the same problem as failing criteria — fail-closed either way
  }
  const runs: CriteriaResult[] = []
  for (const doc of specs) {
    const res = await runCriteria(root, ctx, doc, { suite })
    if (!res.ok) return res
    runs.push(res.value)
  }
  return ok(runs)
}

export async function deepDrift(root: string, ctx: Ctx, canon: Canon, specId: string): Promise<number> {
  if (ctx.env.CI) {
    renderRefusal([v('deep', 'deep-in-ci', 'CI env', 'a local run — CI never invokes reviewers or writes state')])
      .forEach(ctx.err)
    return EXIT.REFUSED
  }
  const doc = findById(canon, specId)
  if (!doc || doc.meta.type !== 'spec') {
    renderRefusal([v('spec', 'unknown-spec', specId, 'a live spec id')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const lane = await runCriteria(root, ctx, doc, {})
  const lensR = resolvePrompt('drift-reviewer')
  if (!lensR.ok) { renderRefusal(lensR.violations).forEach(ctx.err); return EXIT.REFUSED }
  const prompt = `${lensR.value.contents}\n\n## Reviewed content\n\n### Spec: ${specId}\n${serializeDoc({ meta: doc.meta, body: doc.body })}\n\n(Deterministic lane: ${lane.ok ? lane.value.criteria.map((c) => `${c.id}:${c.ok ? 'ok' : 'fail'}`).join(' · ') : 'unrunnable'})\n`
  const invoked = invokeClaude(ctx, { cwd: root, prompt })
  if (!invoked.ok) { renderRefusal(invoked.violations).forEach(ctx.err); return EXIT.REFUSED }
  const rawR = parseVerdictText(invoked.value.text)
  const parsed = rawR.ok ? parseVerdict(rawR.value) : rawR
  const violations = parsed.ok
    ? verdictViolations(parsed.value, { kind: 'tree', root, files: [] })
    : parsed.violations
  const entry = {
    v: 1 as const, t: 'drift-check' as const, run_id: newRunId(), artifact: specId,
    artifact_sha: lane.ok ? lane.value.sha : canonicalSha(doc.meta, doc.body),
    ok: lane.ok && lane.value.ok, tags: lane.ok ? lane.value.tagCount : 0,
    criteria: lane.ok ? lane.value.criteria.map((c) => ({ id: c.id, kind: c.kind, ok: c.ok, detail: c.detail })) : [],
    deep: true,
    ...(violations.length === 0 && parsed.ok ? { verdict: parsed.value } : { malformed: violations }),
  }
  const lockR = acquireLock(root)
  if (!lockR.ok) { renderRefusal(lockR.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    const txn = withTxn(root, {
      op: 'drift-deep', files: [journalRel(specId)],
      journalMulti: [{ stream: specId, line: entryLine(entry as unknown as { t: 'drift-check'; [k: string]: unknown }) }],
    }, () => {
      appendEntry(root, specId, entry as unknown as { t: 'drift-check'; [k: string]: unknown })
      crashPoint(ctx.env, 'drift-journal')
      return stateCommit(root, [journalRel(specId)], `drift-deep(${specId})`)
    })
    if (!txn.ok) { renderRefusal(txn.violations).forEach(ctx.err); return EXIT.REFUSED }
  } finally {
    lockR.value()
  }
  const blocking = parsed.ok && violations.length === 0
    ? parsed.value.findings.filter((f) => f.blocking).length : 1
  return (lane.ok && lane.value.ok && blocking === 0) ? EXIT.OK : EXIT.FINDINGS
}

export async function runDrift(ctx: Ctx, argv: string[]): Promise<number> {
  if (argv.includes('--deep')) {
    const specId = argv.find((a) => !a.startsWith('--'))
    const rootRes0 = primaryRoot(ctx.cwd)
    if (!rootRes0.ok) { renderRefusal(rootRes0.violations).forEach(ctx.err); return EXIT.REFUSED }
    if (!specId) {
      renderRefusal([v('spec-id', 'required', 'absent', 'specflow check --drift --deep <spec-id>')]).forEach(ctx.err)
      return EXIT.REFUSED
    }
    if (argv.includes('--ci')) {
      renderRefusal([v('deep', 'deep-in-ci', '--ci', 'a local run — CI never invokes reviewers or writes state')]).forEach(ctx.err)
      return EXIT.REFUSED
    }
    return deepDrift(rootRes0.value, ctx, loadCanon(rootRes0.value), specId)
  }
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value
  const readonly = argv.includes('--ci') || Boolean(ctx.env.CI)

  if (!readonly) {
    const blocked = guardTxn(ctx, root)
    if (blocked !== undefined) return blocked
  }
  const canon = loadCanon(root)
  const sweep = await driftSweep(root, ctx, canon)
  if (!sweep.ok) { renderRefusal(sweep.violations).forEach(ctx.err); return EXIT.REFUSED }
  const runs = sweep.value
  const failing = runs.filter((r) => !r.ok)

  if (runs.length) {
    rows('drift', ['spec', 'ok', 'tags', 'detail'], runs.map((r) => {
      const doc = findById(canon, r.spec)
      const unconfirmed = !r.ok && doc?.meta.drift === undefined && trailingFails(readStream(root, r.spec)) === 0
      return {
        spec: r.spec, ok: String(r.ok), tags: r.tagCount,
        detail: unconfirmed
          ? 'unconfirmed — seen red once — one more red stamps drift'
          : r.criteria.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join(' · ') || 'clean',
      }
    })).forEach(ctx.out)
  }

  if (readonly) {
    ctx.out(kv('drift-summary', `${failing.length}/${runs.length} failing · mode read-only`))
    ctx.out('help: read-only run — the next local check --drift journals and stamps')
    return failing.length ? EXIT.FINDINGS : EXIT.OK
  }

  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    const runId = newRunId()
    const entries = runs.map((r) => ({ spec: r.spec, entry: driftEntry(r, runId) }))
    const actions = runs.map((run) => {
      const doc = findById(canon, run.spec)
      const flagged = doc?.meta.drift !== undefined
      const priorFails = trailingFails(readStream(root, run.spec))
      return {
        run, doc,
        stamp: doc && !run.ok && priorFails >= 1 && !flagged,
        clear: doc && run.ok && flagged,
      }
    })
    const marker = {
      op: `drift-check ${runId}`,
      files: [...new Set([
        ...entries.map((e) => journalRel(e.spec)),
        ...actions.filter((a) => a.stamp || a.clear).map((a) => a.doc!.rel),
      ])],
      journalMulti: entries.map((e) => ({ stream: e.spec, line: entryLine(e.entry) })),
    }
    const committed = withTxn(root, marker, () => {
      for (const { spec, entry } of entries) appendEntry(root, spec, entry)
      for (const a of actions) {
        if (a.stamp) stampDrift(root, a.doc!, a.run.sha)
        else if (a.clear) clearDrift(root, a.doc!)
      }
      crashPoint(ctx.env, 'drift-journal')
      return stateCommit(root, marker.files, `drift-check: ${failing.length}/${runs.length} failing`)
    })
    if (!committed.ok) { renderRefusal(committed.violations).forEach(ctx.err); return EXIT.REFUSED }
    const stamped = actions.filter((a) => a.stamp).length
    const cleared = actions.filter((a) => a.clear).length
    const suffix = `${stamped ? ` · stamped ${stamped}` : ''}${cleared ? ` · cleared ${cleared}` : ''}`
    ctx.out(kv('drift-summary', `${failing.length}/${runs.length} failing · mode local${suffix}`))
  } finally {
    lock.ok && lock.value()
  }
  ctx.out('help: drift history: specflow log <spec-id>')
  return failing.length ? EXIT.FINDINGS : EXIT.OK
}
