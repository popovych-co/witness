import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planChangeSet } from '../src/change-set.js'
import { pinTree } from '../src/cf-tree.js'
import { loadConfig } from '../src/config.js'
import { diffBase } from '../src/evidence.js'
import { appendEntry, readStream, type Entry } from '../src/journal.js'
import { ENTRY_PROGRESS } from '../src/progress.js'
import { ACT_KINDS } from '../src/slice.js'
import { snapshotTree } from '../src/snapshot.js'
import type { GuardKind } from '../src/verdict.js'
import { TOKEN_BROKEN, TOKEN_FIXED, fixtureEnv, patchConfig, shippableRepo, trustConfig, unwrap, vitestBin } from './helpers.js'

const BY_FILE = `node "${vitestBin()}" run --reporter=junit --outputFile=reports/junit.xml {files}`
const NAME = 'rotates at 80% of the ttl'
const guardTest = (body: string, head = '') =>
  `import { expect, it } from 'vitest'\nimport { rotateDue } from '../src/token'\n${head}it('${NAME}', () => { ${body} })\n`
const CATCHES = guardTest('expect(rotateDue(80, 100)).toBe(true)')

// A shippable plan whose round 1 (implement) reviewed TOKEN_BROKEN and marked src/token.ts for a guard;
// the worktree now holds TOKEN_FIXED and tests/guard.test.ts.
async function bench(opts: { byFile?: string; test?: string; mark?: GuardKind; anchor?: string } = {}) {
  const { repo, wt, planId } = await shippableRepo()
  patchConfig(repo, { criteria: { report: 'junit:reports/junit.xml', byFile: opts.byFile ?? BY_FILE } })
  trustConfig(repo)
  const cfg = unwrap(loadConfig(repo.root))
  const base = unwrap(diffBase(wt, cfg))
  writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
  const tree = snapshotTree(wt, base, planChangeSet(wt, base))!
  unwrap(pinTree(repo.root, planId, tree))
  writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
  appendEntry(repo.root, planId, {
    v: 1, t: 'gate-run', gate: 'implement', artifact: planId, round: 1, run_id: 'r-guard-1', reviewed_sha: 's', prompts_sha: 'p',
    witness: '0', model: 'm', pin: 'm', harness: 'claude-code', checks: [], reviewed_tree: tree,
    verdicts: [{ reviewer: 'code-reviewer', coverage: [], findings: [{ anchor: opts.anchor ?? 'src/token.ts', claim: 'never rotates', blocking: true, guard: opts.mark ?? 'test' }] }],
    outcome: 'stopped',
  } as unknown as Entry)
  mkdirSync(join(wt, 'tests'), { recursive: true })
  writeFileSync(join(wt, 'tests/guard.test.ts'), opts.test ?? CATCHES)
  const guard = (args: string[], env = fixtureEnv()) => repo.cli(['guard', planId, ...args], { cwd: wt, env })
  const guards = () => readStream(repo.root, planId).filter((e) => e.t === 'guard')
  const blobOf = (path: string) => execFileSync('git', ['hash-object', '--', path], { cwd: wt, encoding: 'utf8' }).trim()
  return { repo, wt, planId, guard, guards, blobOf }
}

const TEST_ARGS = ['--finding', 'src/token.ts', '--files', 'tests/guard.test.ts', '--test', NAME]

