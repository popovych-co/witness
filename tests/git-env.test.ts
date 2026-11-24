import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { addOrigin, fakeCtx, fixtureEnv, hermeticEnv, seededRepo, spawnAsync, tmpRepo, writeSpec, type TestRepo } from './helpers.js'
import { scratchDir } from './scratch.js'

// Row 272 (issue #101). No git a test runs leaves a process behind. git's auto maintenance
// (`git maintenance run --auto --detach`, started by a commit, merge, rebase or fetch in its own
// repository, and by receive-pack in a local origin on a push) outlives the command and writes into
// the repository: .git/objects/maintenance.lock, and on some git versions a repack. A test that
// copied or removed a repository right after committing raced it. Each case traces git and reads
// what it started: an auto maintenance run, or the `gc --auto` receive-pack runs itself up to git
// 2.44.
const MAINTENANCE = /run_command: git (maintenance run|gc --auto)/

// The auto runs a trace shows git starting, as git names them: a failure prints the spawn.
const maintenance = (trace: string): string[] =>
  trace.split('\n').filter((l) => MAINTENANCE.test(l)).map((l) => l.slice(l.indexOf('run_command:')))

const traceFile = (): string => join(scratchDir('witness-git-trace-'), 'trace')

// One git command under `env`, traced to a file of the test's own; the trace.
async function traced(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<string> {
  const file = traceFile()
  const r = await spawnAsync('git', args, { cwd, env: { ...env, GIT_TRACE: file } })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} exited ${r.code}\n${r.stderr}`)
  return readFileSync(file, 'utf8')
}

// A fixture repo whose first commit is on its local origin, with a second change staged.
function pushedRepo(): TestRepo {
  const repo = tmpRepo()
  repo.write('a.txt', 'a\n')
  repo.git('add', 'a.txt')
  repo.git('commit', '-qm', 'a')
  addOrigin(repo)
  repo.write('b.txt', 'b\n')
  repo.git('add', 'b.txt')
  return repo
}

describe('no git a test runs starts auto maintenance (row 272, issue #101)', () => {
  // Every env a test hands to git: the worker's own, one built on it, and the two built from
  // nothing, whose env src hands to the children it starts.
  it.each<[string, () => NodeJS.ProcessEnv]>([
    ['the worker env', () => process.env],
    ['hermeticEnv()', () => hermeticEnv()],
    ['fixtureEnv()', () => fixtureEnv()],
    ['fakeCtx().env', () => fakeCtx('.', { env: { PATH: process.env.PATH ?? '' } }).env as NodeJS.ProcessEnv],
  ])('a commit, and a push to a local origin, under %s', async (_name, envOf) => {
    const repo = pushedRepo()
    const commit = await traced(repo.root, envOf(), 'commit', '-qm', 'b')
    const push = await traced(repo.root, envOf(), 'push', '-q', 'origin', 'main')
    expect(commit).toContain('built-in: git commit')
    expect(push).toContain('built-in: git receive-pack')
    expect(maintenance(commit)).toEqual([])
    // receive-pack starts with GIT_CONFIG_COUNT and -c cleared (git's local_repo_env), which is
    // why the suite's config is a global one
    expect(maintenance(push)).toEqual([])
  })

  it('a commit the CLI makes in process, whose git reads the worker env (src/gitio.ts)', async () => {
    const repo = await seededRepo()
    const file = traceFile()
    vi.stubEnv('GIT_TRACE', file)
    try {
      expect((await writeSpec(repo, 'auth-refresh')).code).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
    const trace = readFileSync(file, 'utf8')
    expect(trace).toContain('built-in: git commit')
    expect(maintenance(trace)).toEqual([])
  })

  // The cases above can fail: where the suite's config is overridden, the trace shows the run. Every
  // switch is spelled out, so a machine's system config cannot turn the check red, and the run is in
  // the foreground (autoDetach false), so it is over before the test is.
  it('the trace shows auto maintenance wherever the suite\'s config is overridden', async () => {
    const repo = pushedRepo()
    const commit = await traced(repo.root, process.env, '-c', 'maintenance.auto=true', '-c', 'maintenance.autoDetach=false', '-c', 'gc.autoDetach=false', 'commit', '-qm', 'b')
    const own = join(scratchDir('witness-git-config-'), 'gitconfig')
    writeFileSync(own, '[maintenance]\n\tauto = true\n\tautoDetach = false\n[receive]\n\tautoGC = true\n[gc]\n\tautoDetach = false\n')
    const push = await traced(repo.root, { ...process.env, GIT_CONFIG_GLOBAL: own }, 'push', '-q', 'origin', 'main')
    expect(maintenance(commit)).not.toEqual([])
    expect(maintenance(push)).not.toEqual([])
  })
})
