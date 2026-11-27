// Row 284 (the trust design §4 T4, §3.3; the map's C46, C50). Tolerated sets: per (tool, rule) the old
// spots of a rule a lint guard's proof found on the base (or the growth a human booked), kept on the
// ledger (src/ledger.ts, kind `tolerated-set`). A set applies to its own plan, and to every plan once
// its plan merged (C17's rule).
//
// The allowance is the ledger, never a base run (C50): per tolerated rule and spot key, the plan's own
// sets' copies, plus the merged sets' copies capped by the lines the plan's base holds — a fixed line
// drops, and two sets naming one key never allow more than the base's lines. No job, so chat mode reads
// it exactly. Invariant: every spot of a tolerated rule on main passed a gate that read it as allowed or
// booked it. Growth is the multiset difference against it: anything beyond is new, whatever the counts
// (§4 T4: a swap of one old spot for one new one is one new spot).
import { diagnosticKey, lineKeys, type Diagnostic } from './diagnostics.js'
import { ledgerItems, mergedPlan, type ToleratedItem } from './ledger.js'
import type { ToleratedSpot } from './rounds.js'
import type { ReaderTool } from './settings.js'

// One (tool, rule), a key no rule id can collide in.
export const ruleKey = (tool: ReaderTool, rule: string): string => `${tool}\0${rule}`

// The open sets that apply to `plan`: its own, and every merged plan's.
export function applicableSets(root: string, plan: string): ToleratedItem[] {
  const merged = new Map<string, boolean>()
  const isMerged = (p: string): boolean => {
    if (!merged.has(p)) merged.set(p, mergedPlan(root, p))
    return merged.get(p)!
  }
  return ledgerItems(root).filter((i): i is ToleratedItem => i.kind === 'tolerated-set' && i.state === 'open' && (i.plan === plan || isMerged(i.plan)))
}

// Per `ruleKey`, per spot key, the copies `plan`'s tree may hold: its own sets' whole, the merged sets'
// summed and capped by the lines `base` (a commit) holds. A git failure reading the base caps at 0 —
// red, never green.
export function allowance(root: string, plan: string, base: string, sets: readonly ToleratedItem[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  const add = (rk: string, k: string, n: number) => {
    const m = out.get(rk) ?? new Map<string, number>()
    m.set(k, (m.get(k) ?? 0) + n)
    out.set(rk, m)
  }
  const merged = new Map<string, { tool: ReaderTool; rule: string; file: string; key: string; copies: number }>()
  for (const s of sets) {
    const rk = ruleKey(s.tool, s.rule)
    for (const [k, spot] of Object.entries(s.subject.spots)) {
      if (s.plan === plan) { add(rk, k, spot.copies); continue }
      const at = `${rk}\0${k}`
      const m = merged.get(at) ?? { tool: s.tool, rule: s.rule, file: spot.file, key: k, copies: 0 }
      m.copies += spot.copies
      merged.set(at, m)
    }
  }
  const held = new Map<string, Map<string, number> | undefined>()
  for (const m of merged.values()) {
    const at = `${m.tool}\0${m.rule}\0${m.file}`
    if (!held.has(at)) held.set(at, lineKeys(root, base, m.file, m.tool, m.rule))
    add(ruleKey(m.tool, m.rule), m.key, Math.min(m.copies, held.get(at)?.get(m.key) ?? 0))
  }
  return out
}

// Per key, the copies of `spots` beyond `allowed` — the last copies of a key, in the reading's order —
// each with its file and the first such copy's line; `total` every copy beyond.
export function growth(spots: readonly Diagnostic[], allowed: ReadonlyMap<string, number> | undefined):
{ grown: Record<string, ToleratedSpot>; lines: Record<string, number>; total: number } {
  const seen = new Map<string, number>()
  const grown: Record<string, ToleratedSpot> = {}
  const lines: Record<string, number> = {}
  let total = 0
  for (const d of spots) {
    const k = diagnosticKey(d)
    const n = (seen.get(k) ?? 0) + 1
    seen.set(k, n)
    if (n <= (allowed?.get(k) ?? 0)) continue
    grown[k] = { file: d.file, copies: (grown[k]?.copies ?? 0) + 1 }
    if (!Object.hasOwn(lines, k) && d.line !== undefined) lines[k] = d.line
    total += 1
  }
  return { grown, lines, total }
}

const byTool = (pairs: Iterable<{ tool: ReaderTool; rule: string }>): Map<ReaderTool, Set<string>> => {
  const out = new Map<ReaderTool, Set<string>>()
  for (const { tool, rule } of pairs) out.set(tool, (out.get(tool) ?? new Set<string>()).add(rule))
  return out
}

// The rules `sets` tolerate, per tool.
export function toleratedRules(sets: readonly ToleratedItem[]): Map<ReaderTool, Set<string>> {
  return byTool(sets)
}

// Every rule any tolerated set ever named, whatever its state: what a list may hold of witness's writing.
export function witnessRules(root: string): Map<ReaderTool, Set<string>> {
  return byTool(ledgerItems(root).filter((i): i is ToleratedItem => i.kind === 'tolerated-set'))
}
