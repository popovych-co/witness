import { execFileSync } from 'node:child_process'
import { EXIT, type Ctx } from './cli.js'
import { loadConfig } from './config.js'
import { acquireLock } from './lock.js'
import { crashPoint, guardTxn, withTxn } from './txn.js'
import { appendEntry, journalRel, readStream, type Entry } from './journal.js'
import { primaryRoot, stateCommit, tryGit } from './gitio.js'
import { findById, loadCanon, type CanonDoc } from './scan.js'
import { ok, refuse, renderRefusal, v, type Result } from './refusal.js'
import { kv } from './toon.js'
import { runGate } from './gate.js'
import { lastGateRun, type DecisionEntry } from './rounds.js'
import { prepareStamp, writeStamp } from './stamp.js'
import { branchName, worktreePath } from './worktree.js'

export type ShipPhase = 'gate' | 'awaiting-decision' | 'pr' | 'watch'

export function shipPhase(plan: CanonDoc, entries: Entry[]): ShipPhase {
  if (plan.meta.pr !== undefined) return 'watch'
  const last = lastGateRun(entries, 'ship')
  if (!last) return 'gate'
  const after = entries.slice(entries.indexOf(last as unknown as Entry) + 1)
  const decision = after.find((e) =>
    e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === 'ship') as unknown as DecisionEntry | undefined
  if (!decision) return 'awaiting-decision'
  return decision.decision === 'approve' ? 'pr' : 'gate'
}

function gh(ctx: Ctx, cwd: string, args: string[], timeout = 120_000): { ok: boolean; out: string } {
  try {
    const out = execFileSync('gh', args, {
      cwd, env: ctx.env as NodeJS.ProcessEnv, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true, out }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` || String(err.message) }
  }
}

export function existingPr(ctx: Ctx, root: string, branch: string): number | undefined {
  const r = gh(ctx, root, ['pr', 'list', '--head', branch, '--json', 'number'])
  if (!r.ok) return undefined
  try {
    const arr = JSON.parse(r.out) as Array<{ number: number }>
    return arr[0]?.number
  } catch {
    return undefined
  }
}

export function createPr(ctx: Ctx, wt: string, root: string, plan: CanonDoc, parentSummary: string): Result<number> {
  const branch = branchName(String(plan.meta.id))
  if (!tryGit(root, 'remote', 'get-url', 'origin').ok) {
    return refuse([v('origin', 'no-remote', '(none)', 'an origin remote — gh pr create needs one')])
  }
  const push = tryGit(wt, 'push', '-u', 'origin', branch)
  if (!push.ok) return refuse([v('push', 'push-failed', push.out.slice(0, 200), 'git push -u origin to succeed')])
  const found = existingPr(ctx, root, branch)
  if (found !== undefined) return ok(found)
  const created = gh(ctx, wt, ['pr', 'create', '--head', branch,
    '--title', `${String(plan.meta.id)}: ${parentSummary}`,
    '--body', `Realizes spec ${String(plan.meta.parent)} at ${String(plan.meta['derives-from']).slice(0, 7)} (specflow).`])
  if (!created.ok) {
    return refuse([v('gh', 'pr-create-failed', created.out.slice(0, 200),
      'gh authenticated with push access — specflow check probes gh auth status')])
  }
  const m = /\/pull\/(\d+)\s*$/.exec(created.out.trim())
  if (!m) return refuse([v('gh', 'pr-url-unparseable', created.out.slice(-120), 'a …/pull/<n> URL')])
  return ok(Number(m[1]))
}

export function stampPr(ctx: Ctx, root: string, planId: string, pr: number): Result<{ sha: string }> {
  const canon = loadCanon(root)
  const plan = findById(canon, planId)!
  const stamp = prepareStamp(plan, String(plan.meta.status), 'ship', { pr })
  // pr: is volatile — status stays in-progress; the stamp writes meta.pr and journals the entry
  const lockR = acquireLock(root)
  if (!lockR.ok) return lockR
  try {
    return withTxn(root, {
      op: 'pr-stamp', files: [plan.rel, journalRel(planId)],
      journalMulti: [{ stream: planId, line: stamp.line }],
    }, () => {
      writeStamp(root, { ...stamp, doc: { ...plan, meta: { ...plan.meta, pr } } })
      crashPoint(ctx.env, 'pr-stamp')
      return stateCommit(root, [plan.rel, journalRel(planId)], `ship(${planId}): pr #${pr}`)
    })
  } finally {
    lockR.value()
  }
}

export function rebaseIfMoved(wt: string, shipBranch: string): 'clean' | 'rebased' | 'conflict' {
  if (tryGit(wt, 'merge-base', '--is-ancestor', shipBranch, 'HEAD').ok) return 'clean'
  const rebase = tryGit(wt, 'rebase', shipBranch)
  if (!rebase.ok) {
    tryGit(wt, 'rebase', '--abort')
    return 'conflict'
  }
  tryGit(wt, 'push', '--force-with-lease')
  return 'rebased'
}

export async function runShip(ctx: Ctx, planId: string): Promise<number> {
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const canon = loadCanon(root)
  const plan = findById(canon, planId)
  if (!plan || plan.meta.type !== 'plan') {
    renderRefusal([v('plan', 'unknown-plan', planId, 'a plans/ doc id')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const wt = worktreePath(root, planId)
  const entries = readStream(root, planId)
  const ship = (cfgR.value.raw.ship ?? {}) as { branch?: string }
  const shipBranch = ship.branch ?? 'main'
  let phase = shipPhase(plan, entries)

  if (phase === 'gate') {
    const code = await runGate(ctx, 'ship', planId, { fresh: false, manual: false })
    if (code !== EXIT.FINDINGS && code !== EXIT.OK) return code
    ctx.out(`help: specflow decide ship ${planId} --approve to send the PR — ship always stops`)
    return EXIT.FINDINGS
  }
  if (phase === 'awaiting-decision') {
    ctx.out(kv('ship', `${planId} awaits the ship decision`))
    ctx.out(`help: specflow decide ship ${planId} --show | --approve | --revise --note "<why>" | --stop`)
    return EXIT.FINDINGS
  }
  if (phase === 'pr') {
    const parent = findById(canon, String(plan.meta.parent))
    const created = createPr(ctx, wt, root, plan, String(parent?.meta.summary ?? 'specflow change'))
    if (!created.ok) { renderRefusal(created.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    const stamped = stampPr(ctx, root, planId, created.value)
    if (!stamped.ok) { renderRefusal(stamped.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    ctx.out(kv('pr', `#${created.value} created and stamped`))
    phase = 'watch'
  }

  const pr = Number(findById(loadCanon(root), planId)!.meta.pr)
  const rebase = rebaseIfMoved(wt, shipBranch)
  if (rebase === 'conflict') {
    ctx.out(kv('ship', `semantic-conflict: ${shipBranch} moved and the rebase does not apply cleanly`))
    ctx.out('help: resolve in the worktree (rebase manually), then re-run specflow ship — the CLI never freehands a merge')
    return EXIT.FINDINGS
  }
  if (rebase === 'rebased') ctx.out(kv('rebase', `${shipBranch} moved — mechanically rebased before the watch`))
  const green = gh(ctx, root, ['pr', 'checks', String(pr), '--watch'], 1_800_000)
  if (!green.ok) {
    ctx.out(kv('ci', `red — ${green.out.trim().slice(-200)}`))
    return EXIT.FINDINGS
  }
  ctx.out(kv('ci', 'green'))
  ctx.out(kv('ship', `merge PR #${pr} on GitHub when ready — the lazy stamp flips plan → done, spec → live`))
  return EXIT.OK
}
