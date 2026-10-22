import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ok, refuse, v, type Result, type Violation } from './refusal.js'

export const SCHEMA_VERSION = 1

export interface CanonPaths {
  specs: string
  plans: string
  designs: string
}

export const DEFAULT_PATHS: CanonPaths = { specs: 'specs', plans: 'plans', designs: 'designs' }

export const DOC_KEYS = ['conventions', 'design'] as const
export type DocKey = (typeof DOC_KEYS)[number]
export type DocsRegistry = Partial<Record<DocKey, string[]>>

export interface Config {
  schema: number
  raw: Record<string, unknown>
  paths: CanonPaths
  docs: DocsRegistry
  implement: ImplementConfig
  session: SessionConfig
  gates: GatesConfig
  drive: DriveConfig
  autonomy: boolean
  ship: ShipConfig
  warning?: string
}

export function resolvePaths(raw: Record<string, unknown>): Result<CanonPaths> {
  const conf = (raw.paths ?? {}) as Record<string, unknown>
  const violations: Violation[] = []
  const pick = (key: keyof CanonPaths): string => {
    const val = conf[key]
    if (val === undefined) return DEFAULT_PATHS[key]
    if (typeof val !== 'string' || val === '') {
      violations.push(v(`paths.${key}`, 'invalid', String(val), 'a repo-relative directory'))
      return DEFAULT_PATHS[key]
    }
    const norm = val.replace(/\/+$/, '')
    if (isAbsolute(norm) || norm.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
      violations.push(v(`paths.${key}`, 'invalid', norm, 'a repo-relative directory without . or .. segments'))
      return DEFAULT_PATHS[key]
    }
    if (norm === '.witness' || norm.startsWith('.witness/')) {
      violations.push(v(`paths.${key}`, 'reserved', norm, 'a directory outside .witness/'))
      return DEFAULT_PATHS[key]
    }
    return norm
  }
  const specs = pick('specs')
  const plans = pick('plans')
  const designs = pick('designs')
  if (violations.length === 0) {
    const roots: Array<[string, string]> = [['specs', specs], ['plans', plans], ['designs', designs]]
    for (let i = 0; i < roots.length; i++) {
      for (let j = i + 1; j < roots.length; j++) {
        const [ka, a] = roots[i]!
        const [kb, b] = roots[j]!
        if (a === b) {
          violations.push(v('paths', 'overlap', `${ka}=${kb}=${a}`, 'distinct specs, plans and designs directories'))
        } else if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
          violations.push(v('paths', 'nested', `${a} vs ${b}`, 'directories that do not contain each other (scans are recursive)'))
        }
      }
    }
  }
  return violations.length ? refuse(violations) : ok({ specs, plans, designs })
}

export function resolveDocs(raw: Record<string, unknown>): Result<DocsRegistry> {
  const conf = raw.docs
  if (conf === undefined) return ok({})
  if (typeof conf !== 'object' || conf === null || Array.isArray(conf)) {
    return refuse([v('docs', 'invalid', String(conf), 'a map of doc keys to path lists')])
  }
  const violations: Violation[] = []
  const out: DocsRegistry = {}
  for (const [key, val] of Object.entries(conf as Record<string, unknown>)) {
    if (!(DOC_KEYS as readonly string[]).includes(key)) {
      violations.push(v(`docs.${key}`, 'unknown-doc-key', key,
        `a key with a shipped consumer (${DOC_KEYS.join(' | ')})`))
      continue
    }
    if (!Array.isArray(val) || val.length === 0 || !val.every((x) => typeof x === 'string' && x !== '')) {
      violations.push(v(`docs.${key}`, 'invalid', JSON.stringify(val), 'a non-empty list of repo-relative file paths'))
      continue
    }
    const paths: string[] = []
    for (const p of val as string[]) {
      const norm = p.replace(/\/+$/, '')
      if (isAbsolute(norm) || norm.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
        violations.push(v(`docs.${key}`, 'invalid', norm, 'a repo-relative file path without . or .. segments'))
        continue
      }
      if (norm === '.witness' || norm.startsWith('.witness/')) {
        violations.push(v(`docs.${key}`, 'reserved', norm, 'a path outside .witness/'))
        continue
      }
      paths.push(norm)
    }
    out[key as DocKey] = paths
  }
  return violations.length ? refuse(violations) : ok(out)
}

