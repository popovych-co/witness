import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EXIT } from '../src/cli.js'
import { loadConfig, type Config } from '../src/config.js'
import { gateSpec } from '../src/gate.js'
import '../src/gates/index.js'
import { appendEntry, readStream } from '../src/journal.js'
import type { Option } from '../src/recommend.js'
import type { DecisionEntry } from '../src/rounds.js'
import { findById, loadCanon } from '../src/scan.js'
import { settleStop, settledCode, settledLine } from '../src/settle.js'
import { applyDecision } from '../src/verbs/decide.js'
import { fakeCtx, plannedRepo, type TestRepo } from './helpers.js'

// Row 240 (design §4.1.1's table). What `settleStop` returns once the door refused its act: a lost
// race names its winner (`superseded`), content that moved while the arbiter judged is judged
// again (never a park on the old ruling), and a newer run owed is left to that run (`moved`).

// The arbiter stand-in: counts its calls, runs `during` while it "thinks" (where a human, another
// settler or an edit lands), then picks the option `pick` names from the menu it was given.
const arbiter = vi.hoisted(() => ({
  calls: 0,
  during: [] as Array<() => Promise<void> | void>,
  picks: [] as Array<(argv: readonly string[]) => boolean>,
  notes: [] as Array<string | undefined>,
  malformed: false,
}))
vi.mock('../src/arbiter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/arbiter.js')>()
  return {
    ...real,
    arbitrate: async (_ctx: unknown, _root: string, _cfg: unknown, req: { menu: readonly Option[] }) => {
      const n = arbiter.calls++
      await arbiter.during[n]?.()
      if (arbiter.malformed) return { ok: false, violations: [{ field: 'arbiter', rule: 'arbiter-malformed', got: 'twice', want: 'a choice' }] }
      const pick = arbiter.picks[n] ?? (() => true)
      const i = req.menu.findIndex((o) => o.act !== undefined && pick(o.act.argv))
      return { ok: true, value: { choice: i + 1, reason: `stand-in ${n + 1}`, note: arbiter.notes[n] ?? 'fix it', model: 'm', prompts_sha: 'p' } }
    },
  }
})

const PLAN = 'auth-refresh-plan-1'
const cfgOf = (repo: TestRepo): Config => {
  const r = loadConfig(repo.root)
  if (!r.ok) throw new Error(`config refused: ${JSON.stringify(r.violations)}`)
  return r.value
}
const approves = (argv: readonly string[]) => argv.includes('--approve')
const overrides = (argv: readonly string[]) => argv.includes('--approve') && argv.includes('--override')
const stops = (argv: readonly string[]) => argv.includes('--stop')
const decisions = (repo: TestRepo) =>
  (readStream(repo.root, PLAN).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[])
    .filter((d) => d.gate === 'plan').map((d) => `${d.decision} · ${d.selected ?? 'human'}`)

function reset(during: Array<() => Promise<void> | void>, picks: Array<(argv: readonly string[]) => boolean>, notes: Array<string | undefined> = []): void {
  arbiter.calls = 0
  arbiter.during = during
  arbiter.picks = picks
  arbiter.notes = notes
  arbiter.malformed = false
}

// A plan stop the arbiter judges: below the bound, the one failed check an approve clears
// (`checks-failed` with only amendment-ack); at the bound, a blocking finding on a new anchor
// each round (`bound`). Either way the policy hands it to the arbiter.
async function stopFor(repo: TestRepo, rounds: number): Promise<void> {
  const sha = gateSpec('plan')!.currentSha!(repo.root, loadCanon(repo.root), cfgOf(repo), PLAN)
  for (let round = 1; round <= rounds; round++) {
    appendEntry(repo.root, PLAN, {
      v: 1, t: 'gate-run', gate: 'plan', artifact: PLAN, round, run_id: `r-${round}`, reviewed_sha: sha,
      prompts_sha: 'p', witness: '0', model: 'm', outcome: 'stopped',
      checks: rounds === 1 ? [{ name: 'amendment-ack', ok: false, detail: 'unacknowledged' }] : [],
      verdicts: [{
        reviewer: 'plan-critic', coverage: [],
        findings: rounds === 1 ? [] : [{ blocking: true, anchor: `${PLAN} > ## Step: s${round}`, claim: 'x' }],
      }],
    } as never)
  }
}

// An author's edit, committed, while the arbiter judges: the content the ruling judged is gone.
const editPlan = (repo: TestRepo) => () => {
  const rel = findById(loadCanon(repo.root), PLAN)!.rel
  appendFileSync(join(repo.root, rel), '\nedited while the arbiter judged\n')
  repo.git('add', rel)
  repo.git('commit', '-qm', 'author edit')
}

