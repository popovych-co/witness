import { globToRegExp } from './glob.js'

// Row 277. The files a repo uses to define its checks (spec §3.7): `checks.definitions` lists them,
// and the implement and ship gates fold the base's copy of each one a plan modified or deleted back
// into the plan's tree, to see what the plan's own definitions hide (the lint effect, §4 T3).

// One entry: a repo path or glob, and optionally one top-level member of a JSON object
// (`package.json#scripts`), restored on its own so the plan's other edits to the file stand.
export interface DefinitionEntry { glob: string; member?: string }

// Row 277 (settled point 3). Lint and format configs, `tsconfig*`, package.json scripts, `.gitignore`
// and its kin, test-runner and mutation configs, and the Rust, Python and Go linters' own files.
// TOML sections (`Cargo.toml [lints]`) wait for a consumer to probe; setup files are code.
export const DEFAULT_DEFINITIONS: readonly string[] = [
  '.gitignore', '.eslintignore', '.prettierignore', '.editorconfig', 'biome.json', 'biome.jsonc',
  'eslint.config.*', '.eslintrc*', 'prettier.config.*', '.prettierrc*', 'tsconfig*.json', 'jsconfig*.json',
  'package.json#scripts', 'vitest.config.*', 'vitest.workspace.*', 'jest.config.*', 'playwright.config.*',
  'stryker.config.*', 'stryker.conf.*', 'clippy.toml', '.clippy.toml', 'rustfmt.toml', '.rustfmt.toml',
  'ruff.toml', '.ruff.toml', '.golangci.*',
]

const GLOB_RE = /^[A-Za-z0-9._*@+/-]{1,200}$/
const MEMBER_RE = /^[A-Za-z0-9_.@-]{1,100}$/

// An entry as the setting holds it, or undefined outside its rules: the glob's characters and
// length, never a leading `/`, no empty, `.` or `..` segment, and at most one `#member`.
export function definitionEntry(raw: string): DefinitionEntry | undefined {
  const at = raw.indexOf('#')
  const glob = at < 0 ? raw : raw.slice(0, at)
  const member = at < 0 ? undefined : raw.slice(at + 1)
  if (!GLOB_RE.test(glob) || glob.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return undefined
  if (member === undefined) return { glob }
  return MEMBER_RE.test(member) ? { glob, member } : undefined
}

const matcher = new Map<string, RegExp>()
const regexOf = (glob: string): RegExp => {
  let re = matcher.get(glob)
  if (re === undefined) matcher.set(glob, (re = globToRegExp(glob)))
  return re
}

// The first entry naming `path`: one without a `/` reads the basename at any depth, one with a `/`
// the whole path from the root.
export function definitionFor(entries: readonly DefinitionEntry[], path: string): DefinitionEntry | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return entries.find((e) => regexOf(e.glob).test(e.glob.includes('/') ? path : base))
}

// An ignore file (`.gitignore`, `.prettierignore`, …) can only hide: an added one is removed from
// the tree the base's definitions see.
export const isIgnoreFile = (path: string): boolean => /^\.[a-z]+ignore$/.test(path.slice(path.lastIndexOf('/') + 1))