describe('witness guard — a test guard (row 280)', () => {
  it('a test guard fails on the round it answers and passes now: one guard entry, an act (row 280)', async () => {
    const b = await bench()
    const r = await b.guard(TEST_ARGS)
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain("guard: proven src/token.ts · test 1 named — red on round 1's tree, green now")
    expect(b.guards()).toHaveLength(1)
    expect(b.guards()[0]).toMatchObject({
      t: 'guard', gate: 'implement', anchor: 'src/token.ts', round: 1, run: 'r-guard-1', kind: 'test', tests: [NAME],
      files: { 'tests/guard.test.ts': b.blobOf('tests/guard.test.ts') },
    })
    expect(ENTRY_PROGRESS.guard).toBe('act')
    expect(ACT_KINDS.has('guard')).toBe(true)
    expect((await b.repo.cli(['log', b.planId])).stdout).toMatch(/guard.*implement r1 src\/token\.ts · test 1 named/)
  }, 180_000)

  it('a test that passes on the round it answers is no guard (guard-not-red), and nothing is journaled', async () => {
    const b = await bench({ test: guardTest('expect(1).toBe(1)') })
    const r = await b.guard(TEST_ARGS)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('guard-not-red')
    expect(b.guards()).toEqual([])
  }, 180_000)

  it('a test that fails now is no guard (guard-not-green)', async () => {
    const b = await bench({ test: guardTest('expect(rotateDue(10, 100)).toBe(true)') })
    const r = await b.guard(TEST_ARGS)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('guard-not-green')
    expect(b.guards()).toEqual([])
  }, 180_000)

  it('a run that reports none of the named cases is the environment, never a red (guard-not-run)', async () => {
    const b = await bench({ byFile: "mkdir -p reports && printf '<testsuites/>' > reports/junit.xml && exit 1 # {files}" })
    const r = await b.guard(TEST_ARGS)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('guard-not-run')
    expect(b.guards()).toEqual([])
  }, 180_000)

  it('a load error is not a red (the acceptance): a test importing what only the worktree holds refuses load-failure', async () => {
    const b = await bench({ test: guardTest('expect(rotateDue(80, 100) && helper()).toBe(true)', "import { helper } from '../src/helper'\n") })
    writeFileSync(join(b.wt, 'src/helper.ts'), 'export const helper = () => true\n')
    const r = await b.guard(TEST_ARGS)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('load-failure')
    expect(b.guards()).toEqual([])
  }, 240_000)

  it('with criteria.byFile none the guard runs ship.test, the full suite', async () => {
    const b = await bench({ byFile: 'none' })
    patchConfig(b.repo, { ship: { test: `node "${vitestBin()}" run --reporter=junit --outputFile=reports/junit.xml` } })
    trustConfig(b.repo)
    const r = await b.guard(TEST_ARGS)
    expect(r.code, r.stderr).toBe(0)
    expect(b.guards()).toHaveLength(1)
  }, 240_000)

  it('an untrusted command refuses with the grant to make and runs nothing', async () => {
    const b = await bench()
    const mark = join(b.repo.root, '.git', 'guard-ran')
    patchConfig(b.repo, { criteria: { byFile: `touch '${mark}' && ${BY_FILE}` } })
    rmSync(join(b.repo.root, '.witness', 'allow.json'), { force: true })
    const r = await b.guard(TEST_ARGS, fixtureEnv({ WITNESS_TRUST_CMDS: '0' }))
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('untrusted-blocked')
    expect(r.stderr).toContain('witness next')
    expect(existsSync(mark)).toBe(false)
    expect(b.guards()).toEqual([])
  }, 180_000)

  it('no finding marked at the anchor refuses finding-unknown; --rule with --test refuses guard-kind; a bad name refuses test-name', async () => {
    const b = await bench()
    const unknown = await b.guard(['--finding', 'src/other.ts', '--files', 'tests/guard.test.ts', '--test', NAME])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('finding-unknown')
    const both = await b.guard([...TEST_ARGS, '--rule', 'biome:lint/x'])
    expect(both.code).toBe(2)
    expect(both.stderr).toContain('guard-kind')
    const neither = await b.guard(['--finding', 'src/token.ts', '--files', 'tests/guard.test.ts'])
    expect(neither.stderr).toContain('guard-kind')
    const ctl = await b.guard(['--finding', 'src/token.ts', '--files', 'tests/guard.test.ts', '--test', 'a\u0007b'])
    expect(ctl.stderr).toContain('test-name')
    expect(b.guards()).toEqual([])
  }, 180_000)

  it('a test guard with no test file in its overlay refuses guard-no-test-file; the anchored file refuses overlay-anchor', async () => {
    const b = await bench()
    writeFileSync(join(b.wt, 'eslint.config.mjs'), 'export default []\n')
    const r = await b.guard(['--finding', 'src/token.ts', '--files', 'eslint.config.mjs', '--test', NAME])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('guard-no-test-file')
    const anchored = await b.guard(['--finding', 'src/token.ts', '--files', 'src/token.ts', '--test', NAME])
    expect(anchored.stderr).toContain('overlay-anchor')
    expect(b.guards()).toEqual([])
  }, 180_000)
})
