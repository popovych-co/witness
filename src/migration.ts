import { checkPin } from './pin.js'
import { ok, refuse, v, type Result } from './refusal.js'
import {
  GATE_NAMES, SCHEMA_FINGERPRINTS, SETTINGS, defaultAt, getIn, knownAt, nest, withValues, type Setting,
} from './settings.js'

// Row 193 §4.6–§4.8. One migration, two modes. `memory` is how loadConfig reads an older file:
// it writes nothing and moves no value the file holds — a moved value would be a behavior
// change with no committed diff — so it only reshapes (the schema steps) and fills what is
// missing with the current default. `write` is `witness migrate`'s, and it alone fills what
// an older file left ambient and moves values still at an old default.

export type ChangeKind = 'added' | 'filled' | 'expanded' | 'moved'
export interface Change { kind: ChangeKind; path: string; from?: unknown; to: unknown }

type Raw = Record<string, unknown>

const isMap = (x: unknown): x is Raw => typeof x === 'object' && x !== null && !Array.isArray(x)

export const newestSchema = (): number => Math.max(...Object.keys(SCHEMA_FINGERPRINTS).map(Number))
const oldestSchema = (): number => Math.min(...Object.keys(SCHEMA_FINGERPRINTS).map(Number))

// The sections of a list: every proper prefix of a setting's path ('drive', 'drive.caps').
export function sectionsOf(known: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  for (const p of known) {
    const parts = p.split('.')
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('.'))
  }
  return out
}

// Keys an older schema did not know meant nothing to it, so a memory read drops them before
// reshaping: a schema-1 `arbiter:` block must not become schema 2's arbiter pin. `docs` and
// `drive` already refused unknown keys at schema 1, so theirs stay for the resolver to refuse.
function prune(raw: Raw, known: ReadonlySet<string>): Raw {
  const sections = sectionsOf(known)
  const walk = (obj: Raw, prefix: string): Raw => {
    const out: Raw = {}
    for (const [key, val] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (!prefix && key === 'schema') out[key] = val
      else if (known.has(path)) out[key] = val
      else if (sections.has(path)) out[key] = isMap(val) ? walk(val, path) : val
      else if (path.startsWith('docs.') || path.startsWith('drive.')) out[key] = val
    }
    return out
  }
  return walk(raw, '')
}

// Final review I1. YAML's empty value — `key:` with nothing after it, or a section whose every
// line is commented out — means unset, and 0.20.0 read it so wherever it read loosely; an upgrade
// must not refuse such a file. The one exception is `session`: the context adapter reads an empty
// value there as no limit (row 191 §4.6), so the CLI keeps refusing it and the two agree.
const EMPTY_REFUSED: ReadonlySet<string> = new Set(['session', 'session.contextLimit'])

export function withoutEmpty(raw: Raw): Raw {
  const walk = (obj: Raw, prefix: string): Raw => {
    const out: Raw = {}
    for (const [key, val] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (val === null && !EMPTY_REFUSED.has(path)) continue
      out[key] = isMap(val) ? walk(val, path) : val
    }
    return out
  }
  return walk(raw, '')
}

// A setting can be filled only where every section above it is a map or absent: filling
// under `session: 20` would hide the invalid section the resolver must refuse.
function fillable(raw: Raw, path: string): boolean {
  const parts = path.split('.')
  for (let i = 1; i < parts.length; i++) {
    const above = getIn(raw, parts.slice(0, i).join('.'))
    if (above !== undefined && !isMap(above)) return false
  }
  return true
}

const PIN_WANT = '[provider/]model[:thinking]'

// Lists by position, maps by key set: a reviewer list equal to the old built-in one is at the
// default whatever order the file wrote its map keys in (§4.7).
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  }
  if (!isMap(a) || !isMap(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && deepEqual(a[k], b[k]))
}

