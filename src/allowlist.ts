import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { heldCriteria } from './needs.js'
import { criteriaOwner, type Canon, type CanonDoc } from './scan.js'

const allowPath = (root: string) => join(root, '.witness', 'allow.json')

function load(root: string): string[] {
  if (!existsSync(allowPath(root))) return []
  try {
    const parsed = JSON.parse(readFileSync(allowPath(root), 'utf8')) as { commands?: string[] }
    return Array.isArray(parsed.commands) ? parsed.commands : []
  } catch {
    return []
  }
}

// D154. The trust list, read. One home for the fact "is this command trusted here", so the
// headless block, the decision surface and the `trust` verb cannot disagree about it.
export function trustedCommands(root: string): string[] {
  return load(root)
}

// D154. Append-dedupe. Trust is granted where a human decides — at the decision block via
// `--approve --trust-cmds`, or by the `trust` verb where no stop exists — and both routes
// land here rather than each writing the file their own way.
export function grantCommands(root: string, cmds: string[]): void {
  const have = load(root)
  const merged = [...have]
  for (const c of cmds) if (!merged.includes(c)) merged.push(c)
  if (merged.length === have.length) return
  mkdirSync(join(root, '.witness'), { recursive: true })
  writeFileSync(allowPath(root), JSON.stringify({ commands: merged }, null, 2))
}

// D154. The `cmd:` criteria an artifact carries that this repo does not trust yet. The
// artifact is the SPEC that owns the criteria: a plan gate judges a plan, but criteria live
// on the spec it derives from, and a block that listed nothing there would hide the very
// commands its approve is about to leave blocked.
//
// Row 179: a criterion an unmet need holds is not run, so it needs no trust until the need is
// met. `witness trust <id>` still lists every command, so a human may trust one ahead of time.
export function untrustedCmdsFor(root: string, doc: CanonDoc | undefined): string[] {
  if (!doc) return []
  const held = heldCriteria(doc)
  const list = Array.isArray(doc.meta.criteria) ? (doc.meta.criteria as Array<Record<string, unknown>>) : []
  const cmds = list.filter((c) => !held.has(String(c.id))).map((c) => c.cmd).filter((c): c is string => typeof c === 'string')
  const trusted = new Set(load(root))
  return [...new Set(cmds.filter((c) => !trusted.has(c)))]
}

// Row 205. A command witness runs on this repo's behalf, and where it comes from: the config
// commands every flow runs, a spec's `cmd:` criteria, a doc's `cmd:` needs. The source is what
// the human reads before naming a command to trust.
export interface RunCommand { cmd: string; source: string }

// The filtered runner template, `ship.test`, `ship.lint`, each when set. Full-suite mode's
// runner IS `ship.test`, and a command listed twice is listed once, under its first source.
export function configCommands(cfg: Config): RunCommand[] {
  const out: RunCommand[] = []
  const add = (cmd: string | undefined, source: string) => {
    if (cmd !== undefined && cmd !== '' && !out.some((c) => c.cmd === cmd)) out.push({ cmd, source })
  }
  if (cfg.criteria.runner !== 'full-suite') add(cfg.criteria.runner, 'criteria.runner')
  add(cfg.ship.test, 'ship.test')
  add(cfg.ship.lint, 'ship.lint')
  return out
}

const cmdCriteria = (doc: CanonDoc): RunCommand[] =>
  (Array.isArray(doc.meta.criteria) ? (doc.meta.criteria as Array<Record<string, unknown>>) : [])
    .filter((c) => typeof c.cmd === 'string')
    .map((c) => ({ cmd: c.cmd as string, source: `cmd: ${String(c.id)}` }))

const cmdNeeds = (doc: CanonDoc): RunCommand[] =>
  (Array.isArray(doc.meta.needs) ? (doc.meta.needs as Array<Record<string, unknown>>) : [])
    .flatMap((n, i) => typeof n.cmd === 'string'
      ? [{ cmd: n.cmd, source: `need: ${typeof n.id === 'string' ? n.id : i + 1}` }] : [])

// Row 205. Every command a target's flow runs: the config commands, the `cmd:` criteria of the
// doc that owns its criteria (the spec, for a plan, which carries none of its own), and the
// target's own `cmd:` needs (`start` evaluates a plan's). Held criteria are listed too, so a
// human may trust one ahead of time.
export function commandsRun(cfg: Config, canon: Canon, doc: CanonDoc): RunCommand[] {
  const owner = criteriaOwner(canon, String(doc.meta.id)) ?? doc
  return [...configCommands(cfg), ...cmdCriteria(owner), ...cmdNeeds(doc)]
}

// `witness trust` with no target: everything the repo runs, each doc's commands under its id.
export function repoCommands(cfg: Config, canon: Canon): Array<RunCommand & { doc: string }> {
  return [
    ...configCommands(cfg).map((c) => ({ ...c, doc: '-' })),
    ...canon.docs.flatMap((d) => [...cmdCriteria(d), ...cmdNeeds(d)].map((c) => ({ ...c, doc: String(d.meta.id) }))),
  ]
}

export async function ensureTrusted(root: string, ctx: Ctx, cmd: string): Promise<'trusted' | 'declined' | 'blocked'> {
  if (ctx.env.WITNESS_TRUST_CMDS === '1') return 'trusted'
  const commands = load(root)
  if (commands.includes(cmd)) return 'trusted'
  if (!ctx.isTTY) return 'blocked'
  const answer = await ctx.ask(`witness wants to run: ${cmd}\ntrust this command? saves to .witness/allow.json (gitignored) [y/N]`)
  if (!answer.trim().toLowerCase().startsWith('y')) return 'declined'
  grantCommands(root, [cmd])
  return 'trusted'
}
