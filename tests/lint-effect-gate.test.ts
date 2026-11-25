// Row 277 (§4 T3, the effect layer's lint half). A plan that changes a check definition the base holds
// gains the `definitions` check at implement and ship: drive measures the base's definitions over its
// tree (the lint-effect job); while it does, the round waits (withholding); with no drive it reads not
// checked and the key stays owed.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { grantCommands } from '../src/allowlist.js'
import type { Ctx } from '../src/cli.js'
import { openItems } from '../src/ledger.js'
import { run as decide } from '../src/verbs/decide.js'
import { run as dismiss } from '../src/verbs/dismiss.js'
import { baseWait } from '../src/base-lint.js'
import { loadConfig, type Config } from '../src/config.js'
import { restorable, restoredName } from '../src/definitions.js'
import { acquireDriveLock } from '../src/drive-presence.js'
import { diffBase } from '../src/evidence.js'
import { planChangeSet } from '../src/change-set.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { journalShard } from '../src/jobs.js'
import { loadCanon } from '../src/scan.js'
import { actFacts } from '../src/verbs/next.js'
import { readStream } from '../src/journal.js'
import { LINT_EFFECT, definitionsCheck, lintEffectKind, loosenedOffs, type LintEffectResult } from '../src/lint-effect.js'
import type { GateCheck, GateRunEntry } from '../src/rounds.js'
import {
  CLEAN_THREE, approve, callFor, fakeCtx, fakeLint, fakeScenario, fixtureEnv, gateEnv, patchConfig, putVerdict, runScript, seededRepo,
  shippableRepo, stampLive, trustConfig, writePlan, writeSpec,
} from './helpers.js'
import { DEFAULT_DEFINITIONS } from '../src/definitions.js'
import { worktreePath } from '../src/worktree.js'

const PLAIN = { fresh: false, manual: false }
const cfgOf = (root: string): Config => { const r = loadConfig(root); if (!r.ok) throw new Error('config'); return r.value }
const HIDDEN = 'export const x = "BAD"\n'

// A shippable plan with the fake lint as `ship.lint`'s biome part and its SARIF reader (committed on
// main, granted). The plan's worktree carries fake-lint.mjs; `hide` adds a tracked src/hidden.ts holding
// BAD and lists it in the plan's .gitignore, so the plan's own lint passes and the base's would not.
async function bench(opts: { hide?: boolean; autonomy?: boolean } = {}) {
  const { repo, wt, planId } = await shippableRepo()
  const cmd = fakeLint(repo)
  writeFileSync(join(wt, 'fake-lint.mjs'), readFileSync(join(repo.root, 'fake-lint.mjs')))
  rmSync(join(repo.root, 'fake-lint.mjs'))
  patchConfig(repo, { ship: { lint: { biome: cmd.check } }, readers: { biome: cmd.sarif }, ...(opts.autonomy === true ? { autonomy: 'on' } : {}) })
  repo.git('add', 'witness.config.yaml'); repo.git('commit', '-q', '-m', 'lint')
  grantCommands(repo.root, [cmd.check, cmd.sarif])
  const anchors = ['fake-lint.mjs']
  if (opts.hide !== false) {
    writeFileSync(join(wt, 'src/hidden.ts'), HIDDEN)
    writeFileSync(join(wt, '.gitignore'), `${readFileSync(join(wt, '.gitignore'), 'utf8')}src/hidden.ts\n`)
    anchors.push('src/hidden.ts', '.gitignore')
  }
  execFileSync('git', ['add', '-A'], { cwd: wt })
  if (opts.hide !== false) execFileSync('git', ['add', '-f', 'src/hidden.ts'], { cwd: wt })
  execFileSync('git', ['commit', '-q', '-m', 'the plan'], { cwd: wt })
  const scenario = fakeScenario()
  putVerdict(scenario, { ...CLEAN_THREE, coverage: [...CLEAN_THREE.coverage, ...anchors.map((anchor) => ({ anchor, note: 'read' }))] })
  const printed: string[] = []
  const gate = (name = 'implement', env: Record<string, string> = {}) =>
    runGate(fakeCtx(repo.root, { env: gateEnv(scenario, env), out: (l) => printed.push(l) }), name, planId, PLAIN)
  const runs = () => readStream(repo.root, planId).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]
  const lastRun = () => runs().at(-1)!
  const check = (name: string): GateCheck => lastRun().checks.find((c) => c.name === name)!
  // Runs the job on the key the last round owes, and journals its shard, as drive would.
  const land = () => {
    const key = check('definitions').owes![0]!.key
    const done = lintEffectKind.run(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), cfgOf(repo.root), { kind: LINT_EFFECT, key, shards: 1 }, 1)
    if (done.outcome !== 'done') throw new Error(`job failed: ${done.why}`)
    const r = journalShard(repo.root, { kind: LINT_EFFECT, key, shard: 1, of: 1, ms: 1, ...done })
    if (!r.ok) throw new Error(JSON.stringify(r.violations))
    return key
  }
  const inputs = () => {
    const cfg = cfgOf(repo.root)
    const base = diffBase(wt, cfg)
    if (!base.ok) throw new Error('base')
    const files = planChangeSet(wt, base.value)
    return { cfg, base: base.value, files, restored: restorable(repo.root, wt, base.value, files, cfg.checks.definitions) }
  }
  return { repo, wt, planId, scenario, gate, runs, lastRun, check, land, inputs, printed: () => printed.join('\n') }
}

