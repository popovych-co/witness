import { describe, expect, it } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'
import { contentSha } from '../src/content-sha.js'
import { loadCanon } from '../src/scan.js'
import {
  TOKEN_FIXED, TOKEN_TESTS_TAGGED, crashVerifyRed, git, nextLine, payloadPlan, scaffoldingPlan, shippableRepo,
} from './helpers.js'

describe('verify-red and next read the plan change set (row 246, #93)', () => {
  it('verify-red never sets a payload file aside', async () => {
    const { wt, planId } = await payloadPlan()
    writeFileSync(join(wt, '.claude/hooks/guard-state.mjs'), '// the plan branch\'s payload\n')
    git(wt, 'add', '.claude/hooks/guard-state.mjs'); git(wt, 'commit', '-m', 'init(claude-code): agent payloads')
    writeFileSync(join(wt, 'tests/token.test.ts'), TOKEN_TESTS_TAGGED)
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
    expect(await crashVerifyRed(wt, planId, ['--step', 's1'])).toBe(9)
    expect(readFileSync(join(wt, '.claude/hooks/guard-state.mjs'), 'utf8')).toBe('// the plan branch\'s payload\n')
    const record = git(wt, 'cat-file', 'commit', `refs/witness/verify-red/${planId}`)
    expect(record).not.toContain('.claude/')
  })

  it('a payload-only change is "nothing changed yet" to next, never a gate or a verify-red', async () => {
    const { repo, wt } = await scaffoldingPlan()
    expect(await nextLine(repo, { cwd: wt })).toMatch(/^note: nothing changed yet — make the change/m)
    const init = await repo.cli(['init', '--agent', 'claude-code'])
    expect(init.stdout).toMatch(/^payload-synced: /m)          // the worktree got its payload commit
    const out = await nextLine(repo, { cwd: wt })
    expect(out).toMatch(/^note: nothing changed yet — make the change/m)
    expect(out).not.toMatch(/^next: witness (gate implement|verify-red)/m)
  })

  it('init --agent into a started worktree leaves implement\'s reviewed sha unchanged', async () => {
    const { repo, planId } = await shippableRepo()
    const cfg = loadConfig(repo.root).value!
    const sha = () => contentSha(repo.root, loadCanon(repo.root), cfg, 'implement', planId)
    const before = sha()
    expect(before).toMatch(/^[0-9a-f]{64}$/)
    expect((await repo.cli(['init', '--agent', 'claude-code'])).stdout).toMatch(/^payload-synced: /m)
    expect(sha()).toBe(before)
  })

  it('check names a witness hook a worktree lacks: payload-missing', async () => {
    const { repo, wt } = await payloadPlan()
    rmSync(join(wt, '.claude/hooks/guard-state.mjs'))
    const out = await repo.cli(['check'])
    const text = `${out.stdout}\n${out.stderr}`
    expect(text).toContain('payload-missing')
    // the home is named by its path under the root, which may be spelled through /private on macOS
    expect(text).toContain('.witness/worktrees/auth-refresh-plan-1: .claude/hooks/guard-state.mjs')
  })

  // Slice 1 review, finding 1: a plan that deleted a hook ships, the root pulls, and the root lacks it
  // too — the expected set is the harness's whole payload, not what the root still holds.
  it('check names a witness hook the root itself lacks, by its bare path', async () => {
    const { repo } = await payloadPlan()
    repo.git('rm', '-q', '.claude/hooks/guard-state.mjs')
    repo.git('commit', '-q', '-m', 'a shipped plan deleted a witness hook')
    const out = await repo.cli(['check'])
    const text = `${out.stdout}\n${out.stderr}`
    expect(text).toMatch(/payload-missing,"?\.claude\/hooks\/guard-state\.mjs — /)   // the root, by its bare path
    expect(text).not.toContain('.witness/worktrees/auth-refresh-plan-1: .claude/hooks/guard-state.mjs')   // the worktree still has it
  })
})
