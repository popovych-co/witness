import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { migrateValues, newestSchema, sectionsOf } from './migration.js'
import { checkPin } from './pin.js'
import { ok, refuse, v, type Result, type Violation } from './refusal.js'
import {
  CHANGE_CLASSES, GATE_NAMES, RETIRED, SETTINGS, defaultAt, getIn, knownAt, settingAt,
  type Battery, type GateName, type Setting,
} from './settings.js'

export const SCHEMA_VERSION = 1

export interface CanonPaths {
  specs: string
  plans: string
  designs: string
}

// Every DEFAULT_* below is the list's (settings.ts), read at schema 1, where each was born.
const listDefault = <T>(path: string): T => defaultAt(settingAt(path)!, 1) as T

export const DEFAULT_PATHS: CanonPaths = {
  specs: listDefault('paths.specs'), plans: listDefault('paths.plans'), designs: listDefault('paths.designs'),
}

export const DOC_KEYS = ['conventions', 'design'] as const
export type DocKey = (typeof DOC_KEYS)[number]
export type DocsRegistry = Partial<Record<DocKey, string[]>>

export const DEFAULT_STEPS_PER_DISPATCH: number = listDefault('implement.stepsPerDispatch')
export interface ImplementConfig { stepsPerDispatch: number }

// Row 191 §4.2. The default 20 is the row's premise (§1): once a session's context is more
// than about 20% full, its output gets worse. A repo decision, so its one home is
// witness.config.yaml, never config.local.yaml (row 90).
export const DEFAULT_CONTEXT_LIMIT: number = listDefault('session.contextLimit')
export interface SessionConfig { contextLimit: number }

// D145. One hour. An implement slice is ~25 minutes at the default budget of 3 steps,
// and the cost of the two errors is not symmetric: a generous ceiling wastes an hour
// once, a starved one kills a working e2e run and hands the human a false `spawn-timeout`
// to debug. The ceiling exists to break a hung child, not to pace a healthy one.
export const DEFAULT_SESSION_TIMEOUT_MS: number = listDefault('drive.sessionTimeoutMs')

// Rows 181 and 183. Drive runs up to `parallel` sessions at once, one per target (design
// §11 call 5). The caps park a target that will not converge; their defaults are fewhats's
// 2026-10-19 calibration (B5): rounds = the largest normal merged plan's 13 implement rounds
// plus one budget window · upstream = where the human abandoned thread-mirror-plan-1 ·
// spawns = half again over the busiest normal merged plan's 16 sessions · wall clock = 16 h,
// over the slowest normal merged plan's ~14 h in worktree sessions.
export const DEFAULT_PARALLEL: number = listDefault('drive.parallel')
export interface DriveCaps { rounds: number; upstream: number; spawns: number; wallClockMs: number }
export const DEFAULT_CAPS: DriveCaps = {
  rounds: listDefault('drive.caps.rounds'), upstream: listDefault('drive.caps.upstream'),
  spawns: listDefault('drive.caps.spawns'), wallClockMs: listDefault('drive.caps.wallClockMs'),
}

// `parallelSuites` (row 181): test runs take turns across worktrees unless this is true.
export interface DriveConfig { sessionTimeoutMs: number; parallel: number; parallelSuites: boolean; caps: DriveCaps }

export const DEFAULT_REVIEWER_TIMEOUT_MS: number = listDefault('gates.reviewerTimeoutMs')

// Row 193 §4.3: nothing inherited. Each gate states its own model and reviewers. `model` is
// undefined only for an older file that never pinned one, read in memory: the chain decides.
export interface GateSettings { model?: string; reviewers: Battery }
export type GatesConfig = { reviewerTimeoutMs: number } & Record<GateName, GateSettings>

// `report` undefined = none.
export interface CriteriaConfig { runner?: string; report?: string; exclude: string[] }

