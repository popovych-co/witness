import { EXIT, type Ctx } from '../cli.js'
import { guardTxn, withTxn } from '../txn.js'
import { acquireLock } from '../lock.js'
import { primaryRoot, stateCommit, tryGit } from '../gitio.js'
import { appendEntry, entryLine, journalRel } from '../journal.js'
import { renderRefusal, v, type Violation } from '../refusal.js'
import { kv } from '../toon.js'

// D140. Row 114 fixed one branch of this function and left the other: every non-upstream
// failure rendered as "rebase conflict — resolve manually", which misnames both a real
// conflict (it named no files) and a non-conflict fatal (it was not a conflict at all).
export function classifyPullFailure(out: string): 'no-upstream' | 'conflict' | 'other' {
  if (/no tracking information|no such ref|does not appear to be a git repository/i.test(out)) return 'no-upstream'
  if (/CONFLICT|could not apply/i.test(out)) return 'conflict'
  return 'other'
}

// D138. A bare `push failed: <tail>` hid the one cause witness cannot work around: a
// protected ship-branch means this repo can never receive state commits at all. Naming it
// is what makes the incompatibility visible instead of silent (spec D138's residual).
export function classifyPushFailure(out: string): 'push-rejected' | 'other' {
  return /protected|GH006|remote rejected/i.test(out) ? 'push-rejected' : 'other'
}

export type SyncOutcome = 'ok' | 'no-remote' | 'dirty' | 'locked' | 'no-upstream' | 'conflict' | 'push-rejected' | 'other'

export interface SyncReport {
  result: SyncOutcome
  /** Rendered as-is by the verb and by `sync-auto:`; absent only for `ok`. */
  detail?: string
  /** Present for the two refusal shapes, so the verb renders the same rows it always did. */
  violations?: Violation[]
}

// D138. The whole sequence, with no rendering and no exit codes — so the verb and the two
// automatic call sites share ONE implementation rather than three that drift. It acquires
// the lock itself, which is exactly why callers must invoke it OUTSIDE any lock of their
// own (spec D138's sequencing clause: the stamp's txn must be durable before a rebase
// touches the tree).
export function syncCore(root: string): SyncReport {
  // No origin, nothing to converge with — D139's own rule (`divergence` returns undefined
  // there) applied to the healing half. Reported rather than attempted, so `autoSync` can
  // stay silent while the explicit verb still answers the human who typed it.
  if (!tryGit(root, 'remote', 'get-url', 'origin').ok) return { result: 'no-remote' }
  // Row 114. `git pull --rebase` refuses on ANY unstaged TRACKED change. Untracked paths
  // are deliberately not counted: git rebases around them, so refusing on them would
  // invent a block that does not exist.
  const dirty = tryGit(root, 'status', '--porcelain')
  const tracked = dirty.ok
    ? dirty.out.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('??'))
    : []
  if (tracked.length > 0) {
    const paths = tracked.map((l) => l.slice(3)).join(' · ').slice(0, 200)
    return {
      result: 'dirty',
      detail: paths,
      violations: [v('worktree', 'worktree-dirty', paths,
        'a clean tree — commit or stash the tracked edits, then witness sync (a rebase cannot run over them)')],
    }
  }

  const lockR = acquireLock(root)
  if (!lockR.ok) return { result: 'locked', detail: 'lock held', violations: lockR.violations }
  try {
    const pull = tryGit(root, 'pull', '--rebase')
    if (!pull.ok) {
      const kind = classifyPullFailure(pull.out)
      if (kind === 'no-upstream') {
        return {
          result: 'no-upstream',
          detail: pull.out.trim().slice(0, 120),
          violations: [v('remote', 'no-upstream', pull.out.trim().slice(0, 120),
            'an upstream — git push -u origin main once, then witness sync')],
        }
      }
      if (kind === 'conflict') {
        // Read the unmerged paths BEFORE the abort — it is what erases the conflict state.
        const conflicted = tryGit(root, 'diff', '--name-only', '--diff-filter=U')
        tryGit(root, 'rebase', '--abort')
        const where = conflicted.ok && conflicted.out !== ''
          ? conflicted.out.split('\n').join(' · ')
          : 'unknown files'
        return { result: 'conflict', detail: `rebase conflict in ${where} — resolve manually, then re-run witness sync` }
      }
      // 'other': not a conflict — say what git said, never "rebase conflict".
      tryGit(root, 'rebase', '--abort')
      return { result: 'other', detail: `git pull --rebase failed — ${pull.out.trim().slice(-200)}` }
    }
    const push = tryGit(root, 'push')
    if (!push.ok) {
      if (classifyPushFailure(push.out) === 'push-rejected') {
        return {
          result: 'push-rejected',
          detail: 'the ship branch rejects direct pushes (branch protection?) — witness state commits need push access to it; see DESIGN.md row 138',
        }
      }
      return { result: 'other', detail: `push failed: ${push.out.trim().slice(-200)}` }
    }
    return { result: 'ok' }
  } finally {
    lockR.value()
  }
}

// D138. Sync at the two moments origin is known to have moved. Never throws, never blocks
// its caller: a failure is a printed finding and the caller carries on (D137's decoupling
// clause — an origin-based cut is correct regardless of local main's health).
export function autoSync(root: string, ctx: Ctx, stream: string, trigger: 'merge-stamp' | 'start'): SyncReport {
  const report = syncCore(root)
  // A repo with no remote is not failing at anything: say nothing, record nothing. Any
  // other non-ok outcome is a finding the session should see.
  if (report.result === 'no-remote') return report
  if (report.result !== 'ok') {
    ctx.out(kv('sync-auto', `${report.result}${report.detail ? ` — ${report.detail}` : ''}`))
  }
  journalSync(root, stream, trigger, report.result)
  return report
}

// Best-effort, on `journalRefusal`'s precedent (`verbs/write.ts`): a blocked txn costs the
// record, never the act. The entry is appended AFTER the push and then pushed on its own,
// so an automatic sync does not leave the commit it just made sitting unpushed — which
// would make D139's ahead/behind finding fire on witness's own bookkeeping.
function journalSync(root: string, stream: string, trigger: string, result: SyncOutcome): void {
  const entry = { t: 'sync' as const, trigger, result }
  const rel = journalRel(stream)
  const res = withTxn(root, { op: `sync(${trigger})`, files: [rel], journal: { stream, line: entryLine(entry) } }, () => {
    appendEntry(root, stream, entry)
    return stateCommit(root, [rel], `sync(${trigger}): ${result}`)
  })
  if (res.ok && result === 'ok') tryGit(root, 'push')
}

export async function run(ctx: Ctx, _argv: string[]): Promise<number> {
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked

  // A thin renderer over syncCore — every string and exit code below is the one this verb
  // has always emitted; only the computation moved.
  const report = syncCore(root)
  switch (report.result) {
    case 'ok':
      ctx.out(kv('sync', 'pulled --rebase and pushed accumulated state commits'))
      return EXIT.OK
    case 'no-remote':
      // Someone typed the verb: answer them, even though the automatic caller stays quiet.
      renderRefusal([v('remote', 'no-upstream', 'no origin remote is configured',
        'an upstream — git push -u origin main once, then witness sync')]).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    case 'locked':
      renderRefusal(report.violations ?? []).forEach((l) => ctx.err(l))
      return EXIT.BLOCKED
    case 'dirty':
    case 'no-upstream':
      renderRefusal(report.violations ?? []).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    default:
      ctx.out(kv('sync', report.detail ?? 'sync failed'))
      return EXIT.FINDINGS
  }
}
