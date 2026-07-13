import { execSync } from 'node:child_process'
import { ensureTrusted } from './allowlist.js'
import type { Ctx } from './cli.js'

export interface NeedResult {
  label: string
  kind: 'env' | 'cmd' | 'manual'
  status: 'ok' | 'unmet' | 'blocked' | 'declined'
  detail: string
}

export async function evaluateNeeds(root: string, ctx: Ctx, needs: unknown[]): Promise<NeedResult[]> {
  const out: NeedResult[] = []
  for (const raw of needs) {
    const n = raw as Record<string, unknown>
    if (typeof n.env === 'string') {
      const set = Boolean(ctx.env[n.env])
      out.push({ label: n.env, kind: 'env', status: set ? 'ok' : 'unmet', detail: set ? 'set' : 'env var unset' })
    } else if (typeof n.manual === 'string') {
      const done = n.satisfied === true
      out.push({ label: n.manual, kind: 'manual', status: done ? 'ok' : 'unmet', detail: done ? 'satisfied' : 'flip via specflow satisfy' })
    } else if (typeof n.cmd === 'string') {
      const trust = await ensureTrusted(root, ctx, n.cmd)
      if (trust !== 'trusted') {
        out.push({
          label: n.cmd, kind: 'cmd', status: trust,
          detail: trust === 'blocked' ? 'untrusted in non-TTY — allow interactively or set SPECFLOW_TRUST_CMDS=1' : 'trust declined',
        })
        continue
      }
      try {
        execSync(n.cmd, { cwd: root, stdio: 'ignore' })
        out.push({ label: n.cmd, kind: 'cmd', status: 'ok', detail: 'exit 0' })
      } catch {
        out.push({ label: n.cmd, kind: 'cmd', status: 'unmet', detail: 'nonzero exit' })
      }
    }
  }
  return out
}
