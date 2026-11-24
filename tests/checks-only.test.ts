// Row 264 (§3.2). A withholding check that is red ends a code gate's round before any lens runs: a
// checks-only round — no reviewer, no verdicts, no debt discharged — that resumes only on identical
// checks and runs fresh once they are green.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { grantCommands } from '../src/allowlist.js'
import { openDeferrals } from '../src/deferral.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import { baseLintKind } from '../src/base-lint.js'
import { loadConfig, type Config } from '../src/config.js'
import { acquireDriveLock } from '../src/drive-presence.js'
import { loadCanon } from '../src/scan.js'
import { BASE_LINT } from '../src/base-lint.js'
import { journalShard } from '../src/jobs.js'
import { settleStop } from '../src/settle.js'
import type { DecisionEntry } from '../src/rounds.js'
import type { GateRunEntry } from '../src/rounds.js'
import { TOKEN_FIXED, callCount, fakeCtx, fakeScenario, fixtureEnv, gateEnv, patchConfig, putVerdict, shippableRepo, type TestRepo } from './helpers.js'

// vitest-single lands 4 files in the worktree diff — coverage-minimum needs an anchor for each.
const CLEAN = {
  coverage: [
    { anchor: '.gitignore', note: 'read' },
    { anchor: 'package.json', note: 'read' },
    { anchor: 'src/token.ts', note: 'read' },
    { anchor: 'tests/token.test.ts', note: 'read' },
  ],
  findings: [],
}
const BLOCKING = { ...CLEAN, findings: [{ blocking: true, anchor: 'src/token.ts', claim: 'x' }] }

const runs = (repo: { root: string }, id: string) =>
  readStream(repo.root, id).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]

const cfgOf = (root: string): Config => { const r = loadConfig(root); if (!r.ok) throw new Error('config'); return r.value }

type Flags = { fresh: boolean; manual: boolean }
const PLAIN: Flags = { fresh: false, manual: false }

// A shippable plan whose implement gate passed, and the ways the tests drive it.
async function bench() {
  const { repo, wt, planId } = await shippableRepo()
  const scenario = fakeScenario()
  putVerdict(scenario, CLEAN)
  const gate = (name: string, env: Record<string, string> = {}, flags: Flags = PLAIN) =>
    runGate(fakeCtx(repo.root, { env: gateEnv(scenario, env) }), name, planId, flags)
  const gateOut = async (name: string, env: Record<string, string> = {}): Promise<string> => {
    const lines: string[] = []
    await runGate(fakeCtx(repo.root, { env: gateEnv(scenario, env), out: (l) => lines.push(l) }), name, planId, PLAIN)
    return lines.join('\n')
  }
  expect(await gate('implement')).toBe(0)
  return { repo, wt, planId, scenario, gate, gateOut }
}

// `ship.lint` set, the config committed, and every part's command granted.
function setLint(repo: TestRepo, val: string | Record<string, string>): void {
  patchConfig(repo, { ship: { lint: val } })
  repo.git('add', 'witness.config.yaml'); repo.git('commit', '-q', '-m', 'lint')
  grantCommands(repo.root, typeof val === 'string' ? [val] : Object.values(val))
}

