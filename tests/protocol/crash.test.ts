import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DESIGN_HTML, SPEC_META, approve, fakeScenario, gateEnv, hermeticEnv, putVerdict,
  seededRepo, spawnAsync, witnessDesign, writeDesign, writePlan, writeSpec,
} from '../helpers.js'
import { splitDoc } from '../../src/fm.js'
import { readStream } from '../../src/journal.js'
import { findById, loadCanon } from '../../src/scan.js'
import { pendingTxn } from '../../src/txn.js'
import { recoverChoice } from '../../src/verbs/recover.js'

const pkgRoot = fileURLToPath(new URL('../..', import.meta.url))
const bin = join(pkgRoot, 'dist', 'bin.js')

// Each CLI run is awaited, never spawnSync'd (helpers.ts spawnAsync says why).
function spawnCli(root: string, args: string[], env: Record<string, string> = {}) {
  return spawnAsync(process.execPath, [bin, ...args], { cwd: root, env: hermeticEnv(env) })
}

describe('kill/resume protocol', () => {
  it('crash after artifact-write: guard blocks, rollback converges, rerun succeeds', async () => {
    const repo = await seededRepo()
    repo.write('m.json', JSON.stringify(SPEC_META))
    repo.write('b.md', '## Motivation\nx\n\n## Behavior\ny\n')
    const crashed = await spawnCli(repo.root, ['write', 'auth-refresh', '--effort', 'auth-hardening', '--meta', 'm.json', '--body', 'b.md'], { WITNESS_CRASH_AFTER: 'artifact-write' })
    expect(crashed.code).toBe(9)
    expect(existsSync(join(repo.root, '.witness/txn.json'))).toBe(true)
    expect(existsSync(join(repo.root, 'specs/auth-refresh.md'))).toBe(true)

    const blocked = await repo.cli(['write', 'auth-refresh', '--effort', 'auth-hardening', '--meta', 'm.json', '--body', 'b.md'])
    expect(blocked.code).toBe(3)

    const rolled = await spawnCli(repo.root, ['recover', '--rollback'])
    expect(rolled.code).toBe(0)
    expect(existsSync(join(repo.root, 'specs/auth-refresh.md'))).toBe(false)

    const rerun = await writeSpec(repo, 'auth-refresh')
    expect(rerun.code).toBe(0)
  })

  it('crash after journal-append: complete lands one commit, entry exactly once, check green', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    repo.write('m2.json', JSON.stringify({ ...SPEC_META, summary: 'Rotation plus revocation' }))
    repo.write('b2.md', '## Motivation\nx\n\n## Behavior\ny\n')
    const crashed = await spawnCli(repo.root, ['write', 'auth-refresh', '--effort', 'auth-hardening', '--meta', 'm2.json', '--body', 'b2.md'], { WITNESS_CRASH_AFTER: 'journal-append' })
    expect(crashed.code).toBe(9)

    const completed = await spawnCli(repo.root, ['recover', '--complete'])
    expect(completed.code).toBe(0)
    expect(repo.git('log', '-1', '--format=%(trailers:key=Witness-State,valueonly=true)')).toBe('1')
    const journal = readFileSync(join(repo.root, '.witness/journal/auth-hardening.jsonl'), 'utf8')
    const writes = journal.split('\n').filter((l) => l.includes('"t":"write"'))
    expect(writes).toHaveLength(2)
    expect(repo.read('specs/auth-refresh.md')).toContain('Rotation plus revocation')

    const check = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(check.code).toBe(0)
  })

  it('session death between recap and write: a fresh process resumes from the journal', async () => {
    const repo = await seededRepo()
    repo.write('m.json', JSON.stringify(SPEC_META))
    repo.write('b.md', '## Motivation\nx\n\n## Behavior\ny\n')
    const res = await spawnCli(repo.root, ['write', 'auth-refresh', '--effort', 'auth-hardening', '--meta', 'm.json', '--body', 'b.md'])
    expect(res.code).toBe(0)
  })

  // D167. A plan abandoned with an open debt and revived to draft re-gates to approved and
  // discharges in one transaction — two kinds of line on one stream, so the marker's order is
  // the order recover reads the crash by.
  it('crash after gate-journal on a revived plan that discharges a debt: recover reads it landed and completing appends nothing', async () => {
    const PLAN = 'auth-refresh-plan-1'
    const STEPS = { steps: [{ id: 's1', title: 'rotate', criteria: ['ac-rotate'] }] }
    const blocking = fakeScenario()
    putVerdict(blocking, {
      coverage: [{ anchor: `${PLAN} > ## Step: s1`, note: 'read' }, { anchor: 'auth-refresh > ## Behavior', note: 'read' }],
      findings: [{ blocking: true, anchor: `${PLAN} > ## Step: s1`, claim: 'untestable' }],
    })
    const clean = fakeScenario()
    putVerdict(clean, {
      coverage: [{ anchor: `${PLAN} > ## Step: s1`, note: 'read' }, { anchor: 'auth-refresh > ## Behavior', note: 'read' }],
      findings: [],
    })
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    for (let i = 1; i <= 3; i++) {
      await writePlan(repo, PLAN, STEPS, `## Step: s1\nAttempt ${i}.\n`)
      await repo.cli(['gate', 'plan', PLAN], { env: gateEnv(blocking) })
    }
    expect((await repo.cli(['decide', 'plan', PLAN, '--approve', '--override'])).code).toBe(0)
    expect((await repo.cli(['abandon', PLAN])).code).toBe(0)
    expect((await writePlan(repo, PLAN, STEPS, '## Step: s1\nFixed.\n')).code).toBe(0)

    const crashed = await spawnCli(repo.root, ['gate', 'plan', PLAN], { ...gateEnv(clean), WITNESS_CRASH_AFTER: 'gate-journal' })
    expect(crashed.code).toBe(9)
    const marker = pendingTxn(repo.root)!
    expect(marker.journalMulti!.map((l) => JSON.parse(l.line).t)).toEqual(['gate-run', 'deferral-discharged', 'status'])
    expect(recoverChoice(repo.root, marker).rule).toBe('txn-write-landed')
    const lines = readStream(repo.root, PLAN).length
    expect((await repo.cli(['recover', '--complete'])).code).toBe(0)
    expect(readStream(repo.root, PLAN)).toHaveLength(lines)
    expect(String(findById(loadCanon(repo.root), PLAN)!.meta.status)).toBe('approved')
  })
})

