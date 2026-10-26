import { describe, expect, it } from 'vitest'
import { trustOwed } from '../src/allowlist.js'
import { loadConfig } from '../src/config.js'
import { loadCanon } from '../src/scan.js'
import { worktreePath } from '../src/worktree.js'
import { type TestRepo, approve, autonomyOn, patchConfig, seededRepo, writePlan, writeSpec } from './helpers.js'

// Row 205 (issue #56, P5). A config command the routed step runs — the runner, ship.test,
// ship.lint, a start's cmd: need — that this machine does not trust used to be found only
// inside the session, as a refusal that journaled nothing, so `next` routed the same line again
// and drive respawned it to the cap. Checked before any work, it is the human's act instead.
const NO_TRUST = { WITNESS_TRUST_CMDS: '' }

async function untrustedFlow(opts: { shipTest?: string; autonomy?: boolean } = {}): Promise<TestRepo> {
  const repo = await seededRepo()
  patchConfig(repo, {
    criteria: { runner: 'full-suite', report: 'junit:**/reports/junit.xml' },
    ship: { test: opts.shipTest ?? 'pnpm test', lint: 'pnpm lint' },
  })
  repo.git('add', 'witness.config.yaml')
  repo.git('commit', '-m', 'full-suite')
  await writeSpec(repo, 'ingest', { criteria: [{ id: 'ac-i', test: '@spec:ingest' }] })
  approve(repo, 'ingest')
  await writePlan(repo, 'ingest-plan-1', { parent: 'ingest', steps: [{ id: 's1', title: 'ingest', criteria: ['ac-i'] }] })
  approve(repo, 'ingest-plan-1')
  await repo.cli(['start', 'ingest-plan-1'])
  if (opts.autonomy !== false) autonomyOn(repo)
  return repo
}

const STEP = 'next: witness test-evidence ingest-plan-1 --phase red --step s1'

