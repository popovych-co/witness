import { parseArgs } from 'node:util'
import { cliAct } from '../act.js'
import { EXIT, type Ctx } from '../cli.js'
import { dirtyStatePaths, primaryRoot, tryGit } from '../gitio.js'
import { checkoutRoot } from '../evidence.js'
import { heldPending, heldWorkLine, putBackHeld, standingHeld, treeBase } from '../held.js'
import { acquireLock } from '../lock.js'
import type { Result, Violation } from '../refusal.js'
import { shellWord } from '../toon.js'
import { option, renderDecision, type Decision } from '../recommend.js'
import { kv } from '../toon.js'
import { renderRefusal } from '../refusal.js'
import { completeTxn, landedJournal, pendingTxn, rollbackTxn, type TxnMarker } from '../txn.js'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// D121. The interrupted transaction's own state ranks this: `completeTxn` appends only the
// journal lines that have not landed, so if every one already landed the write finished and
// only the commit is missing. `--complete | --rollback` named the two flags and neither the
// right answer nor the cost of guessing wrong — at the one prompt a human meets while
// looking at a crash. D166: the count is `landedJournal`'s, the derivation `completeTxn`
// uses, so a stream that takes several lines reads the same to both.
export function recoverChoice(root: string, marker: TxnMarker): Decision {
  const streams = landedJournal(root, marker)
  const total = streams.reduce((n, s) => n + s.lines.length, 0)
  const landed = streams.reduce((n, s) => n + s.landed, 0)
  const complete = landed === total && total > 0
  return {
    key: 'recover', rule: complete ? 'txn-write-landed' : 'txn-write-partial',
    options: complete
      ? [
          option(cliAct('recover', '--complete'), 'root', {
            why: `${landed} of ${total} journal line(s) are already on disk and ${marker.files.length} file(s) are written — the transaction finished and only the state commit is missing; completing makes git match what the journal already records` }),
          option(cliAct('recover', '--rollback'), 'root', {
            when: 'you no longer want the operation that was interrupted',
            tradeoff: `reverts ${marker.files.length} file(s) and drops the journal append — the operation must be retaken` }),
        ]
      : [
          option(cliAct('recover', '--rollback'), 'root', {
            why: `only ${landed} of ${total} journal line(s) landed — the transaction was interrupted mid-write, and rolling back to a known state is safer than committing a partial one` }),
          option(cliAct('recover', '--complete'), 'root', {
            when: 'you have inspected the files and the partial state is what you want',
            tradeoff: 'commits a transaction that never finished writing; the journal and the tree may disagree' }),
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
    return recoverHeld(ctx, root)
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

// Row 247 (#92). With no transaction pending, every held ref a crashed verify-red left goes back into
// the checkout its record names, wherever recover runs from — under verify-red's own rules
// (`putBackHeld`), against the base the record names, else that checkout's. A ref whose checkout is
// gone, or whose work cannot go back safely, refuses `verify-red-pending` and stays; nothing is
// written anywhere else. Exit 0 when every ref went back (or none stood), 2 with every refusal
// rendered (3 when the repo lock is held). A pending transaction is handled first, by itself (D121):
// the held refs wait for the next recover.
const HELD_PREFIX = 'refs/witness/verify-red/'
function recoverHeld(ctx: Ctx, root: string): number {
  const listed = tryGit(root, 'for-each-ref', '--format=%(refname)', HELD_PREFIX)
  const refs = listed.ok ? listed.out.split('\n').filter((r) => r.startsWith(HELD_PREFIX)).sort() : []
  const refused: Violation[] = []
  let locked = false
  for (const ref of refs) {
    const planId = ref.slice(HELD_PREFIX.length)
    const held = standingHeld(root, planId)
    if (held === undefined) continue                     // dropped since the listing
    const then = cliAct('next')
    const checkout = held.record?.checkout
    if (checkout !== undefined && !checkoutStands(checkout)) {
      refused.push(heldPending(planId, ref, `the checkout that set it aside, ${shellWord(checkout)}, is gone`, then))
      continue
    }
    const lock = acquireLock(root)
    if (!lock.ok) { refused.push(...lock.violations); locked = true; continue }
    let back: Result<string[]> | undefined
    try {
      const now = standingHeld(root, planId)             // re-read under the lock: a run may have finished
      if (now !== undefined) {
        back = putBackHeld(checkout ?? root, planId, now, checkout !== undefined ? treeBase(root, checkout) : undefined, then)
      }
    } finally {
      lock.value()
    }
    if (back === undefined) continue
    if (!back.ok) { refused.push(...back.violations); continue }
    ctx.out(heldWorkLine(ref, back.value, checkout))
  }
  if (refused.length === 0) return EXIT.OK
  renderRefusal(refused).forEach((l) => ctx.err(l))
  return locked ? EXIT.BLOCKED : EXIT.REFUSED
}

// A checkout that still stands where its record says: the directory exists and git names it as its
// own top level (a directory reused for something else is no longer that checkout).
function checkoutStands(checkout: string): boolean {
  if (!existsSync(checkout)) return false
  const top = checkoutRoot(checkout)
  return top.ok && top.value === checkout
}
