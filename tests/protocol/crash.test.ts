import { beforeAll, describe, expect, it } from 'vitest'
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DESIGN_HTML, SPEC_META, approve, fakeScenario, gateEnv, putVerdict,
  seededRepo, writeDesign, writePlan, writeSpec,
} from '../helpers.js'
import { splitDoc } from '../../src/fm.js'
import { readStream } from '../../src/journal.js'

const pkgRoot = fileURLToPath(new URL('../..', import.meta.url))
const bin = join(pkgRoot, 'dist', 'bin.js')

function spawnCli(root: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr }
}

beforeAll(() => {
  execSync('npm run build', { cwd: pkgRoot, stdio: 'ignore' })
}, 120000)

describe('kill/resume protocol', () => {
  it('crash after artifact-write: guard blocks, rollback converges, rerun succeeds', async () => {
    const repo = await seededRepo()
    repo.write('m.json', JSON.stringify(SPEC_META))
    repo.write('b.md', '## Motivation\nx\n\n## Behavior\ny\n')
    const crashed = spawnCli(repo.root, ['write', 'auth-refresh', '--effort', 'auth-hardening', '--meta', 'm.json', '--body', 'b.md'], { SPECFLOW_CRASH_AFTER: 'artifact-write' })
    expect(crashed.code).toBe(9)
    expect(existsSync(join(repo.root, '.specflow/txn.json'))).toBe(true)
    expect(existsSync(join(repo.root, 'specs/auth-refresh.md'))).toBe(true)

    const blocked = await repo.cli(['write', 'auth-refresh', '--effort', 'auth-hardening', '--meta', 'm.json', '--body', 'b.md'])
    expect(blocked.code).toBe(3)

    const rolled = spawnCli(repo.root, ['recover', '--rollback'])
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
    const crashed = spawnCli(repo.root, ['write', 'auth-refresh', '--effort', 'auth-hardening', '--meta', 'm2.json', '--body', 'b2.md'], { SPECFLOW_CRASH_AFTER: 'journal-append' })
    expect(crashed.code).toBe(9)

    const completed = spawnCli(repo.root, ['recover', '--complete'])
    expect(completed.code).toBe(0)
    expect(repo.git('log', '-1', '--format=%(trailers:key=Specflow-State,valueonly=true)')).toBe('1')
    const journal = readFileSync(join(repo.root, '.specflow/journal/auth-hardening.jsonl'), 'utf8')
    const writes = journal.split('\n').filter((l) => l.includes('"t":"write"'))
    expect(writes).toHaveLength(2)
    expect(repo.read('specs/auth-refresh.md')).toContain('Rotation plus revocation')

    const check = await repo.cli(['check'], { env: { SPECFLOW_TRUST_CMDS: '1' } })
    expect(check.code).toBe(0)
  })

  it('session death between recap and write: a fresh process resumes from the journal', async () => {
    const repo = await seededRepo()
    repo.write('m.json', JSON.stringify(SPEC_META))
    repo.write('b.md', '## Motivation\nx\n\n## Behavior\ny\n')
    const res = spawnCli(repo.root, ['write', 'auth-refresh', '--effort', 'auth-hardening', '--meta', 'm.json', '--body', 'b.md'])
    expect(res.code).toBe(0)
  })
})

describe('design stage — kill/resume + gating', () => {
  it('a ui feature spec walks brainstorm→design→plan and blocks plan until design approves', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')

    // next says: design owed
    let n = await repo.cli(['next'])
    expect(n.stdout).toContain('specflow design booking-form')

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
    const crashed = spawnCli(
      repo.root,
      ['design', 'booking-form', '--file', 'd-booking-form.html'],
      { SPECFLOW_CRASH_AFTER: 'design-artifact' },
    )
    expect(crashed.code).toBe(9)
    expect(existsSync(join(repo.root, '.specflow/txn.json'))).toBe(true)
    expect(existsSync(join(repo.root, 'designs/booking-form.html'))).toBe(true)

    const blocked = await repo.cli(['design', 'booking-form', '--file', 'd-booking-form.html'])
    expect(blocked.code).toBe(3)

    const rolled = spawnCli(repo.root, ['recover', '--rollback'])
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
    const crashed = spawnCli(
      repo.root,
      ['design', 'booking-form', '--file', 'd-booking-form.html'],
      { SPECFLOW_CRASH_AFTER: 'design-journal' },
    )
    expect(crashed.code).toBe(9)

    const completed = spawnCli(repo.root, ['recover', '--complete'])
    expect(completed.code).toBe(0)
    rmSync(join(repo.root, 'd-booking-form.html'), { force: true })
    expect(repo.git('log', '-1', '--format=%(trailers:key=Specflow-State,valueonly=true)')).toBe('1')
    const journal = readFileSync(join(repo.root, '.specflow/journal/booking-form.jsonl'), 'utf8')
    const writes = journal.split('\n').filter((l) => l.includes('"t":"design-write"'))
    expect(writes).toHaveLength(1)

    const check = await repo.cli(['check'], { env: { SPECFLOW_TRUST_CMDS: '1' } })
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
    await repo.cli(['gate', 'design', 'booking-form'], { env: gateEnv(scenario) })
    await repo.cli(['decide', 'design', 'booking-form', '--approve'])
    await writeSpec(
      repo, 'booking-form',
      { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] },
      '## Motivation\nTokens must rotate; copy tweak only.\n\n## Behavior\nSame screen, reworded.\n',
    )

    const crashed = spawnCli(repo.root, ['design', 'booking-form', '--reconfirm'], { SPECFLOW_CRASH_AFTER: 'design-reconfirm' })
    expect(crashed.code).toBe(9)

    const completed = spawnCli(repo.root, ['recover', '--complete'])
    expect(completed.code).toBe(0)
    const journal = readFileSync(join(repo.root, '.specflow/journal/booking-form.jsonl'), 'utf8')
    const reconfirms = journal.split('\n').filter((l) => l.includes('"t":"design-reconfirm"'))
    expect(reconfirms).toHaveLength(1)

    const check = await repo.cli(['check'], { env: { SPECFLOW_TRUST_CMDS: '1' } })
    expect(check.code).toBe(0)
  })
})