describe('the definitions check (row 277)', () => {
  it('a plan that changes no definition the base holds runs no definitions check (Review Focus 1)', async () => {
    const b = await bench({ hide: false })
    expect(await b.gate()).toBe(0)
    expect(b.lastRun().checks.map((c) => c.name)).not.toContain('definitions')
  }, 240_000)

  it('with no drive the check reads not checked, green, and owes its key (row 277)', async () => {
    const b = await bench()
    await b.gate()
    expect(b.check('definitions')).toMatchObject({
      ok: true, owes: [{ kind: 'lint-effect', key: expect.stringMatching(/^[0-9a-f]{40}\.[0-9a-f]{40}\.[0-9a-f]{12}$/) }],
      lint_effect: { read: 'not-checked', changed: ['.gitignore'], why: 'no drive runs jobs in this repo' },
      detail: 'not checked — no drive runs jobs in this repo (.gitignore)',
    })
    expect(b.lastRun().checks.map((c) => c.name).indexOf('definitions')).toBe(b.lastRun().checks.map((c) => c.name).indexOf('lint') + 1)
  }, 240_000)

  it('while drive measures it the check is red: a checks-only round, its key owed (row 277)', async () => {
    const b = await bench()
    const held = acquireDriveLock(b.repo.root, {})
    if (!held.ok) throw new Error('drive lock')
    try {
      expect(await b.gate()).toBe(1)
      expect(b.lastRun()).toMatchObject({ checks_only: true, outcome: 'stopped' })
      expect(b.lastRun().checks.map((c) => c.name)).toEqual(['markers', 'lint', 'definitions'])
      expect(b.check('definitions')).toMatchObject({ ok: false, owes: [{ kind: 'lint-effect' }],
        detail: "drive lints this tree under the base's check definitions (.gitignore) — the gate runs again once it lands" })
      expect(b.check('definitions').lint_effect).toBeUndefined()
    } finally { held.value() }
  }, 240_000)

  it('the landed effect reads measured, and hands on its hidden diagnostic (row 277)', async () => {
    const b = await bench()
    const held = acquireDriveLock(b.repo.root, {})
    if (!held.ok) throw new Error('drive lock')
    try {
      await b.gate()
      b.land()
      await b.gate()
      expect(b.check('definitions')).toMatchObject({ ok: true, lint_effect: { read: 'measured', changed: ['.gitignore'] },
        detail: "the base's check definitions measured over this tree: .gitignore" })
      expect(b.check('definitions').owes).toBeUndefined()
      const { cfg, base, files, restored } = b.inputs()
      const { effect } = definitionsCheck(b.repo.root, b.wt, cfg, base, b.planId, files, restored)
      expect(effect).toMatchObject({ read: 'measured', changed: ['.gitignore'], unread: [],
        offs: [{ kind: 'loosened', tool: 'biome', rule: 'lint/test/noBad', file: 'src/hidden.ts', line: 1, count: 1 }] })
    } finally { held.value() }
  }, 240_000)

  it('scratch runs off: not checked, and still owed (row 277)', async () => {
    const b = await bench()
    const { cfg, base, files, restored } = b.inputs()
    const { check, effect } = definitionsCheck(b.repo.root, b.wt, { ...cfg, scratch: { prepare: undefined } }, base, b.planId, files, restored)
    expect(check).toMatchObject({ name: 'definitions', ok: true, owes: [{ kind: 'lint-effect' }],
      lint_effect: { read: 'not-checked', changed: ['.gitignore'], why: 'scratch runs are off — scratch.prepare is not set' },
      detail: 'not checked — scratch runs are off — scratch.prepare is not set (.gitignore)' })
    expect(effect).toMatchObject({ read: 'not-checked', changed: ['.gitignore'] })
  }, 240_000)

  it('with no lint part and no reader set, nothing is measured: not checked, nothing owed or pinned (slice 2 review I2)', async () => {
    const b = await bench()
    const { cfg, base, files, restored } = b.inputs()
    const before = b.repo.git('for-each-ref', 'refs/witness/cf/')
    const { check, effect } = definitionsCheck(b.repo.root, b.wt, { ...cfg, ship: { ...cfg.ship, lint: undefined }, readers: {} }, base, b.planId, files, restored)
    expect(check).toMatchObject({ ok: true, lint_effect: { read: 'not-checked', changed: ['.gitignore'], why: 'no lint part or reader is set' },
      detail: 'not checked — no lint part or reader is set (.gitignore)' })
    expect(check.owes).toBeUndefined()
    expect(effect).toMatchObject({ read: 'not-checked' })
    expect(b.repo.git('for-each-ref', 'refs/witness/cf/')).toBe(before)
  }, 240_000)

  it('a definition git cannot read reads not checked, saying so, with nothing owed (row 277)', async () => {
    const b = await bench()
    const { cfg, base, files } = b.inputs()
    const refused = { ok: false as const, violations: [{ field: 'definitions', rule: 'definition-unreadable', got: 'fatal: bad object', want: 'x' }] }
    const { check } = definitionsCheck(b.repo.root, b.wt, cfg, base, b.planId, files, refused)
    expect(check).toMatchObject({ ok: true, lint_effect: { read: 'not-checked', changed: [] },
      detail: 'not checked — the check definitions could not be read — fatal: bad object' })
    expect(check.owes).toBeUndefined()
  }, 240_000)

  it('a flipped part its own reader explains is no hit; an unbound flipped part is, keyed by its definitions (C34)', async () => {
    const b = await bench({ hide: false })
    patchConfig(b.repo, { ship: { lint: { biome: 'node fake-lint.mjs check', lint: 'pnpm lint' } }, readers: { biome: 'node fake-lint.mjs sarif' } })
    const cfg = cfgOf(b.repo.root)
    const hit = { tool: 'biome' as const, rule: 'lint/test/noBad', file: 'src/hidden.ts', line: 1, key: 'a'.repeat(16), count: 1 }
    const result = (hits: LintEffectResult['hits'], parts: LintEffectResult['parts']): LintEffectResult =>
      ({ plan: 'a'.repeat(40), effect: 'b'.repeat(40), parts, readers: [{ tool: 'biome' }], hits })
    const defs = { '.gitignore': 'c'.repeat(40) }
    expect(loosenedOffs(cfg, result([hit], [{ part: 'biome', plan: 0, effect: 1 }]), defs))
      .toEqual([{ kind: 'loosened', key: hit.key, count: 1, tool: 'biome', rule: hit.rule, file: hit.file, line: 1 }])
    const unbound = loosenedOffs(cfg, result([], [{ part: 'biome', plan: 0, effect: 0 }, { part: 'lint', plan: 0, effect: 1 }]), defs)
    expect(unbound).toEqual([{ kind: 'loosened', key: expect.stringMatching(/^[0-9a-f]{16}$/), count: 1, part: 'lint', defs }])
    const other = loosenedOffs(cfg, result([], [{ part: 'lint', plan: 0, effect: 1 }]), { '.gitignore': 'd'.repeat(40) })
    expect(other[0]!.key).not.toBe(unbound[0]!.key)
    // a bound part whose reader named nothing hidden (unread, say) still stands as a loosened part
    expect(loosenedOffs(cfg, result([], [{ part: 'biome', plan: 0, effect: 1 }]), defs)).toMatchObject([{ kind: 'loosened', part: 'biome' }])
    // a part red on both sides, or green on the effect tree, is nothing
    expect(loosenedOffs(cfg, result([], [{ part: 'lint', plan: 1, effect: 1 }, { part: 'biome', plan: 1, effect: 0 }]), defs)).toEqual([])
  }, 240_000)

  it("the restored names: ten through visible(), then how many more (row 277)", async () => {
    const b = await bench()
    const { cfg, base, files, restored } = b.inputs()
    const many = Array.from({ length: 12 }, (_, i) => ({ path: `p${i}/.gitignore`, how: 'base' as const, held: 'e'.repeat(40) }))
    const { check } = definitionsCheck(b.repo.root, b.wt, { ...cfg, scratch: { prepare: undefined } }, base, b.planId, files,
      { ok: true, value: [...(restored.ok ? restored.value : []), ...many] })
    expect(check.detail).toMatch(/\(\.gitignore, p0\/\.gitignore, .*p8\/\.gitignore and 3 more\)$/)
    expect(restoredName(many[0]!)).toBe('p0/.gitignore')
  }, 240_000)
})

