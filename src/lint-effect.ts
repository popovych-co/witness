// Row 277 (§4 T3, the effect layer's lint half; corrections C34–C36). The `lint-effect` job: drive runs
// every `ship.lint` part and every set reader on the plan's tree and on the effect tree (the plan's tree
// with the base's check definitions folded back in, src/definitions.ts), in the scratch, and returns what
// the base's definitions see that the plan's do not: each part's exit on both sides, and the diagnostics
// a reader reports on the effect tree beyond its count on the plan's (a per-key multiset, row 263's), on
// every file both trees track but the restored definitions. A gate that changed a definition the base
// holds journals the key it lacked on its `definitions` check (`owes`), and the kind owes exactly those.
//
// Gated (a gate waits on it), no turn (lint takes none, row 255), in the scratch, boxed like base-lint.
// Keyed by the two wrapper commits the gate pins (a plan id has no length cap; a key caps at 200) and 12
// hex over the commands, so an edited command never serves a stale result. No snippet rides the result.
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shownCmd, trustedNow, type RunCommand } from './allowlist.js'
import { objectType } from './cf-tree.js'
import { parentsInTree } from './change-set.js'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { keyCounts, loosenedKey, newDiagnostics, normalizeSnippet, readPart, type Diagnostic } from './diagnostics.js'
import { tryGit } from './gitio.js'
import type { JobKind, JobResult, JobUnit } from './jobs.js'
import { readStream } from './journal.js'
import { RULE_RE } from './lint-readers.js'
import { ok, refuse, type Result } from './refusal.js'
import { lastGateRun } from './rounds.js'
import { execCommand, interrupted } from './runner.js'
import type { Canon } from './scan.js'
import { inScratch, type CfStep } from './scratch-checkout.js'
import { withScratchLock } from './scratch-lock.js'
import { READER_TOOLS, type ReaderTool } from './settings.js'
import { treePaths } from './snapshot.js'

export const LINT_EFFECT = 'lint-effect'
// Two resets, two prepares at most, every part and every reader twice.
export const LINT_EFFECT_BOX_MS = 1_800_000
// The verb's result pipe holds 48 KiB (row 257): the hits stop where the result's JSON would pass this.
export const EFFECT_RESULT_BYTES = 40_000

// Every part under its own source, in file order, then every set reader — bound to a part or not (C34):
// each is an instrument of the effect.
export function effectCommands(cfg: Config): RunCommand[] {
  const parts = (cfg.ship.lint ?? []).map((p) => ({ cmd: p.cmd, source: p.source }))
  return [...parts, ...setReaders(cfg).map((r) => ({ cmd: r.cmd, source: `readers.${r.tool}` }))]
}

const setReaders = (cfg: Config): Array<{ tool: ReaderTool; cmd: string }> =>
  READER_TOOLS.flatMap((tool) => (cfg.readers[tool] !== undefined ? [{ tool, cmd: cfg.readers[tool]! }] : []))

const byFirst = (a: readonly string[], b: readonly string[]): number => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)

// 12 hex over the sorted parts' [name, cmd] and the sorted set readers' [tool, cmd].
function commandsHash(cfg: Config): string {
  const parts = (cfg.ship.lint ?? []).map((p) => [p.name, p.cmd]).sort(byFirst)
  const readers = setReaders(cfg).map((r) => [r.tool, r.cmd]).sort(byFirst)
  return createHash('sha256').update(JSON.stringify([parts, readers])).digest('hex').slice(0, 12)
}

export function lintEffectKey(cfg: Config, plan: string, effect: string): string {
  return `${plan}.${effect}.${commandsHash(cfg)}`
}

const KEY_RE = /^([0-9a-f]{40}|[0-9a-f]{64})\.([0-9a-f]{40}|[0-9a-f]{64})\.([0-9a-f]{12})$/
export function parseLintEffectKey(key: string): { plan: string; effect: string; h12: string } | undefined {
  const m = KEY_RE.exec(key)
  return m ? { plan: m[1]!, effect: m[2]!, h12: m[3]! } : undefined
}

// Whether the config as it stands gives `key`'s commands: a key it no longer gives is never owed.
export const currentEffectKey = (cfg: Config, key: string): boolean => parseLintEffectKey(key)?.h12 === commandsHash(cfg)

