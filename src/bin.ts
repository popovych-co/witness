#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { EXIT, main, type Ctx } from './cli.js'
import { renderRefusal, v } from './refusal.js'

const ctx: Ctx = {
  cwd: process.cwd(),
  env: process.env,
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  out: (l) => process.stdout.write(l + '\n'),
  err: (l) => process.stderr.write(l + '\n'),
  ask: async (q) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      return await rl.question(q + ' ')
    } finally {
      rl.close()
    }
  },
}

// A verb that throws is a bug, but a stack trace is not a refusal: the engine file
// renders exit 2/3 as a refusal it can act on, and anything else reads as a crash the
// session has no vocabulary for. `init --agent` is the first path that touches paths
// the repo is entitled to refuse (git commit --only on an ignored pathspec throws out
// of gitio.ts:6); every other verb gets the same protection for free.
try {
  process.exit(await main(ctx, process.argv.slice(2)))
} catch (e) {
  renderRefusal([v('specflow', 'unexpected-error', String((e as Error).message).slice(0, 200),
    'a bug — re-run with the same arguments and report this line')]).forEach((l) => process.stderr.write(`${l}\n`))
  process.exit(EXIT.REFUSED)
}