// Row 174. How `witness ship` merges its own PR under autonomy. Configured, never detected:
// a style inferred from history would change the day someone merged one PR by hand.
export type MergeStyle = 'merge' | 'squash' | 'rebase'
// `ciSettleMs` (row 174): how long a check set must sit still before green counts. gh's
// watch ends the moment nothing is pending, so a check that registers a few seconds late —
// Actions behind an instant CLA status — would otherwise merge before it ever ran.
export interface ShipConfig { test?: string; lint?: string; branch: string; merge: MergeStyle; ciSettleMs: number }
export const DEFAULT_CI_SETTLE_MS: number = listDefault('ship.ciSettleMs')
// Bounded by the watch window (30 minutes): a longer settle can never be met, and past
// 2^31-1 ms a Node timer fires at once — the window would silently become zero.
export const MAX_CI_SETTLE_MS = 1_800_000

// Every setting, typed. The optional members are undefined only for an older file read in
// memory (its `ambient` settings: the judge ladder, the model chain, "not configured"); a
// schema-2 file states them all.
export interface Config {
  schema: number
  paths: CanonPaths
  docs: DocsRegistry
  criteria: CriteriaConfig
  ship: ShipConfig
  harness?: string
  // Rows 171-175. Whether the CLI settles its own stops is a REPO fact — committed, read by
  // every teammate's CLI alike — so it lives here and never in config.local.yaml. Spelled as
  // the strings `on | off` and nothing else: YAML 1.1 reads `yes`/`on` as booleans and 1.2
  // does not, so accepting booleans would make the same file mean two things across parsers.
  autonomy: boolean
  arbiter: { model?: string }
  session: SessionConfig
  implement: ImplementConfig
  gates: GatesConfig
  drive: DriveConfig
  warning?: string
}

export type Resolved = Omit<Config, 'schema' | 'warning'>

// ── Checking one value by its shape ──────────────────────────────────────────────────────────

type Raw = Record<string, unknown>
const isMap = (val: unknown): val is Raw => typeof val === 'object' && val !== null && !Array.isArray(val)
const shown = (val: unknown): string => (typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val))

// A repo-relative path, trailing slashes dropped, never escaping the repo nor inside .witness/.
function relPath(field: string, val: string, what: 'directory' | 'file path'): Result<string> {
  const norm = val.replace(/\/+$/, '')
  if (isAbsolute(norm) || norm.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return refuse([v(field, 'invalid', norm, `a repo-relative ${what} without . or .. segments`)])
  }
  if (norm === '.witness' || norm.startsWith('.witness/')) {
    return refuse([v(field, 'reserved', norm, what === 'directory' ? 'a directory outside .witness/' : 'a path outside .witness/')])
  }
  return ok(norm)
}

const isNameList = (val: unknown): val is string[] =>
  Array.isArray(val) && val.length > 0 && val.every((x) => typeof x === 'string' && x !== '')

// The value's own rule, with today's codes and texts. Returns the typed value: a path
// normalized, `report: none` as undefined.
export function checkValue(s: Setting, val: unknown): Result<unknown> {
  const field = s.path
  const invalid = () => refuse<unknown>([v(field, 'invalid', shown(val), s.want)])
  const shape = s.shape
  switch (shape.kind) {
    case 'int':
      return typeof val === 'number' && Number.isInteger(val) && val >= shape.min && (shape.max === undefined || val <= shape.max)
        ? ok(val) : invalid()
    case 'bool':
      return typeof val === 'boolean' ? ok(val) : invalid()
    case 'enum':
      return typeof val === 'string' && shape.values.includes(val) ? ok(val) : invalid()
    case 'text':
      return typeof val === 'string' && val !== '' ? ok(val) : invalid()
    case 'dir':
      return typeof val === 'string' && val !== '' ? relPath(field, val, 'directory') : invalid()
    case 'files': {
      if (!Array.isArray(val) || !val.every((x) => typeof x === 'string' && x !== '')) return invalid()
      const out: string[] = []
      const violations: Violation[] = []
      for (const p of val as string[]) {
        const r = relPath(field, p, 'file path')
        if (r.ok) out.push(r.value)
        else violations.push(...r.violations)
      }
      return violations.length ? refuse(violations) : ok(out)
    }
    case 'globs':
      return Array.isArray(val) && val.every((x) => typeof x === 'string' && x !== '') ? ok(val) : invalid()
    case 'runner':
      if (typeof val !== 'string' || val === '') return invalid()
      return val === 'full-suite' || val.includes('{id}')
        ? ok(val)
        : refuse([v(field, 'no-id-placeholder', val, 'template must interpolate {id} (or use full-suite)')])
    case 'report':
      if (val === 'none') return ok(undefined)
      return typeof val === 'string' && val.startsWith('junit:') ? ok(val) : refuse([v(field, 'report-format', shown(val), s.want)])
    case 'pin':
      return typeof val === 'string' ? checkPin(field, val) : refuse([v(field, 'pin-malformed', shown(val), s.want)])
    case 'battery': {
      // Row 13, amended by 193: a plain list is every class; a per-class map names all three,
      // refused when the file loads rather than the first time that class reaches the gate.
      if (isNameList(val)) return ok(val)
      const perClass = isMap(val) && Object.keys(val).length === CHANGE_CLASSES.length
        && CHANGE_CLASSES.every((c) => isNameList(val[c]))
      return perClass ? ok(val) : refuse([v(field, 'battery-shape', shown(val), s.want)])
    }
  }
}

