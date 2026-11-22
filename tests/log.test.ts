import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendEntry } from '../src/journal.js'
import { entryDetail } from '../src/verbs/log.js'
import { SPEC_META, commitEntry, evidenceCycle, seededRepo, startedThreeStepPlan, threeStepPlan, writeSpec } from './helpers.js'

describe('witness log', () => {
  it('renders recap, write, and write-refused entries in order', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    await writeSpec(repo, 'auth-refresh', { ...SPEC_META, summary: 'x'.repeat(121) })
    const res = await repo.cli(['log', 'auth-hardening'])
    expect(res.code).toBe(0)
    const [header, r1, r2, r3] = res.stdout.split('\n')
    expect(header).toBe('entries[3]{n,t,detail}:')
    expect(r1).toContain('recap')
    expect(r1).toContain('class=feature goals=1')
    expect(r2).toContain('write')
    expect(r2).toContain('artifact=auth-refresh')
    expect(r2).toContain('covers=g1')
    expect(r3).toContain('write-refused')
    expect(r3).toContain('summary:max-length')
  })

  it('refuses unknown streams', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['log', 'ghost'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('unknown-stream')
  })
})

// Row 191 §4.3. A plan's log ends with where it stands, and each row names the step it closes.
describe('witness log reads plan steps', () => {
  it('prints steps: after a plan\'s rows and names each row\'s step', async () => {
    const { repo, wt, planId: P } = await startedThreeStepPlan()
    expect((await evidenceCycle(repo, wt, P, 's1')).code).toBe(0)

    const one = (await repo.cli(['log', P])).stdout.split('\n')
    expect(one.at(-1)).toBe('steps: 1/3 done · next s2')
    expect(one.filter((l) => l.includes(',test-evidence,'))).toEqual([
      expect.stringMatching(/,test-evidence,phase=red step=s1 tests=1 failed=1$/),
      expect.stringMatching(/,test-evidence,phase=green step=s1 tests=1 failed=0$/),
    ])

    expect((await repo.cli(['step-close', P, '--step', 's3'])).code).toBe(0)
    const two = (await repo.cli(['log', P])).stdout.split('\n')
    expect(two.at(-1)).toBe('steps: 2/3 done · next s2')
    expect(two.at(-2)).toMatch(/,step-close,step=s3$/)

    expect((await repo.cli(['log', repo.effort])).stdout).not.toContain('steps:')
  })

  // A red that passed is marked vacuous, and one verify-red reconstructed against the base is marked
  // reconstructed: neither reads as a plain red.
  it('marks a vacuous red and a reconstructed one', async () => {
    const repo = await threeStepPlan()
    const P = 'auth-refresh-plan-1'
    const red = (ok: boolean, marks: Record<string, true>) => ({
      t: 'test-evidence' as const, artifact: P, phase: 'red', step: 's1', runner: 'filtered',
      tests: [{ name: 'rotates token before expiry @spec:auth-refresh', ok }], ...marks,
    })
    commitEntry(repo, P, red(true, { vacuous: true }))
    commitEntry(repo, P, red(false, { reconstructed: true }))
    commitEntry(repo, P, red(true, { reconstructed: true, vacuous: true }))
    const rows = (await repo.cli(['log', P])).stdout.split('\n').filter((l) => l.includes(',test-evidence,'))
    expect(rows).toEqual([
      expect.stringMatching(/,test-evidence,phase=red step=s1 tests=1 failed=0 vacuous$/),
      expect.stringMatching(/,test-evidence,phase=red step=s1 tests=1 failed=1 reconstructed$/),
      expect.stringMatching(/,test-evidence,phase=red step=s1 tests=1 failed=0 vacuous reconstructed$/),
    ])
  })
})

describe('witness log says who decided (A5)', () => {
  it('names the arbiter and its model on an autonomous decision', async () => {
    const repo = await seededRepo()
    appendEntry(repo.root, repo.effort, {
      v: 1, t: 'human-decision', gate: 'decompose', artifact: repo.effort, round: 1, decision: 'approve',
      selected: 'arbiter', reason: 'the slice covers g1', arbiter: { model: 'test-model-1', prompts_sha: 'p' }, rule: 'reserved-stop-clean',
    })
    appendEntry(repo.root, repo.effort, { v: 1, t: 'human-decision', gate: 'decompose', artifact: repo.effort, round: 1, decision: 'revise' })
    const out = (await repo.cli(['log', repo.effort])).stdout
    expect(out).toContain('decompose: approve · arbiter · test-model-1')
    expect(out).toMatch(/decompose: revise$/m)
  })
})

