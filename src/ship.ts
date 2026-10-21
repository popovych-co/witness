import { execFileSync } from 'node:child_process'
import { EXIT, type Ctx } from './cli.js'
import { loadConfig, type Config } from './config.js'
import { acquireLock } from './lock.js'
import { crashPoint, guardTxn, withTxn } from './txn.js'
import { appendEntry, journalRel, readStream, type Entry } from './journal.js'
import { primaryRoot, stateCommit, stateOnlyAdvance, tryGit } from './gitio.js'
import { untrustedCmdsFor } from './allowlist.js'
import { criteriaOwner, findById, loadCanon, type CanonDoc } from './scan.js'
import { humanCall, ok, refuse, renderRefusal, v, type Result } from './refusal.js'
import { cmd, kv } from './toon.js'
import { gateSpec, runGate } from './gate.js'
import { lastGateRun, liveExits, type DecisionEntry } from './rounds.js'
import { recommend, renderDecision } from './recommend.js'
import { prepareStamp, writeStamp } from './stamp.js'
import { branchName, worktreePath } from './worktree.js'
import { authoringOwed, gateSettled } from './verbs/next.js'
import { diffReviewedSha } from './reviewed.js'
import { diffBase } from './evidence.js'
// Static, unlike gate.ts and next.ts: this module lies outside gate.ts's static import graph,
// so reaching decide.ts from here closes no registration cycle.
import { settleStop, settledCode } from './settle.js'

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