const decided = (root: string, planId: string) => readStream(root, planId).some((e) => e.t === 'human-decision')
// Holds the drive lock for `fn`, as a running drive would.
async function underDrive<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const held = acquireDriveLock(root, {})
  if (!held.ok) throw new Error('drive lock')
  try { return await fn() } finally { held.value() }
}

describe('the wait on the lint effect (row 277)', () => {
  it("a checks-only round red only for a pending effect is drive's: the gate names the wait and no decision is made (row 277)", async () => {
    const b = await bench({ autonomy: true })
    await underDrive(b.repo.root, async () => {
      await b.gate()
      expect(b.printed()).toContain(`awaits-drive: implement ${b.planId} — drive lints this tree under the base's check definitions first · the gate runs again once it lands`)
      expect(baseWait(b.repo.root, b.lastRun())).toEqual({ waiting: ['definitions'], landed: [], red: [] })
      expect(decided(b.repo.root, b.planId)).toBe(false)
    })
  }, 240_000)

  it('once the effect lands the stop is stale, and next routes the re-gate (row 277)', async () => {
    const b = await bench({ autonomy: true })
    await underDrive(b.repo.root, async () => {
      await b.gate()
      b.land()
      expect(baseWait(b.repo.root, b.lastRun())).toEqual({ waiting: [], landed: ['definitions'], red: [] })
      const entries = readStream(b.repo.root, b.planId)
      expect(actFacts(b.repo.root, cfgOf(b.repo.root), loadCanon(b.repo.root), 'implement', b.planId, entries, {}).checksMoved).toBe(true)
      await b.gate()
      expect(b.lastRun().checks_only).toBeUndefined()
      expect(b.check('definitions')).toMatchObject({ ok: true, lint_effect: { read: 'measured' } })
    })
  }, 240_000)

  it('a key the config no longer gives, scratch runs turned off, or two strikes end the wait: the re-gate reads it (row 277)', async () => {
    const b = await bench({ autonomy: true })
    await underDrive(b.repo.root, async () => {
      await b.gate()
      const red = b.lastRun()
      expect(baseWait(b.repo.root, red).waiting).toEqual(['definitions'])
      const key = b.check('definitions').owes![0]!.key
      // the commands changed: the config no longer gives the key
      const was = b.repo.read('witness.config.yaml')
      patchConfig(b.repo, { readers: { biome: 'node fake-lint.mjs sarif --other' } })
      expect(baseWait(b.repo.root, red)).toEqual({ waiting: [], landed: ['definitions'], red: [] })
      // scratch runs off (an older file that never set scratch.prepare)
      b.repo.write('witness.config.yaml', was)
      patchConfig(b.repo, { schema: 3, scratch: undefined, checks: undefined })
      expect(loadConfig(b.repo.root)).toMatchObject({ ok: true, value: { scratch: { prepare: undefined } } })
      expect(baseWait(b.repo.root, red).landed).toEqual(['definitions'])
      // two strikes
      b.repo.write('witness.config.yaml', was)
      expect(baseWait(b.repo.root, red).waiting).toEqual(['definitions'])
      for (const n of [1, 2]) journalShard(b.repo.root, { kind: LINT_EFFECT, key, shard: 1, of: 1, ms: n, outcome: 'failed', why: 'boom' })
      expect(baseWait(b.repo.root, red).landed).toEqual(['definitions'])
    })
  }, 240_000)

  it('a round red for lint and for nothing else still waits as row 267 has it (row 267 unchanged)', async () => {
    const b = await bench({ hide: false })
    const run = { ...b.runs()[0] ?? {}, artifact: b.planId, checks_only: true as const,
      checks: [{ name: 'markers', ok: true }, { name: 'lint', ok: false, parts: [{ part: 'biome', state: 'red' as const }] }] } as unknown as GateRunEntry
    expect(baseWait(b.repo.root, run)).toEqual({ waiting: [], landed: [], red: ['biome'] })
    // a definitions check that is not last, or is green, waits on nothing
    const green = { ...run, checks: [{ name: 'markers', ok: true }, { name: 'definitions', ok: true, owes: [{ kind: LINT_EFFECT, key: 'k' }] }] } as unknown as GateRunEntry
    expect(baseWait(b.repo.root, green)).toEqual({ waiting: [], landed: [], red: [] })
  }, 240_000)
})