// One hidden diagnostic: a reader's key on the effect tree beyond the plan's tree's count. `key` is
// `loosenedKey` (16 hex over tool, rule, file and the normalized line the effect tree holds); `line` the
// first new copy's; `lineless` where the diagnostic had none (a whole-file diagnostic).
export interface EffectHit { tool: ReaderTool; rule: string; file: string; line?: number; key: string; count: number; lineless?: true }
// `parts` each part's exit on the plan's tree and on the effect tree (0 passed, 1 not); `readers` each set
// reader, with why it could not be read on a side; `over` the hits past the result's size.
export interface LintEffectResult {
  plan: string; effect: string
  parts: Array<{ part: string; plan: 0 | 1; effect: 0 | 1 }>
  readers: Array<{ tool: ReaderTool; unread?: string }>
  hits: EffectHit[]
  over?: number
}

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const HIT_KEY_RE = /^[0-9a-f]{16}$/
const PART_RE = /^[a-z][a-z0-9-]{0,39}$/
const exactKeys = (x: Obj, need: readonly string[], may: readonly string[] = []): boolean =>
  need.every((k) => k in x) && Object.keys(x).every((k) => need.includes(k) || may.includes(k))
// A reader's rule id: '' for none (ESLint's fatal parse errors), '?' for one outside RULE_RE (lint-readers).
export const isRule = (r: unknown): r is string => typeof r === 'string' && (r === '' || r === '?' || RULE_RE.test(r))
const isTool = (t: unknown): t is ReaderTool => typeof t === 'string' && (READER_TOOLS as readonly string[]).includes(t)
const isPositive = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1

function effectHit(x: unknown): EffectHit | undefined {
  if (!isObj(x) || !exactKeys(x, ['tool', 'rule', 'file', 'key', 'count'], ['line', 'lineless'])) return undefined
  if (!isTool(x.tool) || !isRule(x.rule) || typeof x.file !== 'string' || x.file === '' || x.file.length > 1000) return undefined
  if (typeof x.key !== 'string' || !HIT_KEY_RE.test(x.key) || !isPositive(x.count)) return undefined
  if (x.line !== undefined && !isPositive(x.line)) return undefined
  if (x.lineless !== undefined && (x.lineless !== true || x.line !== undefined)) return undefined
  return {
    tool: x.tool, rule: x.rule, file: x.file, ...(x.line !== undefined ? { line: x.line as number } : {}),
    key: x.key, count: x.count as number, ...(x.lineless === true ? { lineless: true as const } : {}),
  }
}

// A shard's result as this kind writes it, exactly; anything else is malformed (undefined).
export function lintEffectResult(x: unknown): LintEffectResult | undefined {
  if (!isObj(x) || !exactKeys(x, ['plan', 'effect', 'parts', 'readers', 'hits'], ['over'])) return undefined
  if (typeof x.plan !== 'string' || !SHA_RE.test(x.plan) || typeof x.effect !== 'string' || !SHA_RE.test(x.effect)) return undefined
  if (!Array.isArray(x.parts) || !Array.isArray(x.readers) || !Array.isArray(x.hits)) return undefined
  const exit = (n: unknown): n is 0 | 1 => n === 0 || n === 1
  const parts: LintEffectResult['parts'] = []
  for (const p of x.parts) {
    if (!isObj(p) || !exactKeys(p, ['part', 'plan', 'effect']) || typeof p.part !== 'string' || !PART_RE.test(p.part)) return undefined
    if (!exit(p.plan) || !exit(p.effect)) return undefined
    parts.push({ part: p.part, plan: p.plan, effect: p.effect })
  }
  const readers: LintEffectResult['readers'] = []
  for (const r of x.readers) {
    if (!isObj(r) || !exactKeys(r, ['tool'], ['unread']) || !isTool(r.tool)) return undefined
    if (r.unread !== undefined && (typeof r.unread !== 'string' || r.unread.length > 200)) return undefined
    readers.push({ tool: r.tool, ...(typeof r.unread === 'string' ? { unread: r.unread } : {}) })
  }
  const hits: EffectHit[] = []
  for (const h of x.hits) {
    const hit = effectHit(h)
    if (hit === undefined) return undefined
    hits.push(hit)
  }
  if (x.over !== undefined && !isPositive(x.over)) return undefined
  return { plan: x.plan, effect: x.effect, parts, readers, hits, ...(x.over !== undefined ? { over: x.over as number } : {}) }
}

