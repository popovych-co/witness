import { describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planChangeSet } from '../src/change-set.js'
import { loadConfig } from '../src/config.js'
import { diffBase } from '../src/evidence.js'
import { codePromptBody } from '../src/gates/implement.js'
import { standingHeld } from '../src/held.js'
import { diffReviewedSha } from '../src/reviewed.js'
import { snapshotTree } from '../src/snapshot.js'
import { worktreePath } from '../src/worktree.js'
import { TOKEN_BROKEN, TOKEN_TESTS_TAGGED, crashVerifyRed, fixtureEnv, git, seedBase, threeStepPlan, unwrap } from './helpers.js'

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

// Slice 1 review I1. With both paths listed, a rename between a file and a directory of one name
// puts a path under what is now a file (ENOTDIR) or at what is now a directory into every reader.
const LIB = 'export const a = 1\nexport const b = 2\nexport const c = 3\n'
const DF = ['src/lib', 'src/lib/index.ts', 'src/token.ts']
// the index, status and each path on disk — a directory named as such, never read as a file
function dfState(wt: string): Record<string, string> {
  const disk = (rel: string): string => {
    try {
      const st = lstatSync(join(wt, rel))
      return st.isDirectory() ? '(directory)' : readFileSync(join(wt, rel), 'utf8')
    } catch {
      return '(none)'
    }
  }
  return {
    index: git(wt, 'ls-files', '-s', '--', 'src'),
    status: git(wt, 'status', '--porcelain=v1', '--untracked-files=all'),
    ...Object.fromEntries(DF.map((rel) => [rel, disk(rel)])),
  }
}
async function dfPlan(shape: 'dir-to-file' | 'file-to-dir') {
  const repo = await threeStepPlan()
  seedBase(repo)
  const [from, to] = shape === 'dir-to-file' ? ['src/lib/index.ts', 'src/lib'] : ['src/lib', 'src/lib/index.ts']
  repo.write(from, LIB)
  repo.git('add', from)
  repo.git('commit', '-m', `base: ${from}`)
  const planId = 'auth-refresh-plan-1'
  const started = await repo.cli(['start', planId])
  if (started.code !== 0) throw new Error(`start: ${started.stdout}\n${started.stderr}`)
  const wt = worktreePath(repo.root, planId)
  git(wt, 'mv', from, 'src/lib.tmp')
  // git mv neither drops the emptied directory nor makes a missing one
  if (shape === 'dir-to-file') rmdirSync(join(wt, 'src/lib'))
  else mkdirSync(join(wt, 'src/lib'))
  git(wt, 'mv', 'src/lib.tmp', to)
  writeFileSync(join(wt, 'tests/token.test.ts'), TOKEN_TESTS_TAGGED)
  git(wt, 'add', 'tests/token.test.ts')
  git(wt, 'commit', '-m', `${from} → ${to} + tagged tests`)
  return { repo, wt, planId, base: unwrap(diffBase(wt, unwrap(loadConfig(repo.root)))) }
}

describe('a rename between a file and a directory of one name (row 248, slice 1 review)', () => {
  it.each(['dir-to-file', 'file-to-dir'] as const)('%s: the identity and the snapshot read it, and verify-red puts it back exactly', async (shape) => {
    const { repo, wt, planId, base } = await dfPlan(shape)
    const files = planChangeSet(wt, base)
    expect(files).toEqual(['src/lib', 'src/lib/index.ts', 'tests/token.test.ts'])
    expect(diffReviewedSha(wt, base)).toMatch(/^[0-9a-f]{64}$/)
    expect(snapshotTree(wt, base, files)).toMatch(/^[0-9a-f]{40}$/)
    const before = dfState(wt)
    const res = await repo.cli(['verify-red', planId, '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    expect(`${res.stdout}${res.stderr}`).not.toContain('unexpected-error')
    expect(res.stdout).toContain('verify-red: red observed')
    expect(dfState(wt)).toEqual(before)
    expect(git(wt, 'status', '--porcelain')).toBe('')
    expect(standingHeld(repo.root, planId)).toBeUndefined()
  })
})
