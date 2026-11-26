import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { foldOverlay, objectType } from './cf-tree.js'
import { lstatListed, parentsInTree, planChangeSet, witnessPaths } from './change-set.js'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { definitionFor, withBaseScripts } from './definitions.js'
import { stateCommit, stateDirs } from './gitio.js'
import { appendEntry, entryLine, journalRel, type Entry } from './journal.js'
import { loadFailures, mergeReports, reportFiles, type TestOutcome } from './junit.js'
import { trustedNow } from './allowlist.js'
import { readPart, type Diagnostic } from './diagnostics.js'
import { RULE_RE } from './lint-readers.js'
import { acquireLock } from './lock.js'
import { ok, refuse, v, type Result, type Violation } from './refusal.js'
import { lensesRan, runsSinceReset, type GateRunEntry } from './rounds.js'
import { execCommand, interrupted } from './runner.js'
import { withRunnerTurn } from './runner-lock.js'
import { inScratch, type CfStep } from './scratch-checkout.js'
import { READER_TOOLS, type ReaderTool } from './settings.js'
import { snapshotTree } from './snapshot.js'
import { isTestPath } from './switch-offs.js'
import { shellWord, visible } from './toon.js'
import { withTxn } from './txn.js'
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
      `the reviewed tree of round ${mark.run.round} — git no longer holds it, so the guard cannot be proven; the judge or a human may book it (witness decide ${shellWord(mark.gate)} ${shellWord(mark.run.artifact)} --book guards)`)])
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

// ── The proof's record ───────────────────────────────────────────────────────────────────────

// Row 280. A proven guard, journaled on the plan's stream. `gate`, `anchor`, `round` and `run` name
// the mark it answers; `kind` the guard's own (a mark asks, it does not choose); `rule` a lint
// guard's tool and rule, `tests` a test guard's case names; `files` each overlay path → its blob sha
// in the current tree (the `guards` check reads a changed one as stale); `base` the plan's base;
// `red`, `green` the trees run; `breadth` the copy a lint guard also caught; `spots` the rule's
// diagnostics on other files of the current tree; `ms` the proof's wall time.
export interface GuardEntry {
  v: 1; t: 'guard'; gate: GuardGate; anchor: string; round: number; run: string; kind: GuardKind
  rule?: { tool: ReaderTool; rule: string }; tests?: string[]; files: Record<string, string>
  base: string; red: string; green: string; breadth?: string; spots?: number; ms: number
}

// One `guard` entry under the repo lock, in one transaction with its state commit.
export function journalGuard(root: string, plan: string, entry: Omit<GuardEntry, 'v' | 't'>): Result<{ sha: string }> {
  const line: GuardEntry = { v: 1, t: 'guard', ...entry }
  const lock = acquireLock(root)
  if (!lock.ok) return lock
  try {
    const marker = { op: `guard(${plan})`, files: [journalRel(plan)], journalMulti: [{ stream: plan, line: entryLine(line as unknown as { t: 'guard'; [k: string]: unknown }) }] }
    return withTxn(root, marker, () => {
      appendEntry(root, plan, line as unknown as Entry)
      return stateCommit(root, marker.files, marker.op)
    })
  } finally {
    lock.value()
  }
}

// ── The test proof (C42) ─────────────────────────────────────────────────────────────────────

// The command a test guard runs: `criteria.byFile` with the guard's test paths (typed, §3.7) for
// `{files}`, space-separated — the only tokens witness appends to a command; else `ship.test`, the
// full suite (undefined when that is unset). A test name never reaches it: names are agent text,
// matched in junit only.
export function testCommand(cfg: Config, files: readonly string[]): string | undefined {
  return cfg.criteria.byFile !== undefined ? cfg.criteria.byFile.replaceAll('{files}', files.join(' ')) : cfg.ship.test
}

const junitGlob = (cfg: Config): string | undefined =>
  cfg.criteria.report?.startsWith('junit:') ? cfg.criteria.report.slice('junit:'.length) : undefined

const namesGot = (names: readonly string[]): string => visible(names.join(' · ')).slice(0, 400)

