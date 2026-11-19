import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BUSY_DIR } from '../src/busy.js'
import { parkAtCap } from '../src/caps.js'
import { EXIT } from '../src/cli.js'
import { loadConfig, type Config } from '../src/config.js'
import { gateSpec, runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { appendEntry, readStream } from '../src/journal.js'
import type { Option } from '../src/recommend.js'
import type { DecisionEntry } from '../src/rounds.js'
import { loadCanon } from '../src/scan.js'
import { settleStop } from '../src/settle.js'
import { runShip } from '../src/ship.js'
import {
  PLAN_BLOCKING, addOrigin, autonomyOn, fakeCtx, fakeScenario, gateEnv, plannedRepo, putVerdict, shippableRepo, type TestRepo,
} from './helpers.js'

// Row 240 (design §4.1.2: the settle lock, the ship marker). A settler takes the stop's settle
// lock before it reads the stop, `parkAtCap` before it reads the stream, and `witness ship` its
// marker before it journals anything. Held by another live process: no read, no model call, no run.

const arbiter = vi.hoisted(() => ({ calls: 0, during: [] as Array<() => Promise<void> | void>, picks: [] as Array<(argv: readonly string[]) => boolean> }))
vi.mock('../src/arbiter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/arbiter.js')>()
  return {
    ...real,
    arbitrate: async (_c: unknown, _r: string, _f: unknown, req: { menu: readonly Option[] }) => {
      const n = arbiter.calls++
      await arbiter.during[n]?.()
      const pick = arbiter.picks[n] ?? (() => true)
      const i = req.menu.findIndex((o) => o.act !== undefined && pick(o.act.argv))
      return { ok: true, value: { choice: i + 1, reason: `stand-in ${n + 1}`, model: 'm', prompts_sha: 'p' } }
    },
  }
})

const PLAN = 'auth-refresh-plan-1'
const OTHER = process.ppid                                   // a live pid that is not this process
const cfgOf = (repo: TestRepo): Config => {
  const r = loadConfig(repo.root)
  if (!r.ok) throw new Error(`config refused: ${JSON.stringify(r.violations)}`)
  return r.value
}
const hold = (root: string, kind: 'settle' | 'ship', target: string, extra: Record<string, number> = {}) => {
  mkdirSync(join(root, BUSY_DIR), { recursive: true })
  writeFileSync(join(root, BUSY_DIR, `${target}.${kind}.json`),
    JSON.stringify({ pid: OTHER, since: Date.now(), until: Date.now() + 3_600_000, ...extra }))
}
const busyFiles = (root: string) => { try { return readdirSync(join(root, BUSY_DIR)) } catch { return [] } }
const decisions = (repo: TestRepo) =>
  (readStream(repo.root, PLAN).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[])
    .filter((d) => d.gate === 'plan').map((d) => `${d.decision} · ${d.selected ?? 'human'}`)

// The bound's stop the arbiter judges: a blocking finding on a new anchor each round.
async function boundStop(repo: TestRepo): Promise<void> {
  const sha = gateSpec('plan')!.currentSha!(repo.root, loadCanon(repo.root), cfgOf(repo), PLAN)
  for (let round = 1; round <= 3; round++) {
    appendEntry(repo.root, PLAN, {
      v: 1, t: 'gate-run', gate: 'plan', artifact: PLAN, round, run_id: `r-${round}`, reviewed_sha: sha,
      prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped',
      verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [{ blocking: true, anchor: `${PLAN} > ## Step: s${round}`, claim: 'x' }] }],
    } as never)
  }
}

