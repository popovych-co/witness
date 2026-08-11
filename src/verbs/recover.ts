import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { dirtyStatePaths, primaryRoot } from '../gitio.js'
import { journalRel } from '../journal.js'
import { renderDecision, type Decision } from '../recommend.js'
import { kv } from '../toon.js'
import { renderRefusal } from '../refusal.js'
import { completeTxn, pendingTxn, rollbackTxn, type TxnMarker } from '../txn.js'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// D121. The interrupted transaction's own state ranks this: `completeTxn` is idempotent
// about the journal append (it compares the last line), so if the line already landed the
// write finished and only the commit is missing. `--complete | --rollback` named the two
// flags and neither the right answer nor the cost of guessing wrong — at the one prompt a
// human meets while looking at a crash.
export function recoverChoice(root: string, marker: TxnMarker): Decision {
  const items = [...(marker.journal ? [marker.journal] : []), ...(marker.journalMulti ?? [])]
  const landed = items.filter(({ stream, line }) => {
    const p = join(root, journalRel(stream))
    return existsSync(p) && readFileSync(p, 'utf8').split('\n').filter(Boolean).at(-1) === line
  }).length
  const complete = landed === items.length && items.length > 0
  return {
    key: 'recover', rule: complete ? 'txn-write-landed' : 'txn-write-partial',
    options: complete
      ? [
          { command: 'witness recover --complete', depth: 'root', runnable: true,
            why: `${landed} of ${items.length} journal line(s) are already on disk and ${marker.files.length} file(s) are written — the transaction finished and only the state commit is missing; completing makes git match what the journal already records` },
          { command: 'witness recover --rollback', depth: 'root', runnable: true,
            when: 'you no longer want the operation that was interrupted',
            tradeoff: `reverts ${marker.files.length} file(s) and drops the journal append — the operation must be retaken` },
        ]
      : [
          { command: 'witness recover --rollback', depth: 'root', runnable: true,
            why: `only ${landed} of ${items.length} journal line(s) landed — the transaction was interrupted mid-write, and rolling back to a known state is safer than committing a partial one` },
          { command: 'witness recover --complete', depth: 'root', runnable: true,
            when: 'you have inspected the files and the partial state is what you want',
            tradeoff: 'commits a transaction that never finished writing; the journal and the tree may disagree' },
        ],
  }
}

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
    rmSync(join(root, '.witness', 'txn.json'), { force: true })
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
    renderDecision(recoverChoice(root, marker)).forEach((l) => ctx.err(l))
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
