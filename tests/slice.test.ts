import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Fill } from '../src/context.js'
import type { Entry } from '../src/journal.js'
import type { CanonDoc } from '../src/scan.js'
import { closedThisSession, contextLine, largestGrowth, sessionActed, sliceLine, stepCloseVerdict, type SliceVerdict } from '../src/slice.js'
import { stepProgress, type Progress, type StepState } from '../src/steps.js'

const m = (tokens: number, window = 1_000_000): Fill => ({ measured: true, reading: { session: 'S', tokens, window } })
const un: Fill = { measured: false, reason: 'no adapter' }

// Steps s1..sN with the first `done` closed; the verdict reads only whether one remains.
const known = (done: number, total: number): Progress => {
  const steps = Array.from({ length: total }, (_, i): StepState =>
    ({ id: `s${i + 1}`, kind: 'criteria', ...(i < done ? { closedAt: i } : {}) }))
  const next = steps[done]
  return { known: true, steps, done, ...(next ? { next } : {}) }
}

type Input = Omit<Parameters<typeof stepCloseVerdict>[0], 'limit' | 'budget'>

describe('the verdict at a step close (row 191 §4.5 · §4.7)', () => {
  it.each<[string, Input, SliceVerdict]>([
    ['rule 1 — no unfinished steps', { fill: m(900_000), progress: known(3, 3) }, { kind: 'gate' }],
    ['rule 2 — reached', { fill: m(200_000), progress: known(1, 3) }, { kind: 'end', why: '20% reached the 20% limit' }],
    ['rule 3 — projected', { fill: m(170_000), progress: known(1, 3), growth: 50_000 }, { kind: 'end', why: '17% + next step ≈ 22% passes the 20% limit' }],
    ['continue', { fill: m(100_000), progress: known(1, 3), growth: 50_000 }, { kind: 'continue' }],
    ['no sample yet skips rule 3', { fill: m(190_000), progress: known(1, 3) }, { kind: 'continue' }],
    ['no first-step exemption', { fill: m(260_000), progress: known(1, 5) }, { kind: 'end', why: '26% reached the 20% limit' }],
    ['unmeasured — budget reached', { fill: un, progress: known(3, 5), closedHere: 3 }, { kind: 'end', why: '3 step(s) closed this session · step budget 3 (context unmeasured)' }],
    ['unmeasured — under budget', { fill: un, progress: known(2, 5), closedHere: 2 }, { kind: 'continue' }],
    ['unmeasured — session unknown', { fill: un, progress: known(1, 5) }, { kind: 'own-count', budget: 3 }],
    ['legacy — rule 2 still applies', { fill: m(250_000), progress: { known: false } }, { kind: 'end', why: '25% reached the 20% limit' }],
    ['legacy — unmeasured', { fill: un, progress: { known: false }, closedHere: 9 }, { kind: 'own-count', budget: 3 }],
  ])('%s', (_, input, want) => expect(stepCloseVerdict({ limit: 20, budget: 3, ...input })).toEqual(want))
})

const planDoc = (steps: Array<Record<string, unknown>>): CanonDoc =>
  ({ rel: 'plans/p.md', meta: { id: 'p', type: 'plan', parent: 'x', steps }, body: '', violations: [], satisfiedNeeds: [] })
const stamp = (session: string, tokens?: number) => ({ session, ...(tokens !== undefined ? { tokens, window: 1_000_000 } : {}) })

// Each close is the next scaffolding step's, stamped with the session it was written in and the
// reading when one was trusted (§4.8).
const closes = (...at: Array<[string, number?]>): Entry[] =>
  at.map(([session, tokens], i) => ({ v: 1, t: 'step-close', artifact: 'p', step: `s${i + 1}`, ctx: stamp(session, tokens) }))
const scaffolding = (n: number) => planDoc(Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, scaffolding: true })))
const growthOf = (entries: Entry[]) => largestGrowth(entries, stepProgress(scaffolding(entries.length), entries))

