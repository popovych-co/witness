// Row 275 (§4 T3, §3.5; corrections C29, C32). The `base-tests` job: drive runs the base commit's suite in
// the scratch when no shipped summary holds the base's code, and returns each spec's counts. A gate that
// read no base journals the key it lacked on its `switch-offs` check (`owes`), and the kind owes exactly
// those keys (C13's on-demand rule). Keyed per base commit and suite (`suiteKey`), so a result asked under
// an older suite command is never run; one result serves every base commit of its code tree.
//
// The kind takes the test turn (it runs a suite) and yields it to plan work (`gated: false`: no gate waits
// on it), runs in the scratch, and is boxed at a session's timeout (a session's suite fits in one). A
// result that lands never moves a stop: the next round reads it.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { shownCmd, trustedNow } from './allowlist.js'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { isId } from './dsl.js'
import type { JobKind, JobResult, JobUnit } from './jobs.js'
import { readStream } from './journal.js'
import { junitSummary, loadFailures, mergeReports, reportFiles, type JunitCounts } from './junit.js'
import { ok, refuse, type Result } from './refusal.js'
import { lastGateRun } from './rounds.js'
import { execCommand, interrupted, runnerConfig, suiteKey } from './runner.js'
import { loadCanon, type Canon } from './scan.js'
import { inScratch, type CfStep } from './scratch-checkout.js'
import { codeTree } from './snapshot.js'

export const BASE_TESTS = 'base-tests'
// A spec's entry is about 50 bytes, so the verb's 48 KiB result cap (row 257) binds first in practice; a
// result past it reads failed, then not measured.
export const MAX_BASE_SPECS = 1_000

export function baseTestsKey(commit: string, suite: string): string {
  return `${commit}.${suite}`
}

export function parseBaseTestsKey(key: string): { commit: string; suite: string } | undefined {
  const m = /^([0-9a-f]{40}|[0-9a-f]{64})\.([0-9a-f]{12})$/.exec(key)
  return m ? { commit: m[1]!, suite: m[2]! } : undefined
}

export interface BaseTestsResult extends JunitCounts { commit: string; code: string; tree: string; specs: Record<string, JunitCounts> }

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0
const COUNT_KEYS = ['passed', 'failed', 'skipped']

// One count triple, exactly; anything else is undefined.
export function junitCounts(x: unknown): JunitCounts | undefined {
  if (!isObj(x) || Object.keys(x).length !== 3 || !COUNT_KEYS.every((k) => isCount(x[k]))) return undefined
  return { passed: x.passed as number, failed: x.failed as number, skipped: x.skipped as number }
}

// A per-spec record of count triples, each key a canon id, at most `max` of them; anything else is undefined.
export function specCounts(x: unknown, max = MAX_BASE_SPECS): Record<string, JunitCounts> | undefined {
  if (!isObj(x)) return undefined
  const entries = Object.entries(x)
  if (entries.length > max) return undefined
  const out: Record<string, JunitCounts> = {}
  for (const [id, raw] of entries) {
    const counts = junitCounts(raw)
    if (!isId(id) || counts === undefined) return undefined
    out[id] = counts
  }
  return out
}

// A shard's result as this kind writes it, exactly; anything else is malformed (undefined).
export function baseTestsResult(x: unknown): BaseTestsResult | undefined {
  if (!isObj(x)) return undefined
  const allowed = new Set([...COUNT_KEYS, 'specs', 'commit', 'code', 'tree'])
  if (Object.keys(x).length !== allowed.size || Object.keys(x).some((k) => !allowed.has(k))) return undefined
  if (!COUNT_KEYS.every((k) => isCount(x[k]))) return undefined
  if (![x.commit, x.code, x.tree].every((s) => typeof s === 'string' && SHA_RE.test(s))) return undefined
  const specs = specCounts(x.specs)
  if (specs === undefined) return undefined
  return {
    passed: x.passed as number, failed: x.failed as number, skipped: x.skipped as number, specs,
    commit: x.commit as string, code: x.code as string, tree: x.tree as string,
  }
}

