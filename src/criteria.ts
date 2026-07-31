import { ensureTrusted } from './allowlist.js'
import type { Ctx } from './cli.js'
import { loadConfig } from './config.js'
import type { TestOutcome } from './junit.js'
import { matchesTag, sourceTags, type SourceTags } from './matcher.js'
import { ok, type Result } from './refusal.js'
import { criteriaExcludes, execCommand, runFiltered, runFullSuite, runnerConfig } from './runner.js'
import type { CanonDoc } from './scan.js'
import { canonicalSha } from './sha.js'

export interface CriterionOutcome {
  id: string
  kind: 'test' | 'cmd'
  ok: boolean
  detail: string
}

export interface CriteriaResult {
  spec: string
  sha: string
  ok: boolean
  mode: 'filtered' | 'full-suite'
  tagCount: number
  criteria: CriterionOutcome[]
}

export async function runCriteria(
  runRoot: string, ctx: Ctx, doc: CanonDoc, opts: { trustRoot?: string; suite?: TestOutcome[] } = {},
): Promise<Result<CriteriaResult>> {
  const trustRoot = opts.trustRoot ?? runRoot
  const cfg = loadConfig(runRoot)
  if (!cfg.ok) return cfg
  const rcRes = runnerConfig(cfg.value)
  if (!rcRes.ok) return rcRes
  const rc = rcRes.value
  const id = String(doc.meta.id)
  const list = (Array.isArray(doc.meta.criteria) ? doc.meta.criteria : []) as Array<Record<string, unknown>>

  let suite = opts.suite
  let suiteProblem: string | undefined
  if (rc.mode === 'full-suite' && suite === undefined && list.some((c) => typeof c.test === 'string')) {
    const res = await runFullSuite(runRoot, ctx, rc, trustRoot)
    if (res.ok) suite = res.value.tests
    else suiteProblem = res.violations.map((x) => `${x.rule}: ${x.field}`).join('; ')
  }
  const src: SourceTags | undefined = rc.mode === 'filtered'
    ? sourceTags(runRoot, criteriaExcludes(cfg.value))
    : undefined

  const criteria: CriterionOutcome[] = []
  for (const c of list) {
    const cid = String(c.id)
    if (typeof c.test === 'string') {
      if (rc.mode === 'full-suite') {
        if (!suite) {
          criteria.push({ id: cid, kind: 'test', ok: false, detail: suiteProblem ?? 'suite did not run' })
          continue
        }
        const mine = suite.filter((t) => matchesTag(t.name, id))
        const passed = mine.filter((t) => t.status === 'passed').length
        const failed = mine.filter((t) => t.status === 'failed').length
        criteria.push({
          id: cid, kind: 'test', ok: passed > 0 && failed === 0,
          detail: `${mine.length} tagged · ${passed} passed · ${failed} failed`,
        })
      } else {
        const run = await runFiltered(runRoot, ctx, rc.template, id, trustRoot)
        const count = src?.counts.get(id) ?? 0
        if (!run.ok) {
          criteria.push({ id: cid, kind: 'test', ok: false, detail: run.violations.map((x) => x.rule).join('; ') })
        } else if (count === 0) {
          criteria.push({ id: cid, kind: 'test', ok: false, detail: 'no tagged test found in source (grep side)' })
        } else {
          criteria.push({
            id: cid, kind: 'test', ok: run.value.exitZero,
            detail: `filtered run ${run.value.exitZero ? 'exit 0' : 'nonzero'} · ${count} tagged in source`,
          })
        }
      }
    } else if (typeof c.cmd === 'string') {
      const trust = await ensureTrusted(trustRoot, ctx, c.cmd)
      if (trust !== 'trusted') {
        criteria.push({ id: cid, kind: 'cmd', ok: false, detail: `untrusted-${trust} — allow interactively or set WITNESS_TRUST_CMDS=1` })
        continue
      }
      const run = execCommand(runRoot, ctx, c.cmd)
      criteria.push({ id: cid, kind: 'cmd', ok: run.exitZero, detail: run.exitZero ? 'exit 0' : 'nonzero exit' })
    }
  }

  const tagCount = rc.mode === 'full-suite'
    ? (suite ?? []).filter((t) => matchesTag(t.name, id)).length
    : (src?.counts.get(id) ?? 0)

  return ok({
    spec: id,
    sha: canonicalSha(doc.meta, doc.body),
    ok: criteria.length > 0 && criteria.every((c) => c.ok),
    mode: rc.mode,
    tagCount,
    criteria,
  })
}
