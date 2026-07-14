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
  const lockR = acquireLock(root)
  if (!lockR.ok) { renderRefusal(lockR.violations).forEach((l) => ctx.err(l)); return EXIT.BLOCKED }
  try {
    const pull = tryGit(root, 'pull', '--rebase')
    if (!pull.ok) {
      if (/no tracking information|no such ref|does not appear to be a git repository/i.test(pull.out)) {
        renderRefusal([v('remote', 'no-upstream', pull.out.trim().slice(0, 120),
          'an upstream — git push -u origin main once, then specflow sync')]).forEach((l) => ctx.err(l))
        return EXIT.REFUSED
      }
      tryGit(root, 'rebase', '--abort')
      ctx.out(kv('sync', 'rebase conflict — resolve manually, then re-run specflow sync'))
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
