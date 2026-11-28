import { appendFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { driveReport, runStart } from '../src/drive-report.js'
import { stateCommit } from '../src/gitio.js'
import { appendEntry, journalRel, type FixCause } from '../src/journal.js'
import * as models from '../src/models.js'
import { record, recordTables, type TrackRecord } from '../src/record.js'
import { loadCanon } from '../src/scan.js'
import { PLAN_BODY, RECAP, SPEC_BODY, approve, fakeCtx, seededRepo, writePlan, writeSpec, type CliResult, type TestRepo } from './helpers.js'

// Row 254. The record's surfaces: plain `status` prints one `record:` line and the fixes still owing a
// cause; `status --record` prints the record in full; drive's report carries the line; the models
// entry exports it as plain data. Nothing that decides reads it (decision 8).

const must = (r: CliResult) => { if (r.code !== 0) throw new Error(`${r.stdout}\n${r.stderr}`) }
const tagged = (spec: string) => ({ criteria: [{ id: 'ac-rotate', test: `@spec:${spec}` }] })
let prs = 0
async function shipPlan(repo: TestRepo, id: string, parent: string, version?: string): Promise<void> {
  must(await writePlan(repo, id, { parent }, PLAN_BODY))
  repo.flipStatus(id, 'done')
  if (version !== undefined) {
    appendFileSync(join(repo.root, journalRel(id)), JSON.stringify({ v: 1, w: version, t: 'gate-run', gate: 'ship', artifact: id,
      round: 1, run_id: `r-${id}`, reviewed_sha: 's', prompts_sha: 'p', witness: version, model: 'm', checks: [], outcome: 'passed' }) + '\n')
  }
  const pr = ++prs
  appendEntry(repo.root, id, { t: 'status', artifact: id, from: 'in-progress', to: 'done', cause: 'merge', pr })
  const r = stateCommit(repo.root, [journalRel(id)], `merge(${id}): pr #${pr}`); if (!r.ok) throw new Error('stamp')
}
async function fix(repo: TestRepo, slug: string, spec: string, cause?: FixCause): Promise<void> {
  if (cause !== undefined) {
    repo.write('r.json', JSON.stringify({ ...RECAP, effort: slug, class: 'fix', cause }))
    must(await repo.cli(['recap', '--file', 'r.json']))
  } else {
    appendEntry(repo.root, slug, { t: 'recap', effort: slug, class: 'fix', goals: [{ id: 'g1', text: 'x' }], non_goals: [], constraints: [], slices: [] })
    const r = stateCommit(repo.root, [journalRel(slug)], `recap(${slug}): fix`); if (!r.ok) throw new Error('seed')
  }
  must(await writeSpec(repo, spec, tagged(spec), SPEC_BODY, slug))
}

// One charged escape (aged one merge), one decision, one fix that predates causes, two shipped plans.
async function recordRepo(): Promise<TestRepo> {
  const repo = await seededRepo()
  for (const id of ['auth-refresh', 'other']) { must(await writeSpec(repo, id, tagged(id))); approve(repo, id) }
  await shipPlan(repo, 'auth-refresh-plan-1', 'auth-refresh', '0.29.0')
  await shipPlan(repo, 'other-plan-1', 'other', '0.29.0')
  await fix(repo, 'rotation-race', 'auth-refresh', 'escape')
  await fix(repo, 'new-rule', 'other', 'decision')
  await fix(repo, 'old-fix', 'other')
  return repo
}
const CI = { env: { CI: '1' } }

describe('the record on status and in drive (row 254)', () => {
  it('status prints the record line and the fixes owing a cause', async () => {
    const repo = await recordRepo()
    const r = await repo.cli(['status'], CI)
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('record: escapes 1 of 2 shipped plans (approximate) · decisions 1 · 1 fix needs a cause · live specs failing not measured · checks added not measured · repairs not measured')
    expect(r.stdout).toContain('cause-owed: old-fix\nhelp: the human names each fix\'s cause, in their own chat or terminal — witness recap --effort <slug> --cause escape|decision')
    expect(r.stdout).not.toContain('fixes[')
  })

  it('status --record prints the fixes, the charge note and the versions', async () => {
    const repo = await recordRepo()
    const r = await repo.cli(['status', '--record'], CI)
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout.trim().split('\n')).toEqual([
      'record: escapes 1 of 2 shipped plans (approximate) · decisions 1 · 1 fix needs a cause · live specs failing not measured · checks added not measured · repairs not measured',
      'fixes[3]{effort,cause,charged,version,age}:',
      '  new-rule,decision,—,—,—',
      '  old-fix,none,—,—,—',
      '  rotation-race,escape,auth-refresh-plan-1,0.29.0,1 merge',
      'note: a charge is approximate — the last plan of the amended spec that shipped before the fix',
      'escapes-by-version[1]{version,escapes,plans}:',
      '  0.29.0,1,2',
      'cause-owed: old-fix',
      'help: the human names each fix\'s cause, in their own chat or terminal — witness recap --effort <slug> --cause escape|decision',
    ])
  })

  it('status prints every fold not measured where a repo has no data', async () => {
    const repo = await seededRepo()
    must(await writeSpec(repo, 'auth-refresh')); approve(repo, 'auth-refresh')
    await shipPlan(repo, 'auth-refresh-plan-1', 'auth-refresh')
    const r = await repo.cli(['status'], CI)
    expect(r.stdout).toContain('record: escapes not measured · live specs failing not measured · checks added not measured · repairs not measured')
    expect(r.stdout).not.toContain('cause-owed')
    const full = await repo.cli(['status', '--record'], CI)
    expect(full.stdout.trim().split('\n')).toEqual([
      'record: escapes not measured · live specs failing not measured · checks added not measured · repairs not measured',
    ])
  })

  it('an uncharged escape, a single fix owing a cause and a measured live fold read as the copy says', async () => {
    const repo = await seededRepo()
    must(await writeSpec(repo, 'auth-refresh', tagged('auth-refresh'))); approve(repo, 'auth-refresh')
    await fix(repo, 'early-fix', 'auth-refresh', 'escape')
    await fix(repo, 'old-a', 'auth-refresh')
    await fix(repo, 'old-b', 'auth-refresh')
    repo.flipStatus('auth-refresh', 'live')
    for (const ok of [false, false]) {
      appendEntry(repo.root, 'auth-refresh', { t: 'drift-check', run_id: 'r-00000001', artifact: 'auth-refresh', artifact_sha: 'x', ok,
        tags: 1, criteria: [], outcomes: { passed: 0, skipped: 0, failed: 1, failing: ['a rotates'] } })
    }
    const r = await repo.cli(['status', '--record'], CI)
    expect(r.stdout).toContain('record: escapes 1 of 0 shipped plans (approximate) · decisions 0 · 2 fixes need a cause · live specs failing 1 · could not verify 0 of 1')
    expect(r.stdout).toContain('  early-fix,escape,none (nothing shipped before),—,—')
    expect(r.stdout).toContain('cause-owed: old-a · old-b')
  })

  it('an escape with no amended spec reads so in its charged cell', () => {
    const r: TrackRecord = {
      escapes: { measured: true, fixes: [{ effort: 'x-fix', cause: 'escape', uncharged: 'no-amended-spec' }], escapes: 1, decisions: 0, plans: 0, byVersion: [] },
      live: { measured: false, specs: 0, failing: [], couldNotVerify: [], unconfirmed: [] }, checks: { measured: false }, tolerated: { measured: false }, repairs: { measured: false },
    }
    expect(recordTables(r)).toContain('  x-fix,escape,none (no amended spec),—,—')
  })

  it("drive's report carries the record line after the decisions line", async () => {
    const repo = await recordRepo()
    const cfg = loadConfig(repo.root); if (!cfg.ok) throw new Error('config')
    const r = driveReport(repo.root, fakeCtx(repo.root), cfg.value, runStart(repo.root), [], { autonomous: false })
    const at = r.lines.findIndex((l) => l.startsWith('decisions: '))
    expect(r.lines[at + 1]).toBe('record: escapes 1 of 2 shipped plans (approximate) · decisions 1 · 1 fix needs a cause · live specs failing not measured · checks added not measured · repairs not measured')
  })

  it('the models entry exports record as plain data', async () => {
    const repo = await recordRepo()
    const m = models.record(repo.root, models.loadCanon(repo.root))
    expect(JSON.parse(JSON.stringify(m))).toEqual(m)
    expect(m).toEqual(record(repo.root, loadCanon(repo.root)))
    expect(m.checks).toEqual({ measured: false })
    expect(m.repairs).toEqual({ measured: false })
  })

  it('nothing that decides reads the record or a cause (decision 8)', () => {
    const src = join(import.meta.dirname, '..', 'src')
    const deciders = ['gate.ts', 'arbiter.ts', 'recommend.ts', 'autonomy.ts', 'settle.ts', 'rounds.ts', 'verbs/next.ts', 'verbs/decide.ts',
      ...readdirSync(join(src, 'gates')).filter((f) => f.endsWith('.ts')).map((f) => `gates/${f}`)]
    for (const f of deciders) {
      const text = readFileSync(join(src, f), 'utf8')
      expect(text, f).not.toMatch(/from '\.{1,2}\/record\.js'/)
      expect(text, f).not.toContain('effortCause')
    }
  })
})
