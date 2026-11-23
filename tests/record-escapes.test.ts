import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stateCommit } from '../src/gitio.js'
import { appendEntry, journalRel, type FixCause } from '../src/journal.js'
import { escapesFold } from '../src/record.js'
import { loadCanon } from '../src/scan.js'
import { PLAN_BODY, RECAP, SPEC_BODY, approve, seededRepo, writePlan, writeSpec, type CliResult, type TestRepo } from './helpers.js'

// Row 254. The escapes fold: each live fix effort's confirmed cause, an escape charged (approximately)
// to the last non-chore plan of its amended spec that shipped before the fix was born, aged in merges,
// grouped by that plan's ship version. Decisions and chores are never charged; nothing is inferred.

const must = (r: CliResult) => { if (r.code !== 0) throw new Error(`${r.stdout}\n${r.stderr}`) }
const fold = (repo: TestRepo) => escapesFold(repo.root, loadCanon(repo.root))
const tagged = (spec: string) => ({ criteria: [{ id: 'ac-rotate', test: `@spec:${spec}` }] })

async function base(specs: string[] = ['auth-refresh', 'other']): Promise<TestRepo> {
  const repo = await seededRepo()                                  // auth-hardening: feature
  for (const id of specs) { must(await writeSpec(repo, id, tagged(id))); approve(repo, id) }
  return repo
}

// A ship gate-run as a CLI of `version` wrote it (appendEntry stamps the running CLI's version). The
// versions stay at or below the running CLI's: a later `w` raises the repo's floor and refuses the CLI.
const shipRun = (id: string, version: string) => ({
  v: 1, w: version, t: 'gate-run', gate: 'ship', artifact: id, round: 1, run_id: `r-${id}`, reviewed_sha: 's',
  prompts_sha: 'p', witness: version, model: 'm', checks: [], verdicts: [], outcome: 'passed',
})
let prs = 0
async function shipPlan(repo: TestRepo, id: string, parent: string,
  opts: { effort?: string; version?: string; trailer?: boolean } = {}): Promise<void> {
  must(await writePlan(repo, id, { parent }, PLAN_BODY, opts.effort ?? repo.effort))
  repo.flipStatus(id, 'done')                                     // a merged plan reads done in canon
  if (opts.version !== undefined) appendFileSync(join(repo.root, journalRel(id)), JSON.stringify(shipRun(id, opts.version)) + '\n')
  const pr = ++prs
  appendEntry(repo.root, id, { t: 'status', artifact: id, from: 'in-progress', to: 'done', cause: 'merge', pr })
  const subject = `merge(${id}): pr #${pr}`
  if (opts.trailer === false) { repo.git('add', journalRel(id)); repo.git('commit', '-m', subject) }
  else { const r = stateCommit(repo.root, [journalRel(id)], subject); if (!r.ok) throw new Error('stamp') }
}
async function recapFix(repo: TestRepo, slug: string, cause?: FixCause): Promise<void> {
  if (cause !== undefined) {
    repo.write('r.json', JSON.stringify({ ...RECAP, effort: slug, class: 'fix', cause }))
    must(await repo.cli(['recap', '--file', 'r.json']))
    return
  }
  appendEntry(repo.root, slug, { t: 'recap', effort: slug, class: 'fix', goals: [{ id: 'g1', text: 'x' }], non_goals: [], constraints: [], slices: [] })
  const r = stateCommit(repo.root, [journalRel(slug)], `recap(${slug}): fix`); if (!r.ok) throw new Error('seed')
}
async function recapOf(repo: TestRepo, slug: string, cls: 'feature' | 'chore', amend = false): Promise<void> {
  repo.write('r.json', JSON.stringify({ ...RECAP, effort: slug, class: cls }))
  must(await repo.cli(['recap', '--file', 'r.json', ...(amend ? ['--amend'] : [])]))
}
const amend = async (repo: TestRepo, effort: string, spec: string) => must(await writeSpec(repo, spec, tagged(spec), SPEC_BODY, effort))

