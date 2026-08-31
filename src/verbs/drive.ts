import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { DEFAULT_MAX_SPAWNS, driveLoop } from '../drive.js'
import { primaryRoot } from '../gitio.js'
import { renderRefusal, v } from '../refusal.js'

// D145. Drive is a human's foreground verb: TTY-only, which is also what makes
// drive-inside-drive structurally impossible (an agent's Bash has no TTY, so a spawned
// child that reaches for `witness drive` is refused by the same rule that lets a human
// run it). The refusal is first — before the root lookup — because "an agent typed this"
// is true regardless of where it was typed.
export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  if (!ctx.isTTY) {
    renderRefusal([v('tty', 'drive-needs-tty', 'non-interactive session',
      'run witness drive in your own terminal — agents are what drive spawns, never what spawns drive')])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }

  const { values } = parseArgs({
    args: argv, options: { flow: { type: 'string' }, 'max-spawns': { type: 'string' } }, allowPositionals: true,
  })
  let maxSpawns = DEFAULT_MAX_SPAWNS
  if (values['max-spawns'] !== undefined) {
    const n = Number(values['max-spawns'])
    if (!Number.isInteger(n) || n < 1) {
      renderRefusal([v('--max-spawns', 'invalid', String(values['max-spawns']),
        'an integer >= 1 — sessions this invocation may spawn')]).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
    maxSpawns = n
  }
  return await driveLoop(root, cfgR.value, ctx, { flow: values.flow, maxSpawns })
}
