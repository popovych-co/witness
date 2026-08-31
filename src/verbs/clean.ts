import { EXIT, type Ctx } from '../cli.js'
import { primaryRoot } from '../gitio.js'
import { findById, loadCanon } from '../scan.js'
import { renderRefusal } from '../refusal.js'
import { kv, rows } from '../toon.js'
import { listWorktrees, removeWorktree, worktreePath } from '../worktree.js'

export async function run(ctx: Ctx, _argv: string[]): Promise<number> {
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const canon = loadCanon(root)
  const swept: Array<{ plan: string; why: string }> = []
  const kept: string[] = []
  // D141. A sweep must never delete the directory the sweeping session stands in.
  const sweep = (planId: string, why: string): void => {
    if (removeWorktree(root, planId, ctx.cwd)) swept.push({ plan: planId, why })
    else kept.push(planId)
  }
  for (const planId of listWorktrees(root)) {
    const doc = findById(canon, planId)
    const status = doc ? String(doc.meta.status) : undefined
    if (!doc) { sweep(planId, 'no such plan'); continue }
    if (status === 'done' || status === 'abandoned') sweep(planId, `plan is ${status}`)
  }
  for (const planId of kept) {
    ctx.out(kv('note', `worktree ${worktreePath(root, planId)} kept — this session stands in it; leave the directory and re-run`))
  }
  if (swept.length) ctx.out(rows('swept', ['plan', 'why'], swept).join('\n'))
  else if (kept.length === 0) ctx.out(kv('clean', 'no stray worktrees'))
  return EXIT.OK
}
