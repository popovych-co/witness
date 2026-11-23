// Row 261. Ship's lint lane: every part of `ship.lint` runs on its own, whatever an earlier one
// did, so a red first part never hides what the others say. Parts take no turn (row 255).
import { ensureTrusted } from './allowlist.js'
import type { Ctx } from './cli.js'
import type { Config, LintPart } from './config.js'
import type { GateCheck } from './rounds.js'
import { execCommand, type RunOutcome } from './runner.js'

export interface PartRun { part: LintPart; trust: 'trusted' | 'declined' | 'blocked'; run?: RunOutcome }

// Per part, in order: trust (checked at `trustRoot`, the primary checkout), then the run in `dir`.
export async function runParts(dir: string, trustRoot: string, ctx: Ctx, parts: readonly LintPart[]): Promise<PartRun[]> {
  const out: PartRun[] = []
  for (const part of parts) {
    const trust = await ensureTrusted(trustRoot, ctx, part.cmd)
    out.push(trust === 'trusted' ? { part, trust, run: execCommand(dir, ctx, part.cmd, { turn: false }) } : { part, trust })
  }
  return out
}

// A plain command's part (source `ship.lint`) reads as 0.30's lane did: its command when green,
// its output's tail when red, `<cmd>: <trust>` untrusted. A named part prefixes its name.
function segment(r: PartRun): string {
  const plain = r.part.source === 'ship.lint'
  if (r.run === undefined) return plain ? `${r.part.cmd}: ${r.trust}` : `${r.part.name}: ${r.part.cmd}: ${r.trust}`
  if (r.run.exitZero) return plain ? r.part.cmd : `${r.part.name}: ok`
  const tail = r.run.output.slice(-300)
  return plain ? tail : `${r.part.name}: red — ${tail}`
}

// `base` is the plan's base commit, read from row 263 on.
export async function lintCheck(root: string, wt: string, ctx: Ctx, cfg: Config, _base: string): Promise<GateCheck> {
  const parts = cfg.ship.lint
  if (parts === undefined) return { name: 'lint', ok: false, detail: 'ship.lint not configured' }
  const runs = await runParts(wt, root, ctx, parts)
  const untrusted = runs.filter((r) => r.trust !== 'trusted').map((r) => r.part.cmd)
  return {
    name: 'lint',
    ok: runs.every((r) => r.run?.exitZero === true),
    detail: runs.map(segment).join(' · '),
    ...(untrusted.length > 0 ? { untrusted } : {}),
  }
}
