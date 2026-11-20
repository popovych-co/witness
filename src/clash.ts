import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cliAct } from './act.js'
import {
  carryGit, carryRef, keptRefs, operationInProgress, remedyLine, unmergedPaths, type OpInProgress, type UnmergedPath,
} from './carry.js'
import { EXIT, type Ctx } from './cli.js'
import { loadConfig, type Config } from './config.js'
import { tryGitC } from './gitio.js'
import { renderRefusal, v, type Violation } from './refusal.js'
import { shellWord } from './toon.js'
import { worktreePath } from './worktree.js'

// Row 243 (design §4.1.2). The guard: one predicate, read by every gate on a plan's worktree, every
// evidence run, `witness turn` there, and ship, so a clash never reaches a reviewer or a commit.
// It answers on any of three signals, in this order (§4.1.5):
//   (c) a carry ref present — a move was interrupted and the work may not be in the tree; `witness
//       ship` is the one remedy, since step 0 turns every such state into one with its own steps;
//   (a) git's unmerged index entries;
//   (b) git's stash-apply label lines in a file a kept ref lists — a clash someone staged or
//       committed with its markers still in.
export type ClashSignal =
  | { kind: 'unmerged'; files: UnmergedPath[] }
  | { kind: 'labels'; files: string[] }
  | { kind: 'carry'; ref: string }

// Signal (b)'s lines. git writes these labels untranslated, with seven markers unless a
// `conflict-marker-size` attribute says otherwise (P51). A plain `=======` never counts: a Markdown
// heading underlined with seven `=` would otherwise hold a plan for its whole life (P22).
const LABELS = '(?:<{7,} Updated upstream|>{7,} Stashed changes|\\|{7,} Stash base)\\r?$'
const ADDED_LABEL = new RegExp(`^\\+${LABELS}`, 'm')
const LABEL_LINE = new RegExp(`^${LABELS}`, 'm')

// `shipBranch` places signal (b)'s merge-base; (c) and (a) take none. With no branch, (b) reads each
// listed file itself, failing closed (§4.1.5).
export function clashLeft(wt: string, planId: string, shipBranch?: string): ClashSignal | undefined {
  const ref = carryRef(planId)
  if (carryGit(wt, 'show-ref', '--verify', '--quiet', ref).code === 0) return { kind: 'carry', ref }
  const unmerged = unmergedPaths(wt)
  if (unmerged.length > 0) return { kind: 'unmerged', files: unmerged }
  const listed = [...new Set(keptRefs(wt, planId).flatMap((k) => k.files))]
  if (listed.length === 0) return undefined
  const base = shipBranch === undefined ? undefined : mergeBase(wt, shipBranch)
  const files = listed.filter((f) => labelled(wt, base, f))
  return files.length > 0 ? { kind: 'labels', files } : undefined
}

// HEAD's merge-base with the remote ship branch, else with the local one: the diff from it shows a
// label line whether it is unstaged, staged or committed.
function mergeBase(wt: string, shipBranch: string): string | undefined {
  for (const ref of [`refs/remotes/origin/${shipBranch}`, `refs/heads/${shipBranch}`]) {
    const r = tryGitC(wt, 'merge-base', 'HEAD', ref)
    if (r.ok && /^[0-9a-f]+$/.test(r.out.trim())) return r.out.trim()
  }
  return undefined
}

// One diff per listed file, from the worktree root, with every setting that could hide a label or
// misname the file turned off: `--text` against a `-diff` attribute, `--no-textconv` and
// `--no-ext-diff` against a driver, `--no-color` against forced colour, fixed prefixes against
// `diff.noprefix`, `--no-relative` against `diff.relative` (P36, P44), and `--literal-pathspecs`
// so `:foo.md` is no magic and `[x].md` matches no `x.md` (P51). With no merge-base, or a diff that
// fails, the file itself is read: failing closed (§4.1.5).
function labelled(wt: string, base: string | undefined, file: string): boolean {
  if (base !== undefined) {
    const d = tryGitC(wt, '--literal-pathspecs', 'diff', '--text', '--no-textconv', '--no-ext-diff', '--no-color',
      '--src-prefix=a/', '--dst-prefix=b/', '--no-relative', base, '--', file)
    if (d.ok) return ADDED_LABEL.test(d.out)
  }
  const bytes = readWorktree(wt, file)
  return bytes !== undefined && LABEL_LINE.test(bytes.toString('latin1'))
}

