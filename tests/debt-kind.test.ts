import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertReads, debtKinds, gateSetup, gateSpec, judgeable, readsOf, runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { openDeferrals, type DeferralEntry } from '../src/deferral.js'
import { journalRel, readStream } from '../src/journal.js'
import {
  approve, callFor, commitEntry, fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, witnessDesign,
  writeDesign, writePlan, writeSpec, type TestRepo,
} from './helpers.js'

// Copied from tests/gate-design.test.ts:12-28 (not exported there).
const CLEAN = {
  coverage: [
    { anchor: 'design#save-bar', note: 'primary action visible' },
    { anchor: 'booking-form > ## Behavior', note: 'every behavior has a home' },
  ],
  findings: [] as never[],
}

async function designed() {
  const repo = await seededRepo()
  await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
  approve(repo, 'booking-form')
  await writeDesign(repo, 'booking-form')
  await witnessDesign(repo, 'booking-form')
  const scenario = fakeScenario()
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
  return { repo, scenario, ctx }
}

// Copied from tests/gate-plan.test.ts (not exported there).
const PAIR_CLEAN = {
  coverage: [
    { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
    { anchor: 'auth-refresh > ## Behavior', note: 'read' },
  ],
  findings: [],
}

async function planRepo() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  const scenario = fakeScenario()
  putVerdict(scenario, PAIR_CLEAN)
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
  return { repo, scenario, ctx }
}

// A "round": a gate-run whose lenses each raised one blocking finding.
const round = (run_id: string, gate: string, raised: Array<[reviewer: string, anchor: string]>) => ({
  v: 1, t: 'gate-run' as const, run_id, gate, verdicts: raised.map(([reviewer, anchor]) => ({
    reviewer, findings: [{ blocking: true, anchor, claim: 'x' }],
  })),
})
const debt = (id: string, artifact: string, gate: string, anchor: string, extra: Partial<DeferralEntry> = {}): DeferralEntry => ({
  v: 1, t: 'deferral', id, artifact, gate, round: 1, anchor, kind: 'artifact-debt', caused_by_run: 'r-1', ...extra,
})
const commitDebt = (repo: TestRepo, d: DeferralEntry) => commitEntry(repo, d.artifact, d as unknown as { t: 'deferral'; [k: string]: unknown })

