// Rows 261–262. `ship.lint`'s parts and the readers bound to them, as repo commands: what trust
// grants, migrate proposes and the base-lint job runs.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RunCommand } from './allowlist.js'
import type { Config, LintPart } from './config.js'
import { readBiomeConfig } from './lint-config.js'
import { READER_TOOLS, type ReaderTool } from './settings.js'

// Row 262. The reader whose tool is the part's name, when one is set. Any other part is opaque.
export function boundReader(cfg: Config, part: LintPart): { tool: ReaderTool; cmd: string } | undefined {
  const tool = READER_TOOLS.find((t) => t === part.name)
  const cmd = tool !== undefined ? cfg.readers[tool] : undefined
  return tool !== undefined && cmd !== undefined ? { tool, cmd } : undefined
}

// Every part under its own source, in file order, then each part's bound reader.
export function lintCommands(cfg: Config): RunCommand[] {
  const parts = cfg.ship.lint ?? []
  const readers = parts.flatMap((p) => {
    const r = boundReader(cfg, p)
    return r !== undefined ? [{ cmd: r.cmd, source: `readers.${r.tool}` }] : []
  })
  return [...parts.map((p) => ({ cmd: p.cmd, source: p.source })), ...readers]
}

const ESLINT_CONFIGS: readonly string[] = [
  ...['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map((x) => `eslint.config.${x}`),
  ...['js', 'cjs', 'json', 'yml', 'yaml'].map((x) => `.eslintrc.${x}`),
]

// The root lockfile's exec form, first match; none without a lockfile.
function execForm(root: string): string | undefined {
  const has = (f: string) => existsSync(join(root, f))
  if (has('pnpm-lock.yaml')) return 'pnpm exec'
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return 'npx --no'
  if (has('yarn.lock')) return 'yarn'
  if (has('bun.lock') || has('bun.lockb')) return 'bunx'
  return undefined
}

// Row 262. Biome and ESLint readers from their root configs, run through the root lockfile's exec
// form. tsc and clippy are never detected: their paths depend on where they run.
export function detectReaders(root: string): Record<string, string> {
  const exec = execForm(root)
  if (exec === undefined) return {}
  const out: Record<string, string> = {}
  if (readBiomeConfig(root) !== undefined) out['readers.biome'] = `${exec} biome check --reporter=sarif .`
  if (ESLINT_CONFIGS.some((f) => existsSync(join(root, f)))) out['readers.eslint'] = `${exec} eslint -f json .`
  return out
}
