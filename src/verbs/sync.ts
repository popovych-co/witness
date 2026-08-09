import { EXIT, type Ctx } from '../cli.js'
import { guardTxn } from '../txn.js'
import { acquireLock } from '../lock.js'
import { primaryRoot, tryGit } from '../gitio.js'
import { renderRefusal, v } from '../refusal.js'
import { kv } from '../toon.js'

export async function run(ctx: Ctx, _argv: string[]): Promise<number> {
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  // Row 114. `git pull --rebase` refuses on ANY unstaged TRACKED change, and every
  // non-conflict failure below rendered as `rebase conflict — resolve manually`, which
  // names neither the real condition nor a single file. A field report read that line as a
  // structural deadlock ("ship owns the sole code commit, so the work is always unstaged")
  // — sync runs in the primary root and never in a worktree, and the actual cause was one
  // hand-edited tracked file. Untracked paths are deliberately not counted: git rebases
  // around them, so refusing on them would invent a block that does not exist.
  const dirty = tryGit(root, 'status', '--porcelain')
  const tracked = dirty.ok
    ? dirty.out.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('??'))
    : []
  if (tracked.length > 0) {
    renderRefusal([v('worktree', 'worktree-dirty', tracked.map((l) => l.slice(3)).join(' · ').slice(0, 200),
      'a clean tree — commit or stash the tracked edits, then witness sync (a rebase cannot run over them)')])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  const lockR = acquireLock(root)
  if (!lockR.ok) { renderRefusal(lockR.violations).forEach((l) => ctx.err(l)); return EXIT.BLOCKED }
  try {
    const pull = tryGit(root, 'pull', '--rebase')
    if (!pull.ok) {
      if (/no tracking information|no such ref|does not appear to be a git repository/i.test(pull.out)) {
        renderRefusal([v('remote', 'no-upstream', pull.out.trim().slice(0, 120),
          'an upstream — git push -u origin main once, then witness sync')]).forEach((l) => ctx.err(l))
        return EXIT.REFUSED
      }
      tryGit(root, 'rebase', '--abort')
      ctx.out(kv('sync', 'rebase conflict — resolve manually, then re-run witness sync'))
      ctx.out(kv('detail', pull.out.trim().slice(-200)))
      return EXIT.FINDINGS
    }
    const push = tryGit(root, 'push')
    if (!push.ok) {
      ctx.out(kv('sync', `push failed: ${push.out.trim().slice(-200)}`))
      return EXIT.FINDINGS
    }
    ctx.out(kv('sync', 'pulled --rebase and pushed accumulated state commits'))
    return EXIT.OK
  } finally {
    lockR.value()
  }
}