// The keys a plan's last implement and last ship gate-runs left on their `definitions` check's `owes`, of
// this kind, whose commands the config gives today.
export function effectOwes(root: string, cfg: Config, plan: string): string[] {
  const entries = readStream(root, plan)
  const out: string[] = []
  for (const gate of ['implement', 'ship']) {
    const run = lastGateRun(entries, gate)
    const checks: unknown[] = Array.isArray(run?.checks) ? run.checks : []
    const defs = checks.find((c): c is Obj => isObj(c) && c.name === 'definitions')
    const owes: unknown[] = Array.isArray(defs?.owes) ? defs.owes : []
    for (const o of owes) {
      if (isObj(o) && o.kind === LINT_EFFECT && typeof o.key === 'string' && currentEffectKey(cfg, o.key)) out.push(o.key)
    }
  }
  return out
}

function owed(root: string, cfg: Config, canon: Canon): JobUnit[] {
  const seen = new Set<string>()
  const out: JobUnit[] = []
  for (const doc of canon.docs) {
    if (doc.meta.type !== 'plan' || doc.meta.status !== 'in-progress' || typeof doc.meta.id !== 'string') continue
    for (const key of effectOwes(root, cfg, doc.meta.id)) {
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind: LINT_EFFECT, key, shards: 1 })
    }
  }
  return out
}

const cut = (s: string): string => s.slice(0, 200)

// The line `file` holds at `line` in `dir`: a relative path with no `..` segment, reached through no
// linked parent, that is a regular file; undefined otherwise.
function lineIn(dir: string, file: string, line: number, cache: Map<string, string[] | undefined>): string | undefined {
  if (file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split('/').includes('..')) return undefined
  if (!cache.has(file)) {
    let lines: string[] | undefined
    try {
      if (parentsInTree(dir, file) && lstatSync(join(dir, file)).isFile()) lines = readFileSync(join(dir, file), 'utf8').split(/\r?\n/)
    } catch { /* unreadable: the reader's own snippet keys it */ }
    cache.set(file, lines)
  }
  return cache.get(file)?.[line - 1]
}

// A diagnostic with the snippet its hit is keyed by: the normalized line the tree holds where it has a
// line (so the merge stamp can find it again in a merged tree, src/diagnostics.ts `hiddenInTree`), else
// the reader's own.
interface Read { diagnostics: Array<Diagnostic & { keySnippet: string }>; unread?: string }
interface Side { exits: Record<string, 0 | 1>; readers: Map<ReaderTool, Read> }

// One side's step (row 258's contract): every part, then every set reader, keeping a diagnostic only on a
// non-empty file the side's tree tracks (a part's build output never counts). Lint has no load rule.
function sideStep(dir: string, ctx: Ctx, cfg: Config, tracked: ReadonlySet<string>): Result<CfStep<Side>> {
  const exits: Record<string, 0 | 1> = {}
  for (const part of cfg.ship.lint ?? []) {
    const run = execCommand(dir, ctx, part.cmd, { turn: false })
    if (run.signal !== undefined) return refuse([{ ...interrupted(run.signal), field: part.source }])
    exits[part.name] = run.exitZero ? 0 : 1
  }
  const readers = new Map<ReaderTool, Read>()
  const cache = new Map<string, string[] | undefined>()
  for (const { tool, cmd } of setReaders(cfg)) {
    const read = readPart(dir, ctx, tool, cmd)
    if (!read.ok) {
      const first = read.violations[0]!
      if (first.rule === 'run-interrupted') return read
      readers.set(tool, { diagnostics: [], unread: cut(`${first.rule}: ${first.got}`) })
      continue
    }
    const diagnostics = read.value.diagnostics.filter((d) => d.file !== '' && tracked.has(d.file)).map((d) => {
      const text = d.line !== undefined ? lineIn(dir, d.file, d.line, cache) : undefined
      return { ...d, keySnippet: text !== undefined ? normalizeSnippet(text) : d.snippet }
    })
    readers.set(tool, { diagnostics })
  }
  return ok({ value: { exits, readers }, load: [] })
}

const order = (a: EffectHit, b: EffectHit): number =>
  a.file !== b.file ? (a.file < b.file ? -1 : 1)
    : (a.line ?? 0) !== (b.line ?? 0) ? (a.line ?? 0) - (b.line ?? 0)
      : a.tool !== b.tool ? (a.tool < b.tool ? -1 : 1)
        : a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0

