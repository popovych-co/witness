import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './cli.js'
import { openDeferrals } from './deferral.js'
import { writeDoc } from './fm.js'
import { stateCommit } from './gitio.js'
import { appendEntry, entryLine, journalRel, readStream, type StatusCause, type StatusEntry } from './journal.js'
import { acquireLock } from './lock.js'
import { canonicalSha } from './sha.js'
import { findById, type Canon, type CanonDoc } from './scan.js'
import { crashPoint, withTxn } from './txn.js'
import { removeWorktree, worktreePath } from './worktree.js'

export interface PreparedStamp {
  doc: CanonDoc
  to: string
  entry: StatusEntry
  line: string
  rel: string
  stream: string
}

export function prepareStamp(
  doc: CanonDoc, to: string, cause: StatusCause, extra: Partial<StatusEntry> = {},
): PreparedStamp {
  const entry: StatusEntry = {
    v: 1, t: 'status', artifact: String(doc.meta.id),
    from: String(doc.meta.status), to, cause, ...extra,
  }
  return { doc, to, entry, line: entryLine(entry as unknown as { t: 'status'; [k: string]: unknown }), rel: doc.rel, stream: String(doc.meta.id) }
}

export function writeStamp(root: string, s: PreparedStamp): void {
  writeDoc(join(root, s.rel), { meta: { ...s.doc.meta, status: s.to }, body: s.doc.body })
  appendEntry(root, s.stream, s.entry as unknown as { t: 'status'; [k: string]: unknown })
}

export interface LazyResult {
  stamped: Array<{ plan: string; spec?: string; pr: number }>
  stale: Array<{ plan: string; why: string }>
}

function prState(ctx: Ctx, root: string, pr: number): string | undefined {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(pr), '--json', 'state'], {
      cwd: root, env: ctx.env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 3_000,
    })
    return (JSON.parse(out) as { state?: string }).state
  } catch {
    return undefined
  }
}

export function lazyStamp(root: string, ctx: Ctx, canon: Canon): LazyResult {
  const result: LazyResult = { stamped: [], stale: [] }
  if (ctx.env.CI) return result                                     // CI never writes state
  const candidates = canon.docs.filter((d) =>
    d.meta.type === 'plan' && String(d.meta.status) === 'in-progress' && d.meta.pr !== undefined)
  for (const plan of candidates) {
    const planId = String(plan.meta.id)
    const pr = Number(plan.meta.pr)
    const state = prState(ctx, root, pr)
    if (state === undefined) { result.stale.push({ plan: planId, why: "stale, couldn't check" }); continue }
    if (state === 'CLOSED') {
      result.stale.push({ plan: planId, why: `pr #${pr} closed unmerged — witness abandon ${planId}?` })
      continue
    }
    if (state !== 'MERGED') { result.stale.push({ plan: planId, why: `pr #${pr} still ${state}` }); continue }

    const parent = findById(canon, String(plan.meta.parent))
    const pinFresh = parent !== undefined &&
      canonicalSha(parent.meta, parent.body) === String(plan.meta['derives-from'])
    const planStamp = prepareStamp(plan, 'done', 'merge', { pr, ...(pinFresh ? {} : { note: 'stale-merge' }) })
    const specStamp = parent && pinFresh && parent.meta.type === 'spec'
      ? prepareStamp(parent, 'live', 'merge', { pr }) : undefined

    // D122. The flow that could discharge this obligation is about to disappear: the plan
    // goes `done` and nothing will ever gate it again, so a ship-time override would be
    // undischargeable by construction. The debt moves to the parent spec, which outlives it
    // and which the next effort touching this area will meet. The id is PRESERVED — a debt
    // renumbered when it changes homes cannot be aged across the move, and age is the only
    // thing separating a fresh deferral from a chronic one.
    //
    // Keyed on `parent`, not on `specStamp`: a stale merge writes no spec stamp, and that is
    // exactly the merge whose debts most need somewhere to live.
    const parentId = parent ? String(parent.meta.id) : undefined
    const moves = parentId === undefined ? [] : openDeferrals(readStream(root, planId)).flatMap((d) => [
      { stream: planId, entry: { v: 1 as const, t: 'deferral-moved' as const, id: d.id, to: parentId } },
      { stream: parentId, entry: { ...d, artifact: parentId, moved_from: planId } },
    ])
    const files = [planStamp.rel, journalRel(planStamp.stream),
      ...(specStamp ? [specStamp.rel, journalRel(specStamp.stream)] : []),
      ...moves.map((m) => journalRel(m.stream))]
    const lockR = acquireLock(root)
    if (!lockR.ok) { result.stale.push({ plan: planId, why: 'lock held' }); continue }
    try {
      const txn = withTxn(root, {
        op: 'merge-stamp', files,
        journalMulti: [
          { stream: planStamp.stream, line: planStamp.line },
          ...(specStamp ? [{ stream: specStamp.stream, line: specStamp.line }] : []),
          ...moves.map((m) => ({ stream: m.stream, line: entryLine(m.entry) })),
        ],
      }, () => {
        writeStamp(root, planStamp)
        if (specStamp) writeStamp(root, specStamp)
        for (const m of moves) appendEntry(root, m.stream, m.entry)
        crashPoint(ctx.env, 'merge-stamp')
        return stateCommit(root, [...new Set(files)], `merge(${planId}): pr #${pr}`)
      })
      if (txn.ok) {
        removeWorktree(root, planId)
        result.stamped.push({ plan: planId, ...(specStamp ? { spec: specStamp.stream } : {}), pr })
      } else {
        result.stale.push({ plan: planId, why: txn.violations.map((x) => x.rule).join(' ') })
      }
    } finally {
      lockR.value()
    }
  }
  // a crash between writeStamp and this point recovers generically (journal replay +
  // commit only) — completeTxn has no notion of "also remove the worktree", and a plan
  // already 'done' never re-enters `candidates` above, so the removal must be re-checked
  // independently of whichever call actually performed the stamp.
  for (const plan of canon.docs.filter((d) => d.meta.type === 'plan' && String(d.meta.status) === 'done')) {
    const planId = String(plan.meta.id)
    if (existsSync(worktreePath(root, planId))) removeWorktree(root, planId)
  }
  return result
}
