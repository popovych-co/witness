// Row 263 (§3.2 base-red; correction C13). The base's lint result, measured on demand: a gate that
// finds a part red journals the base key it lacked (`pending`, or `not-measured` in chat mode, on
// its `lint` check), and the `base-lint` job — the first production kind — owes exactly those keys. A shard runs the part on
// the base commit in the scratch and, red with a bound reader, the reader there, and returns the
// base's diagnostics as hashed keys with counts. Keyed per part, base commit and commands, so an
// edited command never reads a stale result.
import { createHash } from 'node:crypto'
import { shownCmd, trustedNow } from './allowlist.js'
import type { Ctx } from './cli.js'
import { loadConfig, type Config, type LintPart } from './config.js'
import { diagnosticKey, readPart } from './diagnostics.js'
import { jobReading, type JobKind, type JobResult, type JobUnit } from './jobs.js'
import { readStream } from './journal.js'
import { boundReader, lintCommands } from './lint-parts.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { lastGateRun, type GateRunEntry } from './rounds.js'
import { partPasses } from './lint-lane.js'
import { execCommand, interrupted } from './runner.js'
import type { Canon } from './scan.js'
import { inScratch, type CfStep } from './scratch-checkout.js'
import { effectWait } from './lint-effect.js'

export const BASE_LINT = 'base-lint'
// One reset, one prepare (and a re-prepare's worth of slack), a part and its reader.
export const BASE_LINT_BOX_MS = 1_800_000
// A result rides one pipe write of at most 48 KiB (row 257): 2,000 keys of 16 hex with counts fit.
export const MAX_BASE_KEYS = 2_000

const KEY_RE = /^([a-z][a-z0-9-]{0,39})@([0-9a-f]{40}|[0-9a-f]{64})\.([0-9a-f]{12})$/

export function baseLintKey(part: LintPart, reader: string | undefined, commit: string): string {
  const h12 = createHash('sha256').update(JSON.stringify([part.cmd, reader ?? null])).digest('hex').slice(0, 12)
  return `${part.name}@${commit}.${h12}`
}

export function parseBaseKey(key: string): { part: string; commit: string; h12: string } | undefined {
  const m = KEY_RE.exec(key)
  return m ? { part: m[1]!, commit: m[2]!, h12: m[3]! } : undefined
}

export interface BaseLintResult {
  exit: 0 | 1; tree: string; commit: string; read?: { total: number; keys: Record<string, number> }; unread?: string
}

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const DIAG_KEY_RE = /^[0-9a-f]{16}$/

// A shard's result as this kind writes it, exactly; anything else is malformed (undefined).
export function baseLintResult(x: unknown): BaseLintResult | undefined {
  if (!isObj(x)) return undefined
  const allowed = new Set(['exit', 'tree', 'commit', 'read', 'unread'])
  if (Object.keys(x).some((k) => !allowed.has(k))) return undefined
  if (x.exit !== 0 && x.exit !== 1) return undefined
  if (typeof x.tree !== 'string' || !SHA_RE.test(x.tree) || typeof x.commit !== 'string' || !SHA_RE.test(x.commit)) return undefined
  if (x.read !== undefined && x.unread !== undefined) return undefined
  const out: BaseLintResult = { exit: x.exit, tree: x.tree, commit: x.commit }
  if (x.unread !== undefined) {
    if (typeof x.unread !== 'string' || x.unread.length > 200) return undefined
    out.unread = x.unread
  }
  if (x.read !== undefined) {
    const r = x.read
    if (!isObj(r) || Object.keys(r).some((k) => k !== 'total' && k !== 'keys') || !isObj(r.keys)) return undefined
    let sum = 0
    for (const [k, n] of Object.entries(r.keys)) {
      if (!DIAG_KEY_RE.test(k) || !Number.isInteger(n) || (n as number) < 1) return undefined
      sum += n as number
    }
    if (r.total !== sum) return undefined
    out.read = { total: sum, keys: { ...(r.keys as Record<string, number>) } }
  }
  return out
}