describe('the settle lock (row 240)', () => {
  it('a settle beside a live settle lock reads nothing and asks no model', async () => {
    const repo = await plannedRepo()
    await boundStop(repo)
    hold(repo.root, 'settle', PLAN)
    arbiter.calls = 0; arbiter.during = []; arbiter.picks = []
    expect(await settleStop(fakeCtx(repo.root), repo.root, cfgOf(repo), 'plan', PLAN))
      .toEqual({ kind: 'busy', pid: OTHER, since: expect.any(Number) })
    expect(arbiter.calls).toBe(0)
    expect(decisions(repo)).toEqual([])
  })

  it('a settle releases its lock when it ends', async () => {
    const repo = await plannedRepo()
    await boundStop(repo)
    arbiter.calls = 0; arbiter.during = []; arbiter.picks = [(argv) => argv.includes('--stop')]
    expect((await settleStop(fakeCtx(repo.root), repo.root, cfgOf(repo), 'plan', PLAN)).kind).toBe('decided')
    expect(busyFiles(repo.root)).toEqual([])
  })

  it('a gate whose tail meets a held lock prints busy: and exits 3', async () => {
    const repo = await plannedRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, PLAN_BLOCKING)
    hold(repo.root, 'settle', PLAN)
    const out: string[] = []
    const code = await runGate(fakeCtx(repo.root, { env: gateEnv(scenario), out: (l) => out.push(l) }), 'plan', PLAN, { fresh: false, manual: false })
    expect(code).toBe(EXIT.BLOCKED)
    expect(out.some((l) => new RegExp(`^busy: ${PLAN} — another witness run is deciding plan \\(pid ${OTHER}, since \\d\\d:\\d\\d\\)$`).test(l))).toBe(true)
    expect(decisions(repo)).toEqual([])
  }, 60_000)

  it('a busy parkAtCap parks nothing and says busy', async () => {
    const repo = await plannedRepo()
    await boundStop(repo)
    hold(repo.root, 'settle', PLAN)
    const hit = { cap: 'rounds' as const, gate: 'plan', note: 'drive cap: plan ran 3 rounds' }
    expect(await parkAtCap(fakeCtx(repo.root), repo.root, PLAN, hit, cfgOf(repo))).toEqual({ parked: false, busy: true, why: 'busy' })
    expect(decisions(repo)).toEqual([])
  })

  // Review Focus 2
  it('a holder past its until lets a second settler in, and the first one\'s act refuses settled-since', async () => {
    const repo = await plannedRepo()
    await boundStop(repo)
    const lockPath = join(repo.root, BUSY_DIR, `${PLAN}.settle.json`)
    let b: Awaited<ReturnType<typeof settleStop>> | undefined
    arbiter.calls = 0
    arbiter.picks = [(argv) => argv.includes('--override'), (argv) => argv.includes('--stop')]
    arbiter.during = [async () => {
      // A's host slept while its arbiter thought: its lock is past its bound, so B may take it
      writeFileSync(lockPath, JSON.stringify({ pid: OTHER, since: Date.now() - 7_200_000, until: Date.now() - 1 }))
      b = await settleStop(fakeCtx(repo.root), repo.root, cfgOf(repo), 'plan', PLAN)
    }]
    const errs: string[] = []
    const a = await settleStop(fakeCtx(repo.root, { err: (l) => errs.push(l) }), repo.root, cfgOf(repo), 'plan', PLAN)
    expect(b).toMatchObject({ kind: 'decided', decision: 'stop', by: 'arbiter' })
    expect(a).toEqual({ kind: 'superseded', by: 'arbiter', decision: 'stop' })
    expect(errs.join('\n')).toContain('settled-since')
    expect(decisions(repo)).toEqual(['stop · arbiter'])
    expect(arbiter.calls).toBe(2)
  })
})

describe('the ship marker (row 240)', () => {
  it('a second witness ship refuses exit 3 before journaling', async () => {
    const { repo, planId } = await shippableRepo()
    addOrigin(repo)
    hold(repo.root, 'ship', planId)
    const before = readStream(repo.root, planId)
    const out: string[] = []
    expect(await runShip(fakeCtx(repo.root, { out: (l) => out.push(l) }), planId)).toBe(EXIT.BLOCKED)
    expect(out[0]).toMatch(new RegExp(`^busy: ${planId} — witness ship is running on it \\(pid ${OTHER}, since \\d\\d:\\d\\d\\) · nothing to do; it continues when that ends$`))
    expect(readStream(repo.root, planId)).toEqual(before)
  }, 120_000)

  it('ship\'s own gate tail takes the settle lock beside its marker, and both are released', async () => {
    const { repo, planId } = await shippableRepo()
    addOrigin(repo)
    autonomyOn(repo)
    const scenario = fakeScenario()
    putVerdict(scenario, {
      coverage: ['.gitignore', 'package.json', 'src/token.ts', 'tests/token.test.ts'].map((anchor) => ({ anchor, note: 'read' })),
      findings: [],
    })
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    arbiter.calls = 0; arbiter.during = []; arbiter.picks = [(argv) => argv.includes('--revise')]
    const out: string[] = []
    await runShip({ ...ctx, out: (l) => out.push(l) }, planId)
    // the ship gate's stop was settled inside the ship run — its marker never made its own tail busy
    expect(out.some((l) => l.startsWith('busy:'))).toBe(false)
    expect(readStream(repo.root, planId).some((e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === 'ship')).toBe(true)
    expect(busyFiles(repo.root)).toEqual([])
  }, 120_000)
})