// A plan on a seeded repo whose main holds `main` (beside fake-lint.mjs and run-script.mjs), with `ship.lint`
// from `lint`, the biome reader when `reader`, and `extra` definitions beside the default list. The plan's
// worktree writes `plan` (a `force` path added past its .gitignore) and commits.
async function planRepo(o: {
  main: Record<string, string>; plan: Record<string, string>; force?: string[]; reader?: boolean; extra?: string[]
  lint: (cmd: ReturnType<typeof fakeLint>, script: string) => Record<string, string>
}) {
  const repo = await seededRepo()
  const cmd = fakeLint(repo)
  const script = runScript(repo)
  for (const [f, text] of Object.entries(o.main)) repo.write(f, text)
  patchConfig(repo, { autonomy: 'on', ship: { test: 'true', lint: o.lint(cmd, script) }, ...(o.reader === true ? { readers: { biome: cmd.sarif } } : {}),
    checks: { definitions: [...DEFAULT_DEFINITIONS, ...(o.extra ?? [])] } })
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'base')
  trustConfig(repo)
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  // scaffoldingPlan's shape: the spec's first plan done and the spec live, then a plan of one scaffolding
  // step, closed at once — the gate judges the tree, not evidence.
  await writePlan(repo, 'auth-refresh-plan-1')
  repo.flipStatus('auth-refresh-plan-1', 'done')
  stampLive(repo, 'auth-refresh')
  const planId = 'auth-refresh-plan-2'
  const w = await writePlan(repo, planId, { steps: [{ id: 's1', title: 'tidy', scaffolding: true }] }, '## Step: s1\nTidy.\n')
  if (w.code !== 0) throw new Error(`write: ${w.stdout}${w.stderr}`)
  repo.flipStatus(planId, 'approved')
  const started = await repo.cli(['start', planId])
  if (started.code !== 0) throw new Error(`start: ${started.stdout}${started.stderr}`)
  const wt = worktreePath(repo.root, planId)
  const closed = await repo.cli(['step-close', planId, '--step', 's1'], { cwd: wt })
  if (closed.code !== 0) throw new Error(`step-close: ${closed.stdout}${closed.stderr}`)
  for (const [f, text] of Object.entries(o.plan)) {
    mkdirSync(dirname(join(wt, f)), { recursive: true })
    writeFileSync(join(wt, f), text === '.gitignore+' ? `${readFileSync(join(wt, '.gitignore'), 'utf8')}src/hidden.ts\n` : text)
  }
  execFileSync('git', ['add', '-A'], { cwd: wt })
  if ((o.force ?? []).length > 0) execFileSync('git', ['add', '-f', ...o.force!], { cwd: wt })
  execFileSync('git', ['commit', '-q', '-m', 'the plan'], { cwd: wt })
  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: Object.keys(o.plan).map((anchor) => ({ anchor, note: 'read' })), findings: [] })
  const said: string[] = []
  const gate = (name = 'implement') =>
    runGate(fakeCtx(repo.root, { env: gateEnv(scenario), out: (l) => said.push(l), err: (l) => said.push(l) }), name, planId, PLAIN)
  const lastRun = () => {
    const run = (readStream(repo.root, planId).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]).at(-1)
    if (run === undefined) throw new Error(`no gate-run: ${said.join('\n')}`)
    return run
  }
  const check = (name: string): GateCheck => lastRun().checks.find((c) => c.name === name)!
  const land = () => {
    const key = check('definitions').owes![0]!.key
    const done = lintEffectKind.run(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), cfgOf(repo.root), { kind: LINT_EFFECT, key, shards: 1 }, 1)
    if (done.outcome !== 'done') throw new Error(`job failed: ${done.why}`)
    const r = journalShard(repo.root, { kind: LINT_EFFECT, key, shard: 1, of: 1, ms: 1, ...done })
    if (!r.ok) throw new Error(JSON.stringify(r.violations))
  }
  // Under drive: the checks-only round, the job landed, the judged round.
  const measure = (name = 'implement') => underDrive(repo.root, async () => { await gate(name); land(); await gate(name) })
  return { repo, wt, planId, scenario, gate, lastRun, check, measure }
}