// Whether the config as it stands gives `key`: its part still exists with the same command and bound
// reader (slice 3 review). A key it no longer gives is never owed — run would refuse it, and the
// refusal would strike it — and the next gate asks for the current one.
function current(cfg: Config, key: string): boolean {
  const parsed = parseBaseKey(key)
  const part = parsed !== undefined ? cfg.ship.lint?.find((p) => p.name === parsed.part) : undefined
  return parsed !== undefined && part !== undefined && baseLintKey(part, boundReader(cfg, part)?.cmd, parsed.commit) === key
}

// The keys a plan's last implement and last ship gate-runs left missing on their `lint` check:
// `pending`, and `not-measured` (final review: a chat-mode round's key, so a drive started later
// lints it). `nextShard` runs only a unit whose result is missing, so a key struck twice or a
// malformed result is never run again.
const MISSING: ReadonlySet<unknown> = new Set(['pending', 'not-measured'])
function pendingKeys(root: string, plan: string): string[] {
  const entries = readStream(root, plan)
  const out: string[] = []
  for (const gate of ['implement', 'ship']) {
    const run = lastGateRun(entries, gate)
    const checks: unknown[] = Array.isArray(run?.checks) ? run.checks : []
    const lint = checks.find((c): c is Obj => isObj(c) && c.name === 'lint')
    const parts: unknown[] = Array.isArray(lint?.parts) ? lint.parts : []
    for (const p of parts) {
      if (isObj(p) && MISSING.has(p.state) && typeof p.key === 'string' && parseBaseKey(p.key) !== undefined) out.push(p.key)
    }
  }
  return out
}

// Row 267 (T2c's hand-off). What a checks-only round's lint is waiting on, read now: each part that did
// not pass, as `waiting` (drive will lint the base for it), `landed` (its input arrived since: the
// re-gate reads it) or `red` (nothing will arrive — the plan's own red). In this order, for a part
// whose journaled base was missing (`pending` or `not-measured`):
//   landed  the config no longer gives its key: the next gate keys it anew, and the key joins the
//           signature (`checksSignature`), so the round never resumes over it;
//   landed  its result is done and well formed;
//   red     done but malformed: the lane reads that not measured for good, and waiting on it would
//           loop the re-gate;
//   waiting its result is missing while a drive holds the repo and the job owes it — the key rides the
//           plan's last implement or ship run (`pendingKeys`, what `owed` reads; slice 3 review I1: a later
//           round of the gate that no longer asks for it owes nothing, and waiting on it would poll
//           forever) — unless scratch runs are off, when no job will run (red);
//   red     struck twice, no drive runs (nothing reads pending without one), or no job owes it.
// Every other part that did not pass is red, and so is a missing part with no key. All empty for any
// run but a checks-only round whose last check is lint, and for a config file that does not load.
// Row 277: a checks-only round whose last check is a red `definitions` waits on the lint effect alone
// (`effectWait`): `waiting` or `landed`, never `red`.
export interface BaseWait { waiting: string[]; landed: string[]; red: string[] }
export function baseWait(root: string, run: GateRunEntry): BaseWait {
  const out: BaseWait = { waiting: [], landed: [], red: [] }
  const effect = effectWait(root, run)
  if (effect !== undefined) {
    out[effect].push('definitions')
    return out
  }
  const lint = run.checks_only === true ? run.checks.at(-1) : undefined
  if (lint?.name !== 'lint' || lint.parts === undefined) return out
  const cfgR = loadConfig(root)
  if (!cfgR.ok) return out
  const cfg = cfgR.value
  const owes = new Set(pendingKeys(root, run.artifact))
  for (const p of lint.parts) {
    if (partPasses(p)) continue
    if (!MISSING.has(p.state) || p.key === undefined) { out.red.push(p.part); continue }
    if (!current(cfg, p.key)) { out.landed.push(p.part); continue }
    const reading = jobReading(root, { kind: BASE_LINT, key: p.key, shards: 1 })
    if (reading.state === 'done') (baseLintResult(reading.results[0]) !== undefined ? out.landed : out.red).push(p.part)
    else if (reading.state === 'pending' && cfg.scratch.prepare !== undefined && owes.has(p.key)) out.waiting.push(p.part)
    else out.red.push(p.part)
  }
  return out
}