describe('the checks-only round (row 264)', () => {
  it('a red lint part at ship ends the round before any lens: checks only, no reviewer, no debt discharged (§3.2)', async () => {
    const { repo, planId, scenario, gate } = await bench()
    // a judged ship round with a blocking finding, approved over it: one open debt
    putVerdict(scenario, BLOCKING); await gate('ship')
    expect((await repo.cli(['decide', 'ship', planId, '--approve', '--override'])).code).toBe(0)
    expect(openDeferrals(readStream(repo.root, planId))).toHaveLength(1)
    setLint(repo, 'false')
    const calls = callCount(scenario)
    expect(await gate('ship')).toBe(1)
    const last = runs(repo, planId).at(-1)!
    expect(last).toMatchObject({ gate: 'ship', checks_only: true, outcome: 'stopped' })
    expect(last.verdicts).toBeUndefined()
    expect(last.model).toBe(last.pin)
    expect(last.prompts_sha).toMatch(/\S/)
    expect(last.checks.map((c) => c.name)).toEqual(['markers', 'lint'])     // markers green, then lint red (row 265)
    expect(callCount(scenario)).toBe(calls)
    expect(openDeferrals(readStream(repo.root, planId))).toHaveLength(1)
    expect(readStream(repo.root, planId).some((e) => e.t === 'deferral-discharged')).toBe(false)
  }, 240_000)

  it('a checks-only round resumes on identical checks, and runs fresh once the check is green (§3.2)', async () => {
    const { repo, planId, scenario, gate, gateOut } = await bench()
    setLint(repo, 'false'); await gate('ship')
    const n = runs(repo, planId).length
    const again = await gateOut('ship')
    expect(runs(repo, planId)).toHaveLength(n)
    expect(again).toContain('resume — content unchanged')
    setLint(repo, 'true')
    const calls = callCount(scenario)
    await gate('ship')
    const last = runs(repo, planId).at(-1)!
    expect(last.checks_only).toBeUndefined()
    expect(last.verdicts?.length).toBeGreaterThan(0)
    expect(callCount(scenario)).toBeGreaterThan(calls)
  }, 240_000)

  it('red differently is a new checks-only round (§3.2)', async () => {
    const { repo, planId, scenario, gate } = await bench()
    setLint(repo, { a: 'false', b: 'true' }); await gate('ship')
    const calls = callCount(scenario)
    setLint(repo, { a: 'true', b: 'false' }); await gate('ship')
    const [one, two] = runs(repo, planId).slice(-2)
    expect([one!.checks_only, two!.checks_only]).toEqual([true, true])
    expect(callCount(scenario)).toBe(calls)
  }, 240_000)

  it('a trust grant on the same tree re-runs fresh (§3.2)', async () => {
    const { repo, planId, gate } = await bench()
    patchConfig(repo, { ship: { lint: 'echo lint-ok' } })
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-q', '-m', 'lint, not granted')
    await gate('ship', { WITNESS_TRUST_CMDS: '' })
    expect(runs(repo, planId).at(-1)).toMatchObject({ checks_only: true })
    expect(runs(repo, planId).at(-1)!.checks.at(-1)!.untrusted).toEqual(['echo lint-ok'])
    grantCommands(repo.root, ['echo lint-ok'])
    await gate('ship', { WITNESS_TRUST_CMDS: '' })
    expect(runs(repo, planId).at(-1)!.checks_only).toBeUndefined()
    expect(runs(repo, planId).at(-1)!.verdicts?.length).toBeGreaterThan(0)
  }, 240_000)

  it('a wot round whose clippy fails withholds the battery (§4 T2)', async () => {
    const { repo, planId, scenario, gate } = await bench()
    setLint(repo, { biome: 'true', clippy: 'false' })
    const calls = callCount(scenario)
    await gate('ship')
    const last = runs(repo, planId).at(-1)!
    expect(last.checks_only).toBe(true)
    expect(last.checks.at(-1)!.parts!.find((p) => p.part === 'clippy')!.state).not.toBe('green')
    expect(callCount(scenario)).toBe(calls)
  }, 240_000)

  it('a red test round still runs the battery (§4 T2)', async () => {
    const { repo, planId, gate } = await bench()
    patchConfig(repo, { ship: { test: 'false' } })
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-q', '-m', 'a red test command')
    grantCommands(repo.root, ['false'])
    await gate('ship')
    const last = runs(repo, planId).at(-1)!
    expect(last.checks_only).toBeUndefined()
    expect(last.checks.find((c) => c.name === 'tests')!.ok).toBe(false)
    expect(last.verdicts?.length).toBeGreaterThan(0)
  }, 240_000)

  it('at the round bound a withholding red journals nothing (row 264)', async () => {
    const { repo, planId, scenario, gate, gateOut } = await bench()
    putVerdict(scenario, BLOCKING)
    await gate('ship'); await gate('ship', {}, { fresh: true, manual: false }); await gate('ship', {}, { fresh: true, manual: false })
    setLint(repo, 'false')
    const n = runs(repo, planId).length
    const out = await gateOut('ship')
    expect(out).toContain('round bound reached')
    expect(runs(repo, planId)).toHaveLength(n)
  }, 240_000)
})

describe('a checks-only round offers no approve and says so (row 264)', () => {
  it('decide refuses --approve on a checks-only round, naming it (§3.2)', async () => {
    const { repo, planId, gate } = await bench()
    setLint(repo, 'false'); await gate('ship')
    for (const argv of [['--approve'], ['--approve', '--override']]) {
      const r = await repo.cli(['decide', 'ship', planId, ...argv])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('checks-only')
    }
  }, 240_000)

  it('the gate and decide --show say the round ran checks only (row 264)', async () => {
    const { repo, planId, gateOut } = await bench()
    setLint(repo, 'false')
    expect(await gateOut('ship')).toContain('checks-only: lint is red so no lens ran — this round spends no budget')
    expect((await repo.cli(['decide', 'ship', planId, '--show'])).stdout).toContain('checks-only: lint is red so no lens ran')
  }, 240_000)
})

describe('conflict markers at implement (row 265)', () => {
  it('a plan that adds a conflict opener ends the implement round checks only, before lint runs (row 265)', async () => {
    const { repo, wt, planId } = await shippableRepo()
    const scenario = fakeScenario(); putVerdict(scenario, CLEAN)
    writeFileSync(join(wt, 'src', 'token.ts'), `${TOKEN_FIXED}<<<<<<< HEAD\n`)
    const calls = callCount(scenario)
    expect(await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'implement', planId, PLAIN)).toBe(1)
    const last = runs(repo, planId).at(-1)!
    expect(last).toMatchObject({ gate: 'implement', checks_only: true })
    expect(last.checks.map((c) => c.name)).toEqual(['markers'])
    expect(last.checks[0]!.detail).toContain('src/token.ts:')
    expect(callCount(scenario)).toBe(calls)
  }, 240_000)
})

