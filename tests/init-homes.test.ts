import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pinIn, version } from '../src/version.js'
import { worktreePath } from '../src/worktree.js'
import { shippableRepo, type TestRepo } from './helpers.js'

const ENGINE = join('.claude', 'commands', 'witness.md')

// A repository with a live worktree and the payload installed in both homes — the state a
// human is in the moment before they upgrade.
async function installedRepo(): Promise<{ repo: TestRepo; wt: string; planId: string }> {
  const { repo, planId } = await shippableRepo()
  const res = await repo.cli(['init', '--agent', 'claude-code'])
  expect(res.code).toBe(0)
  return { repo, wt: worktreePath(repo.root, planId), planId }
}

// A worktree carrying a payload from an older CLI, committed on its own branch — which is
// how a real one gets that way: the branch was cut before the upgrade, and row 87 commits
// the payload, so the old bytes are part of that branch's history.
function freezeWorktreePayload(wt: string, pin: string): void {
  mkdirSync(dirname(join(wt, ENGINE)), { recursive: true })
  writeFileSync(join(wt, ENGINE), `WITNESS="\${WITNESS_BIN:-npx -y @popovych.co/witness@${pin}}"\n`)
  execFileSync('git', ['add', '-A', '--', ENGINE], { cwd: wt })
  execFileSync('git', ['commit', '--no-verify', '-m', `freeze the payload at ${pin}`], { cwd: wt })
}

describe('init upgrades every home of the repository', () => {
  // The incident, prevented: the human upgrades and re-inits at the root, and the live
  // worktree stops being a time capsule of the CLI that cut it.
  it('rewrites the payload inside a live worktree', async () => {
    const { repo, wt } = await installedRepo()
    freezeWorktreePayload(wt, '0.5.1')

    const res = await repo.cli(['init', '--agent', 'claude-code'])
    expect(res.code).toBe(0)
    expect(pinIn(readFileSync(join(wt, ENGINE), 'utf8'))).toBe(version())

    await repo.cli(['clean'])
  })

  // The payload must be COMMITTED in the worktree or the agent never sees it: a worktree is
  // a branch checkout, which is row 87's whole argument for committing it at the root.
  it('commits the worktree payload on the plan branch', async () => {
    const { repo, wt } = await installedRepo()
    freezeWorktreePayload(wt, '0.5.1')

    await repo.cli(['init', '--agent', 'claude-code'])
    // committed, not merely written: the file the agent reads is the one on the branch
    const committed = execFileSync('git', ['show', `HEAD:${ENGINE}`], { cwd: wt, encoding: 'utf8' })
    expect(pinIn(committed)).toBe(version())
    const status = execFileSync('git', ['status', '--porcelain', '--', ENGINE], { cwd: wt, encoding: 'utf8' })
    expect(status.trim()).toBe('')

    await repo.cli(['clean'])
  })

  // All or nothing across homes. A dirty payload in ONE home must not leave the others
  // upgraded — a half-upgraded set of homes is exactly the skew this row exists to close.
  it('refuses every home when one home has a dirty payload', async () => {
    const { repo, wt, planId } = await installedRepo()
    // deliberately NOT committed — this is the dirty case
    mkdirSync(dirname(join(wt, ENGINE)), { recursive: true })
    writeFileSync(join(wt, ENGINE), 'WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.5.1}"\n')
    const before = readFileSync(join(repo.root, ENGINE), 'utf8')

    const res = await repo.cli(['init', '--agent', 'claude-code'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('payload-dirty')
    // the home is named, or one relative path is ambiguous across every checkout of the repo
    expect(res.stderr).toContain(planId)
    expect(readFileSync(join(repo.root, ENGINE), 'utf8')).toBe(before)

    await repo.cli(['clean'])
  })

  // A repository with no worktrees must behave exactly as it did before this row.
  it('says nothing about other homes when the root is the only home', async () => {
    const { repo } = await installedRepo()
    await repo.cli(['clean'])                       // removes the worktree
    const res = await repo.cli(['init', '--agent', 'claude-code'])
    expect(res.code).toBe(0)
    expect(res.stdout).not.toContain('payload-synced')
  })
})
