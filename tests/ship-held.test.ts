import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Ctx } from '../src/cli.js'
import { loadConfig, type Config } from '../src/config.js'
import { driveLoop } from '../src/drive.js'
import { journalRel } from '../src/journal.js'
import { needsYou, needYouRows } from '../src/needs-you.js'
import { findById, loadCanon } from '../src/scan.js'
import { runShip } from '../src/ship.js'
import { heldPlan } from '../src/verbs/next.js'
import { worktreePath } from '../src/worktree.js'
import {
  approve, autonomyOn, closedStep, commitEntry, fakeClock, fakeCtx, fakeScenario, fixtureEnv, noopOpener, seededRepo,
  writeLocalConfig, writePlan, writeSpec, type TestRepo,
} from './helpers.js'

// Row 242 (design §4.3.1 Rows and Classification, §4.3.2 One predicate and Drive, §4.3.3). A plan is
// held while a merge or fix record stands — the plan stream's latest entry, on the worktree's HEAD —
// and nothing above ship routes. One predicate answers `next`, `needsYou` and drive alike, the merge
// row's command is pinned to the head, and a session's ship on a standing record returns at once.

const PLAN = 'a-plan-1'
const cfgOf = (repo: TestRepo): Config => { const r = loadConfig(repo.root); if (!r.ok) throw new Error('cfg'); return r.value }
async function shipping(): Promise<{ repo: TestRepo; head: string }> {
  const repo = await seededRepo()
  await writeSpec(repo, 'a', { criteria: [{ id: 'ac-a', test: '@spec:a' }] })
  approve(repo, 'a')
  await writePlan(repo, PLAN, { parent: 'a', steps: [{ id: 's1', title: 'a', criteria: ['ac-a'] }] })
  approve(repo, PLAN)
  await repo.cli(['start', PLAN])
  closedStep(repo, PLAN, 's1', 'a')
  repo.setMeta(PLAN, { pr: 7 })
  autonomyOn(repo)
  writeLocalConfig(repo.root, { notify: noopOpener() })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath(repo.root, PLAN), encoding: 'utf8' }).trim()
  return { repo, head }
}
const record = (head: string, outcome: 'merge' | 'fix' | 'merged' | 'transient', reason: string) =>
  ({ t: 'ship-outcome' as const, artifact: PLAN, pr: 7, head, outcome, reason })
const autoCtx = (repo: TestRepo, env: Record<string, string>, out: string[]): Ctx =>
  fakeCtx(repo.root, { env: fixtureEnv({ WITNESS_KEEP_AWAKE_BIN: noopOpener(), WITNESS_DRIVE_IDLE_MAX_MS: '0', ...env }), out: (l) => out.push(l) })
const script = (body: string): string => {
  const bin = join(fakeScenario(), 'agent')
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return bin
}
const items = (repo: TestRepo) => needsYou(repo.root, { env: {} }, cfgOf(repo), loadCanon(repo.root), [])
const plan = (repo: TestRepo) => findById(loadCanon(repo.root), PLAN)!

