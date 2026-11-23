import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { configCommands, grantCommands, trustedNow } from '../src/allowlist.js'
import { loadConfig, type Config } from '../src/config.js'
import { detectPrepare, prepareInputs, prepareScratch } from '../src/prepare.js'
import type { Result } from '../src/refusal.js'
import { openScratch, resetScratch } from '../src/scratch.js'
import { fakeCtx, fakeScenario, fixtureEnv, patchConfig, seededRepo, tmpRepo, type TestRepo } from './helpers.js'

describe('the setup command a repo declares (row 259)', () => {
  it.each([
    [['pnpm-lock.yaml'], 'pnpm install --frozen-lockfile'],
    [['package-lock.json'], 'npm ci'],
    [['npm-shrinkwrap.json'], 'npm ci'],
    [['yarn.lock'], 'yarn install --frozen-lockfile'],
    [['yarn.lock', '.yarnrc.yml'], 'yarn install --immutable'],
    [['bun.lock'], 'bun install --frozen-lockfile'],
    [['bun.lockb'], 'bun install --frozen-lockfile'],
    [['Cargo.lock'], 'none'],
    [[], 'none'],
  ])('detectPrepare with %j at the root is %s', (files, want) => {
    const repo = tmpRepo()
    for (const f of files) repo.write(f, '')
    expect(detectPrepare(repo.root)).toBe(want)
  })
})

const value = <T>(r: Result<T>): T => { if (!r.ok) throw new Error(JSON.stringify(r.violations)); return r.value }
const rule = (r: Result<unknown>): string => (r.ok ? 'ok' : r.violations[0]!.rule)
const cfgOf = (root: string): Config => { const r = loadConfig(root); if (!r.ok) throw new Error('config'); return r.value }
const recordOf = (dir: string) => join(spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: dir, encoding: 'utf8' }).stdout.trim(), 'witness-prepare.json')
const commitAll = (repo: TestRepo, m: string) => { repo.git('add', '-A'); repo.git('commit', '-q', '-m', m) }

// A repo whose scratch.prepare is `sh prepare.sh`, committed with the script; the script logs to a file outside the scratch.
async function prepared(script: string, opts: { grant?: boolean; env?: Record<string, string> } = {}) {
  const repo = await seededRepo()
  const log = join(fakeScenario(), 'prepare.log')
  repo.write('prepare.sh', script)
  patchConfig(repo, { scratch: { prepare: 'sh prepare.sh' } })
  commitAll(repo, 'prepare')
  if (opts.grant !== false) grantCommands(repo.root, ['sh prepare.sh'])
  const ctx = fakeCtx(repo.root, { env: fixtureEnv({ WITNESS_TRUST_CMDS: '0', PREPARE_LOG: log, ...opts.env }) })
  const dir = value(openScratch(repo.root))
  const at = (commit: string) => { value(resetScratch(dir, commit)); return repo.git('rev-parse', `${commit}^{tree}`) }
  const prep = (commit: string, force = false) => prepareScratch(repo.root, ctx, cfgOf(repo.root), dir, at(commit), { force })
  return { repo, ctx, log, dir, prep, head: () => repo.git('rev-parse', 'HEAD') }
}