describe('trust is checked before work (D205)', () => {
  it('a step whose runner is untrusted routes to the trust act (P5)', async () => {
    const repo = await untrustedFlow()
    const res = await repo.cli(['next'], { env: NO_TRUST })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("kept-stop: trust grant — pnpm test (ship.test) · witness trust ingest-plan-1 --cmd 'pnpm test'")
    expect(res.stdout).toContain('next: witness trust ingest-plan-1\n')
    expect(res.stdout).toContain('note: not trusted on this machine — pnpm test (ship.test) · the human names each to trust it')
  })

  it('WITNESS_TRUST_CMDS=1 routes the step itself', async () => {
    const repo = await untrustedFlow()
    const res = await repo.cli(['next'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.stdout).toContain(STEP)
    expect(res.stdout).not.toContain('kept-stop: trust grant')
  })

  it('a grant moves the route back to the step', async () => {
    const repo = await untrustedFlow()
    expect((await repo.cli(['trust', 'ingest-plan-1', '--cmd', 'pnpm test'])).code).toBe(0)
    const res = await repo.cli(['next'], { env: NO_TRUST })
    expect(res.stdout).toContain(STEP)
  })

  it('--flow and a worktree cwd agree with the ladder', async () => {
    const repo = await untrustedFlow()
    const flow = await repo.cli(['next', '--flow', 'ingest-plan-1'], { env: NO_TRUST })
    expect(flow.stdout).toContain('next: witness trust ingest-plan-1\n')
    const wt = await repo.cli(['next'], { env: NO_TRUST, cwd: worktreePath(repo.root, 'ingest-plan-1') })
    expect(wt.stdout).toContain('next: witness trust ingest-plan-1\n')
  })

  it('an untrusted cmd: criterion never routes before the gate (row 154)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'ingest', { criteria: [{ id: 'ac-i', test: '@spec:ingest' }, { id: 'ac-a', cmd: 'echo first' }] })
    approve(repo, 'ingest')
    const cfg = loadConfig(repo.root)
    if (!cfg.ok) throw new Error('config')
    const canon = loadCanon(repo.root)
    const owed = (line: string) => trustOwed(repo.root, NO_TRUST, cfg.value, canon, { line, target: 'ingest-plan-1' })
    // the runner and the ship lanes are owed; the spec's cmd: criterion never is
    expect(owed('witness gate implement ingest-plan-1').map((c) => c.cmd)).toEqual(['npm test -- -t "@spec:{id}"'])
    expect(owed('witness ship ingest-plan-1').map((c) => c.cmd)).toEqual(['npm test -- -t "@spec:{id}"', 'npm test', 'npm run lint'])
    expect(owed('witness gate ship ingest-plan-1').map((c) => c.cmd)).toEqual(['npm test -- -t "@spec:{id}"', 'npm test', 'npm run lint'])
    expect(owed('witness verify-red ingest-plan-1').map((c) => c.cmd)).toEqual(['npm test -- -t "@spec:{id}"'])
    expect(owed('witness decide implement ingest-plan-1 --approve')).toEqual([])
  })

  it('a start whose cmd: need is untrusted routes to the trust act', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'ingest', { criteria: [{ id: 'ac-i', test: '@spec:ingest' }] })
    approve(repo, 'ingest')
    await writePlan(repo, 'ingest-plan-1', { parent: 'ingest', needs: [{ cmd: 'test -d .git' }], steps: [{ id: 's1', title: 'ingest', criteria: ['ac-i'] }] })
    approve(repo, 'ingest-plan-1')
    autonomyOn(repo)
    const res = await repo.cli(['next'], { env: NO_TRUST })
    expect(res.stdout).toContain("kept-stop: trust grant — test -d .git (need: 1) · witness trust ingest-plan-1 --cmd 'test -d .git'")
    expect(res.stdout).toContain('next: witness trust ingest-plan-1\n')
  })

  it('with autonomy off the note prints and no kept-stop line does', async () => {
    const repo = await untrustedFlow({ autonomy: false })
    const res = await repo.cli(['next'], { env: NO_TRUST })
    expect(res.stdout).toContain('next: witness trust ingest-plan-1\n')
    expect(res.stdout).toContain('note: not trusted on this machine — pnpm test (ship.test)')
    expect(res.stdout).not.toContain('kept-stop:')
  })

  it('an autonomous chat routes the trust act while drive has other work', async () => {
    const repo = await seededRepo()
    for (const s of ['a', 'b']) {
      await writeSpec(repo, s, { criteria: [{ id: `ac-${s}`, test: `@spec:${s}` }] })
      approve(repo, s)
    }
    await writePlan(repo, 'a-plan-1', { parent: 'a', steps: [{ id: 's1', title: 'a', criteria: ['ac-a'] }] })
    approve(repo, 'a-plan-1')
    await repo.cli(['start', 'a-plan-1'])
    await writePlan(repo, 'b-plan-1', { parent: 'b', needs: [{ cmd: 'test -d .git' }], steps: [{ id: 's1', title: 'b', criteria: ['ac-b'] }] })
    approve(repo, 'b-plan-1')
    autonomyOn(repo)
    expect((await repo.cli(['trust', 'a-plan-1', '--cmd', 'npm test -- -t "@spec:{id}"'])).code).toBe(0)
    const res = await repo.cli(['next'], { env: NO_TRUST })
    expect(res.stdout).toContain('next: witness trust b-plan-1\n')
    expect(res.stdout).toContain('launch: witness drive --detach')
  })

  it('a single-quoted command renders one paste-ready --cmd (Review Focus 5)', async () => {
    const repo = await untrustedFlow({ shipTest: "pnpm test -t 'a b'" })
    const res = await repo.cli(['next'], { env: NO_TRUST })
    expect(res.stdout).toContain(`witness trust ingest-plan-1 --cmd 'pnpm test -t '\\''a b'\\'''`)
  })
})