describe('design stage — kill/resume + gating', () => {
  it('a ui feature spec walks brainstorm→design→plan and blocks plan until design approves', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')

    // next says: design owed
    let n = await repo.cli(['next'])
    expect(n.stdout).toContain('witness design booking-form')

    // plan write refuses before design is approved
    const early = await writePlan(repo, 'booking-form-plan-1', { parent: 'booking-form' })
    expect(early.code).toBe(2)

    // author + gate + approve the design
    const scenario = fakeScenario()
    const env = gateEnv(scenario)
    putVerdict(scenario, {
      coverage: [{ anchor: 'design#save-bar', note: 'r' }, { anchor: 'booking-form > ## Behavior', note: 'r' }],
      findings: [],
    })
    await writeDesign(repo, 'booking-form')
    await witnessDesign(repo, 'booking-form')
    const g = await repo.cli(['gate', 'design', 'booking-form'], { env })
    expect(g.code).toBe(1)                                    // always stops
    const dec = await repo.cli(['decide', 'design', 'booking-form', '--approve'])
    expect(dec.code).toBe(0)

    // now next routes to plan, and the plan write accepts the design-from pin
    n = await repo.cli(['next'])
    expect(n.stdout).toContain('write booking-form-plan-1')
    const stamp = splitDoc(repo.read('specs/booking-form.md'))
    const designSha = stamp.ok ? (stamp.value.meta.design as { sha: string }).sha : ''
    expect(designSha).not.toBe('')
    const ok = await writePlan(repo, 'booking-form-plan-1', { parent: 'booking-form', 'design-from': designSha })
    expect(ok.code).toBe(0)
  })

  it('crash after the design artifact write: guard blocks, rollback converges, rerun succeeds', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')

    repo.write('d-booking-form.html', DESIGN_HTML)
    const crashed = await spawnCli(
      repo.root,
      ['design', 'booking-form', '--file', 'd-booking-form.html'],
      { WITNESS_CRASH_AFTER: 'design-artifact' },
    )
    expect(crashed.code).toBe(9)
    expect(existsSync(join(repo.root, '.witness/txn.json'))).toBe(true)
    expect(existsSync(join(repo.root, 'designs/booking-form.html'))).toBe(true)

    const blocked = await repo.cli(['design', 'booking-form', '--file', 'd-booking-form.html'])
    expect(blocked.code).toBe(3)

    const rolled = await spawnCli(repo.root, ['recover', '--rollback'])
    expect(rolled.code).toBe(0)
    expect(existsSync(join(repo.root, 'designs/booking-form.html'))).toBe(false)

    rmSync(join(repo.root, 'd-booking-form.html'), { force: true })
    const rerun = await writeDesign(repo, 'booking-form')
    expect(rerun.code).toBe(0)
  })

  it('crash after the journal append: complete lands one commit, design-write entry exactly once', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')

    repo.write('d-booking-form.html', DESIGN_HTML)
    const crashed = await spawnCli(
      repo.root,
      ['design', 'booking-form', '--file', 'd-booking-form.html'],
      { WITNESS_CRASH_AFTER: 'design-journal' },
    )
    expect(crashed.code).toBe(9)

    const completed = await spawnCli(repo.root, ['recover', '--complete'])
    expect(completed.code).toBe(0)
    rmSync(join(repo.root, 'd-booking-form.html'), { force: true })
    expect(repo.git('log', '-1', '--format=%(trailers:key=Witness-State,valueonly=true)')).toBe('1')
    const journal = readFileSync(join(repo.root, '.witness/journal/booking-form.jsonl'), 'utf8')
    const writes = journal.split('\n').filter((l) => l.includes('"t":"design-write"'))
    expect(writes).toHaveLength(1)

    const check = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(check.code).toBe(0)
  })

  it('--reconfirm clears a stale stamp after a no-visual-delta amendment, no session needed', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')
    const scenario = fakeScenario()
    putVerdict(scenario, {
      coverage: [{ anchor: 'design#save-bar', note: 'r' }, { anchor: 'booking-form > ## Behavior', note: 'r' }],
      findings: [],
    })
    await writeDesign(repo, 'booking-form')
    await witnessDesign(repo, 'booking-form')
    await repo.cli(['gate', 'design', 'booking-form'], { env: gateEnv(scenario) })
    await repo.cli(['decide', 'design', 'booking-form', '--approve'])

    const before = splitDoc(repo.read('specs/booking-form.md'))
    const artifactSha = before.ok ? (before.value.meta.design as { sha: string }).sha : ''
    expect(artifactSha).not.toBe('')

    // no visual delta — the wording changes, the artifact doesn't; sha moves, stamp goes stale
    await writeSpec(
      repo, 'booking-form',
      { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] },
      '## Motivation\nTokens must rotate; copy tweak only.\n\n## Behavior\nSame screen, reworded.\n',
    )
    const early = await repo.cli(['design', 'booking-form', '--reconfirm'])
    expect(early.code).toBe(0)

    const after = splitDoc(repo.read('specs/booking-form.md'))
    const stamp = after.ok ? (after.value.meta.design as { sha: string; spec: string }) : undefined
    expect(stamp?.sha).toBe(artifactSha)                      // artifact untouched
    expect(stamp?.spec).not.toBe(before.ok ? (before.value.meta.design as { spec: string }).spec : '')
    expect(readStream(repo.root, 'booking-form').some((e) => e.t === 'design-reconfirm')).toBe(true)

    // now current — a second reconfirm has nothing stale to clear
    const again = await repo.cli(['design', 'booking-form', '--reconfirm'])
    expect(again.code).toBe(2)
  })

  it('crash after a reconfirm journal append: complete converges, reconfirm entry exactly once', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')
    const scenario = fakeScenario()
    putVerdict(scenario, {
      coverage: [{ anchor: 'design#save-bar', note: 'r' }, { anchor: 'booking-form > ## Behavior', note: 'r' }],
      findings: [],
    })
    await writeDesign(repo, 'booking-form')
    await witnessDesign(repo, 'booking-form')
    await repo.cli(['gate', 'design', 'booking-form'], { env: gateEnv(scenario) })
    await repo.cli(['decide', 'design', 'booking-form', '--approve'])
    await writeSpec(
      repo, 'booking-form',
      { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] },
      '## Motivation\nTokens must rotate; copy tweak only.\n\n## Behavior\nSame screen, reworded.\n',
    )

    const crashed = await spawnCli(repo.root, ['design', 'booking-form', '--reconfirm'], { WITNESS_CRASH_AFTER: 'design-reconfirm' })
    expect(crashed.code).toBe(9)

    const completed = await spawnCli(repo.root, ['recover', '--complete'])
    expect(completed.code).toBe(0)
    const journal = readFileSync(join(repo.root, '.witness/journal/booking-form.jsonl'), 'utf8')
    const reconfirms = journal.split('\n').filter((l) => l.includes('"t":"design-reconfirm"'))
    expect(reconfirms).toHaveLength(1)

    const check = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(check.code).toBe(0)
  })
})