export const DEFAULT_STEPS_PER_DISPATCH = 3

export interface ImplementConfig {
  stepsPerDispatch: number
}

export function resolveImplement(raw: Record<string, unknown>): Result<ImplementConfig> {
  const conf = raw.implement
  if (conf === undefined) return ok({ stepsPerDispatch: DEFAULT_STEPS_PER_DISPATCH })
  if (typeof conf !== 'object' || conf === null || Array.isArray(conf)) {
    return refuse([v('implement', 'invalid', String(conf), 'a map of implement-stage settings')])
  }
  const val = (conf as Record<string, unknown>).stepsPerDispatch
  if (val === undefined) return ok({ stepsPerDispatch: DEFAULT_STEPS_PER_DISPATCH })
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
    return refuse([v('implement.stepsPerDispatch', 'invalid', String(val),
      'an integer >= 1 — steps handed to each fresh implement agent')])
  }
  return ok({ stepsPerDispatch: val })
}

// Row 191 §4.2. The default 20 is the row's premise (§1): once a session's context is more
// than about 20% full, its output gets worse. A repo decision, so its one home is
// witness.config.yaml, never config.local.yaml (row 90).
export const DEFAULT_CONTEXT_LIMIT = 20

export interface SessionConfig {
  contextLimit: number
}

export function resolveSession(raw: Record<string, unknown>): Result<SessionConfig> {
  const conf = raw.session
  if (conf === undefined) return ok({ contextLimit: DEFAULT_CONTEXT_LIMIT })
  if (typeof conf !== 'object' || conf === null || Array.isArray(conf)) {
    return refuse([v('session', 'invalid', String(conf), 'a map of session settings')])
  }
  const val = (conf as Record<string, unknown>).contextLimit
  if (val === undefined) return ok({ contextLimit: DEFAULT_CONTEXT_LIMIT })
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 1 || val > 100) {
    return refuse([v('session.contextLimit', 'invalid', String(val),
      'an integer from 1 to 100 — % of the session\'s context window at which witness hands over to a fresh session')])
  }
  return ok({ contextLimit: val })
}

// D145. One hour. An implement slice is ~25 minutes at the default budget of 3 steps,
// and the cost of the two errors is not symmetric: a generous ceiling wastes an hour
// once, a starved one kills a working e2e run and hands the human a false `spawn-timeout`
// to debug. The ceiling exists to break a hung child, not to pace a healthy one.
export const DEFAULT_SESSION_TIMEOUT_MS = 3_600_000

// Rows 181 and 183. Drive runs up to `parallel` sessions at once, one per target (design
// §11 call 5). The caps park a target that will not converge; their defaults are fewhats's
// 2026-10-19 calibration (B5): rounds = the largest normal merged plan's 13 implement rounds
// plus one budget window · upstream = where the human abandoned thread-mirror-plan-1 ·
// spawns = half again over the busiest normal merged plan's 16 sessions · wall clock = 16 h,
// over the slowest normal merged plan's ~14 h in worktree sessions.
export const DEFAULT_PARALLEL = 2
export interface DriveCaps { rounds: number; upstream: number; spawns: number; wallClockMs: number }
export const DEFAULT_CAPS: DriveCaps = { rounds: 16, upstream: 6, spawns: 24, wallClockMs: 57_600_000 }

// `parallelSuites` (row 181): test runs take turns across worktrees unless this is true.
export interface DriveConfig { sessionTimeoutMs: number; parallel: number; parallelSuites: boolean; caps: DriveCaps }

const DRIVE_WANTS: Record<string, string> = {
  sessionTimeoutMs: 'an integer >= 1 — milliseconds each spawned session may take before SIGTERM',
  parallel: 'an integer >= 1 — sessions drive runs at once · one per target',
}
const CAP_WANTS: Record<keyof DriveCaps, string> = {
  rounds: 'an integer >= 1 — gate rounds one target may run across budget resets before drive parks it',
  upstream: 'an integer >= 1 — upstream resets one target may take before drive parks it',
  spawns: 'an integer >= 1 — sessions one target may take in one drive run',
  wallClockMs: 'an integer >= 1 — milliseconds of session time one target may take in one drive run',
}
const DRIVE_KEYS = ['sessionTimeoutMs', 'parallel', 'parallelSuites', 'caps'] as const