describe('prepare (row 259)', () => {
  it('hashes the lock and package-manager files at any depth, and nothing else', () => {
    const repo = tmpRepo()
    repo.write('pnpm-lock.yaml', 'a'); repo.write('package.json', '{}'); repo.write('apps/x/Cargo.lock', 'c'); repo.write('src/a.ts', 'a')
    commitAll(repo, 'one')
    const at = () => prepareInputs(repo.root, repo.git('rev-parse', 'HEAD^{tree}'))
    const h0 = at()
    expect(h0).toMatch(/^[0-9a-f]{64}$/)
    const edit = (rel: string, content: string) => { repo.write(rel, content); commitAll(repo, rel) }
    edit('package.json', '{"scripts":{"x":"y"}}'); expect(at()).toBe(h0)
    edit('src/a.ts', 'b'); expect(at()).toBe(h0)
    edit('apps/x/Cargo.lock', 'd'); const h1 = at(); expect(h1).not.toBe(h0)
    edit('pnpm-workspace.yaml', 'packages: []'); expect(at()).not.toBe(h1)
    const bare = tmpRepo(); bare.write('src/a.ts', 'a'); commitAll(bare, 'x')
    expect(prepareInputs(bare.root, bare.git('rev-parse', 'HEAD^{tree}'))).toBe('')
  })

  it('runs once per inputs, and again at each switch between lockfiles (Review Focus 4)', async () => {
    const { repo, log, prep, head } = await prepared('echo ran >> "$PREPARE_LOG"\n')
    const one = head()
    expect(value(prep(one))).toMatchObject({ ran: true })
    expect(value(prep(one))).toMatchObject({ ran: false })
    repo.write('pnpm-lock.yaml', 'v2\n'); commitAll(repo, 'lock')
    expect(value(prep(head()))).toMatchObject({ ran: true })
    expect(value(prep(one))).toMatchObject({ ran: true })
    expect(value(prep(head()))).toMatchObject({ ran: true })
    expect(readFileSync(log, 'utf8')).toBe('ran\nran\nran\nran\n')
  })

  it('the record is gone while prepare runs, so a prepare killed mid-way runs again (§3.4 acceptance)', async () => {
    const kill = join(fakeScenario(), 'kill-next')
    const { repo, log, dir, prep, head } = await prepared(
      'test -f "$(git rev-parse --git-dir)/witness-prepare.json" && echo present >> "$PREPARE_LOG" || echo absent >> "$PREPARE_LOG"\n'
      + `if [ -f "${kill}" ]; then rm "${kill}"; kill -KILL $$; fi\n`)
    expect(value(prep(head()))).toMatchObject({ ran: true })
    expect(existsSync(recordOf(dir))).toBe(true)
    repo.write('pnpm-lock.yaml', 'v2\n'); commitAll(repo, 'lock')
    writeFileSync(kill, '')
    expect(rule(prep(head()))).toBe('run-interrupted')
    expect(existsSync(recordOf(dir))).toBe(false)
    expect(value(prep(head()))).toMatchObject({ ran: true })
    expect(readFileSync(log, 'utf8')).toBe('absent\nabsent\nabsent\n')
    expect(JSON.parse(readFileSync(recordOf(dir), 'utf8'))).toEqual({ cmd: 'sh prepare.sh', inputs: prepareInputs(repo.root, repo.git('rev-parse', 'HEAD^{tree}')) })
  })

  it('a failing prepare refuses with its last line and leaves no record', async () => {
    const { dir, prep, head } = await prepared('echo "lockfile out of date" >&2\nexit 3\n')
    const r = prep(head())
    expect(rule(r)).toBe('prepare-failed')
    expect(r.ok ? '' : r.violations[0]!.got).toContain('lockfile out of date')
    expect(existsSync(recordOf(dir))).toBe(false)
  })

  it('an untrusted prepare refuses before it runs and never asks, even at a terminal', async () => {
    const { repo, log, dir, head } = await prepared('echo ran >> "$PREPARE_LOG"\n', { grant: false })
    const tty = fakeCtx(repo.root, { tty: true, answers: ['y'], env: fixtureEnv({ WITNESS_TRUST_CMDS: '0', PREPARE_LOG: log }) })
    value(resetScratch(dir, head()))
    expect(rule(prepareScratch(repo.root, tty, cfgOf(repo.root), dir, repo.git('rev-parse', 'HEAD^{tree}')))).toBe('untrusted-blocked')
    expect(existsSync(log)).toBe(false)
  })

  it('prepare none runs nothing; an unset prepare refuses scratch-off', async () => {
    const repo = await seededRepo()
    const ctx = fakeCtx(repo.root, { env: fixtureEnv() })
    const dir = value(openScratch(repo.root))
    const tree = repo.git('rev-parse', 'HEAD^{tree}')
    expect(value(prepareScratch(repo.root, ctx, cfgOf(repo.root), dir, tree))).toEqual({ ran: false, inputs: prepareInputs(repo.root, tree) })
    const off = { ...cfgOf(repo.root), scratch: {} }
    expect(rule(prepareScratch(repo.root, ctx, off, dir, tree))).toBe('scratch-off')
  })

  it('repo commands include scratch.prepare unless it is none; trustedNow reads allow.json or WITNESS_TRUST_CMDS=1 only', async () => {
    const repo = await seededRepo()
    expect(configCommands(cfgOf(repo.root)).map((c) => c.source)).not.toContain('scratch.prepare')
    patchConfig(repo, { scratch: { prepare: 'pnpm install --frozen-lockfile' } })
    expect(configCommands(cfgOf(repo.root)).at(-1)).toEqual({ cmd: 'pnpm install --frozen-lockfile', source: 'scratch.prepare' })
    expect(trustedNow(repo.root, {}, 'pnpm install --frozen-lockfile')).toBe(false)
    expect(trustedNow(repo.root, { WITNESS_TRUST_CMDS: '1' }, 'pnpm install --frozen-lockfile')).toBe(true)
    grantCommands(repo.root, ['pnpm install --frozen-lockfile'])
    expect(trustedNow(repo.root, {}, 'pnpm install --frozen-lockfile')).toBe(true)
  })
})