// 1 → 2 (§4.3): nothing inherited. Each gate keeps its own pin, else takes `gates.model`; the
// arbiter, which read `gates.model` alone (row 172), takes it as `arbiter.model`; `gates.model`
// goes. An invalid `gates.model` refuses under its own name, before anything is copied from it.
function expandGatesModel(raw: Raw, changes: Change[]): Result<Raw> {
  const gates = raw.gates
  if (!isMap(gates) || !('model' in gates)) return ok(raw)
  const gm = gates.model
  if (typeof gm !== 'string') return refuse([v('gates.model', 'pin-malformed', String(gm), PIN_WANT)])
  const checked = checkPin('gates.model', gm)
  if (!checked.ok) return refuse(checked.violations)
  const next: Raw = {}
  for (const [k, val] of Object.entries(gates)) if (k !== 'model') next[k] = val
  for (const g of GATE_NAMES) {
    const block = next[g]
    if (block !== undefined && !isMap(block)) continue
    if (block?.model !== undefined) continue
    next[g] = { ...(block ?? {}), model: gm }
    changes.push({ kind: 'expanded', path: `gates.${g}.model`, from: 'gates.model', to: gm })
  }
  changes.push({ kind: 'expanded', path: 'arbiter.model', from: 'gates.model', to: gm })
  return ok({ ...raw, gates: next, arbiter: { model: gm } })
}

// Structural steps, keyed by the schema they leave.
const STEPS: Record<number, (raw: Raw, changes: Change[]) => Result<Raw>> = {
  1: expandGatesModel,
}

export function migrateValues(raw: Raw, from: number, opts: {
  mode: 'memory' | 'write'; to?: number; settings?: readonly Setting[]; harness?: string
}): Result<{ raw: Raw; changes: Change[] }> {
  const write = opts.mode === 'write'
  const list = opts.settings ?? SETTINGS
  const to = opts.to ?? newestSchema()
  const changes: Change[] = []
  let out = prune(structuredClone(raw), knownAt(Math.max(from, oldestSchema()), list))
  for (let s = from; s < to; s++) {
    const step = STEPS[s]
    if (step === undefined) continue
    const r = step(out, changes)
    if (!r.ok) return refuse(r.violations)
    out = r.value
  }
  // §4.7. A value still equal to the default of the schema it was written under was never a
  // choice: each step moves it to the next default. A different value is a choice, and stays.
  // Only a write moves anything — in memory a move would change behavior with no diff (§4.8).
  if (write) {
    for (let s = Math.max(from, oldestSchema()); s < to; s++) {
      for (const st of list) {
        const val = getIn(out, st.path)
        const was = defaultAt(st, s)
        const next = defaultAt(st, s + 1)
        if (val === undefined || was === undefined || next === undefined || deepEqual(was, next) || !deepEqual(val, was)) continue
        out = withValues(out, nest(st.path, next))
        changes.push({ kind: 'moved', path: st.path, from: val, to: next })
      }
    }
  }
  // What is missing takes the current default. An ambient setting meant something else while
  // absent (the judge ladder, the session default, "not configured"), so only a write fills it —
  // the judge with the session's own harness — and names it `filled`.
  for (const s of list) {
    if (s.since > to || getIn(out, s.path) !== undefined || !fillable(out, s.path)) continue
    if (s.ambient && !write) continue
    const d = write && s.path === 'harness' && opts.harness !== undefined ? opts.harness : defaultAt(s, to)
    if (d === undefined) continue
    out = withValues(out, nest(s.path, d))
    changes.push({ kind: s.ambient ? 'filled' : 'added', path: s.path, to: d })
  }
  if (write) out = { ...out, schema: to }
  return ok({ raw: out, changes })
}

// Row 193 §4.8. What an older file is read as, and what `witness migrate` would write, in one
// line — printed where config warnings print and filed by `check` as `older-schema`.
export function olderSchemaWarning(from: number, to: number, changes: readonly Change[]): string {
  const added = changes.filter((c) => c.kind === 'added').map((c) => c.path)
  const parts: string[] = []
  if (added.length) {
    const named = [...added.slice(0, 3), ...(added.length > 3 ? ['…'] : [])].join(' · ')
    parts.push(`adds ${added.length} setting${added.length === 1 ? '' : 's'} (${named})`)
  }
  if (changes.some((c) => c.kind === 'expanded')) parts.push('expands gates.model')
  parts.push('refreshes comments')
  return `schema ${from} is older than this witness (${to}) — witness migrate ${parts.join(' · ')}`
}