// Per tool read on both sides, the effect tree's diagnostics beyond the plan's tree's count, off the
// restored definitions, folded by `loosenedKey`.
function hidden(plan: Side, effect: Side, changed: ReadonlySet<string>): EffectHit[] {
  const out: EffectHit[] = []
  for (const [tool, mine] of plan.readers) {
    const theirs = effect.readers.get(tool)
    if (mine.unread !== undefined || theirs === undefined || theirs.unread !== undefined) continue
    const off = <T extends Diagnostic>(ds: readonly T[]) => ds.filter((d) => !changed.has(d.file))
    const fresh = newDiagnostics(off(theirs.diagnostics), keyCounts(off(mine.diagnostics))) as Array<Diagnostic & { keySnippet: string }>
    const folded = new Map<string, EffectHit>()
    for (const d of fresh) {
      const key = loosenedKey({ tool, rule: d.rule, file: d.file, snippet: d.keySnippet })
      const hit = folded.get(key)
      if (hit !== undefined) { hit.count++; continue }
      folded.set(key, {
        tool, rule: d.rule, file: d.file, ...(d.line !== undefined ? { line: d.line } : {}), key, count: 1,
        ...(d.line === undefined ? { lineless: true as const } : {}),
      })
    }
    out.push(...folded.values())
  }
  return out.sort(order)
}

// The hits that fit within EFFECT_RESULT_BYTES of result JSON, in order; `over` the rest.
function trimmed(head: Omit<LintEffectResult, 'hits' | 'over'>, hits: readonly EffectHit[]): LintEffectResult {
  // `,"over":<n>` and the commas between hits are counted against the cap too.
  let size = Buffer.byteLength(JSON.stringify({ ...head, hits: [] })) + `,"over":${hits.length}`.length
  const kept: EffectHit[] = []
  for (const h of hits) {
    const add = Buffer.byteLength(JSON.stringify(h)) + (kept.length > 0 ? 1 : 0)
    if (size + add > EFFECT_RESULT_BYTES) break
    size += add
    kept.push(h)
  }
  const over = hits.length - kept.length
  return { ...head, hits: kept, ...(over > 0 ? { over } : {}) }
}

function run(root: string, ctx: Ctx, cfg: Config, unit: JobUnit): JobResult {
  const parsed = parseLintEffectKey(unit.key)
  if (parsed === undefined || parsed.h12 !== commandsHash(cfg)) {
    return { outcome: 'failed', why: 'the lint commands changed since its gate asked — the next gate asks again' }
  }
  if (objectType(root, parsed.plan) !== 'commit' || objectType(root, parsed.effect) !== 'commit') {
    return { outcome: 'failed', why: 'a tree its gate pinned is gone' }
  }
  const untrusted = effectCommands(cfg).find((c) => !trustedNow(root, ctx.env, c.cmd))
  if (untrusted !== undefined) return { outcome: 'failed', why: cut(`untrusted: ${shownCmd(untrusted)}`) }
  const side = (commit: string): Result<Side> => {
    const tracked = new Set(treePaths(root, commit))
    const r = inScratch(root, ctx, cfg, { tree: commit }, (dir) => sideStep(dir, ctx, cfg, tracked))
    return r.ok ? ok(r.value.value) : r
  }
  // Both sides under one scratch hold (re-entrant: the job verb already holds it).
  const both = withScratchLock(root, ctx, cfg.drive.sessionTimeoutMs, () => {
    const p = side(parsed.plan)
    if (!p.ok) return p
    const e = side(parsed.effect)
    return e.ok ? ok({ p: p.value, e: e.value }) : e
  })
  if (!both.ok) return { outcome: 'failed', why: cut(`${both.violations[0]!.rule}: ${both.violations[0]!.got}`) }
  const diff = tryGit(root, 'diff', '--name-only', '-z', '--no-renames', parsed.plan, parsed.effect)
  if (!diff.ok) return { outcome: 'failed', why: 'the restored definitions could not be listed' }
  const changed = new Set(diff.out.split('\0').filter((x) => x !== ''))
  const { p, e } = both.value
  const head = {
    plan: parsed.plan, effect: parsed.effect,
    parts: (cfg.ship.lint ?? []).map((part) => ({ part: part.name, plan: p.exits[part.name]!, effect: e.exits[part.name]! })),
    readers: setReaders(cfg).map(({ tool }) => {
      const unread = e.readers.get(tool)?.unread ?? p.readers.get(tool)?.unread
      return { tool, ...(unread !== undefined ? { unread } : {}) }
    }),
  }
  return { outcome: 'done', result: trimmed(head, hidden(p, e, changed)) }
}

export const lintEffectKind: JobKind = {
  kind: LINT_EFFECT, turn: false, gated: true, scratch: true,
  commands: effectCommands,
  boxMs: () => LINT_EFFECT_BOX_MS,
  owed,
  run: (root, ctx, cfg, unit) => run(root, ctx, cfg, unit),
}