// Whether every named case is present (and loaded) and ended as `want`. A name the run never
// reported is not measured — a wrong name, or the environment emptying the run — never a red.
function judgeCases(tests: readonly TestOutcome[], names: readonly string[], want: 'failed' | 'passed', round: number): Violation | undefined {
  const cases = (n: string) => tests.filter((t) => t.name === n && t.load !== true)
  const absent = names.filter((n) => cases(n).length === 0)
  if (absent.length > 0) {
    return v('--test', 'guard-not-run', namesGot(absent), `a run that reports every named case (${want === 'failed' ? `on round ${round}'s tree` : 'now'}) — a wrong name, or the environment emptied the run (a service down, an empty report); never a red`)
  }
  const off = names.filter((n) => !cases(n).every((t) => t.status === want))
  if (off.length === 0) return undefined
  return want === 'failed'
    ? v('--test', 'guard-not-red', namesGot(off), `tests that fail on round ${round}'s tree, the code the reviewer flagged — these pass there, so they do not catch it`)
    : v('--test', 'guard-not-green', namesGot(off), 'tests that pass on the worktree now — the fix does not satisfy them yet')
}

// Row 280. Red then green, each in the scratch under the verb's test turn (lock order turn →
// scratch, C43). A run's step deletes its reports first (reset keeps `target/`), runs the command
// with no turn of its own (the verb holds it), refuses a run a signal ended (row 247), and returns
// its load failures: inScratch prepares again once and then refuses `load-failure` — a load error is
// never a red. No report at all is not measured (`guard-not-run`). The command is the caller's to
// have trusted.
// What a test guard runs, checked before anything does: the junit glob it reads, the overlay's test
// files, the template granted (`criteria.byFile` or `ship.test`, with its setting's name) and the
// command with the paths substituted.
export function testRun(cfg: Config, files: readonly string[]): Result<{ glob: string; tests: string[]; template: string; source: string; cmd: string }> {
  const glob = junitGlob(cfg)
  if (glob === undefined) {
    return refuse([v('criteria.report', 'guard-no-report', cfg.criteria.report ?? 'none', 'junit:<glob> — a test guard reads its named cases from the junit report')])
  }
  const tests = files.filter(isTestPath)
  if (tests.length === 0) {
    return refuse([v('--files', 'guard-no-test-file', visible(files.join(' ')), 'a test file among --files — the guard\'s test runs from it')])
  }
  const template = cfg.criteria.byFile ?? cfg.ship.test
  const cmd = testCommand(cfg, tests)
  if (template === undefined || cmd === undefined) {
    return refuse([v('ship.test', 'guard-no-command', 'not set', 'a suite command, or criteria.byFile — witness migrate proposes them')])
  }
  return ok({ glob, tests, template, source: cfg.criteria.byFile !== undefined ? 'criteria.byFile' : 'ship.test', cmd })
}

export function proveTest(
  root: string, ctx: Ctx, cfg: Config, plan: string, mark: GuardMark, trees: GuardTrees,
  names: readonly string[], files: readonly string[],
): Result<{ ms: number }> {
  const planned = testRun(cfg, files)
  if (!planned.ok) return planned
  const { glob, cmd } = planned.value
  const t0 = Date.now()
  return withRunnerTurn(root, ctx, `guard ${plan}`, (env) => {
    const here = { ...ctx, env }
    const run = (tree: string) => inScratch(root, here, cfg, { tree, plan }, (dir): Result<CfStep<TestOutcome[]>> => {
      for (const f of reportFiles(dir, glob)) rmSync(join(dir, f), { force: true })
      const out = execCommand(dir, here, cmd, { turn: false })
      if (out.signal !== undefined) return refuse([interrupted(out.signal)])
      const read = mergeReports(dir, glob)
      if (!read.ok) {
        return refuse([v('--test', 'guard-not-run', namesGot(names), `a run that writes junit:${glob} — none was written; the environment, never a red`)])
      }
      return ok({ value: read.value, load: loadFailures(read.value) })
    })
    const red = run(trees.red)
    if (!red.ok) return red
    const notRed = judgeCases(red.value.value, names, 'failed', mark.run.round)
    if (notRed !== undefined) return refuse([notRed])
    const green = run(trees.green)
    if (!green.ok) return green
    const notGreen = judgeCases(green.value.value, names, 'passed', mark.run.round)
    if (notGreen !== undefined) return refuse([notGreen])
    return ok({ ms: Date.now() - t0 })
  })
}

// ── The lint proof ───────────────────────────────────────────────────────────────────────────

// `<tool>:<rule>`, split at the first `:` (clippy's `clippy::x` keeps its colons): a reader tool
// and a rule id the readers can report (RULE_RE).
export function parseRule(raw: string): { tool: ReaderTool; rule: string } | undefined {
  const at = raw.indexOf(':')
  if (at < 0) return undefined
  const tool = raw.slice(0, at)
  const rule = raw.slice(at + 1)
  return (READER_TOOLS as readonly string[]).includes(tool) && RULE_RE.test(rule) ? { tool: tool as ReaderTool, rule } : undefined
}

const UNTRUSTED_WANT = 'a trusted command — witness next names the grant to make, or set WITNESS_TRUST_CMDS=1 for automation'

// Row 280. The reader of `rule.tool` runs once on each tree in the scratch, with no turn (lint takes
// none, row 255; C43) and at error severity only (row 262: a warn-level rule never reads red). Red:
// the rule fires on the anchored file of the red tree — the round's own bytes, which the overlay never
// holds — and, given `copy`, on the breadth copy beside it too. Green: it fires nowhere in the
// anchored file now (a fix that deleted the file is green). `spots`: the rule's diagnostics on every
// other file of the current tree — until T4b's tolerated sets, lint reads them as the plan's. A report
// the reader cannot read is not measured (`reader-unread`), never a red.
export function proveLint(
  root: string, ctx: Ctx, cfg: Config, plan: string, mark: GuardMark, trees: GuardTrees,
  rule: { tool: ReaderTool; rule: string }, anchored: string, copy?: string,
): Result<{ spots: number; ms: number }> {
  const cmd = cfg.readers[rule.tool]
  if (cmd === undefined) {
    return refuse([v(`readers.${rule.tool}`, 'reader-unset', 'none', `the command printing ${rule.tool}'s report — witness migrate proposes one; a lint guard reads its rule there`)])
  }
  if (!trustedNow(root, ctx.env, cmd)) return refuse([v(`readers.${rule.tool}`, 'untrusted-blocked', cmd, UNTRUSTED_WANT)])
  const t0 = Date.now()
  const read = (tree: string): Result<Diagnostic[]> => {
    const r = inScratch(root, ctx, cfg, { tree, plan }, (dir): Result<CfStep<Diagnostic[]>> => {
      const part = readPart(dir, ctx, rule.tool, cmd)
      return part.ok ? ok({ value: part.value.diagnostics, load: [] }) : part
    })
    if (r.ok) return ok(r.value.value)
    const why = r.violations[0]!
    // A reader's own failures read not measured; the scratch's refusals (and a signal) keep their rule.
    if (why.field === `readers.${rule.tool}` && why.rule !== 'run-interrupted') {
      return refuse([v(`readers.${rule.tool}`, 'reader-unread', why.got, `a report the reader prints — ${rule.tool}'s was not read; not measured, never a red`)])
    }
    return r
  }
  const hits = (ds: readonly Diagnostic[], file: string) => ds.filter((d) => d.tool === rule.tool && d.rule === rule.rule && d.file === file).length
  const red = read(trees.red)
  if (!red.ok) return red
  const shown = `${rule.tool}:${rule.rule}`
  if (hits(red.value, anchored) === 0) {
    return refuse([v('--rule', 'guard-not-red', visible(shown),
      `a rule that reports an error on ${visible(anchored)} in round ${mark.run.round}'s tree, the code the reviewer flagged — it reports none there (a warn-level rule never counts)`)])
  }
  if (copy !== undefined && hits(red.value, copy) === 0) {
    return refuse([v('--rule', 'guard-too-narrow', visible(shown), `a rule that catches this shape of code, not this file's path or names — it missed ${visible(copy)}, a copy with renamed locals and changed indentation`)])
  }
  const green = read(trees.green)
  if (!green.ok) return green
  const left = hits(green.value, anchored)
  if (left > 0) {
    return refuse([v('--rule', 'guard-not-green', visible(shown), `a fix the rule no longer flags — it still reports ${left} on ${visible(anchored)} now`)])
  }
  const spots = green.value.filter((d) => d.tool === rule.tool && d.rule === rule.rule && d.file !== anchored).length
  return ok({ spots, ms: Date.now() - t0 })
}