// ── Walking the file ─────────────────────────────────────────────────────────────────────────

const SECTION_WANTS: Record<string, string> = {
  docs: 'a map of doc keys to path lists',
  implement: 'a map of implement-stage settings',
  session: 'a map of session settings',
  gates: 'a map of gate settings',
  drive: 'a map of drive settings',
  'drive.caps': 'a map of cap settings',
}
const sectionWant = (path: string) => SECTION_WANTS[path] ?? `a map of ${path} settings`

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return row[b.length]!
}

// The setting an unknown key most likely meant: the closest in the same section, within two edits.
export function suggestionFor(path: string, known: ReadonlySet<string>): string | undefined {
  const parent = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : ''
  const leaf = path.slice(parent ? parent.length + 1 : 0)
  let best: { path: string; d: number } | undefined
  for (const k of [...known, ...sectionsOf(known)]) {
    const kParent = k.includes('.') ? k.slice(0, k.lastIndexOf('.')) : ''
    if (kParent !== parent) continue
    const d = editDistance(leaf, k.slice(kParent ? kParent.length + 1 : 0))
    if (d <= 2 && (best === undefined || d < best.d)) best = { path: k, d }
  }
  return best?.path
}

const DRIVE_KEYS = ['sessionTimeoutMs', 'parallel', 'parallelSuites', 'caps']
const CAP_KEYS = ['rounds', 'upstream', 'spawns', 'wallClockMs']

// One unknown key's refusal. `docs` and `drive` refused unknown keys before row 193 and keep
// their rules and their enumerating wants; every other section's is row 193's `unknown-key`.
export function unknownKey(path: string, known: ReadonlySet<string>): Violation {
  const leaf = path.slice(path.lastIndexOf('.') + 1)
  if (path.startsWith('docs.')) {
    return v(path, 'unknown-doc-key', leaf, `a key with a shipped consumer (${DOC_KEYS.join(' | ')})`)
  }
  if (path.startsWith('drive.caps.')) return v(path, 'unknown-drive-key', leaf, `a cap (${CAP_KEYS.join(' | ')})`)
  if (path.startsWith('drive.')) return v(path, 'unknown-drive-key', leaf, `a drive setting (${DRIVE_KEYS.join(' | ')})`)
  const retired = RETIRED.find((r) => r.path === path)
  if (retired) return v(path, 'unknown-key', path, retired.instead)
  const near = suggestionFor(path, known)
  return v(path, 'unknown-key', path, near
    ? `a witness setting — did you mean ${near}?`
    : 'a witness setting — the comments in witness.config.yaml list them')
}

// Keys the list does not know, and sections that are not maps. Lenient mode — an older file,
// read as its schema read it — ignores unknown keys outside `docs` and `drive`.
function walkKeys(raw: Raw, known: ReadonlySet<string>, mode: 'strict' | 'lenient'): { violations: Violation[]; broken: string[] } {
  const sections = sectionsOf(known)
  const violations: Violation[] = []
  const broken: string[] = []
  const walk = (obj: Raw, prefix: string) => {
    for (const [key, val] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (!prefix && key === 'schema') continue
      if (known.has(path)) continue
      if (sections.has(path)) {
        if (isMap(val)) walk(val, path)
        else { broken.push(path); violations.push(v(path, 'invalid', shown(val), sectionWant(path))) }
        continue
      }
      if (mode === 'lenient' && !path.startsWith('docs.') && !path.startsWith('drive.')) continue
      violations.push(unknownKey(path, known))
    }
  }
  walk(raw, '')
  return { violations, broken }
}