describe('each lens is asked only about debts it can read (row 216)', () => {
  it('gates declare what their lenses read, and readsOf answers it (issue #73)', async () => {
    await import('../src/gates/index.js')
    expect(['decompose', 'plan', 'design', 'implement', 'ship'].map((g) => readsOf(g)))
      .toEqual(['docs', 'docs', 'design', 'tree', 'tree'])
    expect(readsOf('implement', 'design-reviewer')).toBe('screens')
    expect(readsOf('implement', 'code-reviewer')).toBe('tree')
    expect(readsOf('nope')).toBeUndefined()
    expect(() => assertReads(gateSpec('design')!, { kind: 'tree', root: '/', files: [] })).toThrow()
  })

  it('a debt is of the kinds its raising lenses read, after a take-back too (issue #73)', async () => {
    const repo = await seededRepo()
    commitEntry(repo, 'p1', round('r-1', 'implement', [['design-reviewer', 'initial.png']]))
    commitDebt(repo, debt('d-1', 'p1', 'implement', 'initial.png'))
    commitDebt(repo, debt('d-1', 's1', 'implement', 'initial.png', { moved_from: 'p1' }))
    commitDebt(repo, debt('d-1', 's2', 'implement', 'initial.png', { moved_from: 's1' }))
    const home = debt('d-1', 's1', 'implement', 'initial.png', { moved_from: 's2' })
    commitDebt(repo, home)
    expect(debtKinds(repo.root, home, readStream(repo.root, 's1'))).toEqual(['screens'])
  })

  it('an unmoved debt reads its anchor round from the stream being judged, even after a rename (issue #73)', async () => {
    const repo = await seededRepo()
    commitEntry(repo, 'p2', round('r-2', 'implement', [['design-reviewer', 'shot.png']]))
    const d = debt('d-2', 'old-name', 'implement', 'shot.png', { caused_by_run: 'r-2' })
    expect(debtKinds(repo.root, d, readStream(repo.root, 'p2'))).toEqual(['screens'])
  })

  it("with no anchor round, or an unreadable stream, a debt takes its minting gate's kind (issue #73)", async () => {
    const repo = await seededRepo()
    const gone = (gate: string) => debtKinds(repo.root, debt(`d-${gate}`, 's1', gate, 'x', { caused_by_run: 'r-gone' }), [])
    expect(['implement', 'ship', 'design', 'plan', 'decompose'].map(gone))
      .toEqual([['tree'], ['tree'], ['design'], ['docs'], ['docs']])
    const bad = join(repo.root, journalRel('bad'))
    mkdirSync(dirname(bad), { recursive: true })
    writeFileSync(bad, '{not json\n')
    const moved = debt('d-bad', 's1', 'implement', 'x', { moved_from: 'bad' })
    expect(() => debtKinds(repo.root, moved, [])).not.toThrow()
    expect(debtKinds(repo.root, moved, [])).toEqual(['tree'])
  })

  it('each lens is asked only about the debts it reads, in an order-free text (issue #73)', async () => {
    const repo = await seededRepo()
    const plan = 'auth-refresh-plan-1'
    commitEntry(repo, plan, round('r-1', 'implement', [['code-reviewer', 'src/token.ts#rotate'], ['design-reviewer', 'initial.png']]))
    const dCode = debt('d-code', plan, 'implement', 'src/token.ts#rotate')
    const dShot = debt('d-shot', plan, 'implement', 'initial.png')
    commitDebt(repo, dCode)
    commitDebt(repo, dShot)
    const entries = readStream(repo.root, plan)
    const s = gateSetup(repo.root, gateSpec('implement')!, entries, ['code-reviewer', 'design-reviewer'])
    expect(s.forLens('code-reviewer')).toContain('(d-code)')
    expect(s.forLens('code-reviewer')).not.toContain('(d-shot)')
    expect(s.forLens('design-reviewer')).toContain('(d-shot)')
    expect(s.forLens('design-reviewer')).not.toContain('(d-code)')
    expect(s.text).toBe(gateSetup(repo.root, gateSpec('implement')!, entries, ['design-reviewer', 'code-reviewer']).text)
    expect(judgeable(repo.root, dShot, entries, 'ship', ['drift-reviewer', 'code-reviewer'])).toBe(false)
    expect(judgeable(repo.root, dCode, entries, 'ship', ['drift-reviewer', 'code-reviewer'])).toBe(true)
  })

  it('the design gate neither asks about nor clears a code debt moved onto its spec (issue #73)', async () => {
    const { repo, scenario, ctx } = await designed()
    commitDebt(repo, debt('d-code', 'booking-form', 'implement', 'src/token.ts#rotate',
      { moved_from: 'booking-form-plan-1', caused_by_run: 'r-gone' }))
    commitDebt(repo, debt('d-look', 'booking-form', 'design', 'design#save-bar', { caused_by_run: 'r-gone' }))
    putVerdict(scenario, CLEAN)
    await runGate(ctx, 'design', 'booking-form', { fresh: false, manual: false })
    const asked = readFileSync(join(callFor(scenario, 'design-critic')!, 'stdin'), 'utf8')
    expect(asked).toContain('(d-look)')
    expect(asked).toContain('The gate reads silence as fixed')
    expect(asked).not.toContain('(d-code)')
    expect(openDeferrals(readStream(repo.root, 'booking-form')).map((d) => d.id)).toEqual(['d-code'])
  })

  it('the plan gate neither asks about nor clears an implement debt on its plan (issue #73)', async () => {
    const { repo, scenario, ctx } = await planRepo()
    commitDebt(repo, debt('d-code', 'auth-refresh-plan-1', 'implement', 'src/token.ts#rotate', { caused_by_run: 'r-gone' }))
    await runGate(ctx, 'plan', 'auth-refresh-plan-1', { fresh: false, manual: false })
    const asked = readFileSync(join(callFor(scenario, 'plan-critic')!, 'stdin'), 'utf8')
    expect(asked).not.toContain('(d-code)')
    expect(openDeferrals(readStream(repo.root, 'auth-refresh-plan-1')).map((d) => d.id)).toEqual(['d-code'])
  })
})
