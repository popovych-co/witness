import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planChangeSet } from '../src/change-set.js'
import { loadConfig } from '../src/config.js'
import { diffBase } from '../src/evidence.js'
import { codePromptBody } from '../src/gates/implement.js'
import { diffReviewedSha } from '../src/reviewed.js'
import { worktreePath } from '../src/worktree.js'
import { TOKEN_BROKEN, TOKEN_TESTS_TAGGED, crashVerifyRed, git, seedBase, threeStepPlan, unwrap } from './helpers.js'

// One plan, `seedBase` on main (src/token.ts = TOKEN_BROKEN at the base), started.
async function renamedPlan() {
  const repo = await threeStepPlan()
  seedBase(repo)
  const planId = 'auth-refresh-plan-1'
  const started = await repo.cli(['start', planId])
  if (started.code !== 0) throw new Error(`start: ${started.stdout}\n${started.stderr}`)
  const wt = worktreePath(repo.root, planId)
  return { repo, wt, planId, base: unwrap(diffBase(wt, unwrap(loadConfig(repo.root)))) }
}

describe('a rename is both of its paths in the plan change set (row 248)', () => {
  it('lists the old path and the new one, in the change set and in the prompt', async () => {
    const { wt, base } = await renamedPlan()
    git(wt, 'mv', 'src/token.ts', 'src/rotate.ts')
    git(wt, 'commit', '-m', 'rename')
    expect(planChangeSet(wt, base)).toEqual(['src/rotate.ts', 'src/token.ts'])
    expect(codePromptBody(wt, base, planChangeSet(wt, base), '')).toContain('### Changed files\nsrc/rotate.ts\nsrc/token.ts')
  })

  it('gives a rename and a copy different reviewed identities', async () => {
    const { wt, base } = await renamedPlan()
    git(wt, 'mv', 'src/token.ts', 'src/rotate.ts')
    const renamed = diffReviewedSha(wt, base)
    git(wt, 'checkout', base, '--', 'src/token.ts')          // the old path back: now a copy
    expect(diffReviewedSha(wt, base)).not.toBe(renamed)
  })

  it("lays out verify-red's red tree with the old path, and the put-back takes it away again", async () => {
    const { repo, wt, planId } = await renamedPlan()
    writeFileSync(join(wt, 'tests/token.test.ts'), TOKEN_TESTS_TAGGED)
    git(wt, 'mv', 'src/token.ts', 'src/rotate.ts')
    git(wt, 'add', 'tests/token.test.ts')
    git(wt, 'commit', '-m', 'rename + tagged tests')
    expect(await crashVerifyRed(wt, planId, ['--step', 's1'])).toBe(9)
    expect(readFileSync(join(wt, 'src/token.ts'), 'utf8')).toBe(TOKEN_BROKEN)
    expect(existsSync(join(wt, 'src/rotate.ts'))).toBe(false)
    expect((await repo.cli(['recover'])).code).toBe(0)
    expect(existsSync(join(wt, 'src/token.ts'))).toBe(false)
    expect(readFileSync(join(wt, 'src/rotate.ts'), 'utf8')).toBe(TOKEN_BROKEN)
  })
})
