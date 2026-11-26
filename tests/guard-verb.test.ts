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
import { DEFAULT_DEFINITIONS } from '../src/definitions.js'
import { worktreePath } from '../src/worktree.js'
import type { AnchorInput } from '../src/verdict.js'
import {
  TOKEN_BROKEN, TOKEN_FIXED, approve, fakeLint, fixtureEnv, patchConfig, runScript, seededRepo, shippableRepo, trustConfig, unwrap,
  vitestBin, writePlan, writeSpec,
} from './helpers.js'

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

// A plan whose base (main) holds the fake lint, run-script.mjs, a package.json whose `lintsarif`
// script runs the fake lint's SARIF, and `main` files; round 1 (implement) reviewed src/token.ts with a
// SWALLOW line and marked it; the worktree now holds the fix and fake-lint.json adding `rule`.
const SWALLOWED = `${TOKEN_BROKEN}// SWALLOW the error\n`
async function lintBench(opts: {
  main?: Record<string, string>; rule?: Record<string, unknown>; reader?: string; anchor?: AnchorInput; planPkg?: string; mark?: GuardKind
} = {}) {
  const repo = await seededRepo()
  const lint = fakeLint(repo)
  const script = runScript(repo)
  repo.write('package.json', `${JSON.stringify({ name: 'base', type: 'module', scripts: { lintsarif: lint.sarif } }, null, 2)}\n`)
  for (const [path, text] of Object.entries(opts.main ?? {})) repo.write(path, text)
  const reader = opts.reader ?? lint.sarif
  patchConfig(repo, {
    ship: { test: 'true', lint: { biome: lint.check } }, readers: { biome: reader },
    checks: { definitions: [...DEFAULT_DEFINITIONS, 'fake-lint.json'] },
  })
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'base with lint')
  trustConfig(repo)
  await writeSpec(repo, 'auth-refresh'); approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1'); repo.flipStatus('auth-refresh-plan-1', 'approved')
  const planId = 'auth-refresh-plan-1'
  const started = await repo.cli(['start', planId])
  if (started.code !== 0) throw new Error(started.stderr)
  const wt = worktreePath(repo.root, planId)
  const cfg = unwrap(loadConfig(repo.root))
  const base = unwrap(diffBase(wt, cfg))
  mkdirSync(join(wt, 'src'), { recursive: true })
  if (opts.planPkg !== undefined) writeFileSync(join(wt, 'package.json'), opts.planPkg)
  writeFileSync(join(wt, 'src/token.ts'), SWALLOWED)
  const tree = snapshotTree(wt, base, planChangeSet(wt, base))!
  unwrap(pinTree(repo.root, planId, tree))
  writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
  appendEntry(repo.root, planId, {
    v: 1, t: 'gate-run', gate: 'implement', artifact: planId, round: 1, run_id: 'r-lint-1', reviewed_sha: 's', prompts_sha: 'p',
    witness: '0', model: 'm', pin: 'm', harness: 'claude-code', checks: [], reviewed_tree: tree,
    verdicts: [{ reviewer: 'silent-failure-hunter', coverage: [], findings: [{ anchor: opts.anchor ?? 'src/token.ts', claim: 'swallows the error', blocking: true, guard: opts.mark ?? 'lint' }] }],
    outcome: 'stopped',
  } as unknown as Entry)
  writeFileSync(join(wt, 'fake-lint.json'), `${JSON.stringify({ rules: { 'lint/test/noSwallow': { word: 'SWALLOW', ...opts.rule } } })}\n`)
  const guard = (args: string[], env = fixtureEnv()) => repo.cli(['guard', planId, ...args], { cwd: wt, env })
  const guards = () => readStream(repo.root, planId).filter((e) => e.t === 'guard')
  return { repo, wt, planId, guard, guards }
}

const LINT_ARGS = ['--finding', 'src/token.ts', '--files', 'fake-lint.json', '--rule', 'biome:lint/test/noSwallow']