describe('what a plan\'s check definitions hide is a switch-off (row 277)', () => {
  it('`.gitignore`-hiding a file is caught (§4 T3)', async () => {
    const b = await bench({ autonomy: true })
    await underDrive(b.repo.root, async () => { await b.gate(); b.land(); await b.gate() })
    const off = b.check('switch-offs')
    expect(off.ok).toBe(false)
    expect(off.offs).toContainEqual(expect.objectContaining({ kind: 'loosened', tool: 'biome', rule: 'lint/test/noBad', file: 'src/hidden.ts', line: 1, count: 1 }))
    expect(off.detail).toContain('loosened: src/hidden.ts:1 biome lint/test/noBad')
    // the reviewers are told each loosened hit and the definitions the plan changed
    const asked = readFileSync(join(callFor(b.scenario, 'code-reviewer')!, 'stdin'), 'utf8')
    expect(asked).toContain("- src/hidden.ts:1 — biome lint/test/noBad, hidden by the plan's check definitions")
    expect(asked).toContain('- check definitions the plan changed: .gitignore')
    // ship reads the same: its trees key alike, so the landed result serves it at once
    await b.gate('ship')
    expect(b.lastRun().gate).toBe('ship')
    expect(b.check('definitions')).toMatchObject({ ok: true, lint_effect: { read: 'measured' } })
    expect(b.check('switch-offs').offs).toContainEqual(expect.objectContaining({ kind: 'loosened', file: 'src/hidden.ts' }))
  }, 240_000)

  it('a lint script neutered in package.json is caught as its part (row 277)', async () => {
    const b = await planRepo({
      main: { 'package.json': '{\n  "name": "x",\n  "scripts": {\n    "lint": "node fake-lint.mjs check"\n  }\n}\n' },
      plan: { 'package.json': '{\n  "name": "x",\n  "scripts": {\n    "lint": "true"\n  }\n}\n', 'src/bad.ts': 'export const y = "BAD"\n' },
      lint: (_cmd, script) => ({ lint: `${script} lint` }),
    })
    await b.measure()
    expect(b.check('switch-offs').offs).toContainEqual(expect.objectContaining({ kind: 'loosened', part: 'lint', count: 1,
      defs: { 'package.json#scripts': expect.stringMatching(/^json:[0-9a-f]{16}$/) } }))
    expect(b.check('switch-offs').detail).toContain("lint passes only under the plan's check definitions")
  }, 240_000)

  it("a rule the plan's config turns off hides its new spot (row 277)", async () => {
    const b = await planRepo({
      main: { 'fake-lint.json': '{}\n' }, extra: ['fake-lint.json'], reader: true,
      plan: { 'fake-lint.json': '{"skip": ["src/new.ts"]}\n', 'src/new.ts': 'export const z = "BAD"\n' },
      lint: (cmd) => ({ biome: cmd.check }),
    })
    await b.measure()
    expect(b.check('switch-offs').offs).toEqual([expect.objectContaining({ kind: 'loosened', tool: 'biome', file: 'src/new.ts', line: 1 })])
  }, 240_000)

  it('the definitions check names an unread reader, and its flipped part stands (Review Focus 5)', async () => {
    const b = await planRepo({
      main: { 'fake-lint.json': '{"report": "garbage"}\n' }, extra: ['fake-lint.json'], reader: true,
      plan: { 'fake-lint.json': '{}\n', 'src/hidden.ts': 'export const x = "BAD"\n', '.gitignore': '.gitignore+' }, force: ['src/hidden.ts'],
      lint: (cmd) => ({ biome: cmd.check }),
    })
    await b.measure()
    expect(b.check('definitions').detail).toContain(" · biome could not be read under the base's definitions — reader-unread")
    expect(b.check('definitions').lint_effect).toEqual({ read: 'measured', changed: ['fake-lint.json', '.gitignore'].sort(), unread: ['biome'] })
    expect(b.check('switch-offs').offs).toEqual([expect.objectContaining({ kind: 'loosened', part: 'biome', count: 1 })])
  }, 240_000)
})

