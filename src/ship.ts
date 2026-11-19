import { cliAct } from './act.js'
import { EXIT, type Ctx } from './cli.js'
import { autonomyAt, loadConfig, type Config } from './config.js'
import { acquireLock } from './lock.js'
import { crashPoint, guardTxn, withTxn } from './txn.js'
import { appendEntry, journalRel, readStream, type Entry } from './journal.js'
import { primaryRoot, stateCommit, stateOnlyAdvance, tryGit, tryGitC } from './gitio.js'
import { untrustedCmdsFor } from './allowlist.js'
import { heldSatisfy, liftedHolds, type HeldRow } from './needs.js'
import { criteriaOwner, findById, loadCanon, type CanonDoc } from './scan.js'
import { humanCall, ok, refuse, renderRefusal, v, type Result, type Violation } from './refusal.js'
import { cmd, kv, logSafe, shellLine } from './toon.js'
import { gateSpec, runGate } from './gate.js'
import { lastGateRun, liveExits, type DecisionEntry } from './rounds.js'
import { recommend, renderDecision } from './recommend.js'
import { prepareStamp, writeStamp } from './stamp.js'
import { branchName, worktreePath } from './worktree.js'
import { authoringOwed, gateSettled, openStepRow, stepsOpenViolation } from './verbs/next.js'
import { diffReviewedSha } from './reviewed.js'
import { diffBase } from './evidence.js'
import { handOverIfDue } from './slice.js'
import { execFileSync } from './spawn.js'
// Static, unlike gate.ts and next.ts: this module lies outside gate.ts's static import graph,
// so reaching decide.ts from here closes no registration cycle.
import { busyLine, hhmm, settleStop, settledCode } from './settle.js'
import { classifyGh, classifyGit, journalOutcome, standingRecord, type ShipOutcome } from './ship-outcome.js'
import { heldItem, needYouRows } from './needs-you.js'
import { driveChild } from './drive-presence.js'
import { shipUntil, takeBusy } from './busy.js'

export type ShipPhase = 'gate' | 'awaiting-decision' | 'pr' | 'watch'

