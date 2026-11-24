import { execFileSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planChangeSet } from '../src/change-set.js'
import { loadConfig } from '../src/config.js'
import { collectCaptures, diffBase, screensDir } from '../src/evidence.js'
import { readStream } from '../src/journal.js'
import { snapshotTree } from '../src/snapshot.js'
import { fixtureEnv, shippableRepo, type TestRepo } from './helpers.js'
import { scratchDir } from './scratch.js'

// Row 251. A test-evidence entry names the tree its run read (the snapshot tree, as a gate's
// `reviewed_tree`), and each capture names the test that took it, from a sidecar beside the PNG.
// T6 reads both for the PR proof.

const evidence = (repo: TestRepo, planId: string) =>
  readStream(repo.root, planId).filter((e) => e.t === 'test-evidence') as Array<Record<string, unknown>>
const treePaths = (cwd: string, tree: string) =>
  execFileSync('git', ['ls-tree', '-r', '--name-only', tree], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean)

describe('evidence tree and producing test (row 251)', () => {
  it('test-evidence journals the tree each run read', async () => {
    const { repo, wt, planId } = await shippableRepo()
    const [red, green] = evidence(repo, planId)
    expect(red!.tree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(green!.tree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(green!.tree).not.toBe(red!.tree)                     // src/token.ts changed between them
    const cfg = loadConfig(wt); if (!cfg.ok) throw new Error('config')
    const base = diffBase(wt, cfg.value); if (!base.ok) throw new Error('base')
    expect(green!.tree).toBe(snapshotTree(wt, base.value, planChangeSet(wt, base.value)))
  }, 180_000)

  it("verify-red's red names the red tree: the plan's tests over the base", async () => {
    const { repo, wt, planId } = await shippableRepo()
    const before = evidence(repo, planId).length
    const res = await repo.cli(['verify-red', planId, '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    expect(res.code, `${res.stdout}\n${res.stderr}`).toBe(0)
    const [red, green] = evidence(repo, planId).slice(before)
    expect(red).toMatchObject({ phase: 'red', reconstructed: true })
    const paths = treePaths(wt, String(red!.tree))
    expect(paths).toContain('tests/token.test.ts')
    expect(paths).not.toContain('src/token.ts')                  // new on the branch, held aside
    expect(treePaths(wt, String(green!.tree))).toContain('src/token.ts')
  }, 180_000)

  it('a capture names its producing test from its sidecar', async () => {
    const { repo, wt, planId } = await shippableRepo()
    writeFileSync(join(wt, 'tests/capture.test.ts'), [
      "import { writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "import { expect, it } from 'vitest'",
      "it('writes a capture @spec:auth-refresh', () => {",
      '  const d = process.env.WITNESS_SCREENS_DIR',
      '  if (d) {',
      "    writeFileSync(join(d, 'hello.png'), 'png')",
      "    writeFileSync(join(d, 'hello.png.json'), JSON.stringify({ test: expect.getState().currentTestName }))",
      '  }',
      '})',
      '',
    ].join('\n'))
    const res = await repo.cli(['test-evidence', planId, '--phase', 'green', '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    expect(res.code, `${res.stdout}\n${res.stderr}`).toBe(0)
    expect(evidence(repo, planId).at(-1)!.captures).toEqual(
      [{ name: 'hello.png', sha: expect.stringMatching(/^[0-9a-f]{64}$/), test: 'writes a capture @spec:auth-refresh' }])
  }, 180_000)

  it('a malformed, multi-line or oversized sidecar keeps the capture, drops the test, and warns', () => {
    const root = scratchDir('witness-cap-')
    const dir = screensDir(root, 'p1'); mkdirSync(dir, { recursive: true })
    const sides = [
      ['a', '{'],
      ['b', JSON.stringify({ test: 'x\ny' })],
      ['c', JSON.stringify({ test: 'x'.repeat(1001) })],
      ['d', undefined],
      ['e', JSON.stringify({ test: 'x'.repeat(1000) })],
      ['f', JSON.stringify({ test: 'a\u2028b' })],
      ['g', JSON.stringify({ test: '' })],
      ['h', JSON.stringify(['x'])],
    ] as const
    for (const [name, side] of sides) {
      writeFileSync(join(dir, `${name}.png`), name)
      if (side !== undefined) writeFileSync(join(dir, `${name}.png.json`), side)
    }
    const warned: string[] = []
    const caps = collectCaptures(root, 'p1', (l) => warned.push(l))
    expect(caps.map((c) => c.name)).toEqual(['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png', 'g.png', 'h.png'])
    expect(caps.filter((c) => c.test !== undefined).map((c) => c.name)).toEqual(['e.png'])
    expect(caps.find((c) => c.name === 'e.png')!.test).toBe('x'.repeat(1000))
    expect(warned.map((l) => /capture (\S+)/.exec(l)?.[1])).toEqual(['a.png', 'b.png', 'c.png', 'f.png', 'g.png', 'h.png'])
    expect(warned.every((l) => l.startsWith('warn: '))).toBe(true)
  })

  // Slice 1 security review. The sidecar is read without following a link — one pointing out of the
  // screens dir at a well-formed file is refused unread, and a dangling one is still named — and a
  // FIFO never blocks the read.
  it('a symlinked or special sidecar is refused unread and warned', () => {
    const root = scratchDir('witness-cap-')
    const dir = screensDir(root, 'p1'); mkdirSync(dir, { recursive: true })
    const outside = join(root, 'outside.json')
    writeFileSync(outside, JSON.stringify({ test: 'read from outside the screens dir' }))
    writeFileSync(join(dir, 's.png'), 's'); symlinkSync(outside, join(dir, 's.png.json'))
    writeFileSync(join(dir, 't.png'), 't'); symlinkSync(join(root, 'missing.json'), join(dir, 't.png.json'))
    const fifo = process.platform !== 'win32'
    if (fifo) { writeFileSync(join(dir, 'u.png'), 'u'); execFileSync('mkfifo', [join(dir, 'u.png.json')]) }
    const warned: string[] = []
    const caps = collectCaptures(root, 'p1', (l) => warned.push(l))
    const named = fifo ? ['s.png', 't.png', 'u.png'] : ['s.png', 't.png']
    expect(caps.map((c) => c.name)).toEqual(named)
    expect(caps.every((c) => c.test === undefined)).toBe(true)
    expect(warned.map((l) => /capture (\S+)/.exec(l)?.[1])).toEqual(named)
  })
})
