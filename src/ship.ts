import { execFileSync } from 'node:child_process'
import { EXIT, type Ctx } from './cli.js'
import { loadConfig } from './config.js'
import { acquireLock } from './lock.js'
import { crashPoint, guardTxn, withTxn } from './txn.js'
import { appendEntry, journalRel, readStream, type Entry } from './journal.js'
import { primaryRoot, stateCommit, stateOnlyAdvance, tryGit } from './gitio.js'
import { findById, loadCanon, type CanonDoc } from './scan.js'
import { ok, refuse, renderRefusal, v, type Result } from './refusal.js'
import { cmd, kv } from './toon.js'
import { gateSpec, runGate } from './gate.js'
import { lastGateRun, liveExits, type DecisionEntry } from './rounds.js'
import { prepareStamp, writeStamp } from './stamp.js'
import { branchName, worktreePath } from './worktree.js'
import { authoringOwed, gateSettled } from './verbs/next.js'
import { diffReviewedSha } from './reviewed.js'
import { diffBase } from './evidence.js'

export type ShipPhase = 'gate' | 'awaiting-decision' | 'pr' | 'watch'

export function shipPhase(plan: CanonDoc, entries: Entry[], treeSha?: string, baseMoved = false): ShipPhase {
  // A PR exists, but the watch is only legitimate while the verdict still describes both
  // this tree AND this base. Either one moving re-arms the gate — otherwise a rebase (or
  // any post-approval edit) merges a tree no battery ever read, and re-running
  // `witness ship` is a one-command bypass of every check below.
  // `baseMoved` is a SEPARATE input from `treeSha` on purpose: a moved base has not yet
  // touched the worktree, so the tree sha still matches. Routing on the tree alone would
  // detect the moved base forever and never rebase — only the gate phase rebases, and it
  // is the rebase that finally moves the tree.
  if (plan.meta.pr !== undefined) {
    return gateSettled(entries, 'ship', treeSha) && !baseMoved ? 'watch' : 'gate'
  }
  const last = lastGateRun(entries, 'ship')
  if (!last) return 'gate'
  const after = entries.slice(entries.indexOf(last as unknown as Entry) + 1)
  const decision = after.find((e) =>
    e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === 'ship') as unknown as DecisionEntry | undefined
  // awaiting-decision is deliberately blind to baseMoved: a human reading
  // `decide ship --show` is reading findings pinned to a sha, and rebasing under them
  // would lapse the very gate they are deciding on.
  if (!decision) return 'awaiting-decision'
  if (decision.decision !== 'approve') return 'gate'
  // An approval is against a base as well as a tree — opening the PR on a base that has
  // since moved is the same stale-review bug one step earlier.
  return baseMoved ? 'gate' : 'pr'
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
  // --force-with-lease once an upstream exists: the rebase now runs in the GATE phase, so
  // a re-entered pr phase pushes a rebased branch and a plain push is no longer a
  // fast-forward. The lease still refuses to clobber anything pushed by someone else.
  const hasUpstream = tryGit(wt, 'rev-parse', '--verify', `refs/remotes/origin/${branch}`).ok
  const push = hasUpstream
    ? tryGit(wt, 'push', '--force-with-lease', '-u', 'origin', branch)
    : tryGit(wt, 'push', '-u', 'origin', branch)
  if (!push.ok) return refuse([v('push', 'push-failed', push.out.slice(0, 200), 'git push -u origin to succeed')])
  const found = existingPr(ctx, root, branch)
  if (found !== undefined) return ok(found)
  const created = gh(ctx, wt, ['pr', 'create', '--head', branch,
    '--title', `${String(plan.meta.id)}: ${parentSummary}`,
    '--body', `Realizes spec ${String(plan.meta.parent)} at ${String(plan.meta['derives-from']).slice(0, 7)} (witness).`])
  if (!created.ok) {
    return refuse([v('gh', 'pr-create-failed', created.out.slice(0, 200),
      'gh authenticated with push access — witness check probes gh auth status')])
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

// One read-only fetch decides the whole routing. A failed fetch (no remote, offline) leaves
// this false and the phases behave as they did — the gate phase's own rebaseIfMoved is where
// that condition turns into a structured refusal.
export function baseMoved(wt: string, root: string, shipBranch: string, remote = 'origin'): boolean {
  if (!tryGit(wt, 'fetch', remote, shipBranch).ok) return false
  const base = `${remote}/${shipBranch}`
  if (tryGit(wt, 'merge-base', '--is-ancestor', base, 'HEAD').ok) return false
  return !stateOnlyAdvance(wt, root, 'HEAD', base)
}

export function rebaseIfMoved(wt: string, root: string, shipBranch: string, remote = 'origin'): Result<'clean' | 'rebased'> {
  // Resolve the base from the REMOTE tip, not the local ref: with several flows merging
  // concurrently, local <shipBranch> lags every merge since the human's last pull, so a
  // local ancestry check reports "clean" against a base that is provably behind and the
  // conflict resurfaces on GitHub after CI already went green.
  if (!tryGit(wt, 'remote', 'get-url', remote).ok) {
    return refuse([v('origin', 'no-remote', '(none)', `a ${remote} remote — ship rebases on its tip`)])
  }
  // A configured remote that will not fetch is NOT the offline case. Degrading to the
  // local ref here would silently rebase on a stale base immediately before a merge,
  // which is the exact failure this function exists to prevent.
  const fetched = tryGit(wt, 'fetch', remote, shipBranch)
  if (!fetched.ok) {
    return refuse([v('fetch', 'fetch-failed', fetched.out.slice(0, 200), `git fetch ${remote} ${shipBranch} to succeed`)])
  }
  const base = `${remote}/${shipBranch}`
  if (tryGit(wt, 'merge-base', '--is-ancestor', base, 'HEAD').ok) return ok('clean')
  // Same predicate as baseMoved: an advance made entirely of witness's own state commits is
  // bookkeeping, and rebasing onto it moves the base term of every reviewed sha for nothing.
  if (stateOnlyAdvance(wt, root, 'HEAD', base)) return ok('clean')
  // --autostash: this runs in the GATE phase, and implement deliberately leaves the
  // worktree uncommitted (ship owns the sole code commit, in the pr phase below), so the
  // tree is normally dirty and a bare rebase refuses with "you have unstaged changes".
  // Autostash makes the rebase see a clean tree without moving witness's commit ahead of
  // the human's decision. A pop that conflicts fails the rebase and refuses like any other.
  const rebase = tryGit(wt, 'rebase', '--autostash', base)
  if (!rebase.ok) {
    tryGit(wt, 'rebase', '--abort')
    return refuse([v('rebase', 'textual-conflict', `${base} moved`,
      'resolve in the worktree (rebase manually), then re-run witness ship — the CLI never freehands a merge')])
  }
  // Only push a branch that HAS an upstream. This now runs in the gate phase, before
  // createPr has ever pushed, so on a first ship there is nothing on the remote to
  // update and an unconditional push fails with "no upstream branch" — createPr does
  // the initial push. Where an upstream does exist the push result is the whole point:
  // reporting 'rebased' after a failed push leaves the PR head on the pre-rebase commit,
  // and CI goes green on a tree nobody will merge.
  if (tryGit(wt, 'rev-parse', '--verify', '--quiet', '@{upstream}').ok) {
    const push = tryGit(wt, 'push', '--force-with-lease')
    if (!push.ok) {
      return refuse([v('push', 'push-failed', push.out.slice(0, 200), 'git push --force-with-lease to succeed')])
    }
  }
  return ok('rebased')
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
  // One read-only fetch decides the whole routing. A failed fetch (no remote, offline)
  // leaves baseMoved false and the phases behave as they did — the gate phase's own
  // rebaseIfMoved is where that condition turns into a structured refusal.
  const moved = baseMoved(wt, root, shipBranch)
  const baseR = diffBase(wt, cfgR.value)
  const reviewedSha = baseR.ok ? diffReviewedSha(wt, baseR.value) : undefined
  let phase = shipPhase(plan, entries, reviewedSha, moved)
  if (moved) ctx.out(kv('ship', `${shipBranch} moved — rebasing and re-reviewing before the watch`))

  if (phase === 'gate') {
    // D94: the gate cannot judge unchanged content twice — it answers changed-nothing
    // and appends nothing, so routing the human back at it burns a turn on a command
    // that has already declined. The owed work is the edit the revise asked for.
    if (authoringOwed(entries, 'ship', reviewedSha)) {
      ctx.out(kv('ship', `${planId} — revise owed`))
      ctx.out(`help: edit the code in ${wt} · then re-run witness ship ${planId}`)
      return EXIT.FINDINGS
    }
    // Rebase BEFORE the battery, never after: the reviewers must judge the tree that will
    // actually merge. Reviewing first spends a battery — and a human decision — on a tree
    // without any sibling's merged work, which then lapses (gateSettled's reviewed_sha)
    // the moment the rebase lands.
    const rebase = rebaseIfMoved(wt, root, shipBranch)
    if (!rebase.ok) {
      renderRefusal(rebase.violations).forEach((l) => ctx.err(l))
      // A textual conflict is a hand-back, not a refusal: the human resolves it in the
      // worktree and re-runs. Every other rule (no-remote, fetch-failed, push-failed) is
      // a genuine refusal and exits REFUSED like the rest of the CLI.
      return rebase.violations.some((x) => x.rule === 'textual-conflict') ? EXIT.FINDINGS : EXIT.REFUSED
    }
    if (rebase.value === 'rebased') ctx.out(kv('rebase', `${shipBranch} moved — rebased before the battery`))
    const code = await runGate(ctx, 'ship', planId, { fresh: false, manual: false })
    if (code !== EXIT.FINDINGS && code !== EXIT.OK) return code
    // No second exits line here: the gate's own render already printed the complete set
    // through liveExits. An approve-only line directly beneath it is two answers to one
    // question, and the narrower one is the one a reader acts on (D119).
    return EXIT.FINDINGS
  }
  if (phase === 'awaiting-decision') {
    ctx.out(kv('ship', `${planId} awaits the ship decision`))
    ctx.out(cmd('help', liveExits('ship', planId, entries, false, gateSpec('ship')?.upstreamOf?.(root, canon, planId))))
    return EXIT.FINDINGS
  }
  if (phase === 'pr') {
    const parent = findById(canon, String(plan.meta.parent))
    const parentSummary = String(parent?.meta.summary ?? 'witness change')
    // implement leaves the worktree uncommitted — ship owns the sole code commit
    if (tryGit(wt, 'status', '--porcelain').out !== '') {
      tryGit(wt, 'add', '-A')
      const committed = tryGit(wt, 'commit', '-m', `${planId}: ${parentSummary}`)
      if (!committed.ok) {
        renderRefusal([v('commit', 'ship-commit-failed', committed.out.slice(0, 200),
          'a committable worktree — resolve and re-run witness ship')]).forEach((l) => ctx.err(l))
        return EXIT.REFUSED
      }
      ctx.out(kv('commit', `${planId}: ${parentSummary}`))
    }
    const created = createPr(ctx, wt, root, plan, parentSummary)
    if (!created.ok) { renderRefusal(created.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    const stamped = stampPr(ctx, root, planId, created.value)
    if (!stamped.ok) { renderRefusal(stamped.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    ctx.out(kv('pr', `#${created.value} created and stamped`))
    phase = 'watch'
  }

  const pr = Number(findById(loadCanon(root), planId)!.meta.pr)
  // watch never mutates and never rebases: reaching here means shipPhase already
  // established that both the reviewed tree and the base are the ones the battery judged.
  const green = gh(ctx, root, ['pr', 'checks', String(pr), '--watch'], 1_800_000)
  if (!green.ok) {
    ctx.out(kv('ci', `red — ${green.out.trim().slice(-200)}`))
    return EXIT.FINDINGS
  }
  ctx.out(kv('ci', 'green'))
  ctx.out(kv('ship', `merge PR #${pr} on GitHub when ready — the lazy stamp flips plan → done, spec → live`))
  return EXIT.OK
}
