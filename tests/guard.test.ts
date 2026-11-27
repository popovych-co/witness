import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planChangeSet } from '../src/change-set.js'
import { foldOverlay } from '../src/cf-tree.js'
import { loadConfig, type Config } from '../src/config.js'
import { diffBase } from '../src/evidence.js'
import { anchorFile, findMark, guardMarks, guardTrees, overlayRefusal, typedPath, type GuardMark } from '../src/guard.js'
import type { Entry } from '../src/journal.js'
import type { Result } from '../src/refusal.js'
import type { GateRunEntry } from '../src/rounds.js'
import { snapshotTree } from '../src/snapshot.js'
import { TOKEN_BROKEN, TOKEN_FIXED, shippableRepo } from './helpers.js'

const value = <T>(r: Result<T>): T => { if (!r.ok) throw new Error(JSON.stringify(r.violations)); return r.value }

// Journal fixtures: one round of a gate, its single lens reporting `findings`.
let n = 0
const run = (gate: string, round: number, findings: object[], extra: Record<string, unknown> = {}): Entry => ({
  v: 1, t: 'gate-run', gate, artifact: 'p', round, run_id: `r${++n}`, reviewed_sha: 's', prompts_sha: 'p', witness: '0',
  model: 'm', pin: 'm', harness: 'claude-code', checks: [], reviewed_tree: 'a'.repeat(40),
  verdicts: [{ reviewer: 'code-reviewer', coverage: [], findings }], outcome: 'stopped', ...extra,
}) as unknown as Entry
const mark = (anchor: string, guard: string, extra: Record<string, unknown> = {}) => ({ anchor, claim: 'c', blocking: true, guard, ...extra })
const decision = (gate: string, decision: string): Entry =>
  ({ v: 1, t: 'human-decision', gate, artifact: 'p', round: 1, decision }) as unknown as Entry

describe("a guard's finding (row 280)", () => {
  it("a finding's mark is the newest marking round of its gate's window (row 280)", () => {
    const e = [run('implement', 1, [mark('src/a.ts', 'lint')]), run('implement', 2, [mark('src/a.ts', 'test')])]
    expect(guardMarks(e, 'implement')).toMatchObject([{ gate: 'implement', anchor: 'src/a.ts', mark: 'test', run: { round: 2 } }])
  })

  it('marks before a reset, on non-blocking or demoted findings, and on checks-only rounds owe nothing', () => {
    expect(guardMarks([run('implement', 1, [mark('src/a.ts', 'lint')]), decision('implement', 'approve')], 'implement')).toEqual([])
    expect(guardMarks([run('implement', 1, [mark('src/a.ts', 'lint', { blocking: false })])], 'implement')).toEqual([])
    expect(guardMarks([run('implement', 1, [mark('src/a.ts', 'lint', { demoted: 1 })])], 'implement')).toEqual([])
    expect(guardMarks([run('implement', 1, [mark('src/a.ts', 'lint')], { checks_only: true })], 'implement')).toEqual([])
    expect(guardMarks([run('implement', 1, [mark('src/a.ts', 'lint')], { outcome: 'malformed' })], 'implement')).toEqual([])
  })

  it('one mark per anchor, sorted; an omission anchor keeps its journal spelling', () => {
    const e = [run('implement', 1, [mark('src/b.ts', 'lint'), { anchor: { kind: 'omission', scope: 'tests/' }, claim: 'c', blocking: true, guard: 'test' }, mark('src/b.ts', 'test')])]
    expect(guardMarks(e, 'implement').map((m) => [m.anchor, m.mark])).toEqual([['omission:tests/', 'test'], ['src/b.ts', 'lint']])
  })

  it('findMark reads implement and ship; a ship mark is its own', () => {
    const e = [run('implement', 1, [mark('src/a.ts', 'lint')]), run('ship', 1, [mark('src/a.ts', 'test')])]
    expect(findMark(e, 'src/a.ts')).toMatchObject({ gate: 'ship', mark: 'test' })
    expect(findMark(e.slice(0, 1), 'src/a.ts')).toMatchObject({ gate: 'implement', mark: 'lint' })
    expect(findMark(e, 'src/other.ts')).toBeUndefined()
  })

  it("an anchor's file is its string part before #; an omission has none", () => {
    expect(anchorFile('src/token.ts#rotateDue')).toBe('src/token.ts')
    expect(anchorFile('src/token.ts')).toBe('src/token.ts')
    expect(anchorFile('omission:tests/')).toBeUndefined()
  })

  it('typed paths: no space, quote, $ or leading-dash segment', () => {
    expect(['tests/a.test.ts', 'eslint.config.mjs', 'pkg/@x/a+b.ts'].every(typedPath)).toBe(true)
    expect(['a b.ts', "a'.ts", '$x.ts', '-rf', 'x/-y.ts', '../x', 'a//b', '', './a', '/abs', 'x'.repeat(401)].some(typedPath)).toBe(false)
  })
})

