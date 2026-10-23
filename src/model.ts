import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import type { Config } from './config.js'
import type { HarnessName } from './harness.js'
import { checkPin } from './pin.js'
import type { GateName } from './settings.js'
import { ok, refuse, type Result } from './refusal.js'

export { MODEL_ALIASES } from './pin.js'
export const SESSION_DEFAULT = 'session-default'

export interface MatrixInfo { shipped: string[]; local: string[] }

export function shippedMatrixPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'calibration.yaml')
}

interface MatrixDoc { models?: unknown; matrices?: Record<string, { models?: unknown } | undefined> }

// Per-(harness, model) calibration (Decision 88): a pi-invoked reviewer on the same
// model id is a DIFFERENT reviewer. Legacy top-level `models:` predates the harness
// dimension and was only ever measured through claude -p — it reads as claude-code.
function readModels(path: string, harness: HarnessName): string[] {
  if (!existsSync(path)) return []
  const doc = parse(readFileSync(path, 'utf8')) as MatrixDoc | null
  const scoped = doc?.matrices?.[harness]?.models
  if (Array.isArray(scoped)) return scoped.map(String)
  return harness === 'claude-code' && Array.isArray(doc?.models) ? doc.models.map(String) : []
}

export function loadMatrix(root: string, harness: HarnessName): MatrixInfo {
  return {
    shipped: readModels(shippedMatrixPath(), harness),
    local: readModels(join(root, '.witness', 'calibration.local.yaml'), harness),
  }
}

export interface ModelResolution {
  chain: string[]
  calibrationOf(id: string): 'shipped' | 'local' | 'none'
  warning?: string
  // Which fact the warning states. `matrix-empty` is a property of this witness BUILD
  // — calibration.yaml ships `models: []`, so it held for every user, every model,
  // every run since 0.1.x — and belongs on the orientation surfaces once. `below-floor`
  // is a property of the caller's own pin and stays per-run news (D98a).
  warningKind?: 'matrix-empty' | 'below-floor'
}

// A stage's model pin, from its own setting (row 193: nothing inherited). A gate's pin drives
// its reviewers AND, for implement, its worker agent; the arbiter's is its own (row 172).
// Undefined only for an older file that never pinned one: the calibration chain decides.
export function stagePin(cfg: Config, role: GateName | 'arbiter'): Result<string | undefined> {
  const pin = role === 'arbiter' ? cfg.arbiter.model : cfg.gates[role].model
  if (pin === undefined) return ok(undefined)
  const checked = checkPin(role === 'arbiter' ? 'arbiter.model' : `gates.${role}.model`, pin)
  return checked.ok ? ok(pin) : refuse(checked.violations)
}

export function resolveModel(cfg: Config, matrix: MatrixInfo, role: GateName | 'arbiter'): Result<ModelResolution> {
  const pinR = stagePin(cfg, role)
  if (!pinR.ok) return refuse(pinR.violations)
  const pin = pinR.value
  const calibrated = [...matrix.shipped, ...matrix.local.filter((m) => !matrix.shipped.includes(m))]
  const chain: string[] = []
  if (pin !== undefined) chain.push(pin)
  for (const m of calibrated) if (!chain.includes(m)) chain.push(m)
  chain.push(SESSION_DEFAULT)

  const calibrationOf = (id: string): 'shipped' | 'local' | 'none' =>
    matrix.shipped.includes(id) ? 'shipped' : matrix.local.includes(id) ? 'local' : 'none'

  const head = chain[0]!
  const headLabel = head === SESSION_DEFAULT ? '(session default)' : head
  const matrixEmpty = matrix.shipped.length === 0 && matrix.local.length === 0
  const warningKind = calibrationOf(head) !== 'none'
    ? undefined
    : matrixEmpty ? 'matrix-empty' as const : 'below-floor' as const
  const warning = warningKind === undefined
    ? undefined
    : warningKind === 'matrix-empty'
      ? `calibration matrix is empty — no calibrated model exists yet; ${headLabel} runs uncalibrated`
      : `reviewer model ${headLabel} is below the model floor — no calibration matrix entry covers it`
  return ok({ chain, calibrationOf, warning, warningKind })
}

// One renderer for both orientation surfaces (`status` and `check`). Lives here because
// the grouping rule — one line per distinct warning, labelled with the gates it covers —
// is a property of the resolution, not of either screen. Returns `[]` when every gate's
// model is calibrated.
export function modelFloorLines(root: string, cfg: Config, harness: HarnessName): string[] {
  const matrix = loadMatrix(root, harness)
  const byWarning = new Map<string, string[]>()
  for (const gate of ['decompose', 'plan', 'implement', 'ship', 'design'] as const) {
    const r = resolveModel(cfg, matrix, gate)
    if (r.ok && r.value.warning) {
      byWarning.set(r.value.warning, [...(byWarning.get(r.value.warning) ?? []), gate])
    }
  }
  return [...byWarning].map(([warning, gates]) => `${gates.join(' · ')}: ${warning}`)
}