describe('what a plan\'s check definitions hide is booked (row 278)', () => {
  // The hiding plan measured: a judged implement round red only for its hidden spot.
  async function hiddenStop() {
    const b = await bench()
    await underDrive(b.repo.root, async () => { await b.gate(); b.land(); await b.gate() })
    expect(b.check('switch-offs')).toMatchObject({ ok: false })
    return b
  }

  it('--book switch-offs books a loosened round: one item per hidden rule; the re-gate applies it and passes (row 278)', async () => {
    const b = await hiddenStop()
    const hitKey = b.check('switch-offs').offs![0]!.key
    const r = await b.repo.cli(['decide', 'implement', b.planId, '--book', 'switch-offs'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/^booked: l-[0-9a-f]{8} — switch-offs · biome lint\/test\/noBad hidden by check definitions$/m)
    expect(openItems(b.repo.root, { plan: b.planId })).toEqual([expect.objectContaining({ kind: 'booked-loosened', check: 'switch-offs',
      tool: 'biome', rule: 'lint/test/noBad', subject: { hidden: { [hitKey]: { file: 'src/hidden.ts', copies: 1 } } } })])
    expect(await b.gate()).toBe(0)
    expect(b.check('switch-offs')).toMatchObject({ ok: true, offs: [expect.objectContaining({ kind: 'loosened', booked: 1 })] })
    // status names the fourth kind
    expect((await b.repo.cli(['status'])).stdout).toContain('biome lint/test/noBad hidden, 1 spot')
  }, 300_000)

  it('a further hidden spot beyond the booked copies stays red, and books a fresh item (row 278)', async () => {
    const b = await hiddenStop()
    expect((await b.repo.cli(['decide', 'implement', b.planId, '--book', 'switch-offs'])).code).toBe(0)
    writeFileSync(join(b.wt, 'src/hidden.ts'), `${HIDDEN}export const y = "BAD too"\n`)
    await underDrive(b.repo.root, async () => { await b.gate(); b.land(); await b.gate() })
    const offs = b.check('switch-offs').offs!
    expect(b.check('switch-offs').ok).toBe(false)
    expect(offs.map((o) => [o.kind === 'loosened' ? o.line : 0, o.booked ?? 0])).toEqual([[1, 1], [2, 0]])
    expect((await b.repo.cli(['decide', 'implement', b.planId, '--book', 'switch-offs'])).code).toBe(0)
    expect(openItems(b.repo.root, { plan: b.planId })).toHaveLength(2)
  }, 300_000)

  it('the terminal question and the dismissal name the fourth kind (row 278)', async () => {
    const b = await hiddenStop()
    patchConfig(b.repo, { autonomy: 'on' }); b.repo.git('add', 'witness.config.yaml'); b.repo.git('commit', '-q', '-m', 'autonomy')
    const asked: string[] = []
    const at = (answer: string): Ctx => ({ ...fakeCtx(b.repo.root, { tty: true }), ask: async (q) => { asked.push(q); return answer } })
    expect(await decide(at('y'), ['implement', b.planId, '--book', 'switch-offs'])).toBe(0)
    expect(asked[0]).toBe(`book switch-offs for implement ${b.planId}:\n  biome lint/test/noBad: 1 spot in src/hidden.ts\nbook? an item stays open until main no longer holds it [y/N]`)
    const id = openItems(b.repo.root, { plan: b.planId })[0]!.id
    expect(await dismiss(at('n'), ['ledger', '--item', id, '--cause', 'rule-retired', '--note', 'the rule went'])).toBe(2)
    expect(asked[1]).toContain(`dismiss ${id} — switch-offs · biome lint/test/noBad hidden by check definitions · ${b.planId}: rule-retired`)
  }, 300_000)
})

describe('the judge books what a plan\'s check definitions hide (row 278)', () => {
  it('under autonomy the arbiter books a loosening-only stop in-process, from facts alone (row 278)', async () => {
    const b = await bench({ autonomy: true })
    putVerdict(b.scenario, { choice: 2, reason: 'the hidden file is generated and the ignore entry is the plan\'s scope' }, 'arbiter')
    await underDrive(b.repo.root, async () => {
      await b.gate('implement', { WITNESS_DRIVE: b.planId })
      b.land()
      await b.gate('implement', { WITNESS_DRIVE: b.planId })
    })
    const decided = readStream(b.repo.root, b.planId).filter((e) => e.t === 'human-decision').at(-1)
    expect(decided).toMatchObject({ decision: 'book', selected: 'arbiter', rule: 'waivable', book: { check: 'switch-offs' } })
    expect(openItems(b.repo.root, { plan: b.planId })).toEqual([expect.objectContaining({ kind: 'booked-loosened', tool: 'biome', rule: 'lint/test/noBad' })])
    const asked = readFileSync(join(callFor(b.scenario, 'arbiter')!, 'stdin'), 'utf8')
    expect(asked).toContain(`2. witness decide implement ${b.planId} --book switch-offs`)
    expect(asked).toContain("switch-offs: FAILED · biome: 1 diagnostic the plan's check definitions hide (1 rule)")
    expect(asked).not.toContain('src/hidden.ts')
    expect(asked).not.toContain('noBad')
  }, 300_000)
})
