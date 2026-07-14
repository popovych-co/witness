import { EXIT, type Ctx } from '../cli.js'
import '../gates/index.js'
import { runShip } from '../ship.js'

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const planId = argv.find((a) => !a.startsWith('--'))
  if (!planId) { ctx.err('usage: specflow ship <plan-id>'); return EXIT.REFUSED }
  return runShip(ctx, planId)
}
