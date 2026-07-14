import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ok, refuse, v, type Result } from '../refusal.js'
import { serializeDoc } from '../fm.js'
import { canonicalSha } from '../sha.js'
import { git } from '../gitio.js'
import { latestRecap } from '../journal.js'
import { findById } from '../scan.js'
import { changedFiles, diffBase, evidenceForDiff } from '../evidence.js'
import { runCriteria } from '../criteria.js'
import { effortOf, worktreeTreeSha } from '../reviewed.js'
import { worktreePath } from '../worktree.js'
import { registerGate, type GateInput } from '../gate.js'
import type { GateCheck } from '../rounds.js'

export function codePromptBody(wt: string, base: string, files: string[], header: string): string {
  const diff = git(wt, 'diff', base)
  const untracked = files.filter((f) => {
    const abs = join(wt, f)
    if (!existsSync(abs) || !statSync(abs).isFile()) return false
    return git(wt, 'ls-files', '--', f).trim() === ''
  })
  const untrackedBlocks = untracked.map((f) =>
    `#### untracked: ${f}\n${readFileSync(join(wt, f), 'utf8')}`)
  return [
    header,
    `### Changed files\n${files.join('\n')}`,
    `### Diff vs base ${base.slice(0, 7)}\n${diff}`,
    ...untrackedBlocks,
  ].join('\n\n')
}

registerGate({
  gate: 'implement',
  targetKind: 'plan',

  async resolve(root, ctx, canon, cfg, planId): Promise<Result<GateInput>> {
    const plan = findById(canon, planId)
    if (!plan || plan.meta.type !== 'plan') {
      return refuse([v('plan', 'unknown-plan', planId, 'a plans/ doc id')])
    }
    const wt = worktreePath(root, planId)
    if (String(plan.meta.status) !== 'in-progress' || !existsSync(wt)) {
      return refuse([v('plan', 'not-started', String(plan.meta.status),
        `an in-progress plan with a worktree — run: specflow start ${planId}`)])
    }
    const parent = findById(canon, String(plan.meta.parent))
    if (!parent) {
      return refuse([v('parent', 'unknown-parent', String(plan.meta.parent), 'an existing canon doc')])
    }
    const baseR = diffBase(wt, cfg)
    if (!baseR.ok) return baseR
    const base = baseR.value
    const files = changedFiles(wt, base)

    const checks: GateCheck[] = []
    checks.push({ name: 'diff', ok: files.length > 0,
      detail: files.length ? `${files.length} files changed vs ${base.slice(0, 7)}` : 'nothing changed vs base' })

    const report = evidenceForDiff(wt, root, plan, base)
    const missing = report.required.filter((r) => !(r.red && r.green && !r.vacuous))
    checks.push({ name: 'evidence', ok: report.satisfied,
      detail: report.satisfied
        ? `${report.required.length} tags with red→green pairs`
        : missing.map((m) => `${m.tag}: red=${m.red} green=${m.green}${m.vacuous ? ' vacuous' : ''}`).join(' · ') })

    const lane = await runCriteria(wt, ctx, parent, { trustRoot: root })
    checks.push({
      name: 'drift-lane',
      ok: lane.ok && lane.value.ok,
      detail: lane.ok
        ? lane.value.criteria.map((c) => `${c.id}:${c.ok ? 'ok' : 'fail'}`).join(' · ')
        : lane.violations.map((x) => `${x.field}:${x.rule}`).join(' · '),
    })

    const effort = effortOf(root, planId)
    const recap = effort ? latestRecap(root, effort) : undefined

    return ok<GateInput>({
      class: ((recap?.class as GateInput['class']) ?? 'feature'),
      reviewedSha: worktreeTreeSha(wt),
      artifactSha: canonicalSha(plan.meta, plan.body),
      reviewed: { kind: 'tree', root: wt, files },
      promptBody: codePromptBody(wt, base, files,
        `### Plan under implementation: ${planId}\n${serializeDoc({ meta: plan.meta, body: plan.body })}`),
      checks,
      stamps: [],
    })
  },
})