// Row 193 §4.2. The line that restores a missing setting, in the file's own words.
function missing(s: Setting): Violation {
  const parent = s.path.includes('.') ? s.path.slice(0, s.path.lastIndexOf('.')) : undefined
  const leaf = s.path.slice(parent ? parent.length + 1 : 0)
  const d = defaultAt(s, newestSchema())
  const inline = Array.isArray(d) ? `[${d.join(', ')}]`
    : isMap(d) ? `{ ${Object.entries(d).map(([k, x]) => `${k}: [${(x as string[]).join(', ')}]`).join(', ')} }`
    : String(d)
  return v(s.path, 'missing-setting', 'absent',
    `${leaf}: ${inline}${parent ? ` under ${parent}:` : ''} — or run witness migrate`)
}

// Row 193 §4.1. The one resolver: every setting checked by its shape and returned typed.
// `strict` is a current-schema file: every setting present, nothing unknown. `lenient` is an
// older file after the in-memory upgrade: unknown keys are ignored as its schema ignored them,
// and an ambient setting it never stated stays undefined.
export function resolveSettings(raw: Raw, mode: 'strict' | 'lenient'): Result<Resolved> {
  const known = knownAt(newestSchema())
  const { violations, broken } = walkKeys(raw, known, mode)
  const vals = new Map<string, unknown>()
  for (const s of SETTINGS) {
    if (broken.some((b) => s.path.startsWith(`${b}.`))) continue
    const val = getIn(raw, s.path)
    if (val === undefined) {
      if (mode === 'strict' || !s.ambient) violations.push(missing(s))
      continue
    }
    const r = checkValue(s, val)
    if (r.ok) vals.set(s.path, r.value)
    else violations.push(...r.violations)
  }
  if (violations.length === 0) violations.push(...overlaps(
    vals.get('paths.specs') as string, vals.get('paths.plans') as string, vals.get('paths.designs') as string))
  if (violations.length) return refuse(violations)

  const at = <T>(path: string): T => vals.get(path) as T
  const docs: DocsRegistry = {}
  for (const key of DOC_KEYS) {
    const list = at<string[]>(`docs.${key}`)
    if (list.length) docs[key] = list
  }
  const gates = { reviewerTimeoutMs: at<number>('gates.reviewerTimeoutMs') } as GatesConfig
  for (const g of GATE_NAMES) gates[g] = { model: at<string | undefined>(`gates.${g}.model`), reviewers: at<Battery>(`gates.${g}.reviewers`) }
  return ok({
    paths: { specs: at('paths.specs'), plans: at('paths.plans'), designs: at('paths.designs') },
    docs,
    criteria: { runner: at('criteria.runner'), report: at('criteria.report'), exclude: at('criteria.exclude') },
    ship: {
      test: at('ship.test'), lint: at('ship.lint'), branch: at('ship.branch'),
      merge: at('ship.merge'), ciSettleMs: at('ship.ciSettleMs'),
    },
    harness: at('harness'),
    autonomy: at<string>('autonomy') === 'on',
    arbiter: { model: at('arbiter.model') },
    session: { contextLimit: at('session.contextLimit') },
    implement: { stepsPerDispatch: at('implement.stepsPerDispatch') },
    gates,
    drive: {
      sessionTimeoutMs: at('drive.sessionTimeoutMs'), parallel: at('drive.parallel'), parallelSuites: at('drive.parallelSuites'),
      caps: {
        rounds: at('drive.caps.rounds'), upstream: at('drive.caps.upstream'),
        spawns: at('drive.caps.spawns'), wallClockMs: at('drive.caps.wallClockMs'),
      },
    },
  })
}