// A shippable plan whose round 1 reviewed TOKEN_BROKEN; the worktree now holds TOKEN_FIXED and a guard's test.
async function guardRepo() {
  const { repo, wt, planId } = await shippableRepo()
  const cfgR = loadConfig(repo.root)
  if (!cfgR.ok) throw new Error('config')
  const cfg: Config = cfgR.value
  const base = value(diffBase(wt, cfg))
  writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
  const pinned = snapshotTree(wt, base, planChangeSet(wt, base))!
  writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
  mkdirSync(join(wt, 'tests'), { recursive: true })
  writeFileSync(join(wt, 'tests/guard.test.ts'), "import { it } from 'vitest'\nit('rotates at 80% of the ttl', () => {})\n")
  writeFileSync(join(wt, 'eslint.config.mjs'), 'export default []\n')
  writeFileSync(join(wt, 'src/other.ts'), 'export const o = 1\n')
  const m: GuardMark = { gate: 'implement', anchor: 'src/token.ts', mark: 'test', run: { ...(run('implement', 1, []) as unknown as GateRunEntry), reviewed_tree: pinned } }
  const show = (tree: string, path: string) => execFileSync('git', ['show', `${tree}:${path}`], { cwd: repo.root, encoding: 'utf8' })
  return { repo, wt, planId, cfg, base, pinned, m, show }
}

