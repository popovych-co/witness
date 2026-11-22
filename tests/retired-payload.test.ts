import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planChangeSet } from '../src/change-set.js'
import { loadConfig } from '../src/config.js'
import { diffBase } from '../src/evidence.js'
import { codePromptBody } from '../src/gates/implement.js'
import { changedPaths, treeDiff } from '../src/snapshot.js'
import { worktreePath } from '../src/worktree.js'
import { git, threeStepPlan, unwrap } from './helpers.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OLD = '.claude/hooks/guard-state.mjs'
const SHIPPED = readFileSync(join(REPO, 'plugin/hooks/guard-state.mjs'), 'utf8')
const TAMPER = '#!/usr/bin/env node\nprocess.exit(0)\n'

// A started plan; with `baseHad`, its base carries witness's retired guard (a consumer whose upgrade
// has not reached origin yet).
async function retiredPlan(baseHad: boolean) {
  const repo = await threeStepPlan()
  if (baseHad) {
    repo.write(OLD, SHIPPED)
    repo.git('add', OLD)
    repo.git('commit', '-m', 'init(claude-code): agent payloads')
  }
  const planId = 'auth-refresh-plan-1'
  const started = await repo.cli(['start', planId])
  if (started.code !== 0) throw new Error(`start: ${started.stdout}\n${started.stderr}`)
  const wt = worktreePath(repo.root, planId)
  return { repo, wt, base: unwrap(diffBase(wt, unwrap(loadConfig(repo.root)))) }
}

describe("a retired witness path is witness's only while it holds bytes witness wrote there (row 250, final review)", () => {
  it('a plan that rewrites a retired hook shows it to reviewers: the change set and the prompt diff', async () => {
    const { wt, base } = await retiredPlan(true)
    writeFileSync(join(wt, OLD), TAMPER)
    expect(planChangeSet(wt, base)).toContain(OLD)                       // uncommitted
    git(wt, 'commit', '-am', 'quiet the guard')
    const files = planChangeSet(wt, base)
    expect(files).toContain(OLD)                                          // committed
    expect(codePromptBody(wt, base, files, '')).toContain('+process.exit(0)')
  })

  it("keeps a retired hook at a version witness wrote out of the change set (fewhats' shape: the branch added it)", async () => {
    const { wt, base } = await retiredPlan(false)
    mkdirSync(join(wt, '.claude/hooks'), { recursive: true })
    writeFileSync(join(wt, OLD), SHIPPED)
    git(wt, 'add', OLD)
    git(wt, 'commit', '-m', 'init(claude-code): agent payloads')
    expect(planChangeSet(wt, base)).not.toContain(OLD)
    expect(codePromptBody(wt, base, planChangeSet(wt, base), '')).not.toContain(OLD)
  })

  it('a delta round shows a retired hook rewritten after the round before, and never one witness wrote', async () => {
    const { wt } = await retiredPlan(false)
    const empty = git(wt, 'rev-parse', 'HEAD^{tree}')
    mkdirSync(join(wt, '.claude/hooks'), { recursive: true })
    writeFileSync(join(wt, OLD), SHIPPED)
    git(wt, 'add', OLD)
    git(wt, 'commit', '-m', 'init(claude-code): agent payloads')
    const shipped = git(wt, 'rev-parse', 'HEAD^{tree}')
    expect(changedPaths(wt, empty, shipped)).toEqual([])
    writeFileSync(join(wt, OLD), TAMPER)
    git(wt, 'commit', '-am', 'quiet the guard')
    const tampered = git(wt, 'rev-parse', 'HEAD^{tree}')
    expect(changedPaths(wt, shipped, tampered)).toEqual([OLD])
    expect(treeDiff(wt, shipped, tampered)).toContain('+process.exit(0)')
  })
})
