import { describe, expect, it } from 'vitest'
import type { Entry } from '../src/journal.js'
import { deltaBlock, planDelta } from '../src/delta.js'
import { snapshotFiles } from '../src/snapshot.js'
import { tmpRepo } from './helpers.js'

const V1 = '## Step: s1\nA\n\n## Step: s2\nS\n'
const V2 = '## Step: s1\nB\n\n## Step: s2\nS\n'
function stream() {
  const repo = tmpRepo()
  const from = snapshotFiles(repo.root, [{ name: 'p.md', content: V1 }])!
  const to = snapshotFiles(repo.root, [{ name: 'p.md', content: V2 }])!
  const base = {
    v: 1, t: 'gate-run', gate: 'plan', artifact: 'p', round: 1, run_id: 'r-1', reviewed_sha: 'A',
    prompts_sha: 'ps', witness: '0', model: 'm', pin: 'm', calibration: 'none', checks: [], outcome: 'stopped',
    reviewed_tree: from, basis_sha: 'B1',
    verdicts: [
      { reviewer: 'plan-critic', coverage: [], findings: [
        { blocking: true, anchor: 'p > ## Step: s1', claim: 'untestable' },
        { blocking: false, anchor: 'p > ## Step: s2', claim: 'nit' }] },
      { reviewer: 'design-reviewer', coverage: [], findings: [{ blocking: true, anchor: 'home.png', claim: 'off-look' }] },
    ],
  } as unknown as Entry
  const cur = (over: Record<string, unknown> = {}) => ({
    reviewedSha: 'B', snapshot: { tree: to, context: 'c' }, basis: 'B1',
    reviewed: { kind: 'docs' as const, docs: [{ id: 'p', body: V2 }] },
    inDelta: (lens: string) => lens !== 'design-reviewer', ...over,
  })
  return { repo, from, to, base, cur }
}

describe('planDelta', () => {
  it('plans against the base — its blocking findings, the diff and the unit view', () => {
    const { repo, base, cur } = stream()
    const plan = planDelta(repo.root, [base], 'plan', cur())!
    expect(plan.baseRound).toBe(1)
    expect(plan.base.run_id).toBe('r-1')
    expect(plan.prior).toEqual([{ reviewer: 'plan-critic', anchor: 'p > ## Step: s1', claim: 'untestable' }])
    expect([...plan.reported].sort()).toEqual(['home.png', 'p > ## Step: s1'])     // the screens lens still counts
    expect(plan.diff).toContain('-A')
    expect(plan.diff).toContain('+B')
    expect(plan.view.state('p > ## Step: s2')).toBe('unchanged')
  })

  it('declines when the basis moved, a tree is missing or gone, or nothing differs', () => {
    const { repo, from, base, cur } = stream()
    const gone = { ...(base as object), reviewed_tree: 'f'.repeat(40) } as unknown as Entry
    expect(planDelta(repo.root, [base], 'plan', cur({ basis: 'B2' }))).toBeUndefined()
    expect(planDelta(repo.root, [{ ...(base as object), reviewed_tree: undefined } as unknown as Entry], 'plan', cur())).toBeUndefined()
    expect(planDelta(repo.root, [base], 'plan', cur({ snapshot: undefined }))).toBeUndefined()
    expect(planDelta(repo.root, [gone], 'plan', cur())).toBeUndefined()
    expect(planDelta(repo.root, [base], 'plan', cur({ snapshot: { tree: from, context: 'c' } }))).toBeUndefined()
  })

  // Plan decision 10: at the doc gates the block also names the sections the change touched.
  it('at a doc gate lists the sections the change touched, by anchor', () => {
    const { repo, base, cur } = stream()
    expect(planDelta(repo.root, [base], 'plan', cur())!.sections).toEqual(['p > ## Step: s1'])
  })
})

describe('deltaBlock', () => {
  it('lists the base round blocking findings and the change in the shipped copy', () => {
    const b = deltaBlock({ baseRound: 1, diff: 'DIFF', prior: [
      { reviewer: 'plan-critic', anchor: 'p > ## Step: s1', claim: 'untestable' },
      { reviewer: 'code-reviewer', anchor: { kind: 'omission', scope: 'tests/' }, claim: 'no test' }] })
    expect(b.startsWith('## Delta review — round 1 to now\n\n')).toBe(true)
    expect(b).toContain('1. p > ## Step: s1 — untestable (plan-critic)')
    expect(b).toContain('2. {"kind":"omission","scope":"tests/"} — no test (code-reviewer)')
    expect(b).toContain('### Change since round 1\n\nDIFF\n')
    expect(b).toContain('anchor it at the changed code or section that caused it')
    expect(b).not.toContain('### Sections changed')
    expect(b.endsWith('\n\n')).toBe(true)
  })
  it('says so when the base round blocked nothing', () => {
    expect(deltaBlock({ baseRound: 2, diff: 'D', prior: [] })).toContain('None — round 2 reported no blocking finding.')
  })
  it('names the touched sections before the diff when there are any', () => {
    const b = deltaBlock({ baseRound: 1, diff: 'DIFF', prior: [], sections: ['p > ## Step: s1', 'p > ### Detail'] })
    expect(b).toContain('### Sections changed since round 1\n\n- p > ## Step: s1\n- p > ### Detail\n\n### Change since round 1')
  })
})
