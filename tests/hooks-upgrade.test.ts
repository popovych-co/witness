import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadHarness } from '../src/harness.js'
import { dropRetired, namesRetired, retireAtRoot } from '../src/install.js'
import { refreshSparse } from '../src/worktree.js'
import { git, legacyHooksPlan, tmpRepo, unwrap } from './helpers.js'

const OLD = ['.claude/hooks/canon-guard.mjs', '.claude/hooks/guard-state.mjs', '.claude/hooks/session-dashboard.sh']
const NEW = ['.witness/hooks/canon-guard.mjs', '.witness/hooks/guard-state.mjs', '.witness/hooks/session-dashboard.sh']

describe('upgrading moves the hooks at the root and leaves started worktrees on theirs (row 250, #95)', () => {
  it.each(['branch-added', 'base-had'] as const)('%s: the root moves; the worktree keeps its old hooks and gains the new home', async (shape) => {
    const { repo, wt } = await legacyHooksPlan(shape)
    const wtSettings = readFileSync(join(wt, '.claude/settings.json'), 'utf8')
    const res = await repo.cli(['init', '--agent', 'claude-code'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain(`payload-retired: ${OLD.join(' · ')}`)
    // the root: moved, rewired, one commit, nothing left dirty
    for (const p of OLD) expect(existsSync(join(repo.root, p))).toBe(false)
    expect(repo.git('ls-tree', '-r', '--name-only', 'HEAD', '--', '.claude/hooks')).toBe('.claude/hooks/enforce-pnpm.sh')
    expect(repo.git('ls-tree', '-r', '--name-only', 'HEAD', '--', '.witness/hooks').split('\n')).toEqual(NEW)
    expect(namesRetired(repo.read('.claude/settings.json'))).toBe(false)
    expect(repo.git('status', '--porcelain')).toBe('')
    // the worktree: its branch's settings untouched, its old hooks kept, the new home checked out and committed
    expect(readFileSync(join(wt, '.claude/settings.json'), 'utf8')).toBe(wtSettings)
    for (const p of OLD) expect(git(wt, 'ls-files', '--', p)).toBe(p)
    expect(git(wt, 'ls-files', '-t', '--', '.witness/hooks').split('\n')).toEqual(NEW.map((p) => `H ${p}`))
    expect(git(wt, 'status', '--porcelain', '--', '.witness/hooks')).toBe('')
  })

  it('refuses the whole run while an old hook at the root carries an uncommitted edit', async () => {
    const { repo } = await legacyHooksPlan('base-had')
    repo.write('.claude/hooks/guard-state.mjs', '// mine\n')
    const head = repo.git('rev-parse', 'HEAD')
    const res = await repo.cli(['init', '--agent', 'claude-code'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('payload-dirty')
    expect(res.stderr).toContain('.claude/hooks/guard-state.mjs')
    expect(repo.git('rev-parse', 'HEAD')).toBe(head)
    expect(existsSync(join(repo.root, '.witness/hooks'))).toBe(false)
  })

  it('keeps the old hooks, and says so, when the settings cannot be read', async () => {
    const { repo } = await legacyHooksPlan('base-had')
    repo.write('.claude/settings.json', `${repo.read('.claude/settings.json')}\n{ broken`)
    repo.git('add', '.claude/settings.json')
    repo.git('commit', '-m', 'a broken settings file')
    const res = await repo.cli(['init', '--agent', 'claude-code'])
    expect(res.code).toBe(0)
    for (const p of OLD) expect(existsSync(join(repo.root, p))).toBe(true)
    expect(res.stderr).toContain("warning: .claude/settings.json could not be read, so witness's old hooks stay in .claude/hooks/")
  })
})

// Security review of 4b978bf/9ab21dc: a plan branch can commit `.claude/hooks` as a link to anywhere,
// and a removal through it would delete a file outside the tree.
describe("witness's retired-file removals never follow a symlinked parent out of the tree (row 250)", () => {
  function linkedHooks(root: string): string {
    const outside = mkdtempSync(join(tmpdir(), 'witness-outside-'))
    writeFileSync(join(outside, 'guard-state.mjs'), '// not witness\'s\n')
    mkdirSync(join(root, '.claude'), { recursive: true })
    symlinkSync(outside, join(root, '.claude/hooks'))
    return outside
  }

  it('retireAtRoot leaves a file reached through a linked .claude/hooks', () => {
    const repo = tmpRepo()
    const outside = linkedHooks(repo.root)
    expect(retireAtRoot(repo.root, unwrap(loadHarness('claude-code')), undefined)).toEqual([])
    expect(readFileSync(join(outside, 'guard-state.mjs'), 'utf8')).toBe('// not witness\'s\n')
  })

  it('dropRetired leaves a file reached through a linked .claude/hooks', () => {
    const repo = tmpRepo()
    repo.write('a.txt', 'a\n')
    repo.git('add', 'a.txt')
    repo.git('commit', '-m', 'base')
    const base = repo.git('rev-parse', 'HEAD')
    const outside = linkedHooks(repo.root)
    expect(dropRetired(repo.root, base, 'p')).toEqual([])
    expect(readFileSync(join(outside, 'guard-state.mjs'), 'utf8')).toBe('// not witness\'s\n')
  })
})

// Slice 2 review C1: `read-tree -mu HEAD` resets the index, so a worktree's staged work was lost.
describe("refreshing a worktree's sparse patterns keeps its work (row 250, slice 2 review)", () => {
  it('init into an old-pattern worktree keeps a staged edit, a staged new file and an unstaged edit', async () => {
    const { repo, wt } = await legacyHooksPlan('base-had')
    writeFileSync(join(wt, '.claude/hooks/enforce-pnpm.sh'), '#!/bin/sh\nexit 1\n')
    git(wt, 'add', '.claude/hooks/enforce-pnpm.sh')                   // staged edit
    mkdirSync(join(wt, 'src'), { recursive: true })
    writeFileSync(join(wt, 'src/new.ts'), 'export const n = 1\n')
    git(wt, 'add', 'src/new.ts')                                       // staged new file
    writeFileSync(join(wt, 'witness.config.yaml'), `${readFileSync(join(wt, 'witness.config.yaml'), 'utf8')}# mine\n`)   // unstaged
    expect((await repo.cli(['init', '--agent', 'claude-code'])).code).toBe(0)
    expect(readFileSync(join(wt, '.claude/hooks/enforce-pnpm.sh'), 'utf8')).toBe('#!/bin/sh\nexit 1\n')
    expect(readFileSync(join(wt, 'src/new.ts'), 'utf8')).toBe('export const n = 1\n')
    expect(readFileSync(join(wt, 'witness.config.yaml'), 'utf8')).toMatch(/# mine\n$/)
    expect(git(wt, 'diff', '--cached', '--name-only').split('\n')).toEqual(['.claude/hooks/enforce-pnpm.sh', 'src/new.ts'])
    expect(git(wt, 'ls-files', '-t', '--', '.witness/hooks').split('\n')).toEqual(NEW.map((p) => `H ${p}`))
  })

  it('never touches a directory under .witness/worktrees that is not its own worktree', () => {
    const repo = tmpRepo()
    const patterns = join(repo.root, '.git', 'info', 'sparse-checkout')
    mkdirSync(dirname(patterns), { recursive: true })
    writeFileSync(patterns, '/*\n')
    const stale = join(repo.root, '.witness', 'worktrees', 'stale')
    mkdirSync(stale, { recursive: true })
    expect(refreshSparse(repo.root, stale)).toBe(false)
    expect(readFileSync(patterns, 'utf8')).toBe('/*\n')
  })
})