function readWorktree(wt: string, file: string): Buffer | undefined {
  try {
    return readFileSync(join(wt, file))
  } catch {
    return undefined
  }
}

// §4.1.5 (S1-5). Which side is the plan's depends on the operation that left the entry: a stash
// apply's theirs (stage 3) is the plan's work, a rebase's theirs is the plan's commit being
// replayed, and in a merge, a cherry-pick or a revert on the plan's branch HEAD — ours — is.
export type ClashOp = 'stash' | 'rebase' | 'merge'
export function clashOp(op: OpInProgress | undefined): ClashOp {
  return op === undefined ? 'stash' : op === 'rebase-merge' || op === 'rebase-apply' ? 'rebase' : 'merge'
}

interface Sides { plan: 2 | 3; planVersion: string; otherVersion: string; planSide: string; otherSide: string }
const SIDES: Record<ClashOp, Sides> = {
  stash: { plan: 3, planVersion: "the plan's version", otherVersion: "the base's version", planSide: "the plan's side", otherSide: "the base's side" },
  rebase: { plan: 3, planVersion: "the plan's commit", otherVersion: "the base's version", planSide: "the plan's commit", otherSide: 'the base' },
  merge: {
    plan: 2, planVersion: "the plan's version (HEAD)", otherVersion: 'the merged-in version',
    planSide: "the plan's side (HEAD)", otherSide: 'the merged-in side',
  },
}

// Any operation's conflict markers: `<<<<<<< Updated upstream` from a stash apply, `<<<<<<< HEAD`
// from a rebase or a merge — a marker line and its label, or the marker alone (S1-5).
const OPENS = /^<{7,}(?: |\r?$)/m
const CLOSES = /^>{7,}(?: |\r?$)/m

const contentRow = (file: string): string =>
  `content — resolve the conflict markers keeping both sides' intent, then ${remedyLine(['git', 'add', '--', file])}`

// §4.1.3's per-file rows, one per file in order, each `<kind> — <remedy>`, its kind read from the
// stages and the file: content (it holds conflict markers), binary or both changed with no markers,
// and modify/delete. Every command goes through `remedyLine`. None is a runnable `remedy`: `git
// add` before the markers are resolved would stage them, so no row offers it as `run:`.
export function fileRemedies(wt: string, files: UnmergedPath[], op: ClashOp): string[] {
  const s = SIDES[op]
  const other = s.plan === 3 ? 2 : 3
  const keepPlan = s.plan === 3 ? '--theirs' : '--ours'
  const keepOther = s.plan === 3 ? '--ours' : '--theirs'
  return files.map(({ path, stages }) => {
    const add = remedyLine(['git', 'add', '--', path])
    const rm = remedyLine(['git', 'rm', '--', path])
    const planGone = stages[s.plan] === undefined
    const otherGone = stages[other] === undefined
    if (planGone && otherGone) return `deleted on both sides — ${rm} records the deletion`
    if (planGone || otherGone) {
      const [deleted, changed] = planGone ? [s.planSide, s.otherSide] : [s.otherSide, s.planSide]
      return `modify/delete — ${deleted} deleted it and ${changed} changed it: ${rm} keeps the deletion, ${add} keeps the change`
    }
    const bytes = readWorktree(wt, path)
    const text = bytes?.toString('latin1') ?? ''
    if (OPENS.test(text) && CLOSES.test(text)) return contentRow(path)
    const kind = bytes !== undefined && bytes.subarray(0, 8000).includes(0) ? 'binary' : 'both changed, no markers'
    return `${kind} — ${remedyLine(['git', 'checkout', keepPlan, '--', path])} keeps ${s.planVersion}, `
      + `${remedyLine(['git', 'checkout', keepOther, '--', path])} keeps ${s.otherVersion}; then ${add}`
  })
}

