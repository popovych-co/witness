import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
import { lastGateRun, lastJudgedRun, liveExits, standingHandBack, type DecisionEntry } from './rounds.js'
import { recommend, renderDecision } from './recommend.js'
import { prepareStamp, writeStamp } from './stamp.js'
import { branchName, worktreePath } from './worktree.js'
import { authoringOwed, gateSettled, openStepRow, reReviewOwed, stepsOpenViolation } from './verbs/next.js'
import { diffReviewedSha } from './reviewed.js'
import { diffBase } from './evidence.js'
import { handOverIfDue } from './slice.js'
import { execFileSync } from './spawn.js'
// Static, unlike gate.ts and next.ts: this module lies outside gate.ts's static import graph,
// so reaching decide.ts from here closes no registration cycle.
import { busyLine, hhmm, settleStop, settledCode } from './settle.js'
import {
  carryClashViolations, clashGuard, clashLeft, clashViolations, refuseClash, replayConflictViolations,
} from './clash.js'
import {
  baseInTheWay, blobAt, captureCarry, carryGit, carryGone, carryPending, carryRef, cleanTree, dropCarry, gitAtLeast, headReflog,
  freshStop, heldLock, keepCarry, keepStopped, lockedRow, offBranchPending, operationInProgress, operationRefusal, reapply,
  rebaseOwnerSince, restorePending, sessionUnmerged, touchedRebasePending, unmergedPaths, witnessOwnRebase, workAlreadyBack,
  type OpInProgress, type Reapplied,
} from './carry.js'
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
  // Row 244 (design §4.2.5, §4.2.9). A standing hand-back is a decision owed, with or without a PR: the
  // revise is decided again, never re-gated (the gate would answer changed-nothing) nor edited (the
  // author judged there is nothing to change). Blind to the tree, the base and the holds, as a stop
  // awaiting its decision is: staleness is judged where the decision is made (P34), and the block
  // below reads it.
  if (standingHandBack(entries, 'ship') !== undefined) return 'awaiting-decision'
  if (plan.meta.pr !== undefined) {
    // Final review F1: a hold lifted since the ship gate ran is a verdict that never ran a
    // criterion now owed, so it re-gates exactly as a moved tree does.
    return gateSettled(entries, 'ship', treeSha) && !baseMoved && !holdLifted ? 'watch' : 'gate'
  }
  if (!lastGateRun(entries, 'ship')) return 'gate'
  // Row 244 (design §4.2.3; P9, amends row 77). The gate's LAST disposition after the run it disposed
  // of, read by position as every reader reads it: an approve that answered a revise on unchanged
  // content goes on to the PR, and a retraction after an approve re-gates. A malformed round judged
  // nothing, so the disposition is read after the last run that judged something.
  const judged = lastJudgedRun(entries, 'ship')
  const decision = entries.slice(judged === undefined ? 0 : entries.lastIndexOf(judged as unknown as Entry) + 1)
    .filter((e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === 'ship')
    .at(-1) as unknown as DecisionEntry | undefined
  // awaiting-decision is deliberately blind to baseMoved: a human reading
  // `decide ship --show` is reading findings pinned to a sha, and rebasing under them
  // would lapse the very gate they are deciding on.
  if (!decision) return 'awaiting-decision'
  if (decision.decision !== 'approve') return 'gate'
  // An approval is against a base as well as a tree — opening the PR on a base that has
  // since moved is the same stale-review bug one step earlier.
  // Row 243 (design §4.1.1 step 9; P32, amends row 77). And against the tree the battery judged:
  // ship's carry moves the plan onto a moved base itself, and a clash, a refused apply or a crash
  // ends that run before any battery judges the moved tree. The next run then finds the base
  // unmoved and the approval still the last word. The reviewed sha's base term moves with the
  // carry, and a state-only advance leaves it (stateOnlyAdvance), so the approval routes to the PR
  // only while the gate is settled for the tree as it now stands.
  return baseMoved || holdLifted || !gateSettled(entries, 'ship', treeSha) ? 'gate' : 'pr'
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
// Row 243: a git lock the move met is re-checked too (transient). The session's own work — a commit
// that failed, an unreadable HEAD, a clash or replay conflict, any other refusal of the carry — is no
// record (design §4.1.3's table).
function recordRefusal(root: string, planId: string, violations: readonly Violation[], shipBranch: string): void {
  const o = violations[0] !== undefined ? refusalOutcome(violations[0]) : undefined
  if (o !== undefined) recordOutcome(root, planId, o.outcome, o.reason, shipBranch)
}

const BRANCH_GONE = 'the PR branch is gone from the remote — recreate or reopen it, or abandon the plan'

// A failed fetch, read for what it means (C locale): a login git refused is the human's fix — as on a
// push — and so is a PR branch gone from the remote; anything else is a remote that did not answer.
export function fetchOutcome(out: string, transient: string): { outcome: 'fix' | 'transient'; reason: string } {
  if (classifyGit(out) === 'login') return { outcome: 'fix', reason: 'git refused the login — sign in to the remote again' }
  if (/couldn't find remote ref/i.test(out)) return { outcome: 'fix', reason: BRANCH_GONE }
  return { outcome: 'transient', reason: transient }
}

export function refusalOutcome(x: Violation): { outcome: ShipOutcome; reason: string } | undefined {
  const got = String(x.got)
  switch (x.rule) {
    case 'no-remote': return { outcome: 'fix', reason: 'no origin remote — add one, then re-check' }
    case 'push-diverged': return { outcome: 'fix', reason: 'the PR branch holds commits this worktree lacks — overwriting them is your call' }
    case 'fetch-failed': return fetchOutcome(got, 'the fetch failed')
    case 'push-failed': return classifyGit(got) === 'login'
      ? { outcome: 'fix', reason: 'git refused the login — sign in to the remote again' }
      : { outcome: 'transient', reason: 'the push failed' }
    case 'pr-create-failed': return classifyGh(1, got) === 'login'
      ? { outcome: 'fix', reason: 'GitHub refused the login — gh auth login' }
      : { outcome: 'transient', reason: 'the PR could not be created' }
    case 'pr-url-unparseable': return { outcome: 'transient', reason: 'the PR create answered no PR' }
    // Row 243: the PR's branch the lease read is gone — recreating it, or abandoning the plan, is the human's call.
    case 'pr-branch-gone': return { outcome: 'fix', reason: BRANCH_GONE }
    // Row 243 (design §4.1.3's table): a held lock — the index's or the carry ref's, at any step of
    // the move — is drive's to re-check; the next ship run carries on, step 0 finishing the move.
    // The carry's other refusals (textual-conflict, clash-unresolved, operation-in-progress,
    // carry-refused, carry-pending, rebase-refused) record nothing.
    case 'index-locked': return { outcome: 'transient', reason: 'a git lock was held — the next ship run carries on once it is released' }
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
// Row 243 (design §4.1.1 step 3; P37, P42). The fetch names its refspec, so the tracking ref exists
// after it in a single-branch or shallow clone too, and whether the branch exists at all is read from
// this fetch alone — never from `@{upstream}` or a tracking ref, which such a clone never has and a
// branch deleted on the remote leaves behind, stale. A branch the remote lacks is `absent` (git's
// words, read in the C locale); what that means is the caller's to say: the first push while the plan
// has no PR, the PR branch gone once it has one.
export function leaseFor(wt: string, branch: string, remote = 'origin'): Result<{ tip: string } | { absent: true }> {
  const fetched = tryGitC(wt, 'fetch', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`)
  if (!fetched.ok) {
    if (fetched.out.includes(`couldn't find remote ref refs/heads/${branch}`)) return ok({ absent: true })
    return refuse([v('fetch', 'fetch-failed', fetched.out.slice(0, 200), `${shellLine(['git', 'fetch', remote, branch])} to succeed`)])
  }
  const tip = tryGit(wt, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}^{commit}`)
  if (!tip.ok) return refuse([v('push', 'head-unreadable', tip.out.slice(0, 200), `a readable ${remote}/${branch}`)])
  const sha = tip.out.trim()
  const planId = branch.startsWith('witness/') ? branch.slice('witness/'.length) : undefined
  const recorded = planId === undefined ? undefined : tryGit(wt, 'rev-parse', '--verify', '--quiet', `${pushedRef(planId)}^{commit}`)
  if (recorded?.ok && recorded.out.trim() === sha) return ok({ tip: sha })
  if (tryGit(wt, 'merge-base', '--is-ancestor', sha, 'HEAD').ok) return ok({ tip: sha })
  return refuse([humanCall(v('push', 'push-diverged', `${remote}/${branch} at ${sha.slice(0, 12)}`, DIVERGED_WANT))])
}

// Row 243 (design §4.1.1 step 3). A plan with a PR whose branch the remote lacks, whether or not
// witness recorded a push (a PR opened by 0.28 or earlier has no record): no ship push recreates it.
// Recreating or reopening it, or abandoning the plan, is a human's call.
function branchGone(remote: string, branch: string): Violation {
  return humanCall(v('push', 'pr-branch-gone', `${remote} has no ${branch}`,
    `the PR's branch on ${remote} — it is gone, and recreating or reopening it, or abandoning the plan, is a human's call`))
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
  // A forced push once the branch exists: the rebase runs in the GATE phase, so a re-entered pr
  // phase pushes a rebased branch and a plain push is no longer a fast-forward. Row 242: the lease
  // is witness's own last push (or a tip the worktree holds), never the tracking ref, so it refuses
  // to clobber anything pushed by someone else. Row 243 (P42): whether the branch exists is read
  // from leaseFor's own fetch; a branch the remote lacks is the first push, which createPr alone
  // makes, plain, and only while the plan has no PR — with one, it is the PR branch gone.
  const lease = leaseFor(wt, branch)
  if (!lease.ok) return lease
  if ('absent' in lease.value && plan.meta.pr !== undefined) return refuse([branchGone('origin', branch)])
  const push = pushPr(wt, branch, 'tip' in lease.value ? lease.value.tip : undefined, true)
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

// Row 243 (design §4.1.1 steps 1–2 and 4–8; issue #86). The gate phase moves the plan onto a moved
// base itself. implement leaves the worktree uncommitted on purpose (ship owns the sole code commit),
// so the move carries that work across: witness captures it into its own carry ref, cleans the tree,
// rebases with `--no-autostash`, and puts the work back. `git rebase --autostash` used to, and a
// clash putting it back exited 0, left the markers for a gate and the work on git's shared stash
// list. Now a clash stays in the files (UU), the carry is kept, and ship refuses `textual-conflict`.
// `run` names the plan; `hasPr` and `env` are read by the lease (step 3) and the crash points; `say`
// prints what the move did that its outcome does not say (a `kept:` line, step 7's fallback).
export function rebaseIfMoved(
  wt: string, root: string, shipBranch: string,
  run: { planId: string; hasPr: boolean; env: Ctx['env']; say?: (line: string) => void }, remote = 'origin',
): Result<'clean' | 'rebased'> {
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
  const fetched = tryGitC(wt, 'fetch', remote, shipBranch)
  if (!fetched.ok) {
    // Row 239: the fetch the want names is another tool's command, through the one renderer.
    return refuse([v('fetch', 'fetch-failed', fetched.out.slice(0, 200), `${shellLine(['git', 'fetch', remote, shipBranch])} to succeed`)])
  }
  const base = `${remote}/${shipBranch}`
  if (tryGit(wt, 'merge-base', '--is-ancestor', base, 'HEAD').ok) return ok('clean')
  // Same predicate as baseMoved: an advance made entirely of witness's own state commits is
  // bookkeeping, and rebasing onto it moves the base term of every reviewed sha for nothing.
  if (stateOnlyAdvance(wt, root, 'HEAD', base)) return ok('clean')
  const { planId } = run
  const say = run.say ?? (() => {})
  // Step 1, the guard (§4.1.2): no move over an unresolved clash.
  const clash = clashLeft(wt, planId, shipBranch)
  if (clash !== undefined) return refuse(clashViolations(planId, clash, wt))
  // Step 2 (P19): an operation a session started is its own — never aborted, never applied into.
  const op = operationInProgress(wt)
  if (op !== undefined) return refuse([operationRefusal(wt, planId, op)])
  // Step 3, the lease (row 242), settled before anything moves, so a PR branch someone else pushed to
  // refuses with the worktree untouched (P27). The PR branch is named from the plan, never from HEAD,
  // and whether it exists is read from leaseFor's own fetch (P37). With no PR the move never pushes:
  // createPr makes the first push (P42). With a PR, a branch the remote lacks is the PR branch gone,
  // whether or not a push was recorded — a PR opened by 0.28 or earlier has no record.
  const branch = branchName(planId)
  const lease = run.hasPr ? leaseFor(wt, branch, remote) : undefined
  if (lease !== undefined && !lease.ok) return lease
  if (lease !== undefined && 'absent' in lease.value) return refuse([branchGone(remote, branch)])
  const tip = lease !== undefined && 'tip' in lease.value ? lease.value.tip : undefined
  // Step 2 once more, now the lease's fetch is done: a session's merge, cherry-pick or revert begun
  // meanwhile would be ended by step 5's `git reset --hard`, so it refuses here, with nothing moved.
  const begun = operationInProgress(wt)
  if (begun !== undefined) return refuse([operationRefusal(wt, planId, begun)])
  // §4.1.5: an untracked file where the base holds one is refused before anything moves — in the
  // worktree's sparse checkout the rebase would replace it with the base's bytes and exit 0.
  const inTheWay = baseInTheWay(wt, planId, base)
  if (!inTheWay.ok) return inTheWay
  const orig = carryGit(wt, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}')
  if (orig.code !== 0 || orig.stdout.trim() === '') {
    return refuse([v('rebase', 'head-unreadable', orig.stderr.slice(0, 200), `a readable HEAD in ${wt}`)])
  }
  const at = { head: orig.stdout.trim(), ref: carryGit(wt, 'symbolic-ref', '--quiet', 'HEAD').stdout.trim() }
  // Step 4, capture; step 5, a clean tree — only where there is work to carry.
  const captured = captureCarry(wt, planId)
  if (!captured.ok) return captured
  const carry = captured.value
  if (carry !== undefined) {
    // Test-only crash points, on txn.ts's seam: step 0's tests stop the move here (row 243).
    crashPoint(run.env, 'carry-after-capture')
    // S1-D. Step 2 once more, now the work is captured: a merge, cherry-pick or revert a session began
    // since the check above would be ended by step 5's `git reset --hard`. Nothing has moved yet.
    const during = operationInProgress(wt)
    if (during !== undefined) return refuse(captureOverOperation(wt, planId, carry, during))
    const cleaned = cleanTree(wt, planId)
    if (!cleaned.ok) return cleaned
    crashPoint(run.env, 'carry-after-reset')
  }
  // Step 6. Witness's own rebase (its reflog action `witness-carry`), never stashing anything. Step 2
  // is asked again right before it: a session may have started an operation since (the lease's fetch
  // alone can take a while), and witness rebases into none.
  const appeared = operationInProgress(wt)
  if (appeared !== undefined) return refuse(sessionOperation(wt, planId, appeared, carry))
  const reflog = headReflog(wt)
  const rebase = carryGit(wt, 'rebase', '--no-autostash', base)
  // A rebase stopped on a conflict is still in progress here; a clean one is done, the work not back.
  crashPoint(run.env, 'carry-mid-rebase')
  if (rebase.code !== 0) return refuse(failedRebase(wt, planId, base, carry, at, `${rebase.stdout}${rebase.stderr}`, reflog, say))
  // Step 7. The work back, or the refusal that keeps it.
  if (carry !== undefined) {
    const refused = putBackRefusal(wt, planId, base, reapply(wt, planId, carry), say)
    if (refused !== undefined) return refuse(refused)
  }
  // Step 8. With a PR the push result is the whole point: reporting 'rebased' after a failed push
  // leaves the PR head on the pre-rebase commit, and CI goes green on a tree nobody will merge. A
  // clash or a refused put-back withholds it (returned above); the next ship run carries it, under
  // the same lease, in pushApproved (P21).
  if (tip !== undefined) {
    const push = pushPr(wt, branch, tip, false, remote)
    if (!push.ok) return push
  }
  return ok('rebased')
}

// S1-D. A session's operation begun while the work was captured is refused as step 2 refuses one,
// with nothing moved: the work never left the tree, so the carry ref just written goes, and only
// while it still names this carry. A drop that fails keeps the ref (a held lock, or `carry-pending`);
// step 0 drops it once the operation is over and it finds the work already back.
function captureOverOperation(wt: string, planId: string, carry: string, op: OpInProgress): Violation[] {
  const refusal = operationRefusal(wt, planId, op)
  const ref = carryRef(planId)
  const dropped = carryGit(wt, 'update-ref', '-d', ref, carry)
  if (dropped.code === 0) return [refusal]
  const out = `${dropped.stdout}${dropped.stderr}`
  const lock = heldLock(wt, out, [`${ref}.lock`])
  if (lock !== undefined) return [refusal, lockedRow(planId, lock, true)]
  return [refusal, carryPending(planId,
    `the plan's work is still in the tree, but deleting ${ref} after the capture failed: ${logSafe(out.trim().slice(0, 200)) || 'git printed nothing'}`)]
}

// Step 7's outcome as ship refuses it, or nothing when the work is back clean. Back clean through
// git's "conflicts in index" fallback (P25), the staged versions live only in the kept ref, which
// goes when the plan merges (`dropKept`), so `say` names it (the final review's M2).
function putBackRefusal(
  wt: string, planId: string, onto: string, put: Reapplied, say: (line: string) => void = () => {},
): Violation[] | undefined {
  switch (put.kind) {
    case 'clean':
      if (put.kept !== undefined) say(stagedKeptLine(put.kept))
      return undefined
    case 'clash': return carryClashViolations(planId, wt, put.files, put.kept, onto)
    case 'locked': return [lockedRow(planId, put.lock, true)]
    case 'refused': return [carryPending(planId, put.out)]
  }
}

// The fallback's kept ref, said: the work went back, its staged versions only in the ref. Worded with no
// comma, so the `kept:` line prints unquoted.
function stagedKeptLine(ref: string): string {
  return kv('kept', `${ref} — the plan's work went back without its staged versions (git could not put them back staged) · `
    + `see them with ${shellLine(['git', 'diff', `${ref}^1`, `${ref}^2`])} · the ref is deleted when the plan merges`)
}

// An operation in progress that witness may not end (step 2 met late, and step 0.2): the session's to
// finish, never aborted nor applied into. Work already carried stays in the carry ref
// (`carry-pending`); step 0 puts it back once the operation is over. `silent`: a rebase whose reflog
// cannot tell whose it is (`RebaseOwner`) — both rows then say it may be witness's own.
function sessionOperation(wt: string, planId: string, op: OpInProgress, carry: string | undefined, silent = false): Violation[] {
  const why = silent
    ? 'a git rebase is in progress in the worktree — witness\'s own or a session\'s, its reflog cannot tell'
    : 'a git operation a session started is in progress in the worktree'
  return [operationRefusal(wt, planId, op, silent),
    ...(carry === undefined ? [] : [carryPending(planId, `${why}, so the plan's work was not put back into it`)])]
}

// Step 6 failed. The unmerged paths are read first (a replay conflict's files). An operation now in
// progress is aborted only when it is proven witness's own rebase (`rebaseOwnerSince`); a session's
// that began under the call, or one the reflog cannot place, refuses and is never aborted. The
// abort's exit is not read: success is the state itself, no operation in progress and HEAD back
// where it was. Only then is the carry put back, and its ref
// deleted only after a clean put-back. A put-back that fails keeps the ref (`carry-pending`, or
// `index-locked` for a held lock). After a clean one, a known replay conflict refuses
// `textual-conflict` naming the files, ahead of a lock read once the rebase is undone (a put-back has
// just found the index free); then a held lock `index-locked`, and anything else `rebase-refused` in
// git's own words.
function failedRebase(
  wt: string, planId: string, onto: string, carry: string | undefined, at: { head: string; ref: string }, out: string,
  reflog: readonly string[], say: (line: string) => void,
): Violation[] {
  const replayed = unmergedPaths(wt).map((p) => p.path)
  const op = operationInProgress(wt)
  // Not proven witness's own: never aborted. Only a rebase the reflog cannot place may still be
  // witness's, so only its rows say what to do if it is.
  const owner = op === undefined ? undefined : rebaseOwnerSince(wt, op, out, reflog)
  if (op !== undefined && owner !== 'witness') return sessionOperation(wt, planId, op, carry, owner === 'silent')
  const abort = op === undefined ? undefined : carryGit(wt, 'rebase', '--abort')
  const now = carryGit(wt, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}').stdout.trim()
  const back = operationInProgress(wt) === undefined && now === at.head
    && carryGit(wt, 'symbolic-ref', '--quiet', 'HEAD').stdout.trim() === at.ref
  if (!back) {
    const lock = heldLock(wt, `${out}${abort?.stdout ?? ''}${abort?.stderr ?? ''}`)
    if (lock !== undefined) return [lockedRow(planId, lock, carry !== undefined, true)]
    const got = `the rebase onto ${onto} failed and its abort did not bring HEAD back to ${at.head.slice(0, 12)}: ${logSafe(out.trim().slice(0, 200))}`
    return carry !== undefined ? [carryPending(planId, got)]
      : [v('rebase', 'rebase-refused', got, `the worktree back on ${at.ref || at.head.slice(0, 12)} with no rebase in progress, then ${cliAct('ship', planId).line}`)]
  }
  if (carry !== undefined) {
    const refused = putBackRefusal(wt, planId, onto, reapply(wt, planId, carry), say)
    if (refused !== undefined) return refused
  }
  if (replayed.length > 0) return replayConflictViolations(planId, replayed, onto)
  const lock = heldLock(wt, out)
  if (lock !== undefined) return [lockedRow(planId, lock, false)]
  return [v('rebase', 'rebase-refused', logSafe(out.trim().slice(0, 200)) || 'git printed nothing',
    `a rebase onto ${onto} git accepts — nothing moved, and the plan's work is back as it was; fix what git names, then ${cliAct('ship', planId).line}`)]
}

// Row 243 (design §4.1.3's table). The exit a refusal of the move ends ship on: a clash or a replay
// conflict is the session's work to resolve (1, row 77), a held lock is transient (3), and every
// other refusal — the carry's and the remote's — is a refusal (2).
function carryExit(violations: readonly Violation[]): number {
  if (violations.some((x) => x.rule === 'textual-conflict')) return EXIT.FINDINGS
  if (violations.some((x) => x.rule === 'index-locked')) return EXIT.BLOCKED
  return EXIT.REFUSED
}

// Row 243 (design §4.1.1 step 0). A carry ref standing means a move was interrupted, and the plan's
// work may not be in the tree. Every ship run finishes it first, in the design's sub-order:
//   1. the worktree gone refuses carry-pending, the ref shown and kept;
//   2. an operation in progress: witness's own rebase, proven (`witnessOwnRebase`), is aborted only
//      at git's fresh stop (`freshStop`; fix round 1), its conflicted files kept first in a kept ref
//      (`keepStopped`, named through `say`), and the move goes on; touched since it stopped, it
//      refuses carry-pending and is never aborted. Any other operation refuses operation-in-progress
//      before anything is compared, applied or moved — a session's is never aborted nor applied into
//      (P40, P53);
//   3. HEAD off the plan's branch refuses carry-pending, naming `git switch`;
//   4. unmerged entries: the carry's own (stages 1 and 3 its blobs) are step 7's clash, the carry
//      kept and textual-conflict; a session's refuse carry-pending, naming the files (P43, P52);
//   5. the work already back (git 2.40 and later; c5): the ref dropped (P35);
//   6. a clean tracked tree: the carry re-applied, with step 7's outcomes;
//   7. anything else refuses carry-pending with the restore steps, and never resets.
// A held lock met on the way is index-locked (exit 3), the ref kept. `'none'`: no carry ref. It lives
// here, not in carry.ts: it renders clash.ts's rows, and carry.ts importing clash.ts closes a cycle.
export function finishMove(root: string, wt: string, planId: string, say: (line: string) => void = () => {}): Result<'none' | 'finished'> {
  const ref = carryRef(planId)
  if (carryGit(root, 'show-ref', '--verify', '--quiet', ref).code !== 0) return ok('none')
  if (!existsSync(join(wt, '.git'))) return refuse([carryGone(planId, wt)])
  const read = carryGit(wt, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
  const carry = read.stdout.trim()
  if (read.code !== 0 || carry === '') {
    return refuse([carryPending(planId, `${ref} cannot be read as a commit: ${logSafe(read.stderr.trim().slice(0, 200)) || 'git printed nothing'}`)])
  }
  const branch = branchName(planId)
  const op = operationInProgress(wt)
  if (op !== undefined) {
    const owner = witnessOwnRebase(wt, carry)
    if (owner !== 'witness') return refuse(sessionOperation(wt, planId, op, carry, owner === 'silent'))
    const stop = freshStop(wt)
    if (!stop.fresh) return refuse([touchedRebasePending(planId, stop.why)])
    const kept = keepStopped(wt, planId, stop.unmerged.map((p) => p.path))
    if (!kept.ok) return refuse(kept.violations)
    const abort = carryGit(wt, 'rebase', '--abort')
    say(kv('kept', `${kept.value} — the conflicted files of witness's stopped rebase as they stood, kept before it was aborted · `
      + `see them with ${shellLine(['git', 'show', kept.value])}`))
    if (operationInProgress(wt) !== undefined) {
      const out = `${abort.stdout}${abort.stderr}`
      const lock = heldLock(wt, out)
      return refuse([lock !== undefined ? lockedRow(planId, lock, true, true)
        : carryPending(planId, `witness's own rebase from the interrupted move could not be aborted: ${logSafe(out.trim().slice(0, 200)) || 'git printed nothing'}`)])
    }
  }
  const head = carryGit(wt, 'symbolic-ref', '--quiet', 'HEAD').stdout.trim()
  if (head !== `refs/heads/${branch}`) return refuse([offBranchPending(planId, head)])
  const unmerged = unmergedPaths(wt)
  if (unmerged.length > 0) {
    const own = unmerged.every((p) => p.stages[1] === blobAt(wt, `${carry}^1`, p.path) && p.stages[3] === blobAt(wt, carry, p.path))
    if (!own) return refuse(sessionUnmerged(planId, unmerged))
    const kept = keepCarry(wt, planId, carry, unmerged.map((p) => p.path))
    if (!kept.ok) {
      const lock = heldLock(wt, '', [`${ref}.lock`])
      return refuse(lock !== undefined ? [lockedRow(planId, lock, true)] : kept.violations)
    }
    return refuse(carryClashViolations(planId, wt, unmerged, kept.value, branch))
  }
  const version = carryGit(wt, '--version').stdout.trim()
  const compares = gitAtLeast(version, 2, 40)
  if (compares) {
    const back = workAlreadyBack(wt, carry)
    if (back.lock !== undefined) return refuse([lockedRow(planId, back.lock, true)])
    if (back.back) {
      const refused = putBackRefusal(wt, planId, branch, dropCarry(wt, planId, carry))
      return refused === undefined ? ok('finished') : refuse(refused)
    }
  }
  const status = carryGit(wt, 'status', '--porcelain', '--untracked-files=no')
  if (status.code === 0 && status.stdout === '') {
    const refused = putBackRefusal(wt, planId, branch, reapply(wt, planId, carry), say)
    return refused === undefined ? ok('finished') : refuse(refused)
  }
  const tree = status.code === 0
    ? `the tracked tree holds changes: ${logSafe(status.stdout.trim().slice(0, 200))}`
    : `git status failed: ${logSafe(status.stderr.trim().slice(0, 200)) || 'git printed nothing'}`
  return refuse([restorePending(planId, compares
    ? `the tree neither holds the plan's work as the carry replayed onto HEAD would leave it, nor is it clean — ${tree}`
    : `${logSafe(version) || 'this git'} is older than 2.40, so whether the work is already back cannot be compared (git merge-tree --merge-base); ${tree}`)])
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
  const baseFetch = tryGitC(wt, 'fetch', 'origin', shipBranch)
  if (!baseFetch.ok) {
    const o = fetchOutcome(baseFetch.out, `cannot verify ${shipBranch} (the fetch failed)`)
    ctx.out(kv('merge', o.outcome === 'fix' ? `held — ${o.reason} · then ${shipCmd}` : `held — cannot verify ${shipBranch} (the fetch failed) · ${shipCmd} retries once the remote answers`))
    recordOutcome(root, planId, o.outcome, o.reason, shipBranch)
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
  const authority = tryGitC(root, 'fetch', '--no-tags', 'origin', `+refs/heads/${prBase}:refs/witness/ship-authority`)
  if (!authority.ok) {
    const o = fetchOutcome(authority.out, `cannot verify ${prBase} (the fetch failed)`)
    ctx.out(kv('merge', o.outcome === 'fix' ? `held — ${o.reason} · then ${shipCmd}` : `held — cannot verify ${prBase} (the fetch failed) · ${shipCmd} retries once the remote answers`))
    recordOutcome(root, planId, o.outcome, o.reason, shipBranch)
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
// commit the merge landed. Row 243 (design §4.1.1 step 8; P21): forced only under leaseFor's lease,
// like every ship push. A remote tip that is witness's own last push is overwritten under it, so a
// push a clash, a refused apply, a crash or a session's hand rebase held back is carried here instead
// of reading as push-diverged; a tip that is neither that nor one HEAD holds is someone else's work,
// and overwriting it is a human's call. A branch the remote lacks is the PR branch gone: this push
// never recreates it. The commit comes first (commitApproved: the clash guard, then `git add -A`).
export function pushApproved(ctx: Ctx, root: string, cfg: Config, planId: string, summary: string): Result<string> {
  const committed = commitApproved(ctx, root, cfg, planId, summary)
  if (!committed.ok) return refuse(committed.violations)
  const wt = worktreePath(root, planId)
  const branch = branchName(planId)
  const head = tryGit(wt, 'rev-parse', 'HEAD')
  if (!head.ok) return refuse([v('push', 'head-unreadable', head.out.slice(0, 200), `a readable HEAD in ${wt}`)])
  const sha = head.out.trim()
  const lease = leaseFor(wt, branch)
  if (!lease.ok) return lease
  if ('absent' in lease.value) return refuse([branchGone('origin', branch)])
  // Row 242: the remote already IS the approved tree — witness's own record says so from here on.
  if (sha === lease.value.tip) { recordPushed(wt, planId, sha); return ok(sha) }
  // Row 242: a rejection is the remote holding commits this worktree lacks (push-diverged); any
  // other failure is the push's own (push-failed), classified by its words for the record.
  const push = pushPr(wt, branch, lease.value.tip, true)
  if (!push.ok) return push
  ctx.out(kv('push', `${branch} → the approved tree`))
  return ok(sha)
}

// Ship's code commit, made in the pr phase and again by pushApproved for a revise answered after the
// PR opened. Row 243 (design §4.1.2): never over an unresolved clash, whose markers `git add -A`
// would stage as resolved and the commit carry to the PR. Ship's config is the run's.
function commitApproved(ctx: Ctx, root: string, cfg: Config, planId: string, summary: string): Result<void> {
  const clash = clashGuard(root, planId, cfg.ship.branch)
  if (clash !== undefined) return refuse(clash)
  const wt = worktreePath(root, planId)
  if (tryGit(wt, 'status', '--porcelain').out !== '') {
    tryGit(wt, 'add', '-A')
    const committed = tryGit(wt, 'commit', '-m', `${planId}: ${summary}`)
    if (!committed.ok) {
      return refuse([v('commit', 'ship-commit-failed', committed.out.slice(0, 200),
        'a committable worktree — resolve and re-run witness ship')])
    }
    ctx.out(kv('commit', `${planId}: ${summary}`))
  }
  return ok(undefined)
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
  // Row 243 (design §4.1.1 step 0, P32, P41). A move a crash interrupted is finished first: before
  // the clash guard, whose carry signal names this very run, and before row 241's open-step refusal,
  // the revise-owed and standing-record exits and the phase routing — any of them first would loop.
  // Its refusals exit as the move's do and go through the same record.
  const finished = finishMove(root, worktreePath(root, planId), planId, (l) => ctx.out(l))
  if (!finished.ok) {
    renderRefusal(finished.violations).forEach((l) => ctx.err(l))
    recordRefusal(root, planId, finished.violations, cfgR.value.ship.branch)
    return carryExit(finished.violations)
  }
  if (finished.value === 'finished') {
    ctx.out(kv('move', `an interrupted move is finished — the plan's work is back in the tree, and ${carryRef(planId)} is gone`))
  }
  // Row 243 (design §4.1.2). Ship carries no plan on while a clash in its worktree is unresolved:
  // refused first, exit 2, recording nothing (§4.1.3) — each file on a row with its remedy, or, with
  // a carry ref standing, `witness ship` itself. Asked again before each commit (commitApproved),
  // since a gate phase's rebase runs between.
  const clashed = refuseClash(ctx, root, planId, cfgR.value)
  if (clashed !== undefined) return clashed
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
      needYouRows(heldItem(rec, cfgR.value, planId)).forEach((l) => ctx.out(l))
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
  // Row 244 (design §4.2.9): read against the last run that judged something — the run an approval
  // disposed of. A malformed round after it no longer un-settles the gate, and its checks may have
  // run a criterion the approval never did, so it never speaks for the approval's holds.
  const lifted = (): string[] =>
    liftedHolds(criteriaOwner(loadCanon(root), planId), lastJudgedRun(readStream(root, planId), 'ship'))
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
    // Row 244 (design §4.2.2, §4.2.4). A retraction asks for a re-review, not an edit: on the tree
    // the retracted approval judged, the gate below re-judges it (`--fresh`), after the rebase.
    const reReview = reReviewOwed('ship', planId, entries, reviewedSha)
    // D94: the gate cannot judge unchanged content twice — it answers changed-nothing
    // and appends nothing, so routing the human back at it burns a turn on a command
    // that has already declined. The owed work is the edit the revise asked for.
    if (!reReview && authoringOwed(entries, 'ship', reviewedSha)) {
      ctx.out(kv('ship', `${planId} — revise owed`))
      // Row 239. The re-run it names is an act's line.
      ctx.out(`help: edit the code in ${wt} · then re-run ${cliAct('ship', planId).line}`)
      return EXIT.FINDINGS
    }
    // Rebase BEFORE the battery, never after: the reviewers must judge the tree that will
    // actually merge. Reviewing first spends a battery — and a human decision — on a tree
    // without any sibling's merged work, which then lapses (gateSettled's reviewed_sha)
    // the moment the rebase lands.
    const rebase = rebaseIfMoved(wt, root, shipBranch, { planId, hasPr: plan.meta.pr !== undefined, env: ctx.env, say: (l) => ctx.out(l) })
    if (!rebase.ok) {
      renderRefusal(rebase.violations).forEach((l) => ctx.err(l))
      recordRefusal(root, planId, rebase.violations, shipBranch)
      // A textual conflict is a hand-back, not a refusal: the session resolves it in the
      // worktree and re-runs (exit 1). A held lock is transient (exit 3). Every other rule (the
      // carry's, no-remote, fetch-failed, push-failed) is a genuine refusal (exit 2).
      return carryExit(rebase.violations)
    }
    if (rebase.value === 'rebased') ctx.out(kv('rebase', `${shipBranch} moved — rebased before the battery`))
    const code = await runGate(ctx, 'ship', planId, { fresh: reReview, manual, handover: false })
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
    // Row 244 (design §4.2.5, P34). Content staleness too, read as `decide` reads it — the tree as it
    // stands against the last run that judged something, the run the decision disposes of — so on a
    // moved tree the block offers only live acts: the re-gate first, never an approve `decide` refuses
    // `stale-verdict`. An unresolvable base reads as unmoved ("cannot compute", never "moved").
    const judged = lastJudgedRun(entries, 'ship')
    const treeMoved = reviewedSha !== undefined && judged !== undefined && judged.reviewed_sha !== reviewedSha
    const stale = treeMoved || liftedNow.length > 0
    const d = recommend({ gate: 'ship', target: planId, entries, upstream: up, stale, untrustedCmds })
    if (d) renderDecision(d).forEach((l) => ctx.out(l))
    else ctx.out(cmd('help', liveExits('ship', planId, entries, stale, up)))
    return EXIT.FINDINGS
  }
  if (phase === 'pr') {
    const parent = findById(canon, String(plan!.meta.parent))
    const parentSummary = String(parent?.meta.summary ?? 'witness change')
    // implement leaves the worktree uncommitted — ship owns the sole code commit
    const committed = commitApproved(ctx, root, cfgR.value, planId, parentSummary)
    if (!committed.ok) {
      renderRefusal(committed.violations).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
    // What the approved run did not run, from its own record — the one derivation (row 179). Row 244:
    // the approved run is the last that judged something, never a malformed round after it.
    const held = (lastJudgedRun(entries, 'ship')?.checks ?? []).flatMap((c) => c.held ?? [])
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
  const pushed = pushApproved(ctx, root, cfgR.value, planId, String(findById(canon, String(plan!.meta.parent))?.meta.summary ?? 'witness change'))
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
