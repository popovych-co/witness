import { existsSync } from 'node:fs'
import { ok, refuse, v, type Result } from '../refusal.js'
import { canonicalSha } from '../sha.js'
import { latestRecap, readStream, type Entry } from '../journal.js'
import { findById } from '../scan.js'
import { changedFiles, diffBase } from '../evidence.js'
import { runCriteria } from '../criteria.js'
import { execCommand } from '../runner.js'
import { ensureTrusted } from '../allowlist.js'
import { effortOf, worktreeTreeSha } from '../reviewed.js'
import { worktreePath } from '../worktree.js'
import { codePromptBody } from './implement.js'
import { registerGate, type GateInput } from '../gate.js'
import { lastGateRun, type DecisionEntry, type GateCheck } from '../rounds.js'
import { serializeDoc } from '../fm.js'

async function commandLane(
  wt: string, root: string, ctx: Parameters<typeof ensureTrusted>[1], name: string, cmd: string | undefined,
): Promise<GateCheck> {
  if (!cmd) return { name, ok: false, detail: `ship.${name === 'tests' ? 'test' : 'lint'} not configured` }
  const trust = await ensureTrusted(root, ctx, cmd)
  if (trust !== 'trusted') return { name, ok: false, detail: `${cmd}: ${trust}` }
  const run = execCommand(wt, ctx, cmd)
  return { name, ok: run.exitZero, detail: run.exitZero ? cmd : run.output.slice(-300) }
}

registerGate({
  gate: 'ship',
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

    const entries = readStream(root, planId)
    const lastImplement = lastGateRun(entries, 'implement')
    const implementSettled = (() => {
      if (!lastImplement) return false
      if (lastImplement.outcome === 'passed') return true
      const after = entries.slice(entries.lastIndexOf(lastImplement as unknown as Entry) + 1)
      return after.some((e) => e.t === 'human-decision' &&
        (e as unknown as DecisionEntry).gate === 'implement' &&
        (e as unknown as DecisionEntry).decision === 'approve')
    })()
    checks.push({ name: 'implement-gate', ok: implementSettled,
      detail: lastImplement
        ? `last implement round ${lastImplement.round}: ${lastImplement.outcome}`
        : 'implement gate never ran — specflow gate implement ' + planId })

    const ship = (cfg.raw.ship ?? {}) as { test?: string; lint?: string }
    checks.push(await commandLane(wt, root, ctx, 'tests', ship.test))
    checks.push(await commandLane(wt, root, ctx, 'lint', ship.lint))

    // deterministic drift lane: spec content from MAIN, execution in the worktree
    const lane = await runCriteria(wt, ctx, parent, { trustRoot: root })
    const laneOk = lane.ok && lane.value.ok
    checks.push({
      name: 'drift-lane',
      ok: laneOk,
      detail: lane.ok
        ? lane.value.criteria.map((c) => `${c.id}:${c.ok ? 'ok' : 'fail'}`).join(' · ')
        : lane.violations.map((x) => `${x.field}:${x.rule}`).join(' · '),
    })

    const pin = String(plan.meta['derives-from'])
    const repin = lane.ok && lane.value.ok && pin !== lane.value.sha
      ? { rel: plan.rel, meta: plan.meta, body: plan.body, sha: lane.value.sha }
      : undefined

    const effort = effortOf(root, planId)
    const recap = effort ? latestRecap(root, effort) : undefined

    return ok<GateInput>({
      class: ((recap?.class as GateInput['class']) ?? 'feature'),
      reviewedSha: worktreeTreeSha(wt),
      artifactSha: canonicalSha(plan.meta, plan.body),
      reviewed: { kind: 'tree', root: wt, files },
      promptBody: codePromptBody(wt, base, files,
        `### Parent spec (from main): ${String(parent.meta.id)}\n${serializeDoc({ meta: parent.meta, body: parent.body })}\n\n### Plan: ${planId}\n${serializeDoc({ meta: plan.meta, body: plan.body })}`),
      checks,
      standingStop: 'ship always stops — a human sends every PR',
      stamps: [],
      repin,
    })
  },
})
