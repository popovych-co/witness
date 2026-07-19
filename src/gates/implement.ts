import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ok, refuse, v, type Result } from '../refusal.js'
import { serializeDoc } from '../fm.js'
import { canonicalSha } from '../sha.js'
import { designRel } from '../design.js'
import { git } from '../gitio.js'
import { latestRecap, readStream } from '../journal.js'
import type { LensDoc } from '../reviewer.js'
import { findById } from '../scan.js'
import { changedFiles, diffBase, evidenceForDiff, screensDir } from '../evidence.js'
import { runCriteria } from '../criteria.js'
import { effortOf, worktreeTreeSha } from '../reviewed.js'
import { worktreePath } from '../worktree.js'
import { registerGate, type GateInput, type LensOverride } from '../gate.js'
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

// A UI plan (design-from pinned) must ship screenshots the CLI witnessed: ≥1 capture
// from the latest green evidence cycle whose on-disk bytes still match the journaled sha.
// Zero verified → screens-matched-nothing (the D67 filter-matched-nothing pattern) before
// a reviewer spends tokens; bytes-drift → capture-sha-mismatch (a hand-swapped screenshot
// is doctorable by exactly the adversary CLI-witnessing exists for).
function resolveDesignCaptures(
  stateRoot: string, wt: string, planId: string,
): Result<Array<{ name: string; path: string }>> {
  const green = readStream(stateRoot, planId)
    .filter((e) => e.t === 'test-evidence' && e.phase === 'green')
  const journaled = ((green.at(-1) as { captures?: Array<{ name: string; sha: string }> } | undefined)?.captures) ?? []
  const dir = screensDir(wt, planId)
  const out: Array<{ name: string; path: string }> = []
  for (const c of journaled) {
    const path = join(dir, c.name)
    if (!existsSync(path) || !statSync(path).isFile()) continue     // regenerable — a missing file is just "no capture"
    const sha = createHash('sha256').update(readFileSync(path)).digest('hex')
    if (sha !== c.sha) {
      return refuse([v('screens', 'capture-sha-mismatch', c.name,
        'a capture whose bytes match the sha test-evidence witnessed — re-run the browser suite to regenerate; never hand-edit a screenshot')])
    }
    out.push({ name: c.name, path })
  }
  if (out.length === 0) {
    return refuse([v('screens', 'screens-matched-nothing', `0 verified captures for the latest green cycle of ${planId}`,
      'a UI plan (design-from pinned) must witness ≥1 screenshot — name captures in the browser test, then re-run: specflow test-evidence <plan> --phase green')])
  }
  return ok(out)
}

function screensPromptBody(caps: Array<{ name: string; path: string }>): string {
  return [
    'The reviewed content is the screenshots below. **Read each PNG at its absolute path with the Read tool before judging** — the images are the artifact, not this text.',
    '',
    ...caps.map((c) => `- ${c.name} — ${c.path}`),
  ].join('\n')
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

    const pin = plan.meta['design-from']
    const lensOverrides: Record<string, LensOverride> = {}
    const skipLenses: string[] = []
    if (typeof pin === 'string' && pin !== '') {
      const capR = resolveDesignCaptures(root, wt, planId)
      if (!capR.ok) return capR
      const artRel = designRel(cfg.paths, String(plan.meta.parent))
      const artAbs = join(root, artRel)
      if (!existsSync(artAbs) || !statSync(artAbs).isFile()) {
        return refuse([v('design', 'design-artifact-missing', artRel,
          'the approved living design the plan pins — restore it or re-run the design stage')])
      }
      const living: LensDoc = { path: artRel, contents: readFileSync(artAbs, 'utf8') }
      lensOverrides['design-reviewer'] = {
        reviewed: { kind: 'screens', captures: capR.value },
        promptBody: screensPromptBody(capR.value),
        docs: [living],   // joins prompts_sha → an amended design re-rolls on unchanged code
      }
    } else {
      // not UI-work: drop the lens if a battery names it (stages shrink, never skip)
      skipLenses.push('design-reviewer')
    }

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
      lensOverrides,
      skipLenses,
    })
  },

  currentSha(root, _canon, _cfg, planId) {
    const wt = worktreePath(root, planId)
    return existsSync(wt) ? worktreeTreeSha(wt) : undefined
  },
})
