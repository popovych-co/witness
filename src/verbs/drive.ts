import { EXIT, type Ctx } from '../cli.js'
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
  void argv
  ctx.out('drive: nothing to do')   // replaced by the loop in Task 4
  return EXIT.OK
}