const fullSuiteOf = (cfg: Config) => {
  const rc = runnerConfig(cfg)
  return rc.ok && rc.value.mode === 'full-suite' ? rc.value : undefined
}

// The keys a plan's last implement and last ship gate-runs left on their `switch-offs` check's `owes`,
// of this kind, whose key parses with today's suite.
function owesOf(root: string, plan: string, suite: string): string[] {
  const entries = readStream(root, plan)
  const out: string[] = []
  for (const gate of ['implement', 'ship']) {
    const run = lastGateRun(entries, gate)
    const checks: unknown[] = Array.isArray(run?.checks) ? run.checks : []
    const offs = checks.find((c): c is Obj => isObj(c) && c.name === 'switch-offs')
    const owes: unknown[] = Array.isArray(offs?.owes) ? offs.owes : []
    for (const o of owes) {
      if (!isObj(o) || o.kind !== BASE_TESTS || typeof o.key !== 'string') continue
      if (parseBaseTestsKey(o.key)?.suite === suite) out.push(o.key)
    }
  }
  return out
}

function owed(root: string, cfg: Config, canon: Canon): JobUnit[] {
  const rc = fullSuiteOf(cfg)
  if (rc === undefined) return []
  const suite = suiteKey(rc)
  const seen = new Set<string>()
  const out: JobUnit[] = []
  for (const doc of canon.docs) {
    if (doc.meta.type !== 'plan' || doc.meta.status !== 'in-progress' || typeof doc.meta.id !== 'string') continue
    for (const key of owesOf(root, doc.meta.id, suite)) {
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind: BASE_TESTS, key, shards: 1 })
    }
  }
  return out
}

const cut = (s: string): string => s.slice(0, 200)
type Counts = Omit<BaseTestsResult, 'commit' | 'code' | 'tree'>

function run(root: string, ctx: Ctx, cfg: Config, unit: JobUnit): JobResult {
  const rc = fullSuiteOf(cfg)
  const parsed = parseBaseTestsKey(unit.key)
  if (rc === undefined || parsed === undefined || parsed.suite !== suiteKey(rc)) {
    return { outcome: 'failed', why: 'the suite changed since its gate asked — the next gate asks again' }
  }
  const cmd = { cmd: rc.suiteCmd, source: 'ship.test' }
  if (!trustedNow(root, ctx.env, cmd.cmd)) return { outcome: 'failed', why: cut(`untrusted: ${shownCmd(cmd)}`) }
  const specIds = loadCanon(root).docs.filter((d) => d.meta.type === 'spec').map((d) => String(d.meta.id))
  // The step (row 258's contract): the suite on the base, its report parsed, its load failures returned.
  const step = (dir: string): Result<CfStep<Counts>> => {
    for (const f of reportFiles(dir, rc.reportGlob)) rmSync(join(dir, f))
    const r = execCommand(dir, ctx, rc.suiteCmd, { turn: false })
    if (r.signal !== undefined) return refuse([{ ...interrupted(r.signal), field: 'ship.test' }])
    const tests = mergeReports(dir, rc.reportGlob)
    if (!tests.ok) return tests
    return ok({ value: junitSummary(tests.value, specIds), load: loadFailures(tests.value) })
  }
  const r = inScratch(root, ctx, cfg, { tree: parsed.commit }, step)
  if (!r.ok) return { outcome: 'failed', why: cut(`${r.violations[0]!.rule}: ${r.violations[0]!.got}`) }
  const code = codeTree(root, parsed.commit)
  if (code === undefined) return { outcome: 'failed', why: "the base's code tree could not be read" }
  return { outcome: 'done', result: { ...r.value.value, commit: parsed.commit, code, tree: r.value.record.tree } }
}

export const baseTestsKind: JobKind = {
  kind: BASE_TESTS, turn: true, gated: false, scratch: true,
  commands: (cfg) => cfg.ship.test !== undefined ? [{ cmd: cfg.ship.test, source: 'ship.test' }] : [],
  boxMs: (cfg) => cfg.drive.sessionTimeoutMs,
  owed,
  run: (root, ctx, cfg, unit) => run(root, ctx, cfg, unit),
}