describe("a guard's overlay and trees (row 280)", () => {
  it('a guard whose overlay includes the anchored file refuses (the acceptance)', async () => {
    const { repo, wt, cfg } = await guardRepo()
    expect(overlayRefusal(repo.root, wt, cfg, 'src/token.ts#rotateDue', ['src/token.ts']))
      .toMatchObject({ field: '--files', rule: 'overlay-anchor', got: 'src/token.ts' })
  })

  it('an overlay source file refuses; a test file and a check definition pass; the rest refuse in order', async () => {
    const { repo, wt, cfg } = await guardRepo()
    expect(overlayRefusal(repo.root, wt, cfg, 'src/token.ts', ['src/other.ts'])).toMatchObject({ rule: 'overlay-source', got: 'src/other.ts' })
    expect(overlayRefusal(repo.root, wt, cfg, 'src/token.ts', ['tests/guard.test.ts', 'eslint.config.mjs'])).toBeUndefined()
    expect(overlayRefusal(repo.root, wt, cfg, 'src/token.ts', [])).toMatchObject({ rule: 'overlay-empty' })
    expect(overlayRefusal(repo.root, wt, cfg, 'src/token.ts', ['tests/a b.test.ts'])).toMatchObject({ rule: 'overlay-path' })
    expect(overlayRefusal(repo.root, wt, cfg, 'src/token.ts', ['tests/missing.test.ts'])).toMatchObject({ rule: 'overlay-not-a-file' })
    expect(overlayRefusal(repo.root, wt, cfg, 'src/token.ts', ['tests'])).toMatchObject({ rule: 'overlay-not-a-file' })
    mkdirSync(join(wt, '.witness'), { recursive: true }); writeFileSync(join(wt, '.witness/x.test.ts'), 'x\n')
    expect(overlayRefusal(repo.root, wt, cfg, 'src/token.ts', ['.witness/x.test.ts'])).toMatchObject({ rule: 'overlay-witness' })
  })

  it('a marking round whose tree git does not hold refuses tree-unknown', async () => {
    const { repo, wt, base, cfg, m } = await guardRepo()
    const gone = guardTrees(repo.root, wt, base, cfg, { ...m, run: { ...m.run, reviewed_tree: '0'.repeat(40) } }, ['tests/guard.test.ts'])
    expect(gone).toMatchObject({ ok: false, violations: [{ field: 'finding', rule: 'tree-unknown' }] })
    // the remedy books this finding only (slice 2 review M5)
    expect(gone.ok ? '' : gone.violations[0]!.want).toContain('--book guards --finding src/token.ts')
    const { reviewed_tree: _, ...none } = m.run
    expect(guardTrees(repo.root, wt, base, cfg, { ...m, run: none as GateRunEntry }, ['tests/guard.test.ts']))
      .toMatchObject({ ok: false, violations: [{ field: 'finding', rule: 'tree-unknown' }] })
  })

  it("the red tree holds the round's anchored bytes and the overlay's files; the green tree the worktree", async () => {
    const { repo, wt, base, cfg, m, pinned, show } = await guardRepo()
    const t = value(guardTrees(repo.root, wt, base, cfg, m, ['tests/guard.test.ts'], [
      { path: 'src/token-witness-breadth.ts', mode: '100644', sha: execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo.root, input: 'copy\n', encoding: 'utf8' }).trim() },
    ]))
    expect(t.pinned).toBe(pinned)
    expect(show(t.red, 'src/token.ts')).toBe(TOKEN_BROKEN)
    expect(show(t.red, 'tests/guard.test.ts')).toContain('rotates at 80% of the ttl')
    expect(show(t.red, 'src/token-witness-breadth.ts')).toBe('copy\n')
    expect(() => show(t.red, 'src/other.ts')).toThrow()
    expect(show(t.green, 'src/token.ts')).toBe(TOKEN_FIXED)
    expect(show(t.green, 'src/other.ts')).toBe('export const o = 1\n')
    expect(() => show(t.green, 'src/token-witness-breadth.ts')).toThrow()
    expect(t.current).toBe(t.green)
  })

  it("the old tree is the base with the overlay folded over it, through the base's scripts (row 286)", async () => {
    const { repo, wt, base, cfg, m, show } = await guardRepo()
    const t = value(guardTrees(repo.root, wt, base, cfg, m, ['tests/guard.test.ts'], undefined, undefined, true))
    expect(show(t.old!, 'tests/guard.test.ts')).toBe(show(t.current, 'tests/guard.test.ts'))
    const atBase = (path: string) => { try { return show(base, path) } catch { return undefined } }
    const atOld = (path: string) => { try { return show(t.old!, path) } catch { return undefined } }
    expect(atOld('src/token.ts')).toBe(atBase('src/token.ts'))
    expect(atOld('src/other.ts')).toBeUndefined()
    expect(atOld('eslint.config.mjs')).toBe(atBase('eslint.config.mjs'))
    expect(value(guardTrees(repo.root, wt, base, cfg, m, ['tests/guard.test.ts'])).old).toBeUndefined()
  })

  it("both trees run the base's scripts: the plan's and the overlay's package.json scripts never reach a guard", async () => {
    const { repo, wt, base, cfg } = await guardRepo()
    const git = (args: string[], input = '') => execFileSync('git', args, { cwd: repo.root, input, encoding: 'utf8' }).trim()
    const show = (tree: string, path: string) => execFileSync('git', ['show', `${tree}:${path}`], { cwd: repo.root, encoding: 'utf8' })
    // a base whose package.json declares the scripts a guard's command goes through
    const basePkg = `{\n  "name": "fixture-vitest-single",\n  "type": "module",\n  "scripts": { "test": "vitest run" }\n}\n`
    const blob = git(['hash-object', '-w', '--stdin'], basePkg)
    const baseTree = value(foldOverlay(repo.root, base, { from: base, paths: [], blobs: [{ path: 'package.json', mode: '100644', sha: blob }] }))
    const withPkg = git(['commit-tree', baseTree, '-p', base, '-m', 'base with scripts'])
    const plan = { name: 'fixture-vitest-single', type: 'module', scripts: { test: 'echo fake' }, devDependencies: { leftpad: '1.0.0' } }
    writeFileSync(join(wt, 'package.json'), `${JSON.stringify(plan, null, 2)}\n`)
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
    const pinned = snapshotTree(wt, withPkg, planChangeSet(wt, withPkg))!
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
    const m: GuardMark = { gate: 'implement', anchor: 'src/token.ts', mark: 'test', run: { ...(run('implement', 1, []) as unknown as GateRunEntry), reviewed_tree: pinned } }
    const t = value(guardTrees(repo.root, wt, withPkg, cfg, m, ['tests/guard.test.ts']))
    expect(JSON.parse(show(pinned, 'package.json')).scripts).toEqual({ test: 'echo fake' })
    const withOld = value(guardTrees(repo.root, wt, withPkg, cfg, m, ['tests/guard.test.ts'], undefined, undefined, true))
    expect(JSON.parse(show(withOld.old!, 'package.json')).scripts).toEqual({ test: 'vitest run' })   // row 286: the old tree is the base's
    for (const tree of [t.red, t.green]) {
      const pkg = JSON.parse(show(tree, 'package.json')) as typeof plan
      expect(pkg.scripts).toEqual({ test: 'vitest run' })
      expect(pkg.devDependencies).toEqual({ leftpad: '1.0.0' })
    }
  })
})
