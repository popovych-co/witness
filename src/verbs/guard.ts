import { existsSync } from 'node:fs'
import { ensureTrusted, UNGRANTABLE } from '../allowlist.js'
import { entryAt } from '../cf-tree.js'
import { EXIT, type Ctx } from '../cli.js'
import { refuseClash } from '../clash.js'
import { loadConfig } from '../config.js'
import { diffBase } from '../evidence.js'
import { primaryRoot } from '../gitio.js'
import {
  UNMEASURED_RULES, anchorFile, breadthBlob, findMark, guardTrees, journalGuard, noteUnmeasured, overlayRefusal, parseRule, proveLint, proveTest, testRun, type GuardEntry,
  type GuardMark, type GuardTrees,
} from '../guard.js'
import { refuseHeld } from '../held.js'
import { readStream } from '../journal.js'
import { renderRefusal, v, type Violation } from '../refusal.js'
import { findById, loadCanon } from '../scan.js'
import { hasControl, shellWord, visible } from '../toon.js'
import { guardTxn } from '../txn.js'
import { worktreePath } from '../worktree.js'
import { MAX_TOLERATED_KEYS, itemKey, ledgerItems, newItemId, type LedgerClosed, type ToleratedOpen } from '../ledger.js'
import { allowance, applicableSets, growth, ruleKey } from '../tolerated.js'
import { BIOME_LIST, ESLINT_LIST, extendsWitness, listableAt, writable } from '../tolerated-lists.js'
import type { Diagnostic } from '../diagnostics.js'
import type { GuardLedger } from '../guard.js'
import type { ReaderTool } from '../settings.js'

// Row 280 (§4 T4). `witness guard`: prove the check a fix adds. The guard's files (a lint rule's
// config, or a test file) fold over the tree the marking round reviewed — red there — and the
// worktree's tree now — green there; both run in the scratch with the base's script indirection
// (src/guard.ts). Only a proof is journaled (`guard`, an act); every refusal journals nothing.
const USAGE = 'witness guard <plan-id> --finding <anchor> --files <path>… (--rule <tool>:<rule> | --test <name>…)'
const VALUED = new Set(['--finding', '--files', '--rule', '--test'])
const MAX_NAMES = 20
const MAX_NAME = 500

// A guard that ran and did not prove is a finding about the check (exit 1); anything that kept it
// from being measured is a refusal (exit 2); the repo lock held is a retry (exit 3).
const FINDING_RULES = new Set(['guard-not-red', 'guard-not-green', 'guard-too-narrow', 'guard-not-attributable'])
const exitOf = (rows: readonly Violation[]): number =>
  rows.some((x) => x.rule === 'locked') ? EXIT.BLOCKED
    : rows.some((x) => FINDING_RULES.has(x.rule)) ? EXIT.FINDINGS : EXIT.REFUSED

interface Args { plan: string; finding: string; files: string[]; rule?: string; tests: string[] }

function parse(argv: string[]): Args | Violation {
  const usage = (got: string) => v('args', 'usage', visible(got), USAGE)
  const out: { plan?: string; finding?: string; files: string[]; rule?: string; tests: string[] } = { files: [], tests: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (VALUED.has(a)) {
      const val = argv[i + 1]
      if (val === undefined) return usage(`${a} without a value`)
      i++
      if (a === '--finding') { if (out.finding !== undefined) return usage('--finding twice'); out.finding = val }
      else if (a === '--rule') { if (out.rule !== undefined) return usage('--rule twice'); out.rule = val }
      else if (a === '--files') out.files.push(val)
      else out.tests.push(val)
    } else if (a.startsWith('--')) return usage(a)
    else if (out.plan === undefined) out.plan = a
    else return usage(a)
  }
  if (out.plan === undefined || out.finding === undefined) return usage(argv.join(' '))
  return { plan: out.plan, finding: out.finding, files: out.files, tests: out.tests, ...(out.rule !== undefined ? { rule: out.rule } : {}) }
}

