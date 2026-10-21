import { ensureTrusted } from './allowlist.js'
import type { Ctx } from './cli.js'
import { loadConfig } from './config.js'
import type { TestOutcome } from './junit.js'
import { matchesTag, sourceTags, type SourceTags } from './matcher.js'
import { heldCriteria, satisfyCommand, type HeldRow } from './needs.js'
import { ok, type Result } from './refusal.js'
import type { GateCheck } from './rounds.js'
import { criteriaExcludes, execCommand, runFiltered, runFullSuite, runnerConfig, untrustedOf } from './runner.js'
import type { CanonDoc } from './scan.js'
import { canonicalSha } from './sha.js'

export interface CriterionOutcome {
  id: string
  kind: 'test' | 'cmd'
  ok: boolean
  detail: string
  // Row 171: the command trust kept from running, when that is why this criterion failed.
  untrusted?: string
  // Row 179: the unmet manual needs holding this criterion. A held criterion is never run and
  // never `ok`; the lane's aggregate alone treats it as not failing.
  held?: string[]
}

export function criterionMark(c: CriterionOutcome): string {
  if (c.held !== undefined) return `held by ${c.held.join(' · ')}`
  return c.ok ? 'ok' : 'fail'
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
  // D154 root unification. The trust list and the runner config are two halves of one
  // question — "what may this repository run" — and answering them from two checkouts is
  // the asymmetry behind the Aug 1 false negative. Both resolve at the primary root now
  // (D132's doctrine: a branch checkout cannot re-point what the repo trusts or runs).
  const cfg = loadConfig(trustRoot)
  if (!cfg.ok) return cfg
  const rcRes = runnerConfig(cfg.value)
  if (!rcRes.ok) return rcRes
  const rc = rcRes.value
  const id = String(doc.meta.id)
  const list = (Array.isArray(doc.meta.criteria) ? doc.meta.criteria : []) as Array<Record<string, unknown>>

  let suite = opts.suite
  let suiteProblem: string | undefined
  let suiteUntrusted: string | undefined
  if (rc.mode === 'full-suite' && suite === undefined && list.some((c) => typeof c.test === 'string')) {
    const res = await runFullSuite(runRoot, ctx, rc, trustRoot)
    if (res.ok) suite = res.value.tests
    else {
      suiteProblem = res.violations.map((x) => `${x.rule}: ${x.field}`).join('; ')
      suiteUntrusted = untrustedOf(res.violations)
    }
  }
  const src: SourceTags | undefined = rc.mode === 'filtered'
    ? sourceTags(runRoot, criteriaExcludes(cfg.value))
    : undefined

  const held = heldCriteria(doc)
  const criteria: CriterionOutcome[] = []
  for (const c of list) {
    const cid = String(c.id)
    const holders = held.get(cid)
    if (holders !== undefined) {
      criteria.push({ id: cid, kind: typeof c.test === 'string' ? 'test' : 'cmd', ok: false, held: holders,
        detail: `held by ${holders.join(' · ')} — ${satisfyCommand(id, holders[0]!)}` })
      continue
    }
    if (typeof c.test === 'string') {
      if (rc.mode === 'full-suite') {
        if (!suite) {
          criteria.push({ id: cid, kind: 'test', ok: false, detail: suiteProblem ?? 'suite did not run',
            ...(suiteUntrusted !== undefined ? { untrusted: suiteUntrusted } : {}) })
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
          const blocked = untrustedOf(run.violations)
          criteria.push({ id: cid, kind: 'test', ok: false, detail: run.violations.map((x) => x.rule).join('; '),
            ...(blocked !== undefined ? { untrusted: blocked } : {}) })
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
        // D154. The block now names the verb that unblocks it. `witness trust <id>` is
        // fully resolved — D147's runnability test, applied where the refusal is a detail
        // string rather than a Violation.
        criteria.push({
          id: cid, kind: 'cmd', ok: false,
          detail: `untrusted-${trust} — run: witness trust ${id} (or set WITNESS_TRUST_CMDS=1)`,
          untrusted: c.cmd,
        })
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
    // A lane passes only when something actually passed and nothing failed: a held criterion
    // is not a failure, and it is never a pass either.
    ok: criteria.some((c) => c.ok) && criteria.every((c) => c.ok || c.held !== undefined),
    mode: rc.mode,
    tagCount,
    criteria,
  })
}

// The drift-lane row both code gates journal — one renderer, so implement and ship cannot
// disagree about it. `untrusted` (row 171) collects every command trust kept from running,
// deduplicated in criterion order, so the trust stop reads it from the run's own record.
export function laneCheck(lane: Result<CriteriaResult>): GateCheck {
  const untrusted = lane.ok
    ? [...new Set(lane.value.criteria.flatMap((c) => (c.untrusted !== undefined ? [c.untrusted] : [])))]
    : []
  // Row 179: a lane that passed with held criteria says so in its own record, so no reader
  // of the gate-run can take the green for a verification of what was not run.
  const held: HeldRow[] = lane.ok
    ? lane.value.criteria.flatMap((c) => (c.held ?? []).map((need) =>
        ({ criterion: c.id, need, satisfy: satisfyCommand(lane.value.spec, need) })))
    : []
  return {
    name: 'drift-lane',
    ok: lane.ok && lane.value.ok,
    detail: lane.ok
      ? lane.value.criteria.map((c) => `${c.id}:${criterionMark(c)}`).join(' · ')
      : lane.violations.map((x) => `${x.field}:${x.rule}`).join(' · '),
    ...(untrusted.length > 0 ? { untrusted } : {}),
    ...(held.length > 0 ? { held } : {}),
  }
}
