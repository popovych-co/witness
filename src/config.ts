import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ok, refuse, v, type Result, type Violation } from './refusal.js'

export const SCHEMA_VERSION = 1

export interface CanonPaths {
  specs: string
  plans: string
}

export const DEFAULT_PATHS: CanonPaths = { specs: 'specs', plans: 'plans' }

export interface Config {
  schema: number
  raw: Record<string, unknown>
  paths: CanonPaths
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
    if (norm === '.specflow' || norm.startsWith('.specflow/')) {
      violations.push(v(`paths.${key}`, 'reserved', norm, 'a directory outside .specflow/'))
      return DEFAULT_PATHS[key]
    }
    return norm
  }
  const specs = pick('specs')
  const plans = pick('plans')
  if (violations.length === 0) {
    if (specs === plans) {
      violations.push(v('paths', 'overlap', `${specs} = ${plans}`, 'distinct specs and plans directories'))
    } else if (specs.startsWith(`${plans}/`) || plans.startsWith(`${specs}/`)) {
      violations.push(v('paths', 'nested', `${specs} vs ${plans}`, 'directories that do not contain each other (canon scan is recursive)'))
    }
  }
  return violations.length ? refuse(violations) : ok({ specs, plans })
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

export const configPath = (root: string) => join(root, 'specflow.config.yaml')

export function loadConfig(root: string): Result<Config> {
  const p = configPath(root)
  if (!existsSync(p)) {
    return refuse([v('specflow.config.yaml', 'missing', 'no config at repo root', 'run specflow init')])
  }
  let raw: unknown
  try {
    raw = parseYaml(readFileSync(p, 'utf8'))
  } catch (e) {
    return refuse([v('specflow.config.yaml', 'yaml-parse', String((e as Error).message).slice(0, 120), 'valid YAML')])
  }
  const obj = (raw ?? {}) as Record<string, unknown>
  const schema = obj.schema
  if (typeof schema !== 'number' || !Number.isInteger(schema)) {
    return refuse([v('schema', 'required', String(schema ?? 'absent'), 'integer schema version')])
  }
  if (schema > SCHEMA_VERSION) {
    return refuse([v('schema', 'newer-than-cli', String(schema), `<=${SCHEMA_VERSION} — upgrade specflow`)])
  }
  const paths = resolvePaths(obj)
  if (!paths.ok) return refuse(paths.violations)
  return ok({
    schema,
    raw: obj,
    paths: paths.value,
    warning: schema < SCHEMA_VERSION ? `schema ${schema} < ${SCHEMA_VERSION} — run specflow migrate (reserved)` : undefined,
  })
}