// The names a test guard reads in junit: 1–20 of them, each 1–500 characters, none holding a control
// character (they are spelled out on every screen, never put in a command).
function namesRefusal(names: readonly string[]): Violation | undefined {
  const want = `1–${MAX_NAMES} testcase names as the junit report holds them (vitest: describe > it), each 1–${MAX_NAME} characters with no control character`
  if (names.length > MAX_NAMES) return v('--test', 'test-name', `${names.length} names`, want)
  const bad = names.find((n) => n.trim() === '' || n.length > MAX_NAME || hasControl(n))
  return bad === undefined ? undefined : v('--test', 'test-name', visible(bad).slice(0, 200), want)
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const refused = (rows: Violation[]): number => { renderRefusal(rows).forEach((l) => ctx.err(l)); return exitOf(rows) }
  const args = parse(argv)
  if ('field' in args) return refused([args])
  if ((args.rule === undefined) === (args.tests.length === 0)) {
    return refused([v('--rule|--test', 'guard-kind', args.rule !== undefined ? '--rule and --test' : 'neither',
      'exactly one: --rule <tool>:<rule> for a lint guard, or --test <name> (repeatable) for a test guard')])
  }
  if (args.rule === undefined) {
    const names = namesRefusal(args.tests)
    if (names !== undefined) return refused([names])
  }
  const rule = args.rule === undefined ? undefined : parseRule(args.rule)
  if (args.rule !== undefined && rule === undefined) {
    return refused([v('--rule', 'rule-shape', visible(args.rule), '<tool>:<rule> — tool biome, eslint, clippy or tsc; the rule id as its report names it (letters, digits and @ / _ . : -)')])
  }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) return refused(rootR.violations)
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const plan = findById(loadCanon(root), args.plan)
  if (!plan || plan.meta.type !== 'plan') return refused([v('plan-id', 'unknown-plan', visible(args.plan), 'an existing plan id')])
  // The plan's own worktree, never the caller's cwd: the guard proves what the plan holds.
  const wt = worktreePath(root, args.plan)
  if (!existsSync(wt)) return refused([v('plan-id', 'not-started', args.plan, `a started plan — witness start ${shellWord(args.plan)}`)])
  const clashed = refuseClash(ctx, root, args.plan, wt)
  if (clashed !== undefined) return clashed
  const held = refuseHeld(ctx, root, args.plan, wt)
  if (held !== undefined) return held
  const cfgR = loadConfig(root)
  if (!cfgR.ok) return refused(cfgR.violations)
  const cfg = cfgR.value
  const baseR = diffBase(wt, cfg)
  if (!baseR.ok) return refused(baseR.violations)
  const base = baseR.value

  const mark = findMark(readStream(root, args.plan), args.finding)
  if (mark === undefined) {
    return refused([v('--finding', 'finding-unknown', visible(args.finding),
      `a blocking finding a reviewer marked guard since the gate's last reset — witness gate implement ${shellWord(args.plan)} (or ship) prints them`)])
  }
  const overlay = overlayRefusal(root, wt, cfg, mark.anchor, args.files)
  if (overlay !== undefined) return refused([overlay])
  // Final review I4: from here a refusal the environment or witness causes is kept for the anchor, so
  // the guards check and the judge read it; a proof clears it.
  const out = (rows: Violation[]): number => {
    const why = rows.find((x) => UNMEASURED_RULES.has(x.rule))
    if (why !== undefined) noteUnmeasured(root, args.plan, mark.anchor, why.rule)
    return refused(rows)
  }
  if (rule !== undefined) {
    const anchored = anchorFile(mark.anchor)
    if (anchored === undefined) {
      return out([v('--finding', 'guard-anchor-not-a-file', visible(mark.anchor),
        "a finding anchored at a file — a lint guard's rule is read at the anchored file; an omission is answered by a test guard")])
    }
    const copy = breadthBlob(root, mark, anchored)
    if (!copy.ok) return out(copy.violations)
    const lintTrees = guardTrees(root, wt, base, cfg, mark, args.files, copy.value !== undefined ? [copy.value] : undefined, undefined, true)
    if (!lintTrees.ok) return out(lintTrees.violations)
    const proof = proveLint(root, ctx, cfg, args.plan, mark, lintTrees.value, rule, anchored, copy.value?.path)
    if (!proof.ok) return out(proof.violations)
    const listed = writable(rule.tool, rule.rule)
    const journaled = journalGuard(root, args.plan, {
      ...markOf(mark), kind: 'lint', rule, ...treesOf(root, base, lintTrees.value, args.files),
      ...(copy.value !== undefined ? { breadth: copy.value.path } : {}), spots: proof.value.spots, old: proof.value.old.length, ms: proof.value.ms,
    }, listed ? () => guardSet(root, args.plan, base, mark, rule, proof.value.old) : undefined)
    if (!journaled.ok) return out(journaled.violations)
    noteUnmeasured(root, args.plan, mark.anchor, undefined)
    ctx.out(`guard: proven ${visible(mark.anchor)} · lint ${rule.tool}:${rule.rule} — red on round ${mark.run.round}'s tree, green now`)
    const s = (n: number, one: string, many: string) => (n === 1 ? one : many)
    const set = journaled.value.ledger
    const name = `${rule.tool} ${visible(rule.rule)}`
    if (set?.tolerated !== undefined) {
      ctx.out(`tolerated: ${set.held} old ${s(set.held, 'spot', 'spots')} of ${name} — set ${set.tolerated}; the next gate writes ${rule.tool === 'eslint' ? ESLINT_LIST : BIOME_LIST}`)
      if (rule.tool === 'biome' && extendsWitness(wt) !== true) {
        ctx.out('note: biome.json does not extend ./biome.witness.json — add "./biome.witness.json" to its "extends", or Biome reads the old spots as errors; then re-prove this guard if biome.json is among its files (the edit changes them)')
      }
    }
    if (set?.over === true) ctx.out(`note: ${set.held} old spots — more than ${MAX_TOLERATED_KEYS}, so no tolerated set: lint reads them as this plan's until they are fixed`)
    if (listed && proof.value.mine > 0) {
      ctx.out(`note: ${proof.value.mine} ${s(proof.value.mine, 'spot', 'spots')} this plan added — the tolerated check reads them red until they are fixed`)
    }
    const n = proof.value.spots
    if (!listed && n > 0) {
      ctx.out(`note: ${name} has no tolerated list — lint reads its ${n} other ${s(n, 'spot', 'spots')} as this plan's until ${s(n, 'it is', 'they are')} fixed`)
    }
    return EXIT.OK
  }

  // The test guard: the command is checked before anything runs, and its template is what is granted.
  const planned = testRun(cfg, args.files)
  if (!planned.ok) return out(planned.violations)
  const trust = await ensureTrusted(root, ctx, planned.value.template)
  if (trust !== 'trusted') {
    return out([v(planned.value.source, `untrusted-${trust}`, planned.value.template,
      trust === 'blocked'
        ? (hasControl(planned.value.template) ? UNGRANTABLE : 'a trusted command — witness next names the grant to make, or set WITNESS_TRUST_CMDS=1 for automation')
        : 'trust was declined')])
  }
  // Slice 2 review I3 (b): with criteria.byFile, the attribution tree too, for a finding at a file.
  const attribute = cfg.criteria.byFile !== undefined ? anchorFile(mark.anchor) : undefined
  const trees = guardTrees(root, wt, base, cfg, mark, args.files, undefined, attribute)
  if (!trees.ok) return out(trees.violations)
  const proof = proveTest(root, ctx, cfg, args.plan, mark, trees.value, args.tests, args.files)
  if (!proof.ok) return out(proof.violations)
  const journaled = journalGuard(root, args.plan, {
    ...markOf(mark), kind: 'test', tests: [...args.tests], ...treesOf(root, base, trees.value, args.files), ms: proof.value.ms,
    ...(proof.value.attributed !== undefined ? { attributed: proof.value.attributed } : {}),
  })
  if (!journaled.ok) return out(journaled.violations)
  noteUnmeasured(root, args.plan, mark.anchor, undefined)
  ctx.out(`guard: proven ${visible(mark.anchor)} · test ${args.tests.length} named — red on round ${mark.run.round}'s tree, green now`)
  return EXIT.OK
}