// D189. `log --all` orders every journal line by the commit that appended it, read by the same
// blame abandon reads (`journalActs`): a dotfile's blame config or a blank line must not reorder it.
describe('log --all reads each line\'s commit (D189)', () => {
  it('a blame config the repo cannot satisfy does not reorder the journal', async () => {
    const repo = await seededRepo({ slug: 'zeta' })                       // the effort's stream sorts last
    await writeSpec(repo, 'auth-tokens', { criteria: [{ id: 'ac-tokens', test: '@spec:auth-tokens' }] })
    await writeSpec(repo, 'token-rotation', { supersedes: 'auth-tokens', criteria: [{ id: 'ac-rotation', test: '@spec:token-rotation' }] })
    repo.git('config', 'blame.ignoreRevsFile', '.git-blame-ignore-revs')   // absent here
    const all = await repo.cli(['log', '--all'])
    expect(all.code).toBe(0)
    expect(all.stdout.indexOf('superseded')).toBeGreaterThanOrEqual(0)
    expect(all.stdout.indexOf('recap')).toBeLessThan(all.stdout.indexOf('superseded'))   // commit order, not stream name
  })

  it('a blank journal line does not shift the lines after it onto the wrong commit', async () => {
    const { journalActs } = await import('../src/journal.js')
    const repo = await seededRepo()
    appendFileSync(join(repo.root, '.witness/journal/auth-hardening.jsonl'), '\n')
    repo.git('add', '.witness/journal/auth-hardening.jsonl')
    repo.git('commit', '-q', '-m', 'a blank line', '-m', 'Witness-State: 1')
    await writeSpec(repo, 'auth-refresh')
    const write = journalActs(repo.root, 'auth-hardening').find(({ entry }) => entry.t === 'write')!
    expect(write.commit).toBe(repo.git('rev-parse', 'HEAD'))               // the write's own commit
  })
})

