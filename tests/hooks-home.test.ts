import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { witnessPaths } from '../src/change-set.js'
import { dirtyStatePaths, isStatePath, stateCommit, stateDirs, stateOnlyAdvance } from '../src/gitio.js'
import { canonPatterns } from '../src/worktree.js'
import { git, payloadPlan, seededRepo, tmpRepo } from './helpers.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe("witness's hooks live in .witness/hooks/ (row 250, #95)", () => {
  it('checks the hooks out in a worktree started after init, and neither start nor check calls them canon', async () => {
    const { repo, wt, planId } = await payloadPlan()
    for (const f of ['canon-guard.mjs', 'guard-state.mjs', 'session-dashboard.sh']) {
      expect(existsSync(join(wt, '.witness/hooks', f))).toBe(true)
    }
    expect(git(wt, 'ls-files', '-t', '--', '.witness/hooks').split('\n')).toEqual([
      'H .witness/hooks/canon-guard.mjs', 'H .witness/hooks/guard-state.mjs', 'H .witness/hooks/session-dashboard.sh',
    ])
    expect(existsSync(join(wt, '.witness/journal'))).toBe(false)
    const again = await repo.cli(['start', planId])
    expect(again.code).toBe(0)
    expect(`${again.stdout}${again.stderr}`).not.toContain('canon-in-worktree')
    const ck = await repo.cli(['check'])
    expect(`${ck.stdout}${ck.stderr}`).not.toContain('canon-in-worktree')
  })

  it('re-includes only the hooks in the sparse patterns', async () => {
    const repo = await seededRepo()
    expect(canonPatterns(repo.root)).toEqual(['/*', ...stateDirs(repo.root).map((d) => `!/${d}/`), '/.witness/hooks/'])
  })

  it('is not state: a state commit refuses it, and an edit is no hand edit', async () => {
    const repo = tmpRepo()
    expect((await repo.cli(['init', '--agent', 'claude-code'])).code).toBe(0)
    expect(isStatePath(repo.root, '.witness/hooks/guard-state.mjs')).toBe(false)
    expect(isStatePath(repo.root, '.witness/hooksx/a')).toBe(true)
    expect(isStatePath(repo.root, '.witness/journal/a.jsonl')).toBe(true)
    const r = stateCommit(repo.root, ['.witness/hooks/guard-state.mjs'], 'x')
    expect(r.ok ? undefined : r.violations[0]!.rule).toBe('out-of-scope')
    repo.write('.witness/hooks/guard-state.mjs', '// edited by hand\n')
    expect(dirtyStatePaths(repo.root)).toEqual([])
    const ck = await repo.cli(['check'])
    expect(ck.stdout).not.toContain('hand-edit-in-progress')
    expect(ck.stdout).toContain('payload-stale')
  })

  it('reads a commit touching only the hooks as real base movement', async () => {
    const repo = await seededRepo()
    const from = repo.git('rev-parse', 'HEAD')
    repo.write('.witness/hooks/guard-state.mjs', '// payload\n')
    repo.git('add', '.witness/hooks/guard-state.mjs')
    repo.git('commit', '-m', 'init(claude-code): agent payloads', '-m', 'Witness-State: 1')
    expect(stateOnlyAdvance(repo.root, repo.root, from, 'HEAD')).toBe(false)
  })

  it('names payload a Biome config would check, in check and at init (row 250)', async () => {
    const repo = tmpRepo()
    repo.write('biome.json', '{}\n')
    repo.git('add', 'biome.json')
    repo.git('commit', '-m', 'biome')
    const res = await repo.cli(['init', '--agent', 'claude-code'])
    const detail = ".witness/hooks/canon-guard.mjs · .witness/hooks/guard-state.mjs — biome.json checks them so the repo's own lint can fail on witness's files; add the pattern !.witness to files.includes in biome.json"
    expect(res.stdout).toContain(`payload-linted: ${detail}`)
    const ck = await repo.cli(['check'])
    expect(ck.stdout).toContain('payload-linted')
    expect(ck.stdout).toContain(detail)
  })

  it("stays quiet on fewhats' Biome config", async () => {
    const repo = tmpRepo()
    repo.write('biome.json', readFileSync(join(REPO, 'fixtures/settings/biome-fewhats.json'), 'utf8'))
    repo.git('add', 'biome.json')
    repo.git('commit', '-m', 'biome')
    expect((await repo.cli(['init', '--agent', 'claude-code'])).stdout).not.toContain('payload-linted')
    expect((await repo.cli(['check'])).stdout).not.toContain('payload-linted')
  })

  it('keeps both homes witness-owned in the plan change set', () => {
    expect(witnessPaths()).toEqual([
      '.claude/commands/witness.md', '.claude/hooks/canon-guard.mjs', '.claude/hooks/guard-state.mjs',
      '.claude/hooks/session-dashboard.sh', '.pi/extensions/canon-guard.mjs', '.pi/extensions/context-core.mjs',
      '.pi/extensions/session-dashboard.sh', '.pi/extensions/witness.ts', '.pi/prompts/witness.md',
      '.witness/hooks/canon-guard.mjs', '.witness/hooks/guard-state.mjs', '.witness/hooks/session-dashboard.sh',
    ])
  })
})