describe('a hold only the human can clear is a human stop (row 242)', () => {
  it('#90: a no-CI hold under drive → waiting: merge once, no second session, not stuck (P15 inverted)', async () => {
    const { repo, head } = await shipping()
    const log = join(fakeScenario(), 'spawned')
    // the ship session ends on a no-CI hold and journals its record, as `witness ship` does
    const line = JSON.stringify({ v: 1, ...record(head, 'merge', 'no CI checks reported') }).replaceAll("'", "'\\''")
    const agent = script(`echo "$WITNESS_DRIVE" >> "${log}"\nprintf '%s\\n' '${line}' >> "${join(repo.root, journalRel(PLAN))}"`)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), {}, fakeClock(0))
    expect(readFileSync(log, 'utf8')).toBe(`${PLAN}\n`)
    expect(out).toContain(`wait: merge · ${PLAN} · PR #7 — no CI checks reported`)
    expect(out).toContain(`  run: gh pr merge 7 --merge --match-head-commit ${head}`)
    expect(out).toContain(`  recheck: witness ship ${PLAN}`)
    expect(out.join('\n')).not.toContain('witness retry')
    expect(out.join('\n')).not.toContain('drive: no progress')
  }, 120_000)

  it('a fix stop offers no merge command; the base case offers gh pr edit 7 --base main', async () => {
    const { repo, head } = await shipping()
    commitEntry(repo, PLAN, record(head, 'fix', 'the PR targets release but ship.branch is main'))
    const rows = needYouRows(items(repo).find((i) => i.kind === 'fix')!)
    expect(rows).toEqual([
      `wait: fix · ${PLAN} · PR #7 — the PR targets release but ship.branch is main`,
      '  run: gh pr edit 7 --base main',
      `  recheck: witness ship ${PLAN}`,
    ])
    commitEntry(repo, PLAN, record(head, 'fix', 'closed without merging — reopen it, or abandon the plan'))
    const closed = needYouRows(items(repo).find((i) => i.kind === 'fix')!)
    expect(closed).toEqual([`wait: fix · ${PLAN} · PR #7 — closed without merging — reopen it, or abandon the plan`, `  recheck: witness ship ${PLAN}`])
    expect(closed.join('\n')).not.toContain('gh pr merge')
  }, 120_000)

  it('the held answer is the same from next, next --flow, a worktree next, needsYou and heldPlan', async () => {
    const { repo, head } = await shipping()
    commitEntry(repo, PLAN, record(head, 'merge', 'no CI checks reported'))
    expect(heldPlan(repo.root, cfgOf(repo), plan(repo))).toMatchObject({ outcome: 'merge' })
    expect(items(repo).filter((i) => i.kind === 'merge').map((i) => i.target)).toEqual([PLAN])
    const chat = (await repo.cli(['next'], { env: { CLAUDECODE: '1' } })).stdout.split('\n')
    expect(chat).toContain(`waiting: merge · ${PLAN} · PR #7 — no CI checks reported`)
    expect(chat).not.toContain(`next: witness ship ${PLAN}`)
    const trusted = { WITNESS_TRUST_CMDS: '1' }
    for (const r of [await repo.cli(['next', '--flow', PLAN], { env: trusted }), await repo.cli(['next'], { cwd: worktreePath(repo.root, PLAN), env: trusted })]) {
      const out = r.stdout.split('\n')
      expect(out).toContain(`next: witness ship ${PLAN}`)
      expect(out).toContain('note: merge stop — no CI checks reported')
    }
  }, 120_000)

  it('a plan amended with an open step is routed to the step, never held (P21 inverted)', async () => {
    const { repo, head } = await shipping()
    commitEntry(repo, PLAN, record(head, 'merge', 'no CI checks reported'))
    await writePlan(repo, PLAN, { parent: 'a', steps: [{ id: 's1', title: 'a', criteria: ['ac-a'] }, { id: 's2', title: 'b', criteria: ['ac-a'] }] },
      '## Step: s1\nA.\n\n## Step: s2\nB.\n')
    expect(heldPlan(repo.root, cfgOf(repo), plan(repo))).toBeUndefined()
    expect(items(repo).some((i) => i.kind === 'merge')).toBe(false)
    const out = (await repo.cli(['next', '--flow', PLAN], { env: { WITNESS_TRUST_CMDS: '1' } })).stdout.split('\n')
    expect(out).toContain(`next: witness test-evidence ${PLAN} --phase red --step s2`)
  }, 120_000)

  it('a record stops holding once HEAD moves or a later entry lands; a transient one never holds', async () => {
    const { repo, head } = await shipping()
    commitEntry(repo, PLAN, record(head, 'merge', 'no CI checks reported'))
    expect(heldPlan(repo.root, cfgOf(repo), plan(repo))).toBeDefined()
    expect((await repo.cli(['retry', PLAN])).code).toBe(0)
    expect(heldPlan(repo.root, cfgOf(repo), plan(repo))).toBeUndefined()
    commitEntry(repo, PLAN, record(head, 'merge', 'no CI checks reported'))
    const wt = worktreePath(repo.root, PLAN)
    writeFileSync(join(wt, 'MORE.md'), 'x\n')
    execFileSync('git', ['add', 'MORE.md'], { cwd: wt })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'more'], { cwd: wt })
    expect(heldPlan(repo.root, cfgOf(repo), plan(repo))).toBeUndefined()
    commitEntry(repo, PLAN, record(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim(), 'transient', 'the fetch failed'))
    expect(heldPlan(repo.root, cfgOf(repo), plan(repo))).toBeUndefined()
  }, 120_000)

  it('a drive session\'s ship on a standing record returns its rows at once; a human\'s re-checks', async () => {
    const { repo, head } = await shipping()
    commitEntry(repo, PLAN, record(head, 'merge', 'no CI checks reported'))
    const scenario = fakeScenario()
    const session: string[] = []
    expect(await runShip(fakeCtx(repo.root, { env: { WITNESS_FAKE_DIR: scenario, WITNESS_DRIVE: PLAN }, out: (l) => session.push(l) }), PLAN)).toBe(1)
    expect(session).toContain(`wait: merge · ${PLAN} · PR #7 — no CI checks reported`)
    expect(existsSync(join(scenario, 'gh-calls'))).toBe(false)
    const human: string[] = []
    await runShip(fakeCtx(repo.root, { env: { WITNESS_FAKE_DIR: scenario }, out: (l) => human.push(l), err: (l) => human.push(l) }), PLAN)
    expect(human).not.toContain(`wait: merge · ${PLAN} · PR #7 — no CI checks reported`)
  }, 120_000)

  it('a merged record ends the plan for drive with no further session', async () => {
    const { repo, head } = await shipping()
    commitEntry(repo, PLAN, record(head, 'merged', 'merged · merge'))
    const log = join(fakeScenario(), 'spawned')
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script(`echo x >> "${log}"`) }, out), {}, fakeClock(0))
    expect(existsSync(log)).toBe(false)
  }, 120_000)
})
