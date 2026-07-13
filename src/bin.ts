#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { main, type Ctx } from './cli.js'

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

process.exit(await main(ctx, process.argv.slice(2)))
