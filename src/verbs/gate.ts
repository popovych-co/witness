import { EXIT, type Ctx } from '../cli.js'
import '../gates/index.js'
import { runGate } from '../gate.js'

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const positional = argv.filter((a) => !a.startsWith('--'))
  const [gate, target] = positional
  if (!gate || !target) {
    ctx.err('usage: witness gate <decompose|plan|implement|ship|design> <target> [--fresh] [--manual]')
    return EXIT.REFUSED
  }
  return runGate(ctx, gate, target, { fresh: argv.includes('--fresh'), manual: argv.includes('--manual') })
}
