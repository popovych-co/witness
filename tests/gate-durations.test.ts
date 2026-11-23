import { describe, expect, it } from 'vitest'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { decideView } from '../src/decide-view.js'
import { journalRel, readStream } from '../src/journal.js'
import { timedCheck, type GateRunEntry } from '../src/rounds.js'
import { loadCanon } from '../src/scan.js'
import { cfgOf } from './model-fixtures.js'
import { fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, shippableRepo, writeSpec } from './helpers.js'

// Row 251. Every check a gate journals carries how long it took, so a later item (T2d) can read
// the median per check name. The field never reaches an identity or a printed line.

// vitest-single fixture lands 4 files in the worktree diff — coverage-minimum needs an anchor per each.
const CLEAN = {
  coverage: [
    { anchor: '.gitignore', note: 'read' },
    { anchor: 'package.json', note: 'read' },
    { anchor: 'src/token.ts', note: 'read' },
    { anchor: 'tests/token.test.ts', note: 'read' },
  ],
  findings: [],
}
const runs = (root: string, id: string) =>
  readStream(root, id).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]
const timed = (r: GateRunEntry) =>
  r.checks.length > 0 && r.checks.every((c) => Number.isInteger(c.duration_ms) && c.duration_ms! >= 0)

async function decomposed() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [] })
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
  await runGate(ctx, 'decompose', 'auth-hardening', { fresh: false, manual: false })
  return { repo, ctx }
}

describe('check durations (row 251)', () => {
  it('timedCheck stamps the whole run of a check, an awaited one included', async () => {
    const c = await timedCheck(async () => { await new Promise((r) => setTimeout(r, 60)); return { name: 'slow', ok: true } })
    expect(c).toMatchObject({ name: 'slow', ok: true })
    expect(Number.isInteger(c.duration_ms)).toBe(true)
    expect(c.duration_ms).toBeGreaterThanOrEqual(50)
  })

  it('every check the decompose gate journals carries a duration', async () => {
    const { repo } = await decomposed()
    expect(timed(runs(repo.root, 'auth-hardening').at(-1)!)).toBe(true)
  })

  it('every check the implement and ship gates journal carries a duration', async () => {
    const { repo, planId } = await shippableRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    await runGate(ctx, 'ship', planId, { fresh: false, manual: false })
    const all = runs(repo.root, planId)
    const impl = all.find((r) => r.gate === 'implement')!
    const ship = all.at(-1)!
    expect(ship.gate).toBe('ship')
    expect(timed(impl)).toBe(true)
    expect(timed(ship)).toBe(true)
  }, 180_000)

  // The journaled round's durations are rewritten before the re-run (a fixture's checks all take
  // 0 ms, so a fresh run alone would never differ), and deleted for a round written before row 251.
  it.each([
    ['durations that differ', (c: Record<string, unknown>) => { c.duration_ms = 99_999 }],
    ['no durations at all (a pre-251 round)', (c: Record<string, unknown>) => { delete c.duration_ms }],
  ] as const)('a re-run against %s resumes and appends no round', async (_case, edit) => {
    const { repo, ctx } = await decomposed()
    const rel = journalRel('auth-hardening')
    const lines = repo.read(rel).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    for (const e of lines) if (e.t === 'gate-run') (e.checks as Array<Record<string, unknown>>).forEach(edit)
    repo.write(rel, lines.map((e) => JSON.stringify(e)).join('\n') + '\n')
    repo.git('add', rel); repo.git('commit', '-m', 'rewrite the round\'s durations')
    expect(runs(repo.root, 'auth-hardening')).toHaveLength(1)
    await runGate(ctx, 'decompose', 'auth-hardening', { fresh: false, manual: false })
    expect(runs(repo.root, 'auth-hardening')).toHaveLength(1)
  })

  it('decide --show and the gate view print no duration', async () => {
    const { repo } = await decomposed()
    expect(timed(runs(repo.root, 'auth-hardening').at(-1)!)).toBe(true)
    const view = decideView(repo.root, cfgOf(repo.root), loadCanon(repo.root), 'decompose', 'auth-hardening')
    expect(JSON.stringify(view)).not.toContain('duration_ms')
  })
})
