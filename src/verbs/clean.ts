import { EXIT, type Ctx } from '../cli.js'
import { primaryRoot } from '../gitio.js'
import { findById, loadCanon } from '../scan.js'
import { renderRefusal } from '../refusal.js'
import { kv, rows } from '../toon.js'
import { listWorktrees, removeWorktree } from '../worktree.js'

export async function run(ctx: Ctx, _argv: string[]): Promise<number> {
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const canon = loadCanon(root)
  const swept: Array<{ plan: string; why: string }> = []
  for (const planId of listWorktrees(root)) {
    const doc = findById(canon, planId)
    const status = doc ? String(doc.meta.status) : undefined
    if (!doc) { removeWorktree(root, planId); swept.push({ plan: planId, why: 'no such plan' }); continue }
    if (status === 'done' || status === 'abandoned') {
      removeWorktree(root, planId)
      swept.push({ plan: planId, why: `plan is ${status}` })
    }
  }
  if (swept.length) ctx.out(rows('swept', ['plan', 'why'], swept).join('\n'))
  else ctx.out(kv('clean', 'no stray worktrees'))
  return EXIT.OK
}
