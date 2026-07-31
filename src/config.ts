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
  return ok({
    schema,
    raw: obj,
    paths: paths.value,
    docs: docs.value,
    implement: implement.value,
    warning: schema < SCHEMA_VERSION ? `schema ${schema} < ${SCHEMA_VERSION} — run witness migrate (reserved)` : undefined,
  })
}
