import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './cli.js'

const allowPath = (root: string) => join(root, '.specflow', 'allow.json')

function load(root: string): string[] {
  if (!existsSync(allowPath(root))) return []
  try {
    const parsed = JSON.parse(readFileSync(allowPath(root), 'utf8')) as { commands?: string[] }
    return Array.isArray(parsed.commands) ? parsed.commands : []
  } catch {
    return []
  }
}

export async function ensureTrusted(root: string, ctx: Ctx, cmd: string): Promise<'trusted' | 'declined' | 'blocked'> {
  if (ctx.env.SPECFLOW_TRUST_CMDS === '1') return 'trusted'
  const commands = load(root)
  if (commands.includes(cmd)) return 'trusted'
  if (!ctx.isTTY) return 'blocked'
  const answer = await ctx.ask(`specflow wants to run: ${cmd}\ntrust this command? saves to .specflow/allow.json (gitignored) [y/N]`)
  if (!answer.trim().toLowerCase().startsWith('y')) return 'declined'
  mkdirSync(join(root, '.specflow'), { recursive: true })
  writeFileSync(allowPath(root), JSON.stringify({ commands: [...commands, cmd] }, null, 2))
  return 'trusted'
}
