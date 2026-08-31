import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyPullFailure, classifyPushFailure } from '../src/verbs/sync.js'
import { lazyStamp } from '../src/stamp.js'
import { loadCanon } from '../src/scan.js'
import {
  addOrigin, fakeCtx, fakeScenario, gateEnv, ghState, seededRepo, shippableRepo, writeSpec,
} from './helpers.js'

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

// D138. Local main converges without the human knowing `sync` exists: the merge stamp is
// the moment origin is known to have moved, so the sync sequence runs right after it.
describe('auto-sync (D138)', () => {
  it('classifies a protected-branch push rejection instead of a bare push failure', () => {
    expect(classifyPushFailure('remote: error: GH006: Protected branch update failed')).toBe('push-rejected')
    expect(classifyPushFailure('! [remote rejected] main -> main (protected branch hook declined)')).toBe('push-rejected')
    expect(classifyPushFailure('fatal: unable to access: Could not resolve host')).toBe('other')
  })

  it('the merge stamp heals local main against origin, and says nothing when it works', async () => {
    const seed = await shippableRepo()
    seed.repo.setMeta(seed.planId, { pr: 1 })
    addOrigin(seed.repo)                                   // local main == origin/main here
    const scenario = fakeScenario()
    ghState(scenario, 1, 'MERGED')
    const out: string[] = []
    const ctx = fakeCtx(seed.repo.root, { env: gateEnv(scenario), out: (l) => out.push(l) })

    const result = lazyStamp(seed.repo.root, ctx, loadCanon(seed.repo.root))

    expect(result.stamped).toHaveLength(1)                 // the stamp itself still happened
    expect(seed.repo.git('rev-list', '--count', 'origin/main..main')).toBe('0')
    expect(out.join('\n')).not.toContain('sync-auto:')      // success is silent
  })

  it('records the sync in the journal so an automatic act is auditable', async () => {
    const seed = await shippableRepo()
    seed.repo.setMeta(seed.planId, { pr: 1 })
    addOrigin(seed.repo)
    const scenario = fakeScenario()
    ghState(scenario, 1, 'MERGED')
    const ctx = fakeCtx(seed.repo.root, { env: gateEnv(scenario) })

    lazyStamp(seed.repo.root, ctx, loadCanon(seed.repo.root))

    const { readStream } = await import('../src/journal.js')
    const entry = readStream(seed.repo.root, seed.planId).findLast((e) => e.t === 'sync')
    expect(entry).toBeDefined()
    expect(entry?.trigger).toBe('merge-stamp')
    expect(entry?.result).toBe('ok')
  })

  it('a failing auto-sync is a printed finding, never a crash', async () => {
    const seed = await shippableRepo()
    seed.repo.setMeta(seed.planId, { pr: 1 })
    seed.repo.git('remote', 'add', 'origin', '/nonexistent/origin.git')
    const scenario = fakeScenario()
    ghState(scenario, 1, 'MERGED')
    const out: string[] = []
    const ctx = fakeCtx(seed.repo.root, { env: gateEnv(scenario), out: (l) => out.push(l) })

    const result = lazyStamp(seed.repo.root, ctx, loadCanon(seed.repo.root))

    expect(result.stamped).toHaveLength(1)                 // the stamp is not held hostage
    expect(out.join('\n')).toContain('sync-auto:')
  })
})
