import { EXIT, type Ctx } from '../cli.js'
import '../gates/index.js'
import { runGate } from '../gate.js'

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const positional = argv.filter((a) => !a.startsWith('--'))
  const [gate, target] = positional
  if (!gate || !target) {
    ctx.err('usage: witness gate <decompose|plan|implement|ship|design> <target> [--fresh] [--manual] [--unchanged]')
    return EXIT.REFUSED
  }
  // Row 244 (design §4.2.4): `--unchanged` is the author's hand-back of a revise they judge needs no change.
  return runGate(ctx, gate, target, {
    fresh: argv.includes('--fresh'), manual: argv.includes('--manual'), unchanged: argv.includes('--unchanged'),
  })
}
