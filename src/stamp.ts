import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cliAct } from './act.js'
import { carryGit, keptRefs } from './carry.js'
import type { Ctx } from './cli.js'
import { deferralMoves } from './deferral.js'
import { writeDoc } from './fm.js'
import { stateCommit } from './gitio.js'
import { appendEntry, entryLine, journalRel, readStream, type StatusCause, type StatusEntry } from './journal.js'
import { acquireLock } from './lock.js'
import { canonicalSha } from './sha.js'
import { findById, type Canon, type CanonDoc } from './scan.js'
import { execFileSync } from './spawn.js'
import { crashPoint, withTxn } from './txn.js'
import { autoSync } from './verbs/sync.js'
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
  // D141. Worktrees this run declined to remove because the caller was standing in one.
  // Reported by the renderers, never a failure: it re-runs from any other cwd.
  kept: string[]
  // Row 242. What GitHub said of each in-progress plan's PR, by plan id — read once here, so `next`'s
  // check of a standing merge record costs no second call. Absent: GitHub did not answer.
  views: Map<string, PrView>
}

export interface PrView { state: string; base?: string }

// Row 242. The PR's state and base, from one `gh pr view`. A failure, a timeout, a PR GitHub no longer
// knows, or an answer that is not the JSON asked for, all read as no answer (undefined).
export function prView(ctx: Ctx, root: string, pr: number): PrView | undefined {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(pr), '--json', 'state,baseRefName'], {
      cwd: root, env: ctx.env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const v = JSON.parse(out) as { state?: unknown; baseRefName?: unknown }
    if (typeof v?.state !== 'string' || !/^[A-Z_]+$/.test(v.state)) return undefined
    return { state: v.state, ...(typeof v.baseRefName === 'string' ? { base: v.baseRefName } : {}) }
  } catch {
    return undefined
  }
}

export function prState(ctx: Ctx, root: string, pr: number): string | undefined {
  return prView(ctx, root, pr)?.state
}

export function lazyStamp(root: string, ctx: Ctx, canon: Canon): LazyResult {
  const result: LazyResult = { stamped: [], stale: [], kept: [], views: new Map() }
  if (ctx.env.CI) return result                                     // CI never writes state
  const candidates = canon.docs.filter((d) =>
    d.meta.type === 'plan' && String(d.meta.status) === 'in-progress' && d.meta.pr !== undefined)
  for (const plan of candidates) {
    const planId = String(plan.meta.id)
    const pr = Number(plan.meta.pr)
    const view = prView(ctx, root, pr)
    const state = view?.state
    if (view === undefined || state === undefined) { result.stale.push({ plan: planId, why: "stale, couldn't check" }); continue }
    result.views.set(planId, view)
    if (state === 'CLOSED') {
      // Row 239. The command the why names is an act's line.
      result.stale.push({ plan: planId, why: `pr #${pr} closed unmerged — ${cliAct('abandon', planId).line}?` })
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
    const moves = parentId === undefined ? [] : deferralMoves(readStream(root, planId), planId, parentId)
    const files = [planStamp.rel, journalRel(planStamp.stream),
      ...(specStamp ? [specStamp.rel, journalRel(specStamp.stream)] : []),
      ...moves.map((m) => journalRel(m.stream))]
    const lockR = acquireLock(root)
    if (!lockR.ok) { result.stale.push({ plan: planId, why: 'lock held' }); continue }
    try {
      // Row 254. The op is the commit's subject, so a stamp `recover` completes keeps its plan and PR
      // in the merge clock (`merge(<plan>): pr #N (recovered)`).
      const subject = `merge(${planId}): pr #${pr}`
      const txn = withTxn(root, {
        op: subject, files,
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
        return stateCommit(root, [...new Set(files)], subject)
      })
      if (txn.ok) {
        // D141. `next`/`check`/`dashboard` all reach here, including the SessionStart
        // hook — so this is the removal that used to delete the caller's own directory.
        if (!removeWorktree(root, planId, ctx.cwd)) result.kept.push(worktreePath(root, planId))
        dropKept(root, planId)
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
    if (existsSync(worktreePath(root, planId)) && !removeWorktree(root, planId, ctx.cwd)) {
      result.kept.push(worktreePath(root, planId))
    }
  }
  // D138. A merge is the moment origin is KNOWN to have moved, and the stamp has just
  // written one more local-only commit on top of it — the exact instant the 165-commit
  // divergence was manufactured. Sync here, outside the lock and after every txn is
  // durable (the sequencing clause: sync takes the lock itself, and a rebase must never
  // run over an incomplete transaction). Failure prints and returns; it never blocks.
  const firstStamped = result.stamped[0]
  if (firstStamped) autoSync(root, ctx, firstStamped.plan, 'merge-stamp')
  return result
}

// Row 243 (design §4.1.1 step 10). The plan merged, so its kept refs have served their turn: every
// ref under `refs/witness/kept/<plan>/`, whatever its shape or name, is deleted while it still names
// what was read. The plan's carry ref is never deleted here, since its work may be in no commit, and
// an abandon deletes neither (D168: the CLI never discards work). A ref a failed delete (a held
// lock) or a crash leaves behind is check's to warn of.
function dropKept(root: string, planId: string): void {
  for (const k of keptRefs(root, planId)) carryGit(root, 'update-ref', '-d', k.ref, k.sha)
}
