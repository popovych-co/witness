import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './cli.js'

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
export function untrustedCmdsFor(root: string, doc: { meta: Record<string, unknown> } | undefined): string[] {
  if (!doc) return []
  const list = Array.isArray(doc.meta.criteria) ? (doc.meta.criteria as Array<Record<string, unknown>>) : []
  const cmds = list.map((c) => c.cmd).filter((c): c is string => typeof c === 'string')
  const trusted = new Set(load(root))
  return [...new Set(cmds.filter((c) => !trusted.has(c)))]
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
