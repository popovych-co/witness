import { join } from 'node:path'
import { foldOverlay, objectType } from './cf-tree.js'
import { lstatListed, parentsInTree, planChangeSet, witnessPaths } from './change-set.js'
import type { Config } from './config.js'
import { definitionFor, withBaseScripts } from './definitions.js'
import { stateDirs } from './gitio.js'
import type { Entry } from './journal.js'
import { ok, refuse, v, type Result, type Violation } from './refusal.js'
import { lensesRan, runsSinceReset, type GateRunEntry } from './rounds.js'
import { snapshotTree } from './snapshot.js'
import { isTestPath } from './switch-offs.js'
import { visible } from './toon.js'
import { anchorKey, guardMarked, type GuardKind } from './verdict.js'

// Row 280 (§4 T4). A fix adds a check. A reviewer marks a blocking finding a machine could catch
// from now on (`guard: lint | test`, src/verdict.ts); the round that marks one pins its reviewed tree
// (src/gate.ts). The author answers with a check — a lint rule or a test — and proves it with
// `witness guard` (src/verbs/guard.ts): the check fails on the tree the reviewer flagged, with the
// guard's own files folded over it (red), and passes on the worktree now (green). This module holds
// what the verb and the `guards` check share: the marks, the overlay's rules and the two trees.

export type GuardGate = 'implement' | 'ship'
export const GUARD_GATES: readonly GuardGate[] = ['implement', 'ship']

// One marked anchor of a gate: the newest round in the gate's window that marked it. `anchor` is in
// `anchorKey` spelling (an omission is `omission:<scope>`).
export interface GuardMark { gate: GuardGate; anchor: string; mark: GuardKind; run: GateRunEntry }

// Every anchor a blocking, undemoted finding marked in the gate's rounds since its last reset
// (`runsSinceReset`), from rounds where lenses ran (a checks-only or malformed round judged
// nothing). One per anchor: the newest marking round, and within a round the first lens's mark.
// Sorted by anchor.
export function guardMarks(entries: readonly Entry[], gate: GuardGate): GuardMark[] {
  const by = new Map<string, GuardMark>()
  for (const run of runsSinceReset(entries as Entry[], gate)) {
    if (!lensesRan(run)) continue
    const seen = new Set<string>()
    for (const rv of run.verdicts ?? []) {
      for (const f of rv.findings) {
        if (!guardMarked(f)) continue
        const anchor = anchorKey(f.anchor)
        if (seen.has(anchor)) continue
        seen.add(anchor)
        by.set(anchor, { gate, anchor, mark: f.guard, run })
      }
    }
  }
  return [...by.values()].sort((a, b) => (a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0))
}

// The mark at exactly `anchor`: the newer of the two gates' marks, by the stream's order. A ship mark
// answers to its own guard.
export function findMark(entries: readonly Entry[], anchor: string): GuardMark | undefined {
  const found = GUARD_GATES.flatMap((g) => guardMarks(entries, g).filter((m) => m.anchor === anchor))
  const at = (m: GuardMark) => entries.indexOf(m.run as unknown as Entry)
  return found.sort((a, b) => at(b) - at(a))[0]
}

// A string anchor's file part (before `#`); none for an omission.
export const anchorFile = (anchor: string): string | undefined =>
  anchor.startsWith('omission:') ? undefined : anchor.split('#')[0]

// §3.7's typed path: 1–400 characters of [A-Za-z0-9._@+/-], no empty, `.` or `..` segment, no
// segment starting with `-`. The only tokens witness appends to a command (`{files}`), so none of
// them can be read by a shell or a tool as anything but a path.
const TYPED_RE = /^[A-Za-z0-9._@+/-]{1,400}$/
export function typedPath(p: string): boolean {
  return typeof p === 'string' && TYPED_RE.test(p)
    && p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !seg.startsWith('-'))
}

const under = (p: string, dir: string): boolean => {
  const d = dir.replace(/\/+$/, '')
  return d !== '' && (p === d || p.startsWith(`${d}/`))
}

// The overlay a guard may fold over the round's tree: only check definitions and test files, never
// the anchored file (the acceptance: a guard that rewrote the flagged code would prove nothing),
// never any other source file. Each path in order is checked against every rule; the first broken
// rule refuses, its path spelled out.
export function overlayRefusal(root: string, wt: string, cfg: Config, anchor: string, paths: readonly string[]): Violation | undefined {
  if (paths.length === 0) {
    return v('--files', 'overlay-empty', 'no path', 'the guard\'s files: a lint rule\'s config or a test file, one --files each')
  }
  const witness = new Set(witnessPaths())
  const states = stateDirs(root)
  const file = anchorFile(anchor)
  for (const p of paths) {
    const got = visible(String(p))
    if (!typedPath(p)) {
      return v('--files', 'overlay-path', got, 'a repo-relative path of letters, digits and . _ @ + / - (no empty, . or .. segment, none starting with -)')
    }
    const st = parentsInTree(wt, p) ? lstatListed(join(wt, p)) : undefined
    if (st === undefined || !st.isFile()) {
      return v('--files', 'overlay-not-a-file', got, 'a regular file in the plan\'s worktree — not a folder, a link or a missing path')
    }
    if (witness.has(p) || states.some((d) => under(p, d))) {
      return v('--files', 'overlay-witness', got, 'a file of the code — never canon, witness state or a witness payload')
    }
    if (p === file) {
      return v('--files', 'overlay-anchor', got, 'never the anchored file — the guard must fail on the code the reviewer flagged, as that round held it')
    }
    if (definitionFor(cfg.checks.definitions, p) === undefined && !isTestPath(p)) {
      return v('--files', 'overlay-source', got, 'a check definition (checks.definitions) or a test file — no other source file')
    }
  }
  return undefined
}

// The trees a guard runs on. `pinned` the marking round's reviewed tree; `current` the worktree's
// tree now (the plan's change set over the base, `snapshotTree`); `red` the pinned tree with the
// overlay folded over it from `current`, and any `extra` blobs (the breadth copy); `green` the
// current tree. Both run trees take the base's members for every member definition
// (`package.json#scripts`, `withBaseScripts`): a guard's command goes through the base's script
// indirection, never the plan's or the overlay's.
export interface GuardTrees { pinned: string; current: string; red: string; green: string }

export function guardTrees(
  root: string, wt: string, base: string, cfg: Config, mark: GuardMark, overlay: readonly string[],
  extra?: Array<{ path: string; mode: string; sha: string }>,
): Result<GuardTrees> {
  const pinned = mark.run.reviewed_tree
  if (pinned === undefined || objectType(root, pinned) !== 'tree') {
    return refuse([v('finding', 'tree-unknown', visible(pinned ?? 'none journaled'),
      `the reviewed tree of round ${mark.run.round} — git no longer holds it, so the guard cannot be proven; the judge or a human may book it (witness decide ${mark.gate} ${mark.run.artifact} --book guards)`)])
  }
  const current = snapshotTree(wt, base, planChangeSet(wt, base))
  if (current === undefined) {
    return refuse([v('worktree', 'snapshot-failed', visible(wt), 'a worktree git can snapshot over the base')])
  }
  const folded = foldOverlay(root, pinned, { from: current, paths: [...overlay], ...(extra !== undefined && extra.length > 0 ? { blobs: extra } : {}) })
  if (!folded.ok) return folded
  const red = withBaseScripts(root, base, folded.value, cfg.checks.definitions)
  if (!red.ok) return red
  const green = withBaseScripts(root, base, current, cfg.checks.definitions)
  if (!green.ok) return green
  return ok({ pinned, current, red: red.value, green: green.value })
}