// A stop whose every red part waits on drive's base lint, and no other.
export function awaitsDrive(w: BaseWait): boolean {
  return w.waiting.length > 0 && w.landed.length === 0 && w.red.length === 0
}

function owed(root: string, cfg: Config, canon: Canon): JobUnit[] {
  const seen = new Set<string>()
  const out: JobUnit[] = []
  for (const doc of canon.docs) {
    if (doc.meta.type !== 'plan' || doc.meta.status !== 'in-progress' || typeof doc.meta.id !== 'string') continue
    for (const key of pendingKeys(root, doc.meta.id)) {
      if (seen.has(key) || !current(cfg, key)) continue
      seen.add(key)
      out.push({ kind: BASE_LINT, key, shards: 1 })
    }
  }
  return out
}

type Step = Omit<BaseLintResult, 'tree' | 'commit'>
const cut = (s: string): string => s.slice(0, 200)

// The step (row 258's contract): the part on the base; red with a bound reader, the reader too.
// Lint has no load rule, so `load` is always [].
function step(dir: string, ctx: Ctx, part: LintPart, reader: { tool: Parameters<typeof readPart>[2]; cmd: string } | undefined):
Result<CfStep<Step>> {
  const run = execCommand(dir, ctx, part.cmd, { turn: false })
  if (run.signal !== undefined) return refuse([{ ...interrupted(run.signal), field: part.source }])
  if (run.exitZero) return ok({ value: { exit: 0 }, load: [] })
  if (reader === undefined) return ok({ value: { exit: 1 }, load: [] })
  const read = readPart(dir, ctx, reader.tool, reader.cmd)
  if (!read.ok) {
    const first = read.violations[0]!
    if (first.rule === 'run-interrupted') return read
    return ok({ value: { exit: 1, unread: cut(`${first.rule}: ${first.got}`) }, load: [] })
  }
  const keys: Record<string, number> = {}
  for (const d of read.value.diagnostics) {
    const k = diagnosticKey(d)
    keys[k] = (keys[k] ?? 0) + 1
  }
  const distinct = Object.keys(keys).length
  if (distinct > MAX_BASE_KEYS) {
    return ok({ value: { exit: 1, unread: `${distinct} distinct diagnostics on the base — more than one result holds` }, load: [] })
  }
  return ok({ value: { exit: 1, read: { total: read.value.diagnostics.length, keys } }, load: [] })
}

function run(root: string, ctx: Ctx, cfg: Config, unit: JobUnit): JobResult {
  const parsed = parseBaseKey(unit.key)
  const part = parsed !== undefined ? cfg.ship.lint?.find((p) => p.name === parsed.part) : undefined
  const reader = part !== undefined ? boundReader(cfg, part) : undefined
  if (parsed === undefined || part === undefined || baseLintKey(part, reader?.cmd, parsed.commit) !== unit.key) {
    return { outcome: 'failed', why: 'the part changed since its gate asked — the next gate asks again' }
  }
  const cmds = [{ cmd: part.cmd, source: part.source }, ...(reader ? [{ cmd: reader.cmd, source: `readers.${reader.tool}` }] : [])]
  const untrusted = cmds.find((c) => !trustedNow(root, ctx.env, c.cmd))
  if (untrusted !== undefined) return { outcome: 'failed', why: cut(`untrusted: ${shownCmd(untrusted)}`) }
  const r = inScratch(root, ctx, cfg, { tree: parsed.commit }, (dir) => step(dir, ctx, part, reader))
  if (!r.ok) return { outcome: 'failed', why: cut(`${r.violations[0]!.rule}: ${r.violations[0]!.got}`) }
  return { outcome: 'done', result: { ...r.value.value, tree: r.value.record.tree, commit: r.value.record.commit } }
}

export const baseLintKind: JobKind = {
  kind: BASE_LINT, turn: false, gated: true, scratch: true,
  commands: lintCommands,
  boxMs: () => BASE_LINT_BOX_MS,
  owed,
  run: (root, ctx, cfg, unit) => run(root, ctx, cfg, unit),
}