// Row 244 (the final review's M1). A hand-back (`gate --unchanged`) reads in words, as a decision does,
// in `witness log` and drive's `journal:` line alike — never as cut-off raw JSON.
describe('witness log — a hand-back (row 244)', () => {
  const back = { v: 1 as const, t: 'revise-returned' as const, gate: 'plan', artifact: 'auth-refresh-plan-1', run_id: 'r-7f3a9c', sha: 'a'.repeat(64) }

  it('names the gate and the run handed back', () => {
    expect(entryDetail(back)).toBe('plan: handed back · run r-7f3a9c')
  })

  it('says manual when the hand-back was --manual', () => {
    expect(entryDetail({ ...back, manual: true })).toBe('plan: handed back · run r-7f3a9c · manual')
  })

  // Rows 205, 244. A journal line is foreign text (a hand edit, a session's note): every detail, in
  // every branch, prints through logSafe — an escape sequence or a bidi override is spelled out,
  // never sent to the terminal raw.
  it('spells out control and bidi characters in every detail it prints', () => {
    const esc = '\u001b[2J'
    const rlo = '\u202e'
    const handBack = entryDetail({ ...back, gate: `plan${rlo}`, run_id: `r-1${esc}` })
    expect(handBack).toBe('plan\\u{202e}: handed back · run r-1\\x1b[2J')
    const decision = entryDetail({ v: 1, t: 'human-decision', gate: 'plan', artifact: 'p', decision: 'revise', note: `fix it${rlo}${esc}` })
    expect(decision).toBe('plan: revise — fix it\\u{202e}\\x1b[2J')
    const status = entryDetail({ v: 1, t: 'status', from: 'draft', to: 'approved', cause: `bell\u0007\u2028` })
    expect(status).toBe('draft → approved (bell\\x07\\u{2028})')
    for (const s of [handBack, decision, status]) expect(s).not.toMatch(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/)
  })

  it('witness log spells out a hand-edited type and detail, never prints them raw', async () => {
    const repo = await threeStepPlan()
    const P = 'auth-refresh-plan-1'
    appendFileSync(join(repo.root, '.witness/journal', `${P}.jsonl`),
      `${JSON.stringify({ ...back, artifact: P, run_id: 'r-1\u001b[31m' })}\n${JSON.stringify({ v: 1, t: 'odd\u202e', x: 'y' })}\n`)
    const res = await repo.cli(['log', P])
    expect(res.code).toBe(0)
    expect(res.stdout).not.toMatch(/[\u001b\u202e]/)
    expect(res.stdout).toContain('plan: handed back · run r-1\\x1b[31m')
    expect(res.stdout).toContain(',odd\\u{202e},')
  })

  // Rows 205, 239 (B15). A stream's id is its file's name, which a commit can make anything: the
  // stream cell and the lineage line are spelled out, never printed raw.
  it('witness log --all and --lineage spell out a stream name carrying a bidi override', async () => {
    const repo = await threeStepPlan()
    const odd = 'odd\u202e'
    appendFileSync(join(repo.root, '.witness/journal', `${odd}.jsonl`), `${JSON.stringify({ v: 1, t: 'step-close', step: 's1' })}\n`)
    const all = await repo.cli(['log', '--all'])
    expect(all.code).toBe(0)
    expect(all.stdout).not.toMatch(/[\u202e]/)
    expect(all.stdout).toContain(',odd\\u{202e},step-close,step=s1')
    const lineage = await repo.cli(['log', odd, '--lineage'])
    expect(lineage.code).toBe(0)
    expect(lineage.stdout).not.toMatch(/[\u202e]/)
    expect(lineage.stdout.split('\n')[0]).toBe('lineage: odd\\u{202e}')
    expect(lineage.stdout).toContain(',odd\\u{202e},step-close,step=s1')
  })

  // A superseded stream's `by` is parsed journal text: the chain follows it only as a well-formed id,
  // so an ill-formed one — a path, a control character — ends the chain and is never read as a stream.
  it('an ill-formed by ends the lineage chain and is never read as a stream', async () => {
    const repo = await threeStepPlan()
    const journal = join(repo.root, '.witness/journal')
    const superseded = (by: string) => `${JSON.stringify({ v: 1, t: 'status', from: 'approved', to: 'superseded', cause: 'reslice', by })}\n`
    appendFileSync(join(journal, 'old-a.jsonl'), superseded('../outside'))
    // what the path would reach, were it read: a stream outside the journal, superseded onward
    appendFileSync(join(repo.root, '.witness', 'outside.jsonl'), `${JSON.stringify({ v: 1, t: 'step-close', step: 'leaked' })}\n`)
    appendFileSync(join(journal, 'old-b.jsonl'), superseded('next-b\u001b[2J'))
    appendFileSync(join(journal, 'old-c.jsonl'), superseded('new-c'))
    appendFileSync(join(journal, 'new-c.jsonl'), `${JSON.stringify({ v: 1, t: 'step-close', step: 's1' })}\n`)

    const a = await repo.cli(['log', 'old-a', '--lineage'])
    expect(a.code).toBe(0)
    expect(a.stdout.split('\n')[0]).toBe('lineage: old-a')
    expect(a.stdout).not.toContain('leaked')
    const b = await repo.cli(['log', 'old-b', '--lineage'])
    expect(b.stdout.split('\n')[0]).toBe('lineage: old-b')
    expect(b.stdout).not.toMatch(/[\u001b]/)
    // a well-formed by is followed, as before
    expect((await repo.cli(['log', 'old-c', '--lineage'])).stdout.split('\n')[0]).toBe('lineage: old-c → new-c')
  })

  it('prints the hand-back row through witness log', async () => {
    const repo = await threeStepPlan()
    const P = 'auth-refresh-plan-1'
    appendFileSync(join(repo.root, '.witness/journal', `${P}.jsonl`), `${JSON.stringify({ ...back, artifact: P })}\n`)
    const rows = (await repo.cli(['log', P])).stdout.split('\n').filter((l) => l.includes(',revise-returned,'))
    expect(rows).toEqual([expect.stringMatching(/,revise-returned,plan: handed back · run r-7f3a9c$/)])
  })
})

const D = [{ id: 'd1', text: 'Rotation is server-side' }, { id: 'd2', text: 'Rotate at 80% of the TTL' }]

describe('witness log — decisions (row 198)', () => {
  it('names decisions on the recap and carries on the write', async () => {
    const repo = await seededRepo()
    await repo.cli(['recap', '--amend', '--file', repo.writeRecap({ decisions: D })])
    expect((await writeSpec(repo, 'auth-refresh', { carries: ['d1', 'd2'] })).code).toBe(0)
    const res = await repo.cli(['log', 'auth-hardening'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('decisions=2')
    expect(res.stdout).toContain('carries=d1+d2')
  })
})