export function shipPhase(plan: CanonDoc, entries: Entry[], treeSha?: string, baseMoved = false, holdLifted = false): ShipPhase {
  // A PR exists, but the watch is only legitimate while the verdict still describes both
  // this tree AND this base. Either one moving re-arms the gate — otherwise a rebase (or
  // any post-approval edit) merges a tree no battery ever read, and re-running
  // `witness ship` is a one-command bypass of every check below.
  // `baseMoved` is a SEPARATE input from `treeSha` on purpose: a moved base has not yet
  // touched the worktree, so the tree sha still matches. Routing on the tree alone would
  // detect the moved base forever and never rebase — only the gate phase rebases, and it
  // is the rebase that finally moves the tree.
  if (plan.meta.pr !== undefined) {
    // Final review F1: a hold lifted since the ship gate ran is a verdict that never ran a
    // criterion now owed, so it re-gates exactly as a moved tree does.
    return gateSettled(entries, 'ship', treeSha) && !baseMoved && !holdLifted ? 'watch' : 'gate'
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
  return baseMoved || holdLifted ? 'gate' : 'pr'
}

// `code`: gh's exit status, or null when it ended on a signal (its timeout) — row 242 reads both.
function gh(ctx: Ctx, cwd: string, args: string[], timeout = 120_000): { ok: boolean; out: string; code: number | null } {
  try {
    const out = execFileSync('gh', args, {
      cwd, env: ctx.env as NodeJS.ProcessEnv, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true, out, code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string; status?: number | null }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` || String(err.message), code: typeof err.status === 'number' ? err.status : null }
  }
}

// Row 242 (design §4.3.1). The outcome a ship run ends on, journaled for every reader: the PR it is
// about (once one exists), the worktree's HEAD, and the ship branch's commit as ship last fetched it.
function recordOutcome(root: string, planId: string, outcome: ShipOutcome, reason: string, shipBranch?: string): void {
  const wt = worktreePath(root, planId)
  const head = tryGit(wt, 'rev-parse', 'HEAD')
  if (!head.ok) return
  const pr = findById(loadCanon(root), planId)?.meta.pr
  const base = shipBranch !== undefined ? tryGit(wt, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${shipBranch}`) : undefined
  journalOutcome(root, planId, {
    ...(typeof pr === 'number' && Number.isSafeInteger(pr) && pr >= 1 ? { pr } : {}),
    head: head.out.trim(), ...(base?.ok ? { base: base.out.trim() } : {}), outcome, reason,
  })
}

// Row 242. A refusal of the remote — no origin, a fetch, a push, a PR create — as the outcome it is:
// a human's fix (a branch holding commits the worktree lacks, a lease refused, a refused login, no
// remote), or one drive re-checks (the remote did not answer, or another push or create failure).
// The session's own work — a commit that failed, an unreadable HEAD, a rebase conflict — is no record.
function recordRefusal(root: string, planId: string, violations: readonly Violation[], shipBranch: string): void {
  const x = violations[0]
  if (x === undefined) return
  const got = String(x.got)
  switch (x.rule) {
    case 'no-remote': return recordOutcome(root, planId, 'fix', 'no origin remote — add one, then re-check', shipBranch)
    case 'push-diverged': return recordOutcome(root, planId, 'fix', 'the PR branch holds commits this worktree lacks — overwriting them is your call', shipBranch)
    case 'fetch-failed': return recordOutcome(root, planId, 'transient', 'the fetch failed', shipBranch)
    case 'push-failed': return classifyGit(got) === 'login'
      ? recordOutcome(root, planId, 'fix', 'git refused the login — sign in to the remote again', shipBranch)
      : recordOutcome(root, planId, 'transient', 'the push failed', shipBranch)
    case 'pr-create-failed': return classifyGh(1, got) === 'login'
      ? recordOutcome(root, planId, 'fix', 'GitHub refused the login — gh auth login', shipBranch)
      : recordOutcome(root, planId, 'transient', 'the PR could not be created', shipBranch)
    case 'pr-url-unparseable': return recordOutcome(root, planId, 'transient', 'the PR create answered no PR', shipBranch)
    default: return undefined
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

// Row 179. A PR shipped while a need held criteria says what was not verified, so the human
// reading the PR is not told the spec was proven where it was not. Row 239 (B13): a PR is a surface
// too, so each row's command is the one `heldSatisfy` rebuilds from the journaled row, or none, and
// (ruling R16(a)) its criterion and need are spelled out, so a line break cannot start a line of its own.
export function prBody(plan: CanonDoc, held: HeldRow[]): string {
  const head = `Realizes spec ${String(plan.meta.parent)} at ${String(plan.meta['derives-from']).slice(0, 7)} (witness).`
  if (held.length === 0) return head
  return [head, '', 'Held — not verified while a need is unmet:', ...held.map((h) => {
    const satisfy = heldSatisfy(h)
    return `- ${logSafe(String(h.criterion))}: ${logSafe(String(h.need))} unmet${satisfy ? ` — ${satisfy}` : ''}`
  })].join('\n')
}

// Row 242. The commit witness itself last pushed to a plan's PR branch, kept in a witness-owned
// ref (refs/ is shared by every worktree of the repo). A forced push leases on it, never on the
// tracking ref: any fetch moves that one onto whatever the remote holds, a collaborator's commit
// included, and a lease on it then authorises overwriting that commit (P27).
export function pushedRef(planId: string): string {
  return `refs/witness/pushed/${planId}`
}

export function recordPushed(wt: string, planId: string, sha: string): void {
  tryGit(wt, 'update-ref', pushedRef(planId), sha)
}

const DIVERGED_WANT =
  'a PR branch this worktree can fast-forward — the remote holds commits it does not, and overwriting them is a human\'s call'

// The lease a forced push to `branch` carries, settled from a fresh fetch BEFORE anything moves
// the worktree, so a refused one leaves the worktree as it was, for the human. The fetched tip is
// accepted only when it is witness's own last push, or a commit the worktree already holds (a PR
// pushed before 0.29 has no record, and overwriting what HEAD contains loses nothing); anything
// else is someone else's work. The push then leases on that exact sha, so a commit landing
// between this fetch and the push is refused by the remote itself.
function leaseFor(wt: string, branch: string, remote = 'origin'): Result<string> {
  const fetched = tryGit(wt, 'fetch', remote, branch)
  if (!fetched.ok) {
    return refuse([v('fetch', 'fetch-failed', fetched.out.slice(0, 200), `${shellLine(['git', 'fetch', remote, branch])} to succeed`)])
  }
  const tip = tryGit(wt, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}^{commit}`)
  if (!tip.ok) return refuse([v('push', 'head-unreadable', tip.out.slice(0, 200), `a readable ${remote}/${branch}`)])
  const sha = tip.out.trim()
  const planId = branch.startsWith('witness/') ? branch.slice('witness/'.length) : undefined
  const recorded = planId === undefined ? undefined : tryGit(wt, 'rev-parse', '--verify', '--quiet', `${pushedRef(planId)}^{commit}`)
  if (recorded?.ok && recorded.out.trim() === sha) return ok(sha)
  if (tryGit(wt, 'merge-base', '--is-ancestor', sha, 'HEAD').ok) return ok(sha)
  return refuse([humanCall(v('push', 'push-diverged', `${remote}/${branch} at ${sha.slice(0, 12)}`, DIVERGED_WANT))])
}

// A push of HEAD to the PR branch, forced only under a lease from `leaseFor`, read in the C
// locale; a rejection is the remote holding commits witness did not push. Recorded on success.
function pushPr(wt: string, branch: string, lease: string | undefined, setUpstream: boolean, remote = 'origin'): Result<string> {
  const head = tryGit(wt, 'rev-parse', 'HEAD')
  if (!head.ok) return refuse([v('push', 'head-unreadable', head.out.slice(0, 200), `a readable HEAD in ${wt}`)])
  const push = tryGitC(wt, 'push', '--porcelain',
    ...(lease === undefined ? [] : [`--force-with-lease=refs/heads/${branch}:${lease}`]),
    ...(setUpstream ? ['-u'] : []), remote, `HEAD:refs/heads/${branch}`)
  if (!push.ok) {
    const kind = classifyGit(push.out)
    if (kind === 'diverged' || kind === 'lease') {
      return refuse([humanCall(v('push', 'push-diverged', push.out.slice(0, 200), DIVERGED_WANT))])
    }
    return refuse([v('push', 'push-failed', push.out.slice(0, 200), `${shellLine(['git', 'push', remote, branch])} to succeed`)])
  }
  const sha = head.out.trim()
  if (branch.startsWith('witness/')) recordPushed(wt, branch.slice('witness/'.length), sha)
  return ok(sha)
}

export function createPr(ctx: Ctx, wt: string, root: string, plan: CanonDoc, parentSummary: string, held: HeldRow[] = []): Result<number> {
  const branch = branchName(String(plan.meta.id))
  if (!tryGit(root, 'remote', 'get-url', 'origin').ok) {
    return refuse([v('origin', 'no-remote', '(none)', 'an origin remote — gh pr create needs one')])
  }
  // A forced push once an upstream exists: the rebase now runs in the GATE phase, so a
  // re-entered pr phase pushes a rebased branch and a plain push is no longer a fast-forward.
  // Row 242: the lease is witness's own last push (or a tip the worktree holds), never the
  // tracking ref, so it refuses to clobber anything pushed by someone else.
  const hasUpstream = tryGit(wt, 'rev-parse', '--verify', `refs/remotes/origin/${branch}`).ok
  const lease = hasUpstream ? leaseFor(wt, branch) : undefined
  if (lease !== undefined && !lease.ok) return lease
  const push = pushPr(wt, branch, lease?.value, true)
  if (!push.ok) return push
  const found = existingPr(ctx, root, branch)
  if (found !== undefined) return ok(found)
  const created = gh(ctx, wt, ['pr', 'create', '--head', branch,
    '--title', `${String(plan.meta.id)}: ${parentSummary}`,
    '--body', prBody(plan, held)])
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
    // Row 239: the fetch the want names is another tool's command, through the one renderer.
    return refuse([v('fetch', 'fetch-failed', fetched.out.slice(0, 200), `${shellLine(['git', 'fetch', remote, shipBranch])} to succeed`)])
  }
  const base = `${remote}/${shipBranch}`
  if (tryGit(wt, 'merge-base', '--is-ancestor', base, 'HEAD').ok) return ok('clean')
  // Same predicate as baseMoved: an advance made entirely of witness's own state commits is
  // bookkeeping, and rebasing onto it moves the base term of every reviewed sha for nothing.
  if (stateOnlyAdvance(wt, root, 'HEAD', base)) return ok('clean')
  // Only push a branch that HAS an upstream. This runs in the gate phase, before createPr has
  // ever pushed, so on a first ship there is nothing on the remote to update — createPr does the
  // initial push. Row 242: where an upstream exists, the lease is settled before the rebase, so a
  // PR branch someone else pushed to refuses with the worktree untouched (P27).
  const branch = tryGit(wt, 'symbolic-ref', '--quiet', '--short', 'HEAD')
  const upstream = branch.ok && tryGit(wt, 'rev-parse', '--verify', '--quiet', '@{upstream}').ok
  const lease = upstream ? leaseFor(wt, branch.out.trim(), remote) : undefined
  if (lease !== undefined && !lease.ok) return lease
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
  // Where an upstream exists the push result is the whole point: reporting 'rebased' after a
  // failed push leaves the PR head on the pre-rebase commit, and CI goes green on a tree nobody
  // will merge.
  if (lease !== undefined) {
    const push = pushPr(wt, branch.out.trim(), lease.value, false, remote)
    if (!push.ok) return push
  }
  return ok('rebased')
}

// Row 174. Witness merges what it was allowed to ship — and only that. CI can run for half an
// hour, so the approval is re-checked against the world as it is AFTER the watch: a base
// another flow moved, or a tree that changed, means the merge would land bytes no battery
// read, and it is held for `witness ship` to rebase and re-gate. Never `merge PR`: that is
// drive's human-merge stop (drive.ts), and this is not one.
// `pushed` is the commit `pushApproved` carried to the PR before the watch: the one tree the
// approval and CI both describe. The merge is bound to it, and held when the worktree no
// longer sits cleanly on it — the approval is checked against the WORKING tree, so a commit
// slipped under a restored working tree would otherwise pass the check and be the one merged.
export function mergeOwnPr(ctx: Ctx, root: string, cfg: Config, planId: string, pr: number, pushed?: string): number {
  // Re-read, not reused: CI can run for half an hour, and a human who commits `autonomy: off`
  // meanwhile is taking the merge back (F10). The merge is then theirs, as without autonomy.
  const nowR = loadConfig(root)
  if (!nowR.ok || !nowR.value.autonomy) {
    ctx.out(kv('ship', `merge PR #${pr} on GitHub when ready — the lazy stamp flips plan → done, spec → live`))
    recordOutcome(root, planId, 'merge', 'autonomy is off now — the merge is yours', cfg.ship.branch)
    return EXIT.OK
  }
  cfg = nowR.value
  // Row 241 (R9). A plan re-authored with a new step during the CI watch holds the merge: `next`
  // routes the step, so this outcome writes no record.
  const nowPlan = findById(loadCanon(root), planId)
  const open = nowPlan !== undefined ? openStepRow(root, cfg, nowPlan) : undefined
  if (open !== undefined) {
    ctx.out(kv('merge', `held — ${open.step} is not built yet · ${open.row.line}`))
    return EXIT.FINDINGS
  }
  const entries = readStream(root, planId)
  const wt = worktreePath(root, planId)
  const shipBranch = cfg.ship.branch
  // Row 239. The command every held line names is an act's line.
  const shipCmd = cliAct('ship', planId).line
  // `baseMoved` reads a failed fetch as "not moved" so routing degrades offline; here that
  // would merge onto a base nobody could check (F9), so an unreachable remote holds instead.
  if (!tryGit(wt, 'fetch', 'origin', shipBranch).ok) {
    ctx.out(kv('merge', `held — cannot verify ${shipBranch} (the fetch failed) · ${shipCmd} retries once the remote answers`))
    recordOutcome(root, planId, 'transient', `cannot verify ${shipBranch} (the fetch failed)`, shipBranch)
    return EXIT.FINDINGS
  }
  // The merge is the one irreversible outward act, so its authority comes from the branch it
  // lands on, as the remote holds it — pushed and, on most repos, branch-protected — never
  // from HEAD alone, which the coding agent can commit to. "The branch it lands on" is the
  // PR's base as GitHub reports it, not `ship.branch`, which is working-copy config: a PR
  // aimed anywhere else is a human's call.
  // Row 242: the same view reads the PR's state, so a PR closed (or merged) on GitHub is named.
  const view = gh(ctx, root, ['pr', 'view', String(pr), '--json', 'state,baseRefName'])
  let prBase: string | undefined
  let prState: string | undefined
  try {
    const v0 = view.ok ? (JSON.parse(view.out) as { baseRefName?: unknown; state?: unknown }) : undefined
    prBase = typeof v0?.baseRefName === 'string' ? v0.baseRefName : undefined
    prState = typeof v0?.state === 'string' ? v0.state : undefined
  } catch { prBase = undefined }
  if (prBase === undefined) {
    const login = !view.ok && classifyGh(view.code, view.out) === 'login'
    ctx.out(kv('merge', login ? `held — GitHub refused the login · gh auth login, then ${shipCmd}` : `held — the PR's base branch cannot be read · ${shipCmd} retries`))
    recordOutcome(root, planId, login ? 'fix' : 'transient', login ? 'GitHub refused the login — gh auth login' : "the PR's base branch cannot be read", shipBranch)
    return EXIT.FINDINGS
  }
  if (prState === 'CLOSED') {
    ctx.out(kv('merge', `held — PR #${pr} was closed without merging · a human's call`))
    recordOutcome(root, planId, 'fix', 'closed without merging — reopen it, or abandon the plan', shipBranch)
    return EXIT.FINDINGS
  }
  if (prState === 'MERGED') {
    ctx.out(kv('merged', `#${pr} · merged on GitHub — the lazy stamp finishes the lifecycle on the next scan`))
    recordOutcome(root, planId, 'merged', 'merged on GitHub', shipBranch)
    return EXIT.OK
  }
  if (prBase !== shipBranch) {
    ctx.out(kv('merge', `held — the PR targets ${prBase} but ship.branch is ${shipBranch} · a human's call`))
    recordOutcome(root, planId, 'fix', `the PR targets ${prBase} but ship.branch is ${shipBranch}`, shipBranch)
    return EXIT.FINDINGS
  }
  // Fetched into a witness-owned ref with an explicit forced refspec and read from there:
  // `origin/<base>` is a local ref that `update-ref` or a rewritten fetch refspec can forge.
  // Residual, recorded: an agent with this shell can still rewrite the remote's URL itself.
  if (!tryGit(root, 'fetch', '--no-tags', 'origin', `+refs/heads/${prBase}:refs/witness/ship-authority`).ok) {
    ctx.out(kv('merge', `held — cannot verify ${prBase} (the fetch failed) · ${shipCmd} retries once the remote answers`))
    recordOutcome(root, planId, 'transient', `cannot verify ${prBase} (the fetch failed)`, shipBranch)
    return EXIT.FINDINGS
  }
  if (!autonomyAt(root, 'refs/witness/ship-authority')) {
    ctx.out(kv('ship', `merge PR #${pr} on GitHub when ready — the lazy stamp flips plan → done, spec → live`))
    recordOutcome(root, planId, 'merge', `the shipped ${prBase} says autonomy is off — the merge is yours`, shipBranch)
    return EXIT.OK
  }
  const base = diffBase(wt, cfg)
  const headNow = tryGit(wt, 'rev-parse', 'HEAD')
  const lapsed = baseMoved(wt, root, shipBranch) ? `${shipBranch} moved`
    : !base.ok || !gateSettled(entries, 'ship', diffReviewedSha(wt, base.value)) ? 'the tree moved'
    : tryGit(wt, 'status', '--porcelain').out !== '' ? 'the worktree is not the pushed commit'
    : !headNow.ok || (pushed !== undefined && headNow.out.trim() !== pushed) ? 'HEAD moved since the push'
    : undefined
  if (lapsed !== undefined) {
    ctx.out(kv('merge', `held — the ship approval lapsed (${lapsed}) · ${shipCmd} re-gates`))
    recordOutcome(root, planId, 're-gate', `the ship approval lapsed (${lapsed})`, shipBranch)
    return EXIT.FINDINGS
  }
  // The local checks above prove the WORKTREE is what was judged; `gh pr merge` merges the
  // REMOTE head. Pinning the merge to the reviewed commit makes GitHub refuse a head anyone
  // pushed since — another session, a collaborator, a force-push — so the merge can only
  // ever land the commit CI and the battery saw. A refusal there is a human's call.
  const merged = gh(ctx, root, ['pr', 'merge', String(pr), `--${cfg.ship.merge}`, '--match-head-commit', pushed ?? headNow.out.trim()])
  if (!merged.ok) {
    renderRefusal([humanCall(v('gh', 'merge-refused', merged.out.trim().slice(-200),
      "a PR GitHub will merge — branch protection and required reviews are the repo owner's to settle"))])
      .forEach((l) => ctx.err(l))
    // Row 242: a refusal after the base moved since the check is a re-gate; one GitHub never
    // answered is drive's to re-check; any other is the human's.
    const kind = classifyGh(merged.code, merged.out)
    if (baseMoved(wt, root, shipBranch)) recordOutcome(root, planId, 're-gate', `${shipBranch} moved since the check`, shipBranch)
    else if (kind === 'rate' || kind === 'network') recordOutcome(root, planId, 'transient', 'GitHub did not answer the merge', shipBranch)
    else recordOutcome(root, planId, 'fix', kind === 'login' ? 'GitHub refused the login — gh auth login' : 'GitHub refused the merge — branch protection or required reviews', shipBranch)
    return EXIT.REFUSED
  }
  ctx.out(kv('merged', `#${pr} · ${cfg.ship.merge} — the lazy stamp finishes the lifecycle on the next scan`))
  recordOutcome(root, planId, 'merged', `merged · ${cfg.ship.merge}`, shipBranch)
  return EXIT.OK
}

// The approved tree is what the PR must carry before CI is watched (F8). Ship owns the code
// commit, and a revise at the ship gate leaves its fix uncommitted in the worktree — once a PR
// exists nothing else commits or pushes it, so CI went green on the old head and that is the
// commit the merge landed. Never a force-push: a remote head this worktree lacks is someone
// else's work, and overwriting it is a human's call.
function pushApproved(ctx: Ctx, wt: string, planId: string, summary: string): Result<string> {
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
  if (!head.ok) return refuse([v('push', 'head-unreadable', head.out.slice(0, 200), `a readable HEAD in ${wt}`)])
  const sha = head.out.trim()
  const remote = tryGit(wt, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`)
  // Row 242: the remote already IS the approved tree — witness's own record says so from here on.
  if (remote.ok && sha === remote.out.trim()) { recordPushed(wt, planId, sha); return ok(sha) }
  // Row 242: a rejection is the remote holding commits this worktree lacks (push-diverged); any
  // other failure is the push's own (push-failed), classified by its words for the record.
  const push = pushPr(wt, branch, undefined, true)
  if (!push.ok) return push
  ctx.out(kv('push', `${branch} → the approved tree`))
  return ok(sha)
}

const WATCH_MS = 1_800_000
const POLL_MS = 10_000
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

// Row 242: red only on positive evidence from the check set; a set that could not be read is
// `unreadable` (classified from gh's exit and words), and one still pending when the watch closed
// is `pending` — neither is a red CI.
type CiVerdict = { kind: 'green' } | { kind: 'red'; detail: string } | { kind: 'none' } | { kind: 'no-pass' }
  | { kind: 'unreadable'; detail: string; code: number | null } | { kind: 'pending' }

// Row 174 (F7). `gh pr checks --watch` exits 0 for every rollup with nothing failed or pending
// — cancelled and skipped included — and ends the moment nothing is pending, which can be
// before a late check has registered. So green needs positive evidence on a set that held
// still: after the watch and `ship.ciSettleMs`, at least one check passed and none failed,
// was cancelled or is pending; a check that appeared meanwhile is watched in turn. "No
// checks" at the first poll is retried within the same window before it is believed.
// `settleGreen`: a green set must hold still for `settleMs` before it licenses witness's own merge
// (autonomy); with the merge the human's, the wait applies only before believing "no checks".
async function watchCi(ctx: Ctx, root: string, pr: number, settleMs: number, settleGreen = true): Promise<CiVerdict> {
  const start = Date.now()
  // The watch window; a test shortens it, since a real one is half an hour. Shortening it only makes
  // ship give up sooner with `pending` — never green, which needs a set with nothing pending.
  const windowMs = Number(ctx.env.WITNESS_SHIP_WATCH_MS) || WATCH_MS
  // A green read that followed a watch that failed or timed out has not seen the set hold still:
  // it settles and reads again before it licenses a merge (F7, kept on every path to green).
  let resettled = false
  for (;;) {
    const left = Math.max(1, windowMs - (Date.now() - start))
    const watched = gh(ctx, root, ['pr', 'checks', String(pr), '--watch'], left)
    if (!watched.ok && /no checks reported/.test(watched.out)) {
      if (Date.now() - start < settleMs) { await sleep(Math.min(settleMs, POLL_MS)); continue }
      return { kind: 'none' }
    }
    // A watch that ended any other way says nothing for certain — gh exits 1 for a failed check,
    // a refused login and a network error alike — so the check set is read either way.
    if (watched.ok && settleGreen && settleMs > 0) await sleep(settleMs)
    const read = gh(ctx, root, ['pr', 'checks', String(pr), '--json', 'name,bucket'])
    let checks: Array<{ name: string; bucket: string }> | undefined
    try { checks = read.ok ? JSON.parse(read.out) as Array<{ name: string; bucket: string }> : undefined } catch { checks = undefined }
    if (!Array.isArray(checks)) {
      const why = read.ok ? watched : read
      return { kind: 'unreadable', detail: why.out.trim().slice(-200), code: why.code }
    }
    if (checks.some((c) => c.bucket === 'pending')) {
      if (Date.now() - start >= windowMs) return { kind: 'pending' }
      await sleep(Math.min(POLL_MS, Math.max(1, windowMs - (Date.now() - start))))
      continue
    }
    const bad = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel')
    if (bad.length > 0) return { kind: 'red', detail: bad.map((c) => `${c.bucket}: ${c.name}`).join(' · ') }
    if (!checks.some((c) => c.bucket === 'pass')) return { kind: 'no-pass' }
    if (!watched.ok && settleGreen && settleMs > 0 && !resettled) {
      resettled = true
      await sleep(settleMs)
      continue
    }
    return { kind: 'green' }
  }
}

// Row 191 §4.4. A ship run's exit is where the next pass is decided: with the fill at the limit,
// it runs in a fresh session. Once per run, whatever the gate's tail settled inside it, so the
// gate is told not to hand over itself (Plan's call 7). With the act guard, unlike a revise:
// not every exit follows an act. `revise owed`, a textual conflict and a decision still awaited
// each return having journaled nothing, so a session that opened over the limit would relay at
// them, and so would every fresh session after it, none of them doing the work. A pass that ran
// the gate journaled its run under this session. A refused or blocked run completed no pass,
// so it hands nothing over.
export async function runShip(ctx: Ctx, planId: string, opts: { manual?: boolean } = {}): Promise<number> {
  const code = await shipPass(ctx, planId, opts)
  if (code !== EXIT.OK && code !== EXIT.FINDINGS) return code
  handOverIfDue(ctx, { guard: true })
  return code
}

async function shipPass(ctx: Ctx, planId: string, opts: { manual?: boolean }): Promise<number> {
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
  // Row 240 (design §4.1.2). One ship run per plan: the marker is taken before anything journals
  // and released when the run ends. Held by another live process, this run does nothing — that
  // one continues — and exits 3. Nobody waits for it.
  const marker = takeBusy(root, 'ship', planId, shipUntil(cfgR.value, ctx.env, Date.now()))
  if (!marker.taken) {
    if ('holder' in marker) {
      ctx.out(`busy: ${planId} — witness ship is running on it (pid ${marker.holder.pid}, since ${hhmm(marker.holder.since)}) · nothing to do; it continues when that ends`)
    } else {
      renderRefusal(marker.refused).forEach((l) => ctx.err(l))
    }
    return EXIT.BLOCKED
  }
  try {
    return await shipMarked(ctx, root, cfgR, planId, canon, plan, opts)
  } finally {
    marker.release()
  }
}

async function shipMarked(
  ctx: Ctx, root: string, cfgR: { ok: true; value: Config }, planId: string, canon: ReturnType<typeof loadCanon>,
  plan: CanonDoc, opts: { manual?: boolean },
): Promise<number> {
  // Row 241 (R9). Whoever runs it — a drive session included — ship runs no review and carries no
  // plan on while a step is open: refused before anything journals, naming the step's command.
  const open = openStepRow(root, cfgR.value, plan)
  if (open !== undefined) {
    renderRefusal([stepsOpenViolation(open)]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  // Row 242 (R15). A session drive started meets a standing merge or fix record with its stop at
  // once — re-running ship there only spends a session to reach the same stop. A human's own
  // `witness ship` re-checks, and its outcome replaces the record.
  if (driveChild(ctx.env) !== undefined) {
    const head = tryGit(worktreePath(root, planId), 'rev-parse', 'HEAD')
    const rec = standingRecord(readStream(root, planId), head.ok ? head.out.trim() : undefined)
    if (rec !== undefined) {
      needYouRows(heldItem(rec, cfgR.value)).forEach((l) => ctx.out(l))
      return EXIT.FINDINGS
    }
  }
  const wt = worktreePath(root, planId)
  let entries = readStream(root, planId)
  const shipBranch = cfgR.value.ship.branch
  // `--manual` keeps this run's stop and its merge for a human, exactly as on `witness gate`.
  const manual = opts.manual === true
  const autonomy = cfgR.value.autonomy && !manual
  // One read-only fetch decides the whole routing. A failed fetch (no remote, offline)
  // leaves baseMoved false and the phases behave as they did — the gate phase's own
  // rebaseIfMoved is where that condition turns into a structured refusal.
  const moved = baseMoved(wt, root, shipBranch)
  const baseR = diffBase(wt, cfgR.value)
  let reviewedSha = baseR.ok ? diffReviewedSha(wt, baseR.value) : undefined
  const lifted = (): string[] =>
    liftedHolds(criteriaOwner(loadCanon(root), planId), lastGateRun(readStream(root, planId), 'ship'))
  const liftedNow = lifted()
  let phase = shipPhase(plan, entries, reviewedSha, moved, liftedNow.length > 0)
  if (moved) ctx.out(kv('ship', `${shipBranch} moved — rebasing and re-reviewing before the watch`))
  if (liftedNow.length > 0 && phase === 'gate') {
    ctx.out(kv('ship', `${liftedNow.join(' · ')} no longer held — re-running the ship gate so it runs`))
  }
  // Row 174. Under autonomy an approval settled in this run carries straight on to the PR,
  // so the phase is derived again from the world as it now stands — the gate phase may
  // just have rebased, which moves both the tree and the base terms.
  const rederive = (): ShipPhase => {
    canon = loadCanon(root)
    plan = findById(canon, planId)!
    entries = readStream(root, planId)
    const b = diffBase(wt, cfgR.value)
    reviewedSha = b.ok ? diffReviewedSha(wt, b.value) : undefined
    return shipPhase(plan, entries, reviewedSha, baseMoved(wt, root, shipBranch), lifted().length > 0)
  }

  if (phase === 'gate') {
    // D94: the gate cannot judge unchanged content twice — it answers changed-nothing
    // and appends nothing, so routing the human back at it burns a turn on a command
    // that has already declined. The owed work is the edit the revise asked for.
    if (authoringOwed(entries, 'ship', reviewedSha)) {
      ctx.out(kv('ship', `${planId} — revise owed`))
      // Row 239. The re-run it names is an act's line.
      ctx.out(`help: edit the code in ${wt} · then re-run ${cliAct('ship', planId).line}`)
      return EXIT.FINDINGS
    }
    // Rebase BEFORE the battery, never after: the reviewers must judge the tree that will
    // actually merge. Reviewing first spends a battery — and a human decision — on a tree
    // without any sibling's merged work, which then lapses (gateSettled's reviewed_sha)
    // the moment the rebase lands.
    const rebase = rebaseIfMoved(wt, root, shipBranch)
    if (!rebase.ok) {
      renderRefusal(rebase.violations).forEach((l) => ctx.err(l))
      recordRefusal(root, planId, rebase.violations, shipBranch)
      // A textual conflict is a hand-back, not a refusal: the human resolves it in the
      // worktree and re-runs. Every other rule (no-remote, fetch-failed, push-failed) is
      // a genuine refusal and exits REFUSED like the rest of the CLI.
      return rebase.violations.some((x) => x.rule === 'textual-conflict') ? EXIT.FINDINGS : EXIT.REFUSED
    }
    if (rebase.value === 'rebased') ctx.out(kv('rebase', `${shipBranch} moved — rebased before the battery`))
    const code = await runGate(ctx, 'ship', planId, { fresh: false, manual, handover: false })
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
    // Row 240: a settle another decider won is that decider's decision — an approve carries on too.
    if ((s.kind === 'decided' || s.kind === 'superseded') && s.decision === 'approve') {
      phase = rederive()
      if (phase !== 'pr' && phase !== 'watch') return EXIT.FINDINGS
    } else if (s.kind !== 'none') {
      if (s.kind === 'busy') ctx.out(busyLine('ship', planId, s))
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
    const d = recommend({ gate: 'ship', target: planId, entries, upstream: up, stale: liftedNow.length > 0, untrustedCmds })
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
    // What the approved run did not run, from its own record — the one derivation (row 179).
    const held = (lastGateRun(entries, 'ship')?.checks ?? []).flatMap((c) => c.held ?? [])
    const created = createPr(ctx, wt, root, plan!, parentSummary, held)
    if (!created.ok) {
      renderRefusal(created.violations).forEach((l) => ctx.err(l))
      recordRefusal(root, planId, created.violations, shipBranch)
      return EXIT.REFUSED
    }
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
  if (!pushed.ok) {
    renderRefusal(pushed.violations).forEach((l) => ctx.err(l))
    recordRefusal(root, planId, pushed.violations, shipBranch)
    return EXIT.REFUSED
  }
  // Row 242. Both modes watch CI the same way — autonomy off also waits `ship.ciSettleMs` before it
  // believes "no checks" — and every outcome is journaled for drive, `next` and the report.
  const ci = await watchCi(ctx, root, pr, cfgR.value.ship.ciSettleMs, autonomy)
  const merge = autonomy ? 'witness merges only on green CI' : 'the merge is yours'
  // Row 174 / §11 call 18. Green is the merge's only licence: no checks at all, or none
  // that passed, is not green — the human's call, never a CI to "fix".
  if (ci.kind === 'none' || ci.kind === 'no-pass') {
    const reason = ci.kind === 'none' ? 'no CI checks reported' : 'no passing CI check'
    ctx.out(kv('merge', `held — ${reason} · ${merge}`))
    recordOutcome(root, planId, 'merge', reason, shipBranch)
    return EXIT.FINDINGS
  }
  if (ci.kind === 'red') {
    ctx.out(kv('ci', `red — ${ci.detail}`))
    recordOutcome(root, planId, 'red', ci.detail, shipBranch)
    return EXIT.FINDINGS
  }
  if (ci.kind === 'pending') {
    ctx.out(kv('ci', 'pending — checks still pending when the watch closed · checked again later'))
    recordOutcome(root, planId, 'pending', 'checks still pending when the watch closed', shipBranch)
    return EXIT.FINDINGS
  }
  if (ci.kind === 'unreadable') {
    const login = classifyGh(ci.code, ci.detail) === 'login'
    ctx.out(kv('merge', login
      ? `held — GitHub refused the login · gh auth login, then ${cliAct('ship', planId).line}`
      : 'held — the check set could not be read · checked again later'))
    ctx.out(`note: ${logSafe(ci.detail)}`)
    recordOutcome(root, planId, login ? 'fix' : 'transient', login ? 'GitHub refused the login — gh auth login' : 'the check set could not be read', shipBranch)
    return EXIT.FINDINGS
  }
  ctx.out(kv('ci', 'green'))
  if (autonomy) return mergeOwnPr(ctx, root, cfgR.value, planId, pr, pushed.value)
  ctx.out(kv('ship', `merge PR #${pr} on GitHub when ready — the lazy stamp flips plan → done, spec → live`))
  recordOutcome(root, planId, 'merge', 'CI is green — autonomy is off, so the merge is yours', shipBranch)
  return EXIT.OK
}