const isCount = (val: unknown): val is number => typeof val === 'number' && Number.isInteger(val) && val >= 1
const isMap = (val: unknown): val is Record<string, unknown> =>
  typeof val === 'object' && val !== null && !Array.isArray(val)

// Strict: no consumer sets `drive:` today, so a typo'd key refusing costs nobody, while a
// typo'd cap silently defaulting would let a flow run past the bound its author meant.
export function resolveDrive(raw: Record<string, unknown>): Result<DriveConfig> {
  const conf = raw.drive
  const defaults: DriveConfig = {
    sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS, parallel: DEFAULT_PARALLEL, parallelSuites: false, caps: { ...DEFAULT_CAPS },
  }
  if (conf === undefined) return ok(defaults)
  if (!isMap(conf)) return refuse([v('drive', 'invalid', String(conf), 'a map of drive settings')])
  const violations: Violation[] = []
  for (const key of Object.keys(conf)) {
    if (!(DRIVE_KEYS as readonly string[]).includes(key)) {
      violations.push(v(`drive.${key}`, 'unknown-drive-key', key, `a drive setting (${DRIVE_KEYS.join(' | ')})`))
    }
  }
  const out = defaults
  for (const key of ['sessionTimeoutMs', 'parallel'] as const) {
    const val = conf[key]
    if (val === undefined) continue
    if (!isCount(val)) violations.push(v(`drive.${key}`, 'invalid', String(val), DRIVE_WANTS[key]!))
    else out[key] = val
  }
  if (conf.parallelSuites !== undefined) {
    if (typeof conf.parallelSuites !== 'boolean') {
      violations.push(v('drive.parallelSuites', 'invalid', String(conf.parallelSuites),
        'true | false — whether test runs in two worktrees may overlap'))
    } else {
      out.parallelSuites = conf.parallelSuites
    }
  }
  const caps = conf.caps
  if (caps !== undefined) {
    if (!isMap(caps)) {
      violations.push(v('drive.caps', 'invalid', String(caps), 'a map of cap settings'))
    } else {
      for (const key of Object.keys(caps)) {
        if (!(key in CAP_WANTS)) {
          violations.push(v(`drive.caps.${key}`, 'unknown-drive-key', key, `a cap (${Object.keys(CAP_WANTS).join(' | ')})`))
        }
      }
      for (const key of Object.keys(CAP_WANTS) as Array<keyof DriveCaps>) {
        const val = caps[key]
        if (val === undefined) continue
        if (!isCount(val)) violations.push(v(`drive.caps.${key}`, 'invalid', String(val), CAP_WANTS[key]))
        else out.caps[key] = val
      }
    }
  }
  if (violations.length) return refuse(violations)
  return ok(out)
}

export const DEFAULT_REVIEWER_TIMEOUT_MS = 600_000

export interface GatesConfig {
  reviewerTimeoutMs: number
}

// gates.* is otherwise read loosely at its consumers (stagePin); the timeout is
// resolved here, typed, because a typo'd key silently defaulting to ten minutes is
// exactly the ambient-value class row 90 removed from env.
export function resolveGates(raw: Record<string, unknown>): Result<GatesConfig> {
  const conf = raw.gates
  if (conf === undefined) return ok({ reviewerTimeoutMs: DEFAULT_REVIEWER_TIMEOUT_MS })
  if (typeof conf !== 'object' || conf === null || Array.isArray(conf)) {
    return refuse([v('gates', 'invalid', String(conf), 'a map of gate settings')])
  }
  const val = (conf as Record<string, unknown>).reviewerTimeoutMs
  if (val === undefined) return ok({ reviewerTimeoutMs: DEFAULT_REVIEWER_TIMEOUT_MS })
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
    return refuse([v('gates.reviewerTimeoutMs', 'invalid', String(val),
      'an integer >= 1 — milliseconds each reviewer invocation may take')])
  }
  return ok({ reviewerTimeoutMs: val })
}

