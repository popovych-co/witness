import { describe, expect, it } from 'vitest'
import { appendEntry } from '../src/journal.js'
import { autonomyOn, nextLine, seededRepo, shippableRepo } from './helpers.js'

describe('next — the ask rung (A9)', () => {
  it('routes the oldest unanswered ask to brainstorm with its text', async () => {
    const repo = await seededRepo({ noRecap: true })
    await repo.cli(['ask', 'first thing'])
    await repo.cli(['ask', 'second thing'])
    const out = await nextLine(repo)
    expect(out).toContain('next: witness recap --file <recap.json> --ask a1')
    expect(out).toContain('stage: brainstorm')
    expect(out).toContain('ask: a1 — first thing')
    expect(out).not.toContain('target:')
  })

  it('a new ask does not wait for another effort to finish', async () => {
    const repo = await seededRepo()                         // a live effort owes its decompose write
    expect(await nextLine(repo)).toContain('stage: decompose')
    await repo.cli(['ask', 'another feature'])
    expect(await nextLine(repo)).toContain('--ask a1')
  })

  it('a flow in flight still comes first', async () => {
    const { repo, planId } = await shippableRepo()
    await repo.cli(['ask', 'another feature'])
    expect(await nextLine(repo)).toContain(`gate implement ${planId}`)
  })

  it('skips withdrawn and answered asks', async () => {
    const repo = await seededRepo({ noRecap: true })
    await repo.cli(['ask', 'one'])
    await repo.cli(['ask', 'two'])
    await repo.cli(['ask', '--withdraw', 'a1'])
    expect(await nextLine(repo)).toContain('--ask a2')
    await repo.cli(['recap', '--file', repo.writeRecap({}), '--ask', 'a2'])
    expect(await nextLine(repo)).not.toContain('--ask')
  })

  it('prints a multi-line ask on one line', async () => {
    const repo = await seededRepo({ noRecap: true })
    await repo.cli(['ask', 'line one\n\n  line two, with a comma'])
    const lines = (await nextLine(repo)).split('\n').filter((l) => l.startsWith('ask:'))
    expect(lines).toEqual(['ask: "a1 — line one line two, with a comma"'])
  })

  it('under autonomy with no ask and no effort the grill opens, as without autonomy', async () => {
    const repo = await seededRepo({ noRecap: true })
    autonomyOn(repo)
    const out = await nextLine(repo)
    expect(out).toContain('next: witness recap --file <recap.json>')
    expect(out).toContain('stage: brainstorm')
    expect(out).not.toContain('nothing to build')
  })

  it('an ask that still holds old recap checks reads unanswered', async () => {
    const repo = await seededRepo({ noRecap: true })
    await repo.cli(['ask', 'one'])
    for (const round of [1, 2, 3]) appendEntry(repo.root, 'asks', {
      v: 1, t: 'human-decision', gate: 'recap', artifact: 'a1', round, run_id: `r${round}`,
      decision: 'revise', selected: 'arbiter', reason: 'no', effort: 'x', class: 'feature',
    } as never)
    expect(await nextLine(repo)).toContain('ask: a1 — one')
    expect((await repo.cli(['status'])).stdout).toContain('  a1,queued,one')
  })

  it('status lists the unanswered asks', async () => {
    const repo = await seededRepo({ noRecap: true })
    await repo.cli(['ask', 'one'])
    await repo.cli(['ask', 'two'])
    await repo.cli(['ask', '--withdraw', 'a2'])
    const st = await repo.cli(['status'])
    expect(st.stdout).toContain('asks[1]{id,state,text}:')
    expect(st.stdout).toContain('  a1,queued,one')
  })
})