// git status's two letters for an unmerged entry, from the stages it has.
function statusCode(stages: UnmergedPath['stages']): string {
  const has = (n: 1 | 2 | 3): boolean => stages[n] !== undefined
  if (has(2) && has(3)) return has(1) ? 'UU' : 'AA'
  if (has(1)) return has(2) ? 'UD' : has(3) ? 'DU' : 'DD'
  return has(2) ? 'AU' : 'UA'
}

// The refusal `clash-unresolved` (exit 2 everywhere; the caller renders and exits). For (a) and (b)
// each file is a row of its own, named as a quoted foreign word, with its remedy as prose. For (c)
// it leads with `witness ship <plan>`, which finishes the move, and offers no per-file resolution.
export function clashViolations(planId: string, s: ClashSignal, wt: string): Violation[] {
  if (s.kind === 'carry') {
    const ship = cliAct('ship', planId)
    return [v(s.ref, 'clash-unresolved',
      `${s.ref} is present — a move of the plan's work onto a moved base was interrupted, and the work may not be in the tree`,
      `${ship.line} — it finishes the move first; resolve no file by hand before it has run`,
      ship.withheld === undefined ? ship.line : undefined)]
  }
  if (s.kind === 'unmerged') {
    const rows = fileRemedies(wt, s.files, clashOp(operationInProgress(wt)))
    return s.files.map((f, i) => v(shellWord(f.path), 'clash-unresolved', `unmerged (${statusCode(f.stages)})`, rows[i]!))
  }
  const kept = keptRefs(wt, planId)
  return s.files.map((file) => {
    const refs = kept.filter((k) => k.files.includes(file)).map((k) => k.ref)
    return v(shellWord(file), 'clash-unresolved', `stash-apply label lines in a file ${refs.join(' and ')} lists`,
      `${contentRow(file)} · if a label line is the file's own text (a doc or a fixture), not a clash: a human moves ${refs.join(' and ')} `
        + 'out of refs/witness/kept/, to any name outside it, which releases the file — the backup itself is kept')
  })
}

// §4.1.2 "Who reads it". The plan's worktree asked: the refusal's rows, or nothing. A worktree that
// is not there (no `.git` in it) holds no tree to clash, so nothing is asked: from a leftover
// directory at its path, git would answer from the primary checkout's repository. A carry ref left
// with the worktree gone is ship's step 0 to refuse (`carry-pending`).
export function clashGuard(root: string, planId: string, shipBranch?: string): Violation[] | undefined {
  const wt = worktreePath(root, planId)
  if (!existsSync(join(wt, '.git'))) return undefined
  const s = clashLeft(wt, planId, shipBranch)
  return s === undefined ? undefined : clashViolations(planId, s, wt)
}

// The one call every reader makes: the implement and ship gates, test-evidence and verify-red,
// `witness turn` in a plan's worktree, and ship's first check. It renders the rows and answers exit
// 2 (REFUSED) — in the gate, an evidence run and a turn, exit 1 already means a verdict or a test's
// own failure — or nothing. It never waits on a config: the ship branch comes from the run's own
// config (`run`, given loaded or as the checkout it lives in), else the primary root's, else none.
// A config that will not load — even one whose own lines are the clash's markers — neither hides a
// clash nor refuses where none stands.
export function refuseClash(ctx: Ctx, root: string, planId: string, run: string | Config = root): number | undefined {
  const rows = clashGuard(root, planId, shipBranchFor(root, run))
  if (rows === undefined) return undefined
  renderRefusal(rows).forEach((l) => ctx.err(l))
  return EXIT.REFUSED
}

function shipBranchFor(root: string, run: string | Config): string | undefined {
  if (typeof run !== 'string') return run.ship.branch
  for (const at of run === root ? [root] : [run, root]) {
    const cfg = loadConfig(at)
    if (cfg.ok) return cfg.value.ship.branch
  }
  return undefined
}
