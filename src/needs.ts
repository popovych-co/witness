import { execSync } from 'node:child_process'
import { ensureTrusted } from './allowlist.js'
import type { Ctx } from './cli.js'
import type { CanonDoc } from './scan.js'

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
export function heldCriteria(doc: CanonDoc): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const needs = Array.isArray(doc.meta.needs) ? (doc.meta.needs as Array<Record<string, unknown>>) : []
  for (const n of needs) {
    if (typeof n.manual !== 'string' || typeof n.id !== 'string' || !Array.isArray(n.holds)) continue
    if (needMet(doc, n as { id: string; manual: string; satisfied?: boolean })) continue
    for (const c of n.holds) if (typeof c === 'string') out.set(c, [...(out.get(c) ?? []), n.id])
  }
  return out
}
