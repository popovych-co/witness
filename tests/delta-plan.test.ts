import { describe, expect, it } from 'vitest'
import type { Entry } from '../src/journal.js'
import { deltaBlock, demote, demotionsBlock, outstandingDemotions, planDelta, reportedBy } from '../src/delta.js'
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
    prompts_sha: 'ps', witness: '0', model: 'm', pin: 'm', checks: [], outcome: 'stopped',
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
    expect(['home.png', 'p > ## Step: s1', 'p > ## Step: s2'].map((a) => plan.reported(a))).toEqual([true, true, false])   // the screens lens still counts
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
  it('at a tree gate lists the paths the change touched, canon left out (row 208)', () => {
    const s = stream()
    const from = snapshotFiles(s.repo.root, [{ name: 'a.ts', content: '1' }, { name: 'specs', content: 'x' }, { name: 'b.ts', content: 'same' }])!
    const to = snapshotFiles(s.repo.root, [{ name: 'a.ts', content: '2' }, { name: 'specs', content: 'y' }, { name: 'b.ts', content: 'same' }])!
    const base = { ...(s.base as object), gate: 'implement', reviewed_tree: from } as unknown as Entry
    const plan = planDelta(s.repo.root, [base], 'implement', {
      reviewedSha: 'B', snapshot: { tree: to, context: 'c' }, basis: 'B1', inDelta: () => true,
      reviewed: { kind: 'tree', root: s.repo.root, files: ['a.ts'], canonRoot: s.repo.root, canonDirs: ['specs'] },
    })!
    expect(plan.paths).toEqual(['a.ts'])
    expect(planDelta(s.repo.root, [s.base], 'plan', s.cur())!.paths).toBeUndefined()
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
  it('names the files the change touched and the floor before the diff (row 208)', () => {
    const b = deltaBlock({ baseRound: 1, diff: 'DIFF', prior: [], paths: ['src/a.ts', 'src/gone.ts'] })
    expect(b).toContain('the verdict contract applies to it unchanged — except the coverage floor, which counts only the files listed under "Files changed since round 1".\n\n')
    expect(b).toContain('### Files changed since round 1\n\n- src/a.ts\n- src/gone.ts\n\nCover at least 2 of these files, each with its own coverage anchor.\n\n### Change since round 1')
    expect(deltaBlock({ baseRound: 1, diff: 'D', prior: [] })).toContain('the verdict contract applies to it unchanged.\n\n')
  })
})

describe('demote', () => {
  const unchanged = { state: () => 'unchanged' as const }
  const f = (anchor: unknown, extra: Record<string, unknown> = {}) => ({ blocking: true, anchor, claim: 'x', ...extra })
  const d = (view = unchanged, reported: string[] = []) => ({ baseRound: 1, reported: (a: unknown) => reported.includes(a as string), view })
  const inDelta = (lens: string) => lens !== 'design-reviewer'

  it('demotes a blocking finding in an unchanged unit that the base did not report', () => {
    const [v] = demote([{ reviewer: 'code-reviewer', coverage: [], findings: [f('src/a.ts')] }] as never, d(), inDelta)
    expect(v!.findings).toEqual([{ blocking: false, anchor: 'src/a.ts', claim: 'x', demoted: 1 }])
  })

  it('leaves reported, changed, context, pin-contradicting, non-blocking and override-lens findings alone', () => {
    const changed = { state: (a: unknown) => (a === 'c' ? 'changed' as const : a === 'ctx' ? 'context' as const : 'unchanged' as const) }
    const verdicts = [
      { reviewer: 'code-reviewer', coverage: [], findings: [f('rep'), f('c'), f('ctx'), f('pin', { contradicts_pin: 1 }), f('nb', { blocking: false })] },
      { reviewer: 'design-reviewer', coverage: [], findings: [f('initial.png')] },
    ]
    expect(demote(verdicts as never, d(changed, ['rep']), inDelta)).toEqual(verdicts)
  })
})