// Row 174. Witness merges what it was allowed to ship — and only that. CI can run for half an
// hour, so the approval is re-checked against the world as it is AFTER the watch: a base
// another flow moved, or a tree that changed, means the merge would land bytes no battery
// read, and it is held for `witness ship` to rebase and re-gate. Never `merge PR`: that is
// drive's human-merge stop (drive.ts), and this is not one.
export function mergeOwnPr(ctx: Ctx, root: string, cfg: Config, planId: string, pr: number): number {
  // Re-read, not reused: CI can run for half an hour, and a human who commits `autonomy: off`
  // meanwhile is taking the merge back (F10). The merge is then theirs, as without autonomy.
  const nowR = loadConfig(root)
  if (!nowR.ok || !nowR.value.autonomy) {
    ctx.out(kv('ship', `merge PR #${pr} on GitHub when ready — the lazy stamp flips plan → done, spec → live`))
    return EXIT.OK
  }
  cfg = nowR.value
  const entries = readStream(root, planId)
  const wt = worktreePath(root, planId)
  const shipBranch = ((cfg.raw.ship ?? {}) as { branch?: string }).branch ?? 'main'
  // `baseMoved` reads a failed fetch as "not moved" so routing degrades offline; here that
  // would merge onto a base nobody could check (F9), so an unreachable remote holds instead.
  if (!tryGit(wt, 'fetch', 'origin', shipBranch).ok) {
    ctx.out(kv('merge', `held — cannot verify ${shipBranch} (the fetch failed) · witness ship ${planId} retries once the remote answers`))
    return EXIT.FINDINGS
  }
  const base = diffBase(wt, cfg)
  const lapsed = baseMoved(wt, root, shipBranch) ? `${shipBranch} moved`
    : !base.ok || !gateSettled(entries, 'ship', diffReviewedSha(wt, base.value)) ? 'the tree moved'
    : undefined
  if (lapsed !== undefined) {
    ctx.out(kv('merge', `held — the ship approval lapsed (${lapsed}) · witness ship ${planId} re-gates`))
    return EXIT.FINDINGS
  }
  // The local checks above prove the WORKTREE is what was judged; `gh pr merge` merges the
  // REMOTE head. Pinning the merge to the reviewed commit makes GitHub refuse a head anyone
  // pushed since — another session, a collaborator, a force-push — so the merge can only
  // ever land the commit CI and the battery saw. A refusal there is a human's call.
  const head = tryGit(wt, 'rev-parse', 'HEAD')
  if (!head.ok) {
    ctx.out(kv('merge', `held — the reviewed commit cannot be read in ${wt} · witness ship ${planId} re-gates`))
    return EXIT.FINDINGS
  }
  const merged = gh(ctx, root, ['pr', 'merge', String(pr), `--${cfg.ship.merge}`, '--match-head-commit', head.out.trim()])
  if (!merged.ok) {
    renderRefusal([humanCall(v('gh', 'merge-refused', merged.out.trim().slice(-200),
      "a PR GitHub will merge — branch protection and required reviews are the repo owner's to settle"))])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  ctx.out(kv('merged', `#${pr} · ${cfg.ship.merge} — the lazy stamp finishes the lifecycle on the next scan`))
  return EXIT.OK
}

// The approved tree is what the PR must carry before CI is watched (F8). Ship owns the code
// commit, and a revise at the ship gate leaves its fix uncommitted in the worktree — once a PR
// exists nothing else commits or pushes it, so CI went green on the old head and that is the
// commit the merge landed. Never a force-push: a remote head this worktree lacks is someone
// else's work, and overwriting it is a human's call.
function pushApproved(ctx: Ctx, wt: string, planId: string, summary: string): Result<void> {
  if (tryGit(wt, 'status', '--porcelain').out !== '') {
    tryGit(wt, 'add', '-A')
    const committed = tryGit(wt, 'commit', '-m', `${planId}: ${summary}`)
    if (!committed.ok) {
      return refuse([v('commit', 'ship-commit-failed', committed.out.slice(0, 200),
        'a committable worktree — resolve and re-run witness ship')])
    }
    ctx.out(kv('commit', `${planId}: ${summary}`))
  }
  const branch = branchName(planId)
  tryGit(wt, 'fetch', 'origin', branch)
  const head = tryGit(wt, 'rev-parse', 'HEAD')
  const remote = tryGit(wt, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`)
  if (head.ok && remote.ok && head.out.trim() === remote.out.trim()) return ok(undefined)
  const push = tryGit(wt, 'push', '-u', 'origin', `HEAD:${branch}`)
  if (!push.ok) {
    return refuse([humanCall(v('push', 'push-diverged', push.out.slice(0, 200),
      'a PR branch this worktree can fast-forward — the remote holds commits it does not, and overwriting them is a human\'s call'))])
  }
  ctx.out(kv('push', `${branch} → the approved tree`))
  return ok(undefined)
}

const WATCH_MS = 1_800_000
const POLL_MS = 10_000
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

type CiVerdict = { kind: 'green' } | { kind: 'red'; detail: string } | { kind: 'none' } | { kind: 'no-pass' }

// Row 174 (F7). `gh pr checks --watch` exits 0 for every rollup with nothing failed or pending
// — cancelled and skipped included — and ends the moment nothing is pending, which can be
// before a late check has registered. So green needs positive evidence on a set that held
// still: after the watch and `ship.ciSettleMs`, at least one check passed and none failed,
// was cancelled or is pending; a check that appeared meanwhile is watched in turn. "No
// checks" at the first poll is retried within the same window before it is believed.
async function watchCi(ctx: Ctx, root: string, pr: number, settleMs: number): Promise<CiVerdict> {
  const start = Date.now()
  for (;;) {
    const left = Math.max(1, WATCH_MS - (Date.now() - start))
    const watched = gh(ctx, root, ['pr', 'checks', String(pr), '--watch'], left)
    if (!watched.ok) {
      if (/no checks reported/.test(watched.out)) {
        if (Date.now() - start < settleMs) { await sleep(Math.min(settleMs, POLL_MS)); continue }
        return { kind: 'none' }
      }
      return { kind: 'red', detail: watched.out.trim().slice(-200) }
    }
    if (settleMs > 0) await sleep(settleMs)
    const read = gh(ctx, root, ['pr', 'checks', String(pr), '--json', 'name,bucket'])
    let checks: Array<{ name: string; bucket: string }> | undefined
    try { checks = read.ok ? JSON.parse(read.out) as Array<{ name: string; bucket: string }> : undefined } catch { checks = undefined }
    if (!Array.isArray(checks)) return { kind: 'red', detail: `the check set could not be read — ${read.out.trim().slice(-120)}` }
    if (checks.some((c) => c.bucket === 'pending')) {
      if (Date.now() - start >= WATCH_MS) return { kind: 'red', detail: 'checks still pending when the watch window closed' }
      continue
    }
    const bad = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel')
    if (bad.length > 0) return { kind: 'red', detail: bad.map((c) => `${c.bucket}: ${c.name}`).join(' · ') }
    return checks.some((c) => c.bucket === 'pass') ? { kind: 'green' } : { kind: 'no-pass' }
  }
}

export async function runShip(ctx: Ctx, planId: string, opts: { manual?: boolean } = {}): Promise<number> {
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  let canon = loadCanon(root)
  let plan = findById(canon, planId)
  if (!plan || plan.meta.type !== 'plan') {
    renderRefusal([v('plan', 'unknown-plan', planId, 'a plans/ doc id')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const wt = worktreePath(root, planId)
  let entries = readStream(root, planId)
  const ship = (cfgR.value.raw.ship ?? {}) as { branch?: string }
  const shipBranch = ship.branch ?? 'main'
  // `--manual` keeps this run's stop and its merge for a human, exactly as on `witness gate`.
  const manual = opts.manual === true
  const autonomy = cfgR.value.autonomy && !manual
  // One read-only fetch decides the whole routing. A failed fetch (no remote, offline)
  // leaves baseMoved false and the phases behave as they did — the gate phase's own
  // rebaseIfMoved is where that condition turns into a structured refusal.
  const moved = baseMoved(wt, root, shipBranch)
  const baseR = diffBase(wt, cfgR.value)
  let reviewedSha = baseR.ok ? diffReviewedSha(wt, baseR.value) : undefined
  let phase = shipPhase(plan, entries, reviewedSha, moved)
  if (moved) ctx.out(kv('ship', `${shipBranch} moved — rebasing and re-reviewing before the watch`))
  // Row 174. Under autonomy an approval settled in this run carries straight on to the PR,
  // so the phase is derived again from the world as it now stands — the gate phase may
  // just have rebased, which moves both the tree and the base terms.
  const rederive = (): ShipPhase => {
    canon = loadCanon(root)
    plan = findById(canon, planId)!
    entries = readStream(root, planId)
    const b = diffBase(wt, cfgR.value)
    reviewedSha = b.ok ? diffReviewedSha(wt, b.value) : undefined
    return shipPhase(plan, entries, reviewedSha, baseMoved(wt, root, shipBranch))
  }

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
    const code = await runGate(ctx, 'ship', planId, { fresh: false, manual })
    if (code !== EXIT.FINDINGS && code !== EXIT.OK) return code
    // No second exits line here: the gate's own render already printed the complete set
    // through liveExits. An approve-only line directly beneath it is two answers to one
    // question, and the narrower one is the one a reader acts on (D119).
    if (!(autonomy && code === EXIT.OK)) return EXIT.FINDINGS
    phase = rederive()
    if (phase !== 'pr' && phase !== 'watch') return EXIT.FINDINGS
  }
  if (phase === 'awaiting-decision' && autonomy) {
    // A stop the gate's tail left owed (a crash, or one waiting when autonomy was turned on)
    // settles here by the same policy; anything but an approve hands back as before.
    const s = await settleStop(ctx, root, cfgR.value, 'ship', planId)
    if (s.kind === 'decided' && s.decision === 'approve') {
      phase = rederive()
      if (phase !== 'pr' && phase !== 'watch') return EXIT.FINDINGS
    } else if (s.kind !== 'none') {
      return settledCode(EXIT.FINDINGS, s)
    }
    // `none` — a stop the policy does not settle (a `--manual` run's): the human's, rendered below.
  }
  if (phase === 'awaiting-decision') {
    ctx.out(kv('ship', `${planId} awaits the ship decision`))
    // D121. Ship is one of the three stops north star 3 reserves for human judgment, so the
    // block's `judge-first:` line matters most here: the battery judged the code against the
    // plan, and nothing judged the plan against the product.
    const up = gateSpec('ship')?.upstreamOf?.(root, canon, planId)
    // D154. The ship gate runs criteria too, so its approve carries the same two prices.
    const untrustedCmds = untrustedCmdsFor(root, criteriaOwner(canon, planId))
    const d = recommend({ gate: 'ship', target: planId, entries, upstream: up, stale: false, untrustedCmds })
    if (d) renderDecision(d).forEach((l) => ctx.out(l))
    else ctx.out(cmd('help', liveExits('ship', planId, entries, false, up)))
    return EXIT.FINDINGS
  }
  if (phase === 'pr') {
    const parent = findById(canon, String(plan!.meta.parent))
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
    const created = createPr(ctx, wt, root, plan!, parentSummary)
    if (!created.ok) { renderRefusal(created.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    const stamped = stampPr(ctx, root, planId, created.value)
    if (!stamped.ok) { renderRefusal(stamped.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    ctx.out(kv('pr', `#${created.value} created and stamped`))
    phase = 'watch'
  }

  const pr = Number(findById(loadCanon(root), planId)!.meta.pr)
  // watch never rebases: reaching here means shipPhase already established that both the
  // reviewed tree and the base are the ones the battery judged. It does carry that tree to
  // the PR first — a revise answered after the PR opened is otherwise never pushed (F8).
  const pushed = pushApproved(ctx, wt, planId, String(findById(canon, String(plan!.meta.parent))?.meta.summary ?? 'witness change'))
  if (!pushed.ok) { renderRefusal(pushed.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  if (autonomy) {
    const ci = await watchCi(ctx, root, pr, cfgR.value.ship.ciSettleMs)
    // Row 174 / §11 call 18. Green is the merge's only licence: no checks at all, or none
    // that passed, is not green — the human's call, never a CI to "fix".
    if (ci.kind === 'none') { ctx.out(kv('merge', 'held — no CI checks reported · witness merges only on green CI')); return EXIT.FINDINGS }
    if (ci.kind === 'no-pass') { ctx.out(kv('merge', 'held — no passing CI check · witness merges only on green CI')); return EXIT.FINDINGS }
    if (ci.kind === 'red') { ctx.out(kv('ci', `red — ${ci.detail}`)); return EXIT.FINDINGS }
    ctx.out(kv('ci', 'green'))
    return mergeOwnPr(ctx, root, cfgR.value, planId, pr)
  }
  const green = gh(ctx, root, ['pr', 'checks', String(pr), '--watch'], WATCH_MS)
  if (!green.ok) {
    ctx.out(kv('ci', `red — ${green.out.trim().slice(-200)}`))
    return EXIT.FINDINGS
  }
  ctx.out(kv('ci', 'green'))
  ctx.out(kv('ship', `merge PR #${pr} on GitHub when ready — the lazy stamp flips plan → done, spec → live`))
  return EXIT.OK
}