// Scans are recursive, so the three canon roots must be distinct and never contain each other.
function overlaps(specs: string, plans: string, designs: string): Violation[] {
  const out: Violation[] = []
  const roots: Array<[string, string]> = [['specs', specs], ['plans', plans], ['designs', designs]]
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const [ka, a] = roots[i]!
      const [kb, b] = roots[j]!
      if (a === b) {
        out.push(v('paths', 'overlap', `${ka}=${kb}=${a}`, 'distinct specs, plans and designs directories'))
      } else if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        out.push(v('paths', 'nested', `${a} vs ${b}`, 'directories that do not contain each other (scans are recursive)'))
      }
    }
  }
  return out
}

// One section read through the list, for callers without a loaded Config: absent settings
// take their default, present ones their shape's rule.
function sectionOf<T>(raw: Raw, section: string, keys: readonly string[]): Result<Record<string, T>> {
  const conf = raw[section]
  if (conf !== undefined && !isMap(conf)) return refuse([v(section, 'invalid', shown(conf), sectionWant(section))])
  const out: Record<string, T> = {}
  const violations: Violation[] = []
  for (const key of keys) {
    const s = settingAt(`${section}.${key}`)!
    const val = getIn(raw, s.path)
    const r = val === undefined ? ok(defaultAt(s, 1)) : checkValue(s, val)
    if (r.ok) out[key] = r.value as T
    else violations.push(...r.violations)
  }
  return violations.length ? refuse(violations) : ok(out)
}

// Seam: the canon roots alone (canonPaths, the canon scan).
export function resolvePaths(raw: Raw): Result<CanonPaths> {
  const r = sectionOf<string>(raw, 'paths', ['specs', 'plans', 'designs'])
  if (!r.ok) return refuse(r.violations)
  const { specs, plans, designs } = r.value as unknown as CanonPaths
  const bad = overlaps(specs, plans, designs)
  return bad.length ? refuse(bad) : ok({ specs, plans, designs })
}

// Seam: the context limit alone — what the dependency-free adapter reader must agree with
// (row 191 §4.6, tests/context-core.test.ts).
export function resolveSession(raw: Raw): Result<SessionConfig> {
  const r = sectionOf<number>(raw, 'session', ['contextLimit'])
  return r.ok ? ok({ contextLimit: r.value.contextLimit! }) : refuse(r.violations)
}

// Row 171 (F11). Autonomy is a COMMITTED repo fact: on only when HEAD's witness.config.yaml
// says so as well. A working-copy edit — the coding agent's, say — grants nothing, because
// the setting it would grant is merge authority over that agent's own work. `autonomyAt` reads
// any revision: the merge asks the shipped branch's remote copy (row 174), a fact the agent
// cannot make true with a local commit.
export function autonomyAt(root: string, rev: string): boolean {
  try {
    const text = execFileSync('git', ['show', `${rev}:witness.config.yaml`],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return ((parseYaml(text) ?? {}) as Record<string, unknown>).autonomy === 'on'
  } catch {
    return false
  }
}
const committedAutonomy = (root: string): boolean => autonomyAt(root, 'HEAD')

// Machine facts live in ONE gitignored file with a closed key set (row 90): a key in
// the wrong home refuses, so no repo↔local precedence rule can exist. Deliberately
// NOT wired into loadConfig — same doctrine as harness resolution (row 87): an
// unread key must not brick `witness check`; the four reviewer/opener boundaries
// load it, and check reports its violations as findings.
export interface LocalConfig {
  reviewerExtensions: string[]
  opener?: string
  notify?: string                  // row 184: drive's run summary is its one argument
}

const LOCAL_KEYS = ['reviewerExtensions', 'opener', 'notify'] as const

export const localConfigPath = (root: string) => join(root, '.witness', 'config.local.yaml')

export function loadLocalConfig(root: string): Result<LocalConfig> {
  const p = localConfigPath(root)
  if (!existsSync(p)) return ok({ reviewerExtensions: [] })
  let raw: unknown
  try {
    raw = parseYaml(readFileSync(p, 'utf8'))
  } catch (e) {
    return refuse([v('.witness/config.local.yaml', 'yaml-parse',
      String((e as Error).message).slice(0, 120), 'valid YAML')])
  }
  const obj = (raw ?? {}) as Record<string, unknown>
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    return refuse([v('.witness/config.local.yaml', 'invalid', String(obj), 'a map of machine-local keys')])
  }
  const violations: Violation[] = []
  for (const key of Object.keys(obj)) {
    if (!(LOCAL_KEYS as readonly string[]).includes(key)) {
      violations.push(v(key, 'unknown-local-key', key,
        `a machine-local key (${LOCAL_KEYS.join(' | ')}) — repo facts belong in witness.config.yaml`))
    }
  }
  let reviewerExtensions: string[] = []
  const ext = obj.reviewerExtensions
  if (ext !== undefined) {
    if (!Array.isArray(ext) || !ext.every((x) => typeof x === 'string' && x !== '')) {
      violations.push(v('reviewerExtensions', 'invalid', JSON.stringify(ext),
        'a list of extension paths handed to the harness reviewer spawn'))
    } else {
      reviewerExtensions = ext as string[]
    }
  }
  let opener: string | undefined
  if (obj.opener !== undefined) {
    if (typeof obj.opener !== 'string' || obj.opener === '') {
      violations.push(v('opener', 'invalid', String(obj.opener), 'a command name or path'))
    } else {
      opener = obj.opener
    }
  }
  let notify: string | undefined
  if (obj.notify !== undefined) {
    if (typeof obj.notify !== 'string' || obj.notify === '') {
      violations.push(v('notify', 'invalid', String(obj.notify),
        'a command name or path — it receives the run summary as its one argument'))
    } else {
      notify = obj.notify
    }
  }
  if (violations.length) return refuse(violations)
  return ok({ reviewerExtensions, ...(opener !== undefined ? { opener } : {}), ...(notify !== undefined ? { notify } : {}) })
}

