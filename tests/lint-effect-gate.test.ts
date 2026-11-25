// Row 277 (§4 T3, the effect layer's lint half). A plan that changes a check definition the base holds
// gains the `definitions` check at implement and ship: drive measures the base's definitions over its
// tree (the lint-effect job); while it does, the round waits (withholding); with no drive it reads not
// checked and the key stays owed.
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { grantCommands } from '../src/allowlist.js'
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
import { CLEAN_THREE, fakeCtx, fakeLint, fakeScenario, fixtureEnv, gateEnv, patchConfig, putVerdict, shippableRepo } from './helpers.js'

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
  const gate = (name = 'implement') =>
    runGate(fakeCtx(repo.root, { env: gateEnv(scenario), out: (l) => printed.push(l) }), name, planId, PLAIN)
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
