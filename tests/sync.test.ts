import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyPullFailure } from '../src/verbs/sync.js'
import { addOrigin, seededRepo, writeSpec } from './helpers.js'

describe('classifyPullFailure', () => {
  it('names the three shapes', () => {
    expect(classifyPullFailure('There is no tracking information for the current branch.')).toBe('no-upstream')
    expect(classifyPullFailure('CONFLICT (content): Merge conflict in .witness/journal/x.jsonl\nerror: could not apply cc31971')).toBe('conflict')
    expect(classifyPullFailure('fatal: Not possible to fast-forward, aborting.')).toBe('other')
  })
})

describe('witness sync', () => {
  it('renders a real rebase conflict as conflict with the conflicted paths, not the catch-all', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    addOrigin(repo)
    // Diverge with a content conflict: clone the bare, append to the same journal tail, push.
    const clone = mkdtempSync(join(tmpdir(), 'sync-clone-'))
    execFileSync('git', ['clone', `${repo.root}-origin.git`, clone], { stdio: 'ignore' })
    const gitIn = (...args: string[]) =>
      execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    gitIn('config', 'user.name', 'test')
    gitIn('config', 'user.email', 'test@example.com')
    gitIn('config', 'commit.gpgsign', 'false')
    const journalRel = join('.witness', 'journal', `${repo.effort}.jsonl`)
    const journal = join(clone, journalRel)
    execFileSync('bash', ['-c', `printf '%s\\n' '{"v":1,"t":"conflict-bait"}' >> '${journal}'`])
    gitIn('add', '-A')
    gitIn('commit', '-m', 'remote edit')
    gitIn('push', 'origin', 'main')
    // Local: conflicting append to the same file tail.
    repo.write(journalRel, repo.read(journalRel) + '{"v":1,"t":"local-bait"}\n')
    repo.git('add', '-A'); repo.git('commit', '-m', 'local edit')

    const res = await repo.cli(['sync'])

    expect(res.code).toBe(1)
    // `kv` TOON-escapes any value carrying a comma, so the line renders quoted — the old
    // catch-all carried the same comma and rendered the same way. Kind, conflicted path
    // and remedy in one assertion; the `detail:` line the catch-all needed is gone.
    expect(res.stdout).toMatch(
      /^sync: "rebase conflict in \.witness\/journal\/\S+ — resolve manually, then re-run witness sync"$/m)
    expect(res.stdout).not.toMatch(/^detail: /m)
  })

  it('renders a non-conflict failure verbatim, never as a rebase conflict', () => {
    // Pure-function coverage above pins the classifier; this pins the render wiring:
    // the catch-all that printed "rebase conflict" for every non-upstream failure is gone.
    const src = readFileSync('src/verbs/sync.ts', 'utf8')
    expect(src).not.toMatch(/rebase conflict — resolve manually.*\n.*detail/)
  })
})

describe('divergence visibility (D139)', () => {
  it('check warns when local is ahead, and is silent when clean or remoteless', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')

    const before = await repo.cli(['check'])
    expect(before.stdout).not.toContain('origin/main')          // no remote → silent

    addOrigin(repo)
    const clean = await repo.cli(['check'])
    expect(clean.stdout).not.toContain('origin/main')           // in step → silent

    repo.git('commit', '--allow-empty', '-m', 'local only')
    const res = await repo.cli(['check'])

    expect(res.code).toBe(0)                                    // warn, never error
    expect(res.stdout).toMatch(/warn,git,main,ahead,1 ahead · 0 behind origin\/main — witness sync/)
  })
})
