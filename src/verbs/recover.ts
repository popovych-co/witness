import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { dirtyStatePaths, primaryRoot } from '../gitio.js'
import { kv } from '../toon.js'
import { renderRefusal } from '../refusal.js'
import { completeTxn, pendingTxn, rollbackTxn } from '../txn.js'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { complete: { type: 'boolean' }, rollback: { type: 'boolean' } },
  })
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) {
    renderRefusal(rootRes.violations).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const root = rootRes.value
  const marker = pendingTxn(root)
  if (!marker) {
    ctx.out('recover: no pending transaction')
    return EXIT.OK
  }
  if (dirtyStatePaths(root).length === 0) {
    rmSync(join(root, '.specflow', 'txn.json'), { force: true })
    ctx.out(kv('recovered', 'already-committed — marker cleared'))
    return EXIT.OK
  }
  let choice: 'complete' | 'rollback' | undefined =
    values.complete ? 'complete' : values.rollback ? 'rollback' : undefined
  if (!choice && ctx.isTTY) {
    const answer = await ctx.ask(`crashed mid-'${marker.op}' — [c]omplete the commit or [r]ollback?`)
    choice = answer.trim().toLowerCase().startsWith('c') ? 'complete' : answer.trim().toLowerCase().startsWith('r') ? 'rollback' : undefined
  }
  if (!choice) {
    ctx.err(kv('pending', marker.op))
    ctx.err('help: specflow recover --complete | --rollback')
    return EXIT.BLOCKED
  }
  if (choice === 'rollback') {
    rollbackTxn(root, marker)
    ctx.out(kv('recovered', 'rolled-back'))
    return EXIT.OK
  }
  const res = completeTxn(root, marker)
  if (!res.ok) {
    renderRefusal(res.violations).forEach(ctx.err)
    return EXIT.REFUSED
  }
  ctx.out(kv('recovered', `completed as ${res.value.sha.slice(0, 7)}`))
  return EXIT.OK
}