describe('settleStop after the door refused its act (row 240)', () => {
  it('a lost race returns superseded naming the winner, with the revise-context rebuilt from the journal', async () => {
    const repo = await plannedRepo()
    await stopFor(repo, 1)
    reset([async () => {
      expect(await applyDecision(fakeCtx(repo.root), { gate: 'plan', target: PLAN, decision: 'revise', note: 'the human got there first' })).toBe(0)
    }], [approves])
    const out: string[] = []
    const s = await settleStop(fakeCtx(repo.root, { out: (l) => out.push(l) }), repo.root, cfgOf(repo), 'plan', PLAN)
    expect(s).toEqual({ kind: 'superseded', by: 'human', decision: 'revise' })
    expect(out).toContain(`decided: plan ${PLAN} → revise · human (decided first)`)
    expect(out.some((l) => l.startsWith('revise-context'))).toBe(true)
    expect(out).toContain('note: the human got there first')
    expect(decisions(repo)).toEqual(['revise · human'])                      // no park on top
    expect(arbiter.calls).toBe(1)
  })

  it('a stale-verdict refusal below the bound is judged again: routed, no park, no second call (P26)', async () => {
    const repo = await plannedRepo()
    await stopFor(repo, 1)
    reset([editPlan(repo)], [approves])
    const s = await settleStop(fakeCtx(repo.root), repo.root, cfgOf(repo), 'plan', PLAN)
    expect(s.kind).toBe('routed')
    expect(s.kind === 'routed' && s.act.line).toBe(`witness gate plan ${PLAN}`)
    expect(arbiter.calls).toBe(1)
    expect(decisions(repo)).toEqual([])
  })

  it('at the bound, a stale-verdict refusal asks the arbiter once more about the content as it is now (bound-stale)', async () => {
    const repo = await plannedRepo()
    await stopFor(repo, 3)
    reset([editPlan(repo)], [overrides, stops])
    const s = await settleStop(fakeCtx(repo.root), repo.root, cfgOf(repo), 'plan', PLAN)
    expect(s).toMatchObject({ kind: 'decided', by: 'arbiter', decision: 'stop', rule: 'bound-stale' })
    expect(arbiter.calls).toBe(2)
    expect(decisions(repo)).toEqual(['stop · arbiter'])
  })


  it('an anchor-moved refusal returns moved: no park, nothing for the human', async () => {
    const repo = await plannedRepo()
    await stopFor(repo, 1)
    const sha = gateSpec('plan')!.currentSha!(repo.root, loadCanon(repo.root), cfgOf(repo), PLAN)
    reset([() => {
      appendEntry(repo.root, PLAN, {
        v: 1, t: 'gate-run', gate: 'plan', artifact: PLAN, round: 2, run_id: 'r-2', reviewed_sha: sha,
        prompts_sha: 'p', witness: '0', model: 'm', outcome: 'stopped',
        checks: [{ name: 'amendment-ack', ok: false, detail: 'unacknowledged' }],
        verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [] }],
      } as never)
    }], [approves])
    const out: string[] = []
    const s = await settleStop(fakeCtx(repo.root, { out: (l) => out.push(l) }), repo.root, cfgOf(repo), 'plan', PLAN)
    expect(s).toEqual({ kind: 'moved' })
    expect(decisions(repo)).toEqual([])
    expect(out.some((l) => l.startsWith('autonomy: left'))).toBe(false)
  })

  it('a policy park built from the stop as it was read lands once: two malformed answers park it (F4)', async () => {
    const repo = await plannedRepo()
    await stopFor(repo, 3)
    reset([], [])
    arbiter.malformed = true
    const s = await settleStop(fakeCtx(repo.root), repo.root, cfgOf(repo), 'plan', PLAN)
    expect(s).toMatchObject({ kind: 'decided', by: 'policy', decision: 'stop' })
    expect(decisions(repo)).toEqual(['stop · policy'])
  })

  it('a malformed-answer park whose read predates a human decision is superseded, never parked on top', async () => {
    const repo = await plannedRepo()
    await stopFor(repo, 3)
    reset([async () => {
      expect(await applyDecision(fakeCtx(repo.root), { gate: 'plan', target: PLAN, decision: 'revise', upstream: 'auth-refresh' })).toBe(0)
    }], [])
    arbiter.malformed = true
    const s = await settleStop(fakeCtx(repo.root), repo.root, cfgOf(repo), 'plan', PLAN)
    expect(s).toEqual({ kind: 'superseded', by: 'human', decision: 'revise-upstream' })
    expect(decisions(repo)).toEqual(['revise-upstream · human'])
  })
})

describe('the readers of a settle (row 240)', () => {
  it('settledCode treats superseded as decided with the winner\'s decision; moved keeps the code; busy is exit 3', () => {
    expect(settledCode(EXIT.FINDINGS, { kind: 'superseded', by: 'human', decision: 'approve' })).toBe(EXIT.OK)
    expect(settledCode(EXIT.FINDINGS, { kind: 'superseded', by: 'policy', decision: 'revise' })).toBe(EXIT.FINDINGS)
    expect(settledCode(EXIT.FINDINGS, { kind: 'moved' })).toBe(EXIT.FINDINGS)
    expect(settledCode(EXIT.FINDINGS, { kind: 'busy', pid: 4242, since: 0 })).toBe(EXIT.BLOCKED)
  })

  it('settledLine prints superseded as decided first, and nothing for moved or busy', () => {
    expect(settledLine({ gate: 'ship', target: PLAN, settled: { kind: 'superseded', by: 'arbiter', decision: 'revise-upstream' } }))
      .toBe(`decided: ship ${PLAN} → revise-upstream · arbiter (decided first)`)
    expect(settledLine({ gate: 'ship', target: PLAN, settled: { kind: 'moved' } })).toBeUndefined()
    expect(settledLine({ gate: 'ship', target: PLAN, settled: { kind: 'busy', pid: 1, since: 0 } })).toBeUndefined()
  })
})