// Rows 171-175. Whether the CLI settles its own stops is a REPO fact — committed, read by
// every teammate's CLI alike — so it lives here and never in config.local.yaml. Spelled as
// the strings `on | off` and nothing else: YAML 1.1 reads `yes`/`on` as booleans and 1.2
// does not, so accepting booleans would make the same file mean two things across parsers.
export function resolveAutonomy(raw: Record<string, unknown>): Result<boolean> {
  const val = raw.autonomy
  if (val === undefined) return ok(false)
  if (val === 'on') return ok(true)
  if (val === 'off') return ok(false)
  return refuse([v('autonomy', 'invalid', String(val), 'on | off')])
}

// Row 174. How `witness ship` merges its own PR under autonomy. Configured, never detected:
// a style inferred from history would change the day someone merged one PR by hand.
export type MergeStyle = 'merge' | 'squash' | 'rebase'
// `ciSettleMs` (row 174): how long a check set must sit still before green counts. gh's
// watch ends the moment nothing is pending, so a check that registers a few seconds late —
// Actions behind an instant CLA status — would otherwise merge before it ever ran.
export interface ShipConfig { merge: MergeStyle; ciSettleMs: number }
const MERGE_STYLES: readonly MergeStyle[] = ['merge', 'squash', 'rebase']
export const DEFAULT_CI_SETTLE_MS = 60_000
export const MAX_CI_SETTLE_MS = 1_800_000

// The rest of `ship.*` (test, lint, branch) is still read loosely at its consumers; only
// the key with a closed value set is resolved here, and only when `ship` is a map.
export function resolveShip(raw: Record<string, unknown>): Result<ShipConfig> {
  const conf = raw.ship
  if (typeof conf !== 'object' || conf === null || Array.isArray(conf)) return ok({ merge: 'merge', ciSettleMs: DEFAULT_CI_SETTLE_MS })
  const val = (conf as Record<string, unknown>).merge
  if (val !== undefined && (typeof val !== 'string' || !(MERGE_STYLES as readonly string[]).includes(val))) {
    return refuse([v('ship.merge', 'invalid', String(val), 'merge | squash | rebase')])
  }
  const settle = (conf as Record<string, unknown>).ciSettleMs
  // Bounded by the watch window (30 minutes): a longer settle can never be met, and past
  // 2^31-1 ms a Node timer fires at once — the window would silently become zero.
  if (settle !== undefined && (typeof settle !== 'number' || !Number.isInteger(settle) || settle < 0 || settle > MAX_CI_SETTLE_MS)) {
    return refuse([v('ship.ciSettleMs', 'invalid', String(settle),
      `an integer from 0 to ${MAX_CI_SETTLE_MS} — milliseconds a green check set must hold before witness merges`)])
  }
  return ok({ merge: (val ?? 'merge') as MergeStyle, ciSettleMs: (settle as number | undefined) ?? DEFAULT_CI_SETTLE_MS })
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
  const paths = resolvePaths(obj)
  if (!paths.ok) return refuse(paths.violations)
  const docs = resolveDocs(obj)
  if (!docs.ok) return refuse(docs.violations)
  const implement = resolveImplement(obj)
  if (!implement.ok) return refuse(implement.violations)
  const session = resolveSession(obj)
  if (!session.ok) return refuse(session.violations)
  const gates = resolveGates(obj)
  if (!gates.ok) return refuse(gates.violations)
  const drive = resolveDrive(obj)
  if (!drive.ok) return refuse(drive.violations)
  const autonomy = resolveAutonomy(obj)
  if (!autonomy.ok) return refuse(autonomy.violations)
  const shipCfg = resolveShip(obj)
  if (!shipCfg.ok) return refuse(shipCfg.violations)
  const uncommitted = autonomy.value && !committedAutonomy(root)
  return ok({
    schema,
    raw: obj,
    paths: paths.value,
    docs: docs.value,
    implement: implement.value,
    session: session.value,
    gates: gates.value,
    drive: drive.value,
    autonomy: autonomy.value && !uncommitted,
    ship: shipCfg.value,
    warning: schema < SCHEMA_VERSION ? `schema ${schema} < ${SCHEMA_VERSION} — run witness migrate (reserved)`
      : uncommitted ? 'autonomy: on is not committed — it stays off until witness.config.yaml is committed'
      : undefined,
  })
}
