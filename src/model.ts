import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import type { Config } from './config.js'
import type { HarnessName } from './harness.js'
import { parsePin } from './pin.js'
import { ok, refuse, v, type Result } from './refusal.js'

export const MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable', 'default', 'latest']
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
}

// the stage's model pin from config — per-gate wins over the global gates.model;
// the same pin drives that stage's gate reviewers AND its worker agent (implement)
export function stagePin(cfg: Config, gate?: string): Result<string | undefined> {
  const gates = (cfg.raw.gates ?? {}) as Record<string, unknown> & { model?: unknown }
  const gateBlock = gate !== undefined && typeof gates[gate] === 'object' && gates[gate] !== null
    ? (gates[gate] as { model?: unknown })
    : undefined
  const pinRaw = gateBlock?.model ?? gates.model
  const pinField = gateBlock?.model !== undefined ? `gates.${gate}.model` : 'gates.model'
  const pin = pinRaw === undefined ? undefined : String(pinRaw)
  if (pin !== undefined) {
    const parsed = parsePin(pinField, pin)
    if (!parsed.ok) return refuse(parsed.violations)
    if (MODEL_ALIASES.includes(parsed.value.model)) {
      return refuse([v(pinField, 'alias-refused', pin,
        'an exact model id — aliases re-point under the calibration (Decision 55)')])
    }
  }
  return ok(pin)
}

export function resolveModel(cfg: Config, matrix: MatrixInfo, gate?: string): Result<ModelResolution> {
  const pinR = stagePin(cfg, gate)
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
  const warning = calibrationOf(head) !== 'none'
    ? undefined
    : matrixEmpty
      ? `calibration matrix is empty — no calibrated model exists yet; ${headLabel} runs uncalibrated`
      : `reviewer model ${headLabel} is below the model floor — no calibration matrix entry covers it`
  return ok({ chain, calibrationOf, warning })
}