describe('lint at implement (row 265)', () => {
  it('the implement gate runs every lint part and withholds on a red one, owing its base key (row 265)', async () => {
    const { repo, wt, planId } = await shippableRepo()
    const scenario = fakeScenario(); putVerdict(scenario, CLEAN)
    setLint(repo, { ui: '! grep -rq LINTBAD src' })               // an opaque part, red on the plan's tree
    writeFileSync(join(wt, 'src', 'token.ts'), `${TOKEN_FIXED}// LINTBAD\n`)
    const held = acquireDriveLock(repo.root, {})
    try {
      expect(await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'implement', planId, PLAIN)).toBe(1)
      const last = runs(repo, planId).at(-1)!
      expect(last).toMatchObject({ gate: 'implement', checks_only: true })
      const lint = last.checks.at(-1)!
      expect(lint.name).toBe('lint')
      expect(lint.parts).toEqual([expect.objectContaining({ part: 'ui', state: 'pending' })])
      expect(baseLintKind.owed(repo.root, cfgOf(repo.root), loadCanon(repo.root)).map((u) => u.key)).toEqual([lint.parts![0]!.key])
    } finally {
      if (held.ok) held.value()
    }
  }, 240_000)
})

const decisions = (root: string, stream: string) =>
  readStream(root, stream).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[]

// Row 267. Autonomy on, ship.lint one opaque part; implement passes on the clean tree (it runs lint
// too), then the plan's tree turns red for ship alone.
async function redForShip() {
  const b = await bench()
  patchConfig(b.repo, { autonomy: 'on', ship: { lint: { ui: '! grep -rq LINTBAD src' } } })
  b.repo.git('add', 'witness.config.yaml'); b.repo.git('commit', '-q', '-m', 'autonomy, one lint part')
  grantCommands(b.repo.root, ['! grep -rq LINTBAD src'])
  writeFileSync(join(b.wt, 'src', 'token.ts'), `${TOKEN_FIXED}// LINTBAD\n`)
  return b
}

describe('a round red only for drive\'s base lint (row 267)', () => {
  it('a stop red only for a base result drive owes is left to drive, then re-gated once the result lands (row 267)', async () => {
    const { repo, planId, scenario, gateOut } = await redForShip()
    const held = acquireDriveLock(repo.root, {})
    try {
      const out = await gateOut('ship')
      expect(out).toContain('awaits-drive: ship auth-refresh-plan-1 — drive lints the base of ui first')
      expect(decisions(repo.root, planId).filter((d) => d.gate === 'ship')).toEqual([])
      const unit = baseLintKind.owed(repo.root, cfgOf(repo.root), loadCanon(repo.root))[0]!
      const r = baseLintKind.run(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), cfgOf(repo.root), unit, 1) as { result: unknown }
      journalShard(repo.root, { kind: BASE_LINT, key: unit.key, shard: 1, of: 1, outcome: 'done', ms: 1, result: r.result })
      const s = await settleStop(fakeCtx(repo.root, { env: gateEnv(scenario) }), repo.root, cfgOf(repo.root), 'ship', planId)
      expect(s).toMatchObject({ kind: 'routed', line: expect.stringContaining('witness gate ship auth-refresh-plan-1') })
    } finally {
      if (held.ok) held.value()
    }
  }, 240_000)

  it('with no drive the same stop is the policy\'s revise (row 267)', async () => {
    const { repo, planId, gate } = await redForShip()
    await gate('ship')
    expect(decisions(repo.root, planId).filter((d) => d.gate === 'ship').at(-1)).toMatchObject({ decision: 'revise', selected: 'policy', rule: 'checks-only' })
  }, 240_000)
})

describe('a round red only for drive\'s base lint — slice 3 review (row 267)', () => {
  it('a waiting stop whose content moved since is routed to the re-gate, never left waiting (I1)', async () => {
    const { repo, wt, planId, scenario, gateOut } = await redForShip()
    const held = acquireDriveLock(repo.root, {})
    try {
      expect(await gateOut('ship')).toContain('awaits-drive: ship auth-refresh-plan-1')
      writeFileSync(join(wt, 'src', 'token.ts'), TOKEN_FIXED)          // the author fixed the lint: the content moved
      const s = await settleStop(fakeCtx(repo.root, { env: gateEnv(scenario) }), repo.root, cfgOf(repo.root), 'ship', planId)
      expect(s).toMatchObject({ kind: 'routed', line: expect.stringContaining('witness gate ship auth-refresh-plan-1') })
    } finally {
      if (held.ok) held.value()
    }
  }, 240_000)
})