describe('witness guard — a lint guard (row 280)', () => {
  it('a lint guard reads the declared rule on the round it answers and none now (row 280)', async () => {
    const b = await lintBench()
    const r = await b.guard(LINT_ARGS)
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain("guard: proven src/token.ts · lint biome:lint/test/noSwallow — red on round 1's tree, green now")
    expect(r.stdout).not.toContain('other spot')
    expect(b.guards()).toHaveLength(1)
    expect(b.guards()[0]).toMatchObject({ t: 'guard', kind: 'lint', rule: { tool: 'biome', rule: 'lint/test/noSwallow' }, spots: 0 })
  }, 180_000)

  it('a warn-level rule is not a red (the acceptance)', async () => {
    const b = await lintBench({ rule: { level: 'warn' } })
    const r = await b.guard(LINT_ARGS)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('guard-not-red')
    expect(b.guards()).toEqual([])
  }, 180_000)

  it('a rule that still fires on the anchored file now is no guard (guard-not-green)', async () => {
    const b = await lintBench({ rule: { word: 'return' } })   // a keyword: the breadth copy keeps it
    const r = await b.guard(LINT_ARGS)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('guard-not-green')
    expect(b.guards()).toEqual([])
  }, 180_000)

  it("the rule's other spots on the current tree are counted and said", async () => {
    const b = await lintBench({ main: { 'src/other.ts': 'export const o = 1 // SWALLOW\n' } })
    const r = await b.guard(LINT_ARGS)
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain("note: 1 other spot on the current tree — lint reads it as this plan's until it is fixed")
    expect(b.guards()[0]).toMatchObject({ spots: 1 })
  }, 180_000)

  it("a lint guard runs the base's scripts: a reader through a script the plan rewrote reads the base's", async () => {
    const quiet = `${JSON.stringify({ name: 'base', type: 'module', scripts: { lintsarif: 'node -e "process.stdout.write(\'{}\')"' } }, null, 2)}\n`
    const b = await lintBench({ reader: 'node run-script.mjs lintsarif', planPkg: quiet })
    const r = await b.guard(LINT_ARGS)
    expect(r.code, r.stderr).toBe(0)
    expect(b.guards()).toHaveLength(1)
  }, 180_000)

  it('a lint guard on an omission anchor refuses guard-anchor-not-a-file; an unset reader refuses reader-unset', async () => {
    const b = await lintBench({ anchor: { kind: 'omission', scope: 'src/' } })
    const omission = await b.guard(['--finding', 'omission:src/', '--files', 'fake-lint.json', '--rule', 'biome:lint/test/noSwallow'])
    expect(omission.code).toBe(2)
    expect(omission.stderr).toContain('guard-anchor-not-a-file')
    const c = await lintBench()
    const unset = await c.guard(['--finding', 'src/token.ts', '--files', 'fake-lint.json', '--rule', 'eslint:no-swallow'])
    expect(unset.code).toBe(2)
    expect(unset.stderr).toContain('reader-unset')
    expect([...b.guards(), ...c.guards()]).toEqual([])
  }, 240_000)

  it('a report the reader cannot read refuses reader-unread, never a red', async () => {
    const b = await lintBench()
    writeFileSync(join(b.wt, 'fake-lint.json'), `${JSON.stringify({ report: 'garbage', rules: { 'lint/test/noSwallow': { word: 'SWALLOW' } } })}\n`)
    const r = await b.guard(LINT_ARGS)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('reader-unread')
    expect(b.guards()).toEqual([])
  }, 180_000)

  it('--rule outside <tool>:<rule> refuses rule-shape', async () => {
    const b = await lintBench()
    for (const rule of ['nope', 'biome:', 'x:y', 'eslint:a b']) {
      const r = await b.guard(['--finding', 'src/token.ts', '--files', 'fake-lint.json', '--rule', rule])
      expect(r.stderr, rule).toContain('rule-shape')
    }
    expect(b.guards()).toEqual([])
  }, 240_000)
})

describe('witness guard — the breadth copy (row 280)', () => {
  it("a rule scoped to the anchored file's path is too narrow (guard-too-narrow)", async () => {
    const b = await lintBench({ rule: { files: ['src/token.ts'] } })
    const r = await b.guard(LINT_ARGS)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('guard-too-narrow')
    expect(b.guards()).toEqual([])
  }, 180_000)

  it("a rule scoped to the anchored file and the copy's old fixed name is still too narrow: the copy's name is drawn each run (slice 2 review I1)", async () => {
    const b = await lintBench({ rule: { files: ['src/token.ts', 'src/token-witness-breadth.ts'] } })
    const r = await b.guard(LINT_ARGS)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('guard-too-narrow')
  }, 180_000)

  it("a rule matching a parameter's name is too narrow (slice 2 review I2)", async () => {
    const b = await lintBench({ rule: { word: 'prev' } })
    const r = await b.guard(LINT_ARGS)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('guard-too-narrow')
  }, 180_000)

  it("a rule matching a local's name is too narrow", async () => {
    const b = await lintBench({ rule: { word: 'rotateDue' } })
    const r = await b.guard(LINT_ARGS)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('guard-too-narrow')
    expect(b.guards()).toEqual([])
  }, 180_000)

  it('a guard that holds on its breadth copy journals the copy', async () => {
    const b = await lintBench()
    const r = await b.guard(LINT_ARGS)
    expect(r.code, r.stderr).toBe(0)
    expect((b.guards()[0] as { breadth?: string }).breadth).toMatch(/^src\/[a-z]{8}\.ts$/)
  }, 180_000)

  it('a lint guard on a file outside the JS/TS family refuses breadth-unprobed', async () => {
    const b = await lintBench({ anchor: 'src/lib.rs' })
    const r = await b.guard(['--finding', 'src/lib.rs', '--files', 'fake-lint.json', '--rule', 'biome:lint/test/noSwallow'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('breadth-unprobed')
    expect(r.stderr).toContain('--book guards')
    expect(b.guards()).toEqual([])
  }, 240_000)
})