// Plan decision 16 · spec §7 C3: ship receives implement's outstanding demotions by name.
describe('outstandingDemotions and demotionsBlock (ship backstops implement)', () => {
  const run = (round: number, findings: unknown[], extra: Record<string, unknown> = {}) => ({
    v: 1, t: 'gate-run', gate: 'implement', artifact: 'p', round, run_id: `r-${round}`, reviewed_sha: `s${round}`,
    prompts_sha: 'p', witness: '0', model: 'm', pin: 'm', checks: [], outcome: 'stopped',
    verdicts: [{ reviewer: 'code-reviewer', coverage: [], findings }], ...extra,
  }) as unknown as Entry
  const dem = (anchor: unknown, since: number, claim = 'x') => ({ blocking: false, anchor, claim, demoted: since })
  const delta = (round: number) => ({ delta: { round, run: `r-${round}` } })
  const OM = { kind: 'omission', scope: 'tests/' }

  it('lists the demotions since the last full review, one per lens and anchor, the latest kept', () => {
    const e = [
      run(1, [{ blocking: true, anchor: 'a.ts', claim: 'full' }]),
      run(2, [dem('a.ts', 1, 'first')], delta(1)),
      run(3, [dem('a.ts', 2, 'second'), dem(OM, 2)], delta(2)),
      run(4, [dem('b.ts', 3)], { ...delta(3), outcome: 'malformed' }),
      { ...(run(5, [dem('c.ts', 1)], delta(1)) as object), gate: 'ship' } as unknown as Entry,
    ]
    expect(outstandingDemotions(e, 'implement')).toEqual([
      { reviewer: 'code-reviewer', anchor: 'a.ts', claim: 'second', round: 3, since: 2 },
      { reviewer: 'code-reviewer', anchor: OM, claim: 'x', round: 3, since: 2 },
    ])
  })

  // Final review M1: a cached replay re-judged nothing — it re-served an older verdict.
  it('a cached replay of a full verdict is no re-judgment', () => {
    const e = [run(1, []), run(2, [dem('a.ts', 1)], delta(1)), run(3, [], { cached: true })]
    expect(outstandingDemotions(e, 'implement').map((d) => d.anchor)).toEqual(['a.ts'])
  })

  it('a later full review re-judged them all', () => {
    const e = [run(1, []), run(2, [dem('a.ts', 1)], delta(1)), run(3, [])]
    expect(outstandingDemotions(e, 'implement')).toEqual([])
  })

  it('renders each with its anchor, lens and round, and nothing when there are none', () => {
    const b = demotionsBlock('implement', [
      { reviewer: 'code-reviewer', anchor: 'a.ts#f', claim: 'leaks', round: 3, since: 2 },
      { reviewer: 'pr-test', anchor: OM as never, claim: 'no test', round: 2, since: 1 }])
    expect(b.startsWith('## Demoted at implement')).toBe(true)
    expect(b).toContain('1. a.ts#f — leaks — code-reviewer · implement round 3')
    expect(b).toContain('2. omission · scope tests/ — no test — pr-test · implement round 2 — report it with "anchor": { "kind": "omission", "scope": "tests/" }')
    expect(b).toContain('it then blocks here')
    expect(b.endsWith('\n\n')).toBe(true)
    expect(demotionsBlock('implement', [])).toBe('')
  })
})

// Final review #5: a prior blocker re-reported under another spelling is the same finding.
describe('reportedBy at the code gates (C3, final review)', () => {
  const f = (anchor: unknown) => ({ blocking: true, anchor, claim: 'x' })
  const unchanged = { state: () => 'unchanged' as const }
  const run = (reported: (a: unknown) => boolean, anchors: unknown[]) =>
    demote([{ reviewer: 'code-reviewer', coverage: [], findings: anchors.map(f) }] as never, { baseRound: 1, reported: reported as never, view: unchanged }, () => true)[0]!
      .findings.map((x) => x.blocking)

  it('normalizes the path, and a bare path matches any anchor in its file', () => {
    const r = reportedBy(['src/token.ts#nextToken', { kind: 'omission', scope: 'tests/' }], true)
    expect(run(r, ['./src/token.ts#nextToken', 'src/token.ts', { kind: 'omission', scope: './tests' }])).toEqual([true, true, true])
    expect(run(r, ['src/token.ts#other', 'src/other.ts'])).toEqual([false, false])     // new in an unchanged file: demotable
  })

  it('a bare path the base reported covers every symbol in its file', () => {
    expect(run(reportedBy(['src/a.ts'], true), ['src/a.ts#f', './src/a.ts'])).toEqual([true, true])
  })

  it('doc anchors compare exactly', () => {
    expect(run(reportedBy(['p > ## Step: s1'], false), ['p > ## Step: s1', 'p'])).toEqual([true, false])
  })
})