// Lenient path resolution for callers without a loaded Config (canon scan, git
// state scoping): a missing or broken config falls back to the defaults — the
// verbs own the refusal messaging via loadConfig, which validates paths strictly.
export function canonPaths(root: string): CanonPaths {
  const p = configPath(root)
  if (!existsSync(p)) return DEFAULT_PATHS
  try {
    const raw = (parseYaml(readFileSync(p, 'utf8')) ?? {}) as Record<string, unknown>
    const resolved = resolvePaths(raw)
    return resolved.ok ? resolved.value : DEFAULT_PATHS
  } catch {
    return DEFAULT_PATHS
  }
}

export const configPath = (root: string) => join(root, 'witness.config.yaml')

export function loadConfig(root: string): Result<Config> {
  const p = configPath(root)
  if (!existsSync(p)) {
    return refuse([v('witness.config.yaml', 'missing', 'no config at repo root', 'run witness init')])
  }
  let raw: unknown
  try {
    raw = parseYaml(readFileSync(p, 'utf8'))
  } catch (e) {
    return refuse([v('witness.config.yaml', 'yaml-parse', String((e as Error).message).slice(0, 120), 'valid YAML')])
  }
  const obj = (raw ?? {}) as Record<string, unknown>
  const schema = obj.schema
  if (typeof schema !== 'number' || !Number.isInteger(schema)) {
    return refuse([v('schema', 'required', String(schema ?? 'absent'), 'integer schema version')])
  }
  if (schema > SCHEMA_VERSION) {
    return refuse([v('schema', 'newer-than-cli', String(schema), `<=${SCHEMA_VERSION} — upgrade witness`)])
  }
  // Row 193 §4.8. An older file is read through the same migration `witness migrate` runs,
  // in memory: missing settings take today's defaults, and nothing the file holds moves.
  const older = schema < newestSchema()
  let values: Record<string, unknown> = obj
  if (older) {
    const m = migrateValues(obj, schema, { mode: 'memory' })
    if (!m.ok) return refuse(m.violations)
    values = m.value.raw
  }
  const r = resolveSettings(values, older ? 'lenient' : 'strict')
  if (!r.ok) return refuse(r.violations)
  const uncommitted = r.value.autonomy && !committedAutonomy(root)
  return ok({
    schema,
    ...r.value,
    autonomy: r.value.autonomy && !uncommitted,
    warning: schema < SCHEMA_VERSION ? `schema ${schema} < ${SCHEMA_VERSION} — run witness migrate (reserved)`
      : uncommitted ? 'autonomy: on is not committed — it stays off until witness.config.yaml is committed'
      : undefined,
  })
}