const markOf = (m: GuardMark): Pick<GuardEntry, 'gate' | 'anchor' | 'round' | 'run'> =>
  ({ gate: m.gate, anchor: m.anchor, round: m.run.round, run: m.run.run_id })

// Each overlay path's blob in the current tree, and the trees run.
function treesOf(root: string, base: string, t: GuardTrees, files: readonly string[]): Pick<GuardEntry, 'files' | 'base' | 'red' | 'green'> {
  const blobs: Record<string, string> = {}
  for (const p of files) blobs[p] = entryAt(root, t.current, p)?.sha ?? ''
  return { files: blobs, base, red: t.red, green: t.green }
}

// Row 286 (§3.3, C52). Read under the guard's repo lock: the rule's old spots (the old tree's) a list can name,
// minus what merged plans' sets already allow, are the plan's tolerated set — 1–MAX_TOLERATED_KEYS keys open
// one (origin `guard`) and close the plan's earlier `guard` sets for the rule (`by: 'guard'`, the re-proof
// replaces them), none closes them alone; past the cap none opens and the earlier ones stay.
function guardSet(root: string, plan: string, base: string, mark: GuardMark, rule: { tool: ReaderTool; rule: string }, old: readonly Diagnostic[]): GuardLedger {
  const merged = applicableSets(root, plan).filter((x) => x.plan !== plan)
  const g = growth(old.filter((d) => listableAt(rule.tool, d)), allowance(root, plan, base, merged).get(ruleKey(rule.tool, rule.rule)))
  const keys = Object.keys(g.grown)
  if (keys.length > MAX_TOLERATED_KEYS) return { opens: [], closes: [], held: g.total, over: true }
  const items = ledgerItems(root)
  const closes: LedgerClosed[] = items
    .filter((i) => i.kind === 'tolerated-set' && i.state === 'open' && i.plan === plan && i.origin === 'guard' && i.tool === rule.tool && i.rule === rule.rule)
    .map((i) => ({ v: 1, t: 'ledger-closed', id: i.id, by: 'guard', plan }))
  if (keys.length === 0) return { opens: [], closes, held: 0, over: false }
  const taken = new Set(items.map((i) => i.id))
  let id = newItemId()
  while (taken.has(id)) id = newItemId()
  const subject = { spots: g.grown }
  const open: ToleratedOpen = {
    v: 1, t: 'ledger-open', id, key: itemKey({ kind: 'tolerated-set', check: 'tolerated', plan, tool: rule.tool, rule: rule.rule, subject }),
    kind: 'tolerated-set', check: 'tolerated', plan, gate: mark.gate, round: mark.run.round, run_id: mark.run.run_id,
    tool: rule.tool, rule: rule.rule, origin: 'guard', anchor: mark.anchor, subject,
  }
  return { opens: [open], closes, tolerated: id, held: g.total, over: false }
}