describe('the escapes fold (row 254)', () => {
  it('no fix effort reads not measured', async () => {
    const repo = await base()
    await shipPlan(repo, 'auth-refresh-plan-1', 'auth-refresh')
    await shipPlan(repo, 'other-plan-1', 'other')
    expect(fold(repo)).toMatchObject({ measured: false, fixes: [], escapes: 0, decisions: 0, plans: 2 })
  })

  it('fixes with no cause read not measured and are listed', async () => {
    const repo = await base()
    await recapFix(repo, 'old-fix')
    expect(fold(repo)).toMatchObject({ measured: false, fixes: [{ effort: 'old-fix' }], escapes: 0, decisions: 0 })
  })

  it('an escape is charged to the last plan of its spec shipped before it, skipping chore plans, aged in merges', async () => {
    const repo = await base()
    await recapOf(repo, 'tidy-up', 'chore')
    await shipPlan(repo, 'auth-refresh-plan-1', 'auth-refresh', { version: '0.29.0' })
    await shipPlan(repo, 'auth-refresh-plan-2', 'auth-refresh', { effort: 'tidy-up', version: '0.29.0' })
    await shipPlan(repo, 'other-plan-1', 'other', { version: '0.29.0' })
    await recapFix(repo, 'rotation-race', 'escape')
    await amend(repo, 'rotation-race', 'auth-refresh')
    const f = fold(repo)
    expect(f.fixes).toEqual([{ effort: 'rotation-race', cause: 'escape', charged: { plan: 'auth-refresh-plan-1', version: '0.29.0', age: 2 } }])
    expect(f).toMatchObject({ measured: true, escapes: 1, decisions: 0, plans: 2 })
  })

  it('a decision is counted and never charged', async () => {
    const repo = await base()
    await shipPlan(repo, 'auth-refresh-plan-1', 'auth-refresh')
    await recapFix(repo, 'new-rule', 'decision')
    await amend(repo, 'new-rule', 'auth-refresh')
    expect(fold(repo)).toMatchObject({ measured: true, escapes: 0, decisions: 1, fixes: [{ effort: 'new-rule', cause: 'decision' }] })
    expect(fold(repo).fixes[0]).toEqual({ effort: 'new-rule', cause: 'decision' })
  })

  it('an escape raised before its spec shipped anything is uncharged', async () => {
    const repo = await base()
    await recapFix(repo, 'pairing-code-attempts', 'escape')
    await amend(repo, 'pairing-code-attempts', 'auth-refresh')
    approve(repo, 'auth-refresh')
    await shipPlan(repo, 'auth-refresh-plan-1', 'auth-refresh')
    expect(fold(repo).fixes).toEqual([{ effort: 'pairing-code-attempts', cause: 'escape', uncharged: 'nothing-shipped-before' }])
  })

  it('a chore is never charged', async () => {
    const repo = await base()
    await recapOf(repo, 'tidy-up', 'chore')
    await shipPlan(repo, 'auth-refresh-plan-1', 'auth-refresh', { effort: 'tidy-up' })
    await recapFix(repo, 'rotation-race', 'escape')
    await amend(repo, 'rotation-race', 'auth-refresh')
    const f = fold(repo)
    expect(f.fixes).toEqual([{ effort: 'rotation-race', cause: 'escape', uncharged: 'nothing-shipped-before' }])
    expect(f.plans).toBe(0)
  })

  it('an abandoned fix and a fix amended to a chore are not counted', async () => {
    const repo = await base()
    await shipPlan(repo, 'auth-refresh-plan-1', 'auth-refresh')
    await recapFix(repo, 'gone-fix', 'escape')
    await amend(repo, 'gone-fix', 'auth-refresh')
    must(await repo.cli(['abandon', 'gone-fix']))
    await recapFix(repo, 'now-chore', 'escape')
    await recapOf(repo, 'now-chore', 'chore', true)
    expect(fold(repo)).toMatchObject({ measured: false, fixes: [], escapes: 0, decisions: 0 })
  })

  it("escapes group by the charged plan's ship version; a plan with no ship run is unknown", async () => {
    const repo = await base()
    await shipPlan(repo, 'auth-refresh-plan-1', 'auth-refresh', { version: '0.29.0' })
    await shipPlan(repo, 'other-plan-1', 'other', { version: '0.9.1' })
    await shipPlan(repo, 'other-plan-2', 'other', { version: '0.14.4' })
    await shipPlan(repo, 'other-plan-3', 'other')
    await recapFix(repo, 'rotation-race', 'escape')
    await amend(repo, 'rotation-race', 'auth-refresh')
    // by number, not by text: 0.9.1 sorts below 0.14.4
    expect(fold(repo).byVersion).toEqual([
      { version: '0.29.0', escapes: 1, plans: 1 }, { version: '0.14.4', escapes: 0, plans: 1 },
      { version: '0.9.1', escapes: 0, plans: 1 }, { version: 'unknown', escapes: 0, plans: 1 },
    ])
  })

  it('with no state commits to order by, an escape is uncharged, never charged to a wrong plan', async () => {
    const repo = await base()
    await shipPlan(repo, 'auth-refresh-plan-1', 'auth-refresh', { trailer: false })
    await recapFix(repo, 'rotation-race', 'escape')
    await amend(repo, 'rotation-race', 'auth-refresh')
    const f = fold(repo)
    expect(f.fixes).toEqual([{ effort: 'rotation-race', cause: 'escape', uncharged: 'order-unknown' }])
    expect(f.plans).toBe(1)
  })

  // Slice 2 review F2. A candidate the clock cannot place may have shipped after the charged one.
  it('a candidate the clock cannot place leaves the escape uncharged, even beside a placed one', async () => {
    const repo = await base()
    await shipPlan(repo, 'auth-refresh-plan-1', 'auth-refresh')
    await shipPlan(repo, 'auth-refresh-plan-2', 'auth-refresh', { trailer: false })
    await recapFix(repo, 'rotation-race', 'escape')
    await amend(repo, 'rotation-race', 'auth-refresh')
    expect(fold(repo).fixes).toEqual([{ effort: 'rotation-race', cause: 'escape', uncharged: 'order-unknown' }])
  })

  it("a fix is born at its effort's first recap, whatever its class then", async () => {
    const repo = await base()
    await recapOf(repo, 'turned-fix', 'feature')
    await shipPlan(repo, 'auth-refresh-plan-1', 'auth-refresh')
    repo.write('r.json', JSON.stringify({ ...RECAP, effort: 'turned-fix', class: 'fix', cause: 'escape' }))
    must(await repo.cli(['recap', '--amend', '--file', 'r.json']))
    await amend(repo, 'turned-fix', 'auth-refresh')
    expect(fold(repo).fixes).toEqual([{ effort: 'turned-fix', cause: 'escape', uncharged: 'nothing-shipped-before' }])
  })

  // Slice 3 review M1. An escape whose writes name no spec in canon — recapped but not yet decomposed,
  // or its spec renamed since — has nothing to charge against, which is not "nothing shipped before".
  it('an escape that names no spec in canon is uncharged as having no amended spec', async () => {
    const repo = await base()
    await shipPlan(repo, 'auth-refresh-plan-1', 'auth-refresh')
    await recapFix(repo, 'not-yet-decomposed', 'escape')
    expect(fold(repo).fixes).toEqual([{ effort: 'not-yet-decomposed', cause: 'escape', uncharged: 'no-amended-spec' }])
  })

  it('an escape whose spec was renamed since is uncharged as having no amended spec', async () => {
    const repo = await base()
    await shipPlan(repo, 'auth-refresh-plan-1', 'auth-refresh')
    await recapFix(repo, 'rotation-race', 'escape')
    await amend(repo, 'rotation-race', 'auth-refresh')
    must(await repo.cli(['rename', 'auth-refresh', 'auth-session']))
    expect(fold(repo).fixes).toEqual([{ effort: 'rotation-race', cause: 'escape', uncharged: 'no-amended-spec' }])
  })

  it("fewhats' shape: three fixes split escape and decision", async () => {
    const repo = await base(['signin-email-code', 'laptop-pairing', 'instagram-channel'])
    await shipPlan(repo, 'signin-email-code-plan-1', 'signin-email-code', { version: '0.14.4' })
    await recapFix(repo, 'single-use-code-race', 'escape')
    await amend(repo, 'single-use-code-race', 'signin-email-code')
    await recapFix(repo, 'pairing-code-attempts', 'decision')
    await amend(repo, 'pairing-code-attempts', 'laptop-pairing')
    await recapFix(repo, 'browser-exposure-posture', 'decision')
    await amend(repo, 'browser-exposure-posture', 'instagram-channel')
    const f = fold(repo)
    expect(f).toMatchObject({ measured: true, escapes: 1, decisions: 2, plans: 1 })
    expect(f.fixes.map((x) => x.effort)).toEqual(['browser-exposure-posture', 'pairing-code-attempts', 'single-use-code-race'])
    expect(f.fixes[2]).toEqual({ effort: 'single-use-code-race', cause: 'escape', charged: { plan: 'signin-email-code-plan-1', version: '0.14.4', age: 0 } })
  })
})
