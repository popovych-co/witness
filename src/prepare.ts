import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { trustedNow, UNGRANTABLE } from './allowlist.js'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { tryGit } from './gitio.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { execCommand } from './runner.js'
import { execFileSync } from './spawn.js'
import { hasControl, shellWord, visible } from './toon.js'

// Row 259. The setup command a repo's root lockfile names: what `init` writes and `migrate` fills
// as `scratch.prepare`. First match wins; a root with no JavaScript lockfile prepares nothing
// (`none`) — a Cargo workspace builds on demand, and a human states anything else.
export function detectPrepare(root: string): string {
  const has = (f: string) => existsSync(join(root, f))
  // Slice 2 review: run headless, pnpm aborts whenever the kept node_modules must be purged (a
  // hoisting setting that differs between trees, a pnpm upgrade) — ERR_PNPM_ABORTED_REMOVE_MODULES_
  // DIR_NO_TTY — so prepare would fail for good; the scratch's modules are always witness's to purge.
  if (has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile --config.confirm-modules-purge=false'
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return 'npm ci'
  if (has('yarn.lock')) return has('.yarnrc.yml') ? 'yarn install --immutable' : 'yarn install --frozen-lockfile'
  if (has('bun.lock') || has('bun.lockb')) return 'bun install --frozen-lockfile'
  return 'none'
}

// Row 259 (correction C11). What prepare's run depends on: tracked files at any depth whose base
// name is a lockfile or a package manager's own config — a built-in list, never a setting. A
// manifest's dependency edit moves its lockfile (`--frozen-lockfile` refuses otherwise), so
// `package.json` is left out: a scripts-only edit needs no reinstall. An input the list misses is
// caught by the load rule (row 258): a run that cannot load prepares again once.
export const PREPARE_INPUTS: readonly string[] = [
  'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.pnpmfile.cjs', '.npmrc', 'package-lock.json', 'npm-shrinkwrap.json',
  'yarn.lock', '.yarnrc', '.yarnrc.yml', '.pnp.cjs', 'bun.lock', 'bun.lockb', 'bunfig.toml', '.nvmrc', '.node-version',
  '.tool-versions', 'Cargo.lock', 'rust-toolchain', 'rust-toolchain.toml', 'poetry.lock', 'uv.lock', 'Pipfile.lock',
  'requirements.txt', 'go.sum', 'Gemfile.lock', 'composer.lock',
]
const INPUT_SET: ReadonlySet<string> = new Set(PREPARE_INPUTS)

// sha256 over `<mode> <sha>\t<path>\n` of each input `tree` holds, in ls-tree's order; '' for none.
export function prepareInputs(root: string, tree: string): string {
  const listed = execFileSync('git', ['ls-tree', '-r', '-z', tree], {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines: string[] = []
  for (const rec of listed.split('\0')) {
    const m = /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]+)$/.exec(rec)
    if (m && INPUT_SET.has(basename(m[3]!))) lines.push(`${m[1]} ${m[2]}\t${m[3]}\n`)
  }
  return lines.length === 0 ? '' : createHash('sha256').update(lines.join('')).digest('hex')
}

// The record of the last prepare that exited 0, in the scratch's own git dir: it lives and dies
// with the scratch and survives reset and clean. Removed before prepare starts and written after
// exit 0, so a prepare killed mid-way (drive stopping a job at its box) leaves none.
interface PrepareRecord { cmd: string; inputs: string }
const RECORD = 'witness-prepare.json'

function recordPath(dir: string): string | undefined {
  const r = tryGit(dir, 'rev-parse', '--path-format=absolute', '--git-dir')
  return r.ok ? join(r.out, RECORD) : undefined
}

function readRecord(p: string): PrepareRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<PrepareRecord>
    return typeof raw.cmd === 'string' && typeof raw.inputs === 'string' ? { cmd: raw.cmd, inputs: raw.inputs } : undefined
  } catch {
    return undefined
  }
}

// The output's reason: its last error line (`ERR_…`, `error`, `npm ERR!`, `fatal:`), else its last
// line — a package manager's trailing hint never names what failed (slice 2 review).
const lastLine = (text: string): string => {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const errors = lines.filter((l) => /^(ERR_|npm ERR!|error\b|Error\b|ERROR\b|fatal\b)/.test(l))
  return visible(errors.at(-1) ?? lines.at(-1) ?? 'no output').slice(0, 200)
}

// Prepares the scratch at `dir` (checked out at `tree`) when its inputs moved since the last
// prepare that exited 0, or when `force`d (the load rule's second try). Headless: an untrusted
// command refuses before it runs and never asks, even at a terminal — the human grants it.
export function prepareScratch(
  root: string, ctx: Ctx, cfg: Config, dir: string, tree: string, opts: { force?: boolean } = {},
): Result<{ ran: boolean; inputs: string }> {
  const cmd = cfg.scratch.prepare
  if (cmd === undefined) {
    return refuse([v('scratch.prepare', 'scratch-off', 'not set', 'a setup command, or none — witness migrate proposes one')])
  }
  const inputs = prepareInputs(root, tree)
  if (cmd === 'none') return ok({ ran: false, inputs })
  const p = recordPath(dir)
  if (p === undefined) return refuse([v('.witness/scratch', 'scratch-unusable', 'no git dir', 'remove .witness/scratch — witness makes it again')])
  const rec = readRecord(p)
  if (!opts.force && rec?.cmd === cmd && rec.inputs === inputs) return ok({ ran: false, inputs })
  if (!trustedNow(root, ctx.env, cmd)) {
    return refuse([v('scratch.prepare', 'untrusted-blocked', visible(cmd),
      hasControl(cmd) ? UNGRANTABLE : `a trusted command — the human grants it: witness trust --cmd ${shellWord(cmd)}`)])
  }
  rmSync(p, { force: true })
  const run = execCommand(dir, ctx, cmd, { turn: false })
  if (run.signal) {
    return refuse([v('scratch.prepare', 'run-interrupted', `the setup command was ended by ${run.signal} before it finished`,
      'a prepare nothing stops — it runs again on the next scratch run')])
  }
  if (!run.exitZero) {
    return refuse([v('scratch.prepare', 'prepare-failed', lastLine(run.output), 'a setup command that exits 0 in the scratch checkout')])
  }
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ cmd, inputs } satisfies PrepareRecord))
  renameSync(tmp, p)
  return ok({ ran: true, inputs })
}
