import { appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { witnessPaths } from '../src/change-set.js'
import { stateDirs } from '../src/gitio.js'
import { codeTree } from '../src/snapshot.js'
import { seededRepo, writeSpec } from './helpers.js'

// Row 275 (C29). Every journal line and stamp is a commit on main, so main's whole tree moves
// without any code moving: the code tree is the tree a suite's outcome rests on.
describe('the code a tree holds (row 275, C29)', () => {
  it("leaves out witness's state, canon and payload: commits that differ only there share it", async () => {
    const repo = await seededRepo()
    repo.write('src/a.ts', 'a()\n'); repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'code')
    const a = repo.git('rev-parse', 'HEAD')
    repo.write('.witness/journal/x.jsonl', '{"v":1,"t":"status"}\n')
    repo.write(join(stateDirs(repo.root)[0]!, 'x.md'), '# x\n')           // the config's specs folder
    repo.write(witnessPaths()[0]!, 'payload\n')
    repo.git('add', '-A', '-f'); repo.git('commit', '-q', '-m', 'witness only')
    const b = repo.git('rev-parse', 'HEAD')
    expect(codeTree(repo.root, a)).toMatch(/^[0-9a-f]{40}$/)
    expect(codeTree(repo.root, b)).toBe(codeTree(repo.root, a))
    expect(codeTree(repo.root, repo.git('rev-parse', `${b}^{tree}`))).toBe(codeTree(repo.root, a))
    repo.write('src/a.ts', 'b()\n'); repo.git('commit', '-qam', 'more code')
    expect(codeTree(repo.root, repo.git('rev-parse', 'HEAD'))).not.toBe(codeTree(repo.root, a))
  })
  it('main moving an existing stream and an existing canon doc keeps every older commit readable and its code (slice 1 review C1)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    repo.write('src/a.ts', 'a()\n'); repo.git('add', '-A', '-f'); repo.git('commit', '-q', '-m', 'code')
    const a = repo.git('rev-parse', 'HEAD')
    const stream = readdirSync(join(repo.root, '.witness', 'journal')).find((f) => f.endsWith('.jsonl'))!
    appendFileSync(join(repo.root, '.witness', 'journal', stream), '{"v":1,"t":"status"}\n')
    appendFileSync(join(repo.root, stateDirs(repo.root)[0]!, 'auth-refresh.md'), '\nstamped\n')
    repo.git('add', '-A', '-f'); repo.git('commit', '-q', '-m', 'a journal line and a stamp')
    const b = repo.git('rev-parse', 'HEAD')
    expect(codeTree(repo.root, a)).toMatch(/^[0-9a-f]{40}$/)
    expect(codeTree(repo.root, repo.git('rev-parse', `${a}^{tree}`))).toBe(codeTree(repo.root, a))
    expect(codeTree(repo.root, b)).toBe(codeTree(repo.root, a))
  })
  it('a sha the repo lacks reads undefined', async () => {
    expect(codeTree((await seededRepo()).root, 'f'.repeat(40))).toBeUndefined()
  })
})
