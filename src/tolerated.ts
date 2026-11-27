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
import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cliAct } from './act.js'
import { ensureTrusted } from './allowlist.js'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { diagnosticKey, lineKeys, readPart, type Diagnostic } from './diagnostics.js'
import { commitWithTrailer, gitBlob, tryGit } from './gitio.js'
import { jsonStyle } from './lint-config.js'
import { guardAct } from './guard.js'
import { MAX_TOLERATED_KEYS, ledgerItems, mergedPlan, type ToleratedItem } from './ledger.js'
import type { GateCheck, ToleratedSpot, ToleratedVerdict } from './rounds.js'
import type { ReaderTool } from './settings.js'
import {
  BIOME_LIST, ESLINT_LIST, biomeList, biomeListText, biomePairs, eslintList, eslintListText, extendsWitness, parseEslintList,
} from './tolerated-lists.js'
import { quotedWord, visible } from './toon.js'

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
// red, never green. Slice 1 review I2: the plan's own `guard` copies are old spots, base lines too, so
// the merged sets share the cap with them — `own + min(Σ merged, max(0, base lines − own guard))`; an
// own booked copy is new code and uses up no base line.
export function allowance(root: string, plan: string, base: string, sets: readonly ToleratedItem[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  const add = (rk: string, k: string, n: number) => {
    const m = out.get(rk) ?? new Map<string, number>()
    m.set(k, (m.get(k) ?? 0) + n)
    out.set(rk, m)
  }
  const merged = new Map<string, { tool: ReaderTool; rule: string; file: string; key: string; copies: number }>()
  const ownGuard = new Map<string, number>()
  for (const s of sets) {
    const rk = ruleKey(s.tool, s.rule)
    for (const [k, spot] of Object.entries(s.subject.spots)) {
      if (s.plan === plan) {
        add(rk, k, spot.copies)
        if (s.origin === 'guard') ownGuard.set(`${rk}\0${k}`, (ownGuard.get(`${rk}\0${k}`) ?? 0) + spot.copies)
        continue
      }
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
    const rk = ruleKey(m.tool, m.rule)
    const room = Math.max(0, (held.get(at)?.get(m.key) ?? 0) - (ownGuard.get(`${rk}\0${m.key}`) ?? 0))
    add(rk, m.key, Math.min(m.copies, room))
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

// ── The tolerated check (row 284, C46) ────────────────────────────────────────────────────────────

// One tolerated tool's reading on the plan's tree: every spot (errors and tolerated spots together), or
// why none was read — `why` a refusal rule id, `cmd` the command trust did not grant.
export type ToolReading = { ok: true; spots: Diagnostic[] } | { ok: false; state: 'not-measured' | 'untrusted'; why: string; cmd?: string }

// What a code gate read for the check: the sets that apply, each tolerated tool's reading, and the list
// paths it rewrote for the tree.
export interface ToleratedReading { sets: ToleratedItem[]; tools: Map<ReaderTool, ToolReading>; wrote: string[] }

const HIDES_NOTES = /--diagnostic-level(?:=|\s+)(?:warn|error)\b/
const SHOWN = 10

const listOf = (tool: ReaderTool): string => (tool === 'biome' ? BIOME_LIST : ESLINT_LIST)
function want(tool: ReaderTool, why: string): string {
  switch (why) {
    case 'reader-unset': return `readers.${tool} is not set — a tolerated set reads its spots there`
    case 'reader-unread': return 'its report could not be read — never green'
    case 'run-interrupted': return 'its run was ended before it reported — never green'
    case 'biome-unwired': return 'biome.json does not extend ./biome.witness.json — add it to "extends"'
    case 'reader-hides-notes': return 'readers.biome hides info diagnostics (--diagnostic-level) — tolerated spots arrive as notes'
    case 'list-ignored': return `${listOf(tool)} is gitignored — the tolerated list must be committed`
    default: return `${visible(why)} — never green`
  }
}

// Row 284 (§4 T4; C46). Withholding, the human's to book; runs at implement and ship wherever a set
// applies. Per tolerated (tool, rule), sorted: the plan's spots of the rule beyond the allowance are
// growth — red until fixed or booked. A rule witness cannot read (its reader unset, untrusted or unread;
// Biome not extending the witness file, or its reader hiding notes; a list the repo ignores) is red too,
// never green.
export function toleratedCheck(root: string, wt: string, cfg: Config, plan: string, base: string, gate: 'implement' | 'ship', reading: ToleratedReading): GateCheck {
  const rules = toleratedRules(reading.sets)
  const allowed = allowance(root, plan, base, reading.sets)
  const verdicts: ToleratedVerdict[] = []
  const untrusted: string[] = []
  const segs: string[] = []
  const book = cliAct('decide', gate, plan, '--book', 'tolerated').line
  const wired = rules.has('biome') ? extendsWitness(wt) === true : true
  const hides = HIDES_NOTES.test(cfg.readers?.biome ?? '')
  for (const tool of [...rules.keys()].sort()) {
    const r = reading.tools.get(tool) ?? { ok: false as const, state: 'not-measured' as const, why: 'reader-unread' }
    for (const rule of [...rules.get(tool)!].sort()) {
      const name = `${tool} ${visible(rule)}`
      const off = !r.ok ? { state: r.state, why: r.why }
        : tool === 'biome' && !wired ? { state: 'not-measured' as const, why: 'biome-unwired' }
        : tool === 'biome' && hides ? { state: 'not-measured' as const, why: 'reader-hides-notes' }
        : undefined
      if (off !== undefined) {
        verdicts.push({ tool, rule, ...off })
        if (!r.ok && r.state === 'untrusted' && r.cmd !== undefined && !untrusted.includes(r.cmd)) untrusted.push(r.cmd)
        segs.push(off.state === 'untrusted' ? `${name}: not run — readers.${tool} is not trusted` : `${name}: not measured — ${want(tool, off.why)}`)
        continue
      }
      const spots = (r as { spots: Diagnostic[] }).spots.filter((d) => d.tool === tool && d.rule === rule)
      const g = growth(spots, allowed.get(ruleKey(tool, rule)))
      const keys = Object.keys(g.grown)
      const kept = keys.slice(0, MAX_TOLERATED_KEYS)
      const over = keys.slice(MAX_TOLERATED_KEYS).reduce((a, k) => a + g.grown[k]!.copies, 0)
      const grown = Object.fromEntries(kept.map((k) => [k, g.grown[k]!]))
      const lines = Object.fromEntries(kept.filter((k) => Object.hasOwn(g.lines, k)).map((k) => [k, g.lines[k]!]))
      verdicts.push({ tool, rule, state: 'measured', spots: spots.length, allowed: spots.length - g.total, grown,
        ...(over > 0 ? { over } : {}), ...(Object.keys(lines).length > 0 ? { lines } : {}) })
      if (g.total === 0) {
        segs.push(`${name}: ${spots.length} spot${spots.length === 1 ? '' : 's'}, all tolerated`)
        continue
      }
      const where = (k: string) => `${visible(g.grown[k]!.file)}${Object.hasOwn(g.lines, k) ? `:${g.lines[k]}` : ''}${g.grown[k]!.copies > 1 ? ` ×${g.grown[k]!.copies}` : ''}`
      const shown = keys.slice(0, SHOWN)
      const more = g.total - shown.reduce((a, k) => a + g.grown[k]!.copies, 0)
      let seg = `${name}: ${g.total} new beside ${spots.length - g.total} tolerated — ${shown.map(where).join(', ')}${more > 0 ? `, and ${more} more` : ''}`
      seg += ` — fix them, or a human books them: ${book}`
      const proof = reproof(root, plan, base, reading.sets, tool, rule, keys.map((k) => ({ key: k, ...g.grown[k]!, line: g.lines[k] })))
      if (proof !== undefined) seg += ` — the base holds ${proof.where}: re-prove the guard of ${quotedWord(visible(proof.anchor))} (${guardAct(plan, proof.anchor)}) to tolerate it`
      segs.push(seg)
    }
  }
  const ok = verdicts.every((x) => x.state === 'measured' && Object.keys(x.grown ?? {}).length === 0 && x.over === undefined)
  return { name: 'tolerated', ok, detail: segs.join(' · '), tolerated: verdicts, ...(untrusted.length > 0 ? { untrusted } : {}) }
}

// Review Focus 1. A grown spot whose line the plan's base already holds, under a `guard` set of the plan's
// own for the rule — a rebase moved a line the guard tolerated: the newest such set's anchor, and the
// first such spot, to name the re-proof.
function reproof(root: string, plan: string, base: string, sets: readonly ToleratedItem[], tool: ReaderTool, rule: string,
  grown: ReadonlyArray<{ key: string; file: string; line?: number }>): { anchor: string; where: string } | undefined {
  const own = sets.filter((s) => s.plan === plan && s.origin === 'guard' && s.anchor !== undefined && s.tool === tool && s.rule === rule).at(-1)
  if (own === undefined) return undefined
  const held = new Map<string, Map<string, number> | undefined>()
  for (const x of grown) {
    if (!held.has(x.file)) held.set(x.file, lineKeys(root, base, x.file, tool, rule))
    if ((held.get(x.file)?.get(x.key) ?? 0) > 0) return { anchor: own.anchor!, where: `${visible(x.file)}${x.line !== undefined ? `:${x.line}` : ''}` }
  }
  return undefined
}

// ── The lists every code gate writes (row 285, C51) ───────────────────────────────────────────────

// A regular file's text at `rel` under `dir` (never through a link); undefined when there is none.
function fileText(dir: string, rel: string): string | undefined {
  try {
    return lstatSync(join(dir, rel)).isFile() ? readFileSync(join(dir, rel), 'utf8') : undefined
  } catch {
    return undefined
  }
}

const LIST_OF: Partial<Record<ReaderTool, string>> = { eslint: ESLINT_LIST, biome: BIOME_LIST }

// Row 285 (C51). Before anything reads the tree: each tolerated tool's reader runs in the worktree (as lint's,
// `ensureTrusted`), and each list is written for the tree — ESLint's tolerating every spot of a tolerated
// rule (growth included: the tool never reports one, the tolerated check alone judges), dropping a rule a
// set once named but none applies to now, keeping the repo's own entries at most at the base's count;
// Biome's per file, never deleted once present. Undefined when no set applies and neither list holds what
// witness wrote, so every other plan's round is untouched. With `commit` (ship), the paths it changed are
// committed with the trailer, as `dropRetired`; implement leaves them for the reviewed tree.
export async function prepareTolerated(root: string, wt: string, ctx: Ctx, cfg: Config, plan: string, base: string, commit?: string):
Promise<ToleratedReading | undefined> {
  const sets = applicableSets(root, plan)
  const rules = toleratedRules(sets)
  const witness = witnessRules(root)
  const eslintNow = fileText(wt, ESLINT_LIST)
  const biomeNow = fileText(wt, BIOME_LIST)
  const eslintHeld = eslintNow !== undefined && Object.values(parseEslintList(eslintNow) ?? {})
    .some((byRule) => Object.keys(byRule).some((r) => witness.get('eslint')?.has(r) === true))
  const biomeHeld = biomeNow !== undefined && biomePairs(biomeNow).size > 0
  if (sets.length === 0 && !eslintHeld && !biomeHeld) return undefined
  const read = new Set<ReaderTool>(rules.keys())
  if (eslintHeld) read.add('eslint')
  if (biomeHeld) read.add('biome')
  const tools = new Map<ReaderTool, ToolReading>()
  const wrote: string[] = []
  for (const tool of [...read].sort()) {
    const cmd = cfg.readers?.[tool]
    if (cmd === undefined) { tools.set(tool, { ok: false, state: 'not-measured', why: 'reader-unset' }); continue }
    if (await ensureTrusted(root, ctx, cmd) !== 'trusted') { tools.set(tool, { ok: false, state: 'untrusted', why: 'untrusted', cmd }); continue }
    const list = LIST_OF[tool]
    if (list !== undefined && tryGit(wt, 'check-ignore', '-q', '--', list).ok) {
      tools.set(tool, { ok: false, state: 'not-measured', why: 'list-ignored' })
      continue
    }
    const r = readPart(wt, ctx, tool, cmd)
    if (!r.ok) {
      tools.set(tool, { ok: false, state: 'not-measured', why: r.violations[0]?.rule === 'run-interrupted' ? 'run-interrupted' : 'reader-unread' })
      continue
    }
    const spots = [...r.value.diagnostics, ...r.value.tolerated]
    tools.set(tool, { ok: true, spots })
    if (tool === 'eslint') {
      const prior = parseEslintList(gitBlob(root, base, ESLINT_LIST)?.toString('utf8') ?? '')
      const text = eslintListText(eslintList(spots, rules.get('eslint') ?? new Set(), witness.get('eslint') ?? new Set(), prior), jsonStyle(wt, eslintNow))
      if (text === undefined && eslintNow !== undefined) { rmSync(join(wt, ESLINT_LIST), { force: true }); wrote.push(ESLINT_LIST) }
      if (text !== undefined && text !== eslintNow) { writeFileSync(join(wt, ESLINT_LIST), text); wrote.push(ESLINT_LIST) }
    }
    if (tool === 'biome' && (rules.has('biome') || biomeNow !== undefined)) {
      const text = biomeListText(biomeList(spots, rules.get('biome') ?? new Set()), jsonStyle(wt, biomeNow))
      if (text !== biomeNow) { writeFileSync(join(wt, BIOME_LIST), text); wrote.push(BIOME_LIST) }
    }
  }
  if (commit !== undefined && wrote.length > 0) {
    const committed = commitWithTrailer(wt, wrote, commit)
    if (!committed.ok) throw new Error(committed.violations.map((x) => x.got).join('; '))
  }
  return { sets, tools, wrote }
}
