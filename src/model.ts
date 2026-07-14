import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import type { Config } from './config.js'
import { ok, refuse, v, type Result } from './refusal.js'

export const MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable', 'default', 'latest']
export const SESSION_DEFAULT = 'session-default'

export interface MatrixInfo { shipped: string[]; local: string[] }

export function shippedMatrixPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'calibration.yaml')
}

function readModels(path: string): string[] {
  if (!existsSync(path)) return []
  const doc = parse(readFileSync(path, 'utf8')) as { models?: unknown } | null
  return Array.isArray(doc?.models) ? doc.models.map(String) : []
}

export function loadMatrix(root: string): MatrixInfo {
  return {
    shipped: readModels(shippedMatrixPath()),
    local: readModels(join(root, '.specflow', 'calibration.local.yaml')),
  }
}

export interface ModelResolution {
  chain: string[]
  calibrationOf(id: string): 'shipped' | 'local' | 'none'
  warning?: string
}

export function resolveModel(cfg: Config, matrix: MatrixInfo): Result<ModelResolution> {
  const gates = (cfg.raw.gates ?? {}) as { model?: unknown }
  const pin = gates.model === undefined ? undefined : String(gates.model)
  if (pin !== undefined && MODEL_ALIASES.includes(pin)) {
    return refuse([v('gates.model', 'alias-refused', pin,
      'an exact model id — aliases re-point under the calibration (Decision 55)')])
  }
  const calibrated = [...matrix.shipped, ...matrix.local.filter((m) => !matrix.shipped.includes(m))]
  const chain: string[] = []
  if (pin !== undefined) chain.push(pin)
  for (const m of calibrated) if (!chain.includes(m)) chain.push(m)
  chain.push(SESSION_DEFAULT)

  const calibrationOf = (id: string): 'shipped' | 'local' | 'none' =>
    matrix.shipped.includes(id) ? 'shipped' : matrix.local.includes(id) ? 'local' : 'none'

  const head = chain[0]!
  const warning = calibrationOf(head) === 'none'
    ? `reviewer model ${head === SESSION_DEFAULT ? '(session default)' : head} is below the model floor — no calibration matrix entry covers it`
    : undefined
  return ok({ chain, calibrationOf, warning })
}