describe('the expected next step (row 191 §4.5)', () => {
  it('samples growth within one session only', () => {
    expect(growthOf(closes(['A', 100_000], ['A', 150_000], ['B', 400_000], ['B', 420_000]))).toBe(50_000)
  })
  it('takes the largest sample', () => {
    expect(growthOf(closes(['A', 100_000], ['A', 130_000], ['A', 200_000]))).toBe(70_000)
  })
  // P2: Pi's estimate can fall between turns.
  it('never samples a negative growth', () => {
    expect(growthOf(closes(['A', 17_064], ['A', 15_489]))).toBeUndefined()
  })
  it('skips a close that carries no tokens', () => {
    expect(growthOf(closes(['A'], ['A', 150_000]))).toBeUndefined()
  })
  // A re-recorded green and the next step's red are no closes: s1 closed at 100k, s2 at 150k.
  it('samples only the entries that closed a step', () => {
    const plan = planDoc([{ id: 's1', criteria: ['ac'] }, { id: 's2', criteria: ['ac'] }])
    const ev = (phase: 'red' | 'green', step: string, tokens: number): Entry =>
      ({ v: 1, t: 'test-evidence', artifact: 'p', phase, step, tests: [{ name: 'a @spec:x', ok: phase === 'green' }], ctx: stamp('A', tokens) })
    const entries = [ev('red', 's1', 50_000), ev('green', 's1', 100_000), ev('green', 's1', 400_000), ev('red', 's2', 120_000), ev('green', 's2', 150_000)]
    expect(largestGrowth(entries, stepProgress(plan, entries))).toBe(50_000)
  })
  it('converts growth with the current window', () => {
    expect(contextLine(m(100_000, 200_000), 20, 3, 30_000)).toBe('50% of 200k · limit 20% · next step ≈ +15%')
  })
  it('renders context and slice', () => {
    expect(contextLine(m(170_000), 20, 3, 50_000)).toBe('17% of 1M · limit 20% · next step ≈ +5%')
    expect(contextLine(m(170_000), 20, 3, 1_000)).toBe('17% of 1M · limit 20% · next step ≈ +1%')
    expect(contextLine(m(170_000), 20, 3)).toBe('17% of 1M · limit 20%')
    expect(contextLine({ measured: false, reason: 'stale' }, 20, 3)).toBe('unmeasured (stale) — step budget 3')
    expect(sliceLine({ kind: 'continue' })).toBe('continue')
    expect(sliceLine({ kind: 'end', why: '21% reached the 20% limit' })).toBe('end — 21% reached the 20% limit')
    expect(sliceLine({ kind: 'gate' })).toBe('gate — no steps remain')
    expect(sliceLine({ kind: 'own-count', budget: 3 })).toBe("own count — the CLI cannot count this session's steps · end after 3 step(s) by your own count")
  })
})

describe('what this session did (row 191 §4.5 · §4.7 · §4.8)', () => {
  it('counts only this session’s closes', () => {
    const entries = closes(['A'], ['B'], ['A'])
    expect(closedThisSession(entries, stepProgress(scaffolding(3), entries), 'A')).toBe(2)
  })
  // Plan's call 8. The lines are written raw: a line the CLI journals carries only the writer's
  // own stamp, never one it was handed.
  it('sessionActed counts acts and ignores bookkeeping', () => {
    const root = mkdtempSync(join(tmpdir(), 'witness-slice-'))
    const dir = join(root, '.witness', 'journal')
    mkdirSync(dir, { recursive: true })
    const line = (stream: string, e: Record<string, unknown>) => appendFileSync(join(dir, `${stream}.jsonl`), JSON.stringify({ v: 1, ...e }) + '\n')
    line('x', { t: 'ask', ctx: { session: 'h' } })
    line('x', { t: 'status', ctx: { session: 'h' } })
    expect(sessionActed(root, 'h')).toBe(false)
    line('y', { t: 'gate-run', ctx: { session: 'h' } })
    expect(sessionActed(root, 'h')).toBe(true)
    expect(sessionActed(root, 'other')).toBe(false)
  })
})
