import { execSync } from 'node:child_process'
import { ensureTrusted } from './allowlist.js'
import type { Ctx } from './cli.js'
import type { GateCheck } from './rounds.js'
import type { Canon, CanonDoc } from './scan.js'

export interface NeedResult {
  label: string
  kind: 'env' | 'cmd' | 'manual'
  status: 'ok' | 'unmet' | 'blocked' | 'declined'
  detail: string
}

// Row 179. What a journaled satisfaction names a need by: its id, else its manual text.
export function needKey(n: { id?: string; manual: string }): string {
  return n.id ?? n.manual
}

// The one judge of a manual need. Satisfying a need is a human's assertion about the world,
// so `witness satisfy` journals it rather than rewriting the spec — a frontmatter flip moved
// the content sha, which re-queued a plan and re-armed a look for no change in behavior. The
// frontmatter flag stays as legacy input: a doc written `satisfied: true` reads met.
export function needMet(doc: CanonDoc, n: { id?: string; manual: string; satisfied?: boolean }): boolean {
  return n.satisfied === true || doc.satisfiedNeeds.includes(needKey(n))
}

export async function evaluateNeeds(root: string, ctx: Ctx, needs: unknown[], doc: CanonDoc): Promise<NeedResult[]> {
  const out: NeedResult[] = []
  for (const raw of needs) {
    const n = raw as Record<string, unknown>
    if (typeof n.env === 'string') {
      const set = Boolean(ctx.env[n.env])
      out.push({ label: n.env, kind: 'env', status: set ? 'ok' : 'unmet', detail: set ? 'set' : 'env var unset' })
    } else if (typeof n.manual === 'string') {
      const done = needMet(doc, n as { id?: string; manual: string; satisfied?: boolean })
      out.push({ label: n.manual, kind: 'manual', status: done ? 'ok' : 'unmet', detail: done ? 'satisfied' : 'flip via witness satisfy' })
    } else if (typeof n.cmd === 'string') {
      const trust = await ensureTrusted(root, ctx, n.cmd)
      if (trust !== 'trusted') {
        out.push({
          label: n.cmd, kind: 'cmd', status: trust,
          detail: trust === 'blocked' ? 'untrusted in non-TTY — allow interactively or set WITNESS_TRUST_CMDS=1' : 'trust declined',
        })
        continue
      }
      try {
        execSync(n.cmd, { cwd: root, stdio: 'ignore' })
        out.push({ label: n.cmd, kind: 'cmd', status: 'ok', detail: 'exit 0' })
      } catch {
        out.push({ label: n.cmd, kind: 'cmd', status: 'unmet', detail: 'nonzero exit' })
      }
    }
  }
  return out
}

export function satisfyCommand(doc: string, need: string): string {
  return `witness satisfy ${doc} --need ${need}`
}

// Row 179. What a spec's unmet manual needs hold: criterion id → the ids of the needs holding
// it, in needs order. A satisfied need holds nothing, so its criteria run and must pass.
//
// Only a spec's own `cmd:` criteria can be held, as validateHolds requires: the lane reads a
// hand-edited doc before `check` flags it, and honouring a hold on a test criterion there let
// an edit skip the spec's tests and clear its drift stamp.
export function heldCriteria(doc: CanonDoc): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (doc.meta.type !== 'spec') return out
  const criteria = Array.isArray(doc.meta.criteria) ? (doc.meta.criteria as Array<Record<string, unknown>>) : []
  const cmds = new Set(criteria.filter((c) => typeof c.cmd === 'string').map((c) => String(c.id)))
  const needs = Array.isArray(doc.meta.needs) ? (doc.meta.needs as Array<Record<string, unknown>>) : []
  for (const n of needs) {
    if (typeof n.manual !== 'string' || typeof n.id !== 'string' || !Array.isArray(n.holds)) continue
    if (needMet(doc, n as { id: string; manual: string; satisfied?: boolean })) continue
    for (const c of n.holds) if (typeof c === 'string' && cmds.has(c)) out.set(c, [...(out.get(c) ?? []), n.id])
  }
  return out
}

// Row 179. One row per (criterion · unmet need holding it): what a gate's lane check, its
// `held:` lines and a PR body name as not verified. Built by `laneCheck` from the lane's own
// outcome, so the record and every surface read one derivation.
export interface HeldRow { criterion: string; need: string; satisfy: string }

// Row 179. The one listing of what waits on a human's assertion about the world: `status`,
// `next`, `start` and drive's run report all read it. A plan need blocks its plan's start; a
// spec need never blocks anything — it holds the criteria it names, or nothing.
export interface UnmetNeed {
  doc: string                     // the spec or plan carrying the need
  type: 'spec' | 'plan'
  need: string                    // its id · else its manual text
  text: string                    // the manual text
  holds: string[]                 // criteria it holds while unmet · [] for a plan need
  blocks: 'start' | 'nothing'
  satisfy: string                 // the human's command — the id when the need has one, else its index
}

export function unmetNeeds(canon: Canon): UnmetNeed[] {
  const docs = canon.docs
    .filter((d) => d.meta.type === 'spec' || (d.meta.type === 'plan' && ['draft', 'approved'].includes(String(d.meta.status))))
    .sort((a, b) => String(a.meta.id).localeCompare(String(b.meta.id)))
  return docs.flatMap((d) => {
    const id = String(d.meta.id)
    const type = d.meta.type as 'spec' | 'plan'
    const needs = Array.isArray(d.meta.needs) ? (d.meta.needs as Array<Record<string, unknown>>) : []
    const manuals = needs.filter((n) => typeof n.manual === 'string') as Array<{ id?: string; manual: string; satisfied?: boolean; holds?: unknown }>
    return manuals.flatMap((n, i) => needMet(d, n) ? [] : [{
      doc: id, type, need: needKey(n), text: n.manual,
      holds: type === 'spec' && Array.isArray(n.holds) ? (n.holds as string[]) : [],
      blocks: type === 'plan' ? 'start' as const : 'nothing' as const,
      satisfy: satisfyCommand(id, n.id ?? String(i + 1)),
    }])
  })
}

// Final review F1. The criteria a gate-run recorded as held that no unmet need holds now. A
// satisfy moves no sha, so without this the verdict still "describes current content" while
// a criterion it never ran is now owed: approving it, or shipping on an approval it predates,
// would merge that criterion unverified. A lifted hold is staleness at consumption (D75).
export function liftedHolds(doc: CanonDoc | undefined, run: { checks: GateCheck[] } | undefined): string[] {
  if (doc === undefined || run === undefined) return []
  const now = heldCriteria(doc)
  return [...new Set(run.checks.flatMap((c) => (c.held ?? []).map((h) => h.criterion)))].filter((c) => !now.has(c))
}
