// Row 265 (§4 T2, C16). A conflict opener on a line the plan adds withholds the review; a marker the
// base already holds is not the plan's, and a bare `=======`, a closer alone or an opener inside a
// line never count (P22).
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { markersCheck } from '../src/markers.js'
import { tmpRepo, type TestRepo } from './helpers.js'

// Slice 2 review M1: the git calls markersCheck makes, counted (tmpRepo runs git itself, uncounted).
const gitCalls = vi.hoisted(() => ({ n: 0 }))
vi.mock('../src/gitio.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/gitio.js')>()
  return { ...real, tryGitC: (...a: Parameters<typeof real.tryGitC>) => { gitCalls.n += 1; return real.tryGitC(...a) } }
})

// A repo whose base commit holds `files`; the change is made after it, uncommitted.
function based(files: Record<string, string>): { repo: TestRepo; root: string; base: string } {
  const repo = tmpRepo()
  for (const [rel, body] of Object.entries(files)) repo.write(rel, body)
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'base')
  return { repo, root: repo.root, base: repo.git('rev-parse', 'HEAD') }
}

describe('markersCheck (row 265)', () => {
  it('an added conflict opener withholds, named by file and line (row 265)', () => {
    const { repo, root, base } = based({ 'a.ts': 'one\ntwo\n' })
    repo.write('a.ts', 'one\n<<<<<<< HEAD\ntwo\n')
    expect(markersCheck(root, base, ['a.ts'])).toMatchObject({ name: 'markers', ok: false, detail: expect.stringContaining('a.ts:2') })
  })

  it('a bare =======, a closer alone and an opener inside a line never count (P22)', () => {
    const { repo, root, base } = based({ 'a.ts': 'one\n' })
    repo.write('a.ts', 'one\n=======\n>>>>>>> theirs\nx <<<<<<< y\n')
    expect(markersCheck(root, base, ['a.ts']).ok).toBe(true)
  })

  it('a marker line the base already holds is not the plan\'s (C16)', () => {
    const { repo, root, base } = based({ 'a.ts': '<<<<<<< HEAD\none\n' })
    repo.write('a.ts', '<<<<<<< HEAD\nONE\n')
    const c = markersCheck(root, base, ['a.ts'])
    expect(c.ok).toBe(true)
    expect(c.detail).toBe('no conflict markers in the lines the plan adds (1 files)')
  })

  it('an untracked file counts whole; a binary file and a symlink never do (row 265)', () => {
    const { repo, root, base } = based({ 'a.ts': 'one\n', 'held.txt': '<<<<<<< x\n' })
    repo.write('n.ts', 'fine\n<<<<<<< ours\n')
    repo.write('bin.dat', '\0\n<<<<<<< x\n')
    symlinkSync(join(root, 'held.txt'), join(root, 'link.ts'))
    expect(markersCheck(root, base, ['n.ts']).detail).toContain('n.ts:2')
    expect(markersCheck(root, base, ['bin.dat', 'link.ts']).ok).toBe(true)
  })

  it('a CRLF opener and a labelled one count (row 265)', () => {
    const { repo, root, base } = based({ 'a.ts': 'one\r\n' })
    repo.write('a.ts', 'one\r\n<<<<<<<\r\nmid\r\n<<<<<<< Updated upstream\r\n')
    const c = markersCheck(root, base, ['a.ts'])
    expect(c.ok).toBe(false)
    expect(c.detail!.match(/a\.ts:\d+/g)).toEqual(['a.ts:2', 'a.ts:4'])
  })

  it('ten places are listed, then a count (row 265)', () => {
    const { repo, root, base } = based({ 'a.ts': 'one\n' })
    repo.write('a.ts', `one\n${'<<<<<<< HEAD\n'.repeat(12)}`)
    const c = markersCheck(root, base, ['a.ts'])
    expect(c.detail!.match(/a\.ts:\d+/g)).toHaveLength(10)
    expect(c.detail).toContain(' · and 2 more')
  })

  it('an added line that reads like a diff header still counts; a removed one never does (row 265)', () => {
    const { repo, root, base } = based({ 'a.ts': 'keep\n<<<<<<< gone\n' })
    repo.write('a.ts', 'keep\n++ x\n<<<<<<< new\n')
    const c = markersCheck(root, base, ['a.ts'])
    expect(c.detail!.match(/a\.ts:\d+/g)).toEqual(['a.ts:3'])
  })

  it('a file holding no opener anywhere costs no git call (slice 2 review M1)', () => {
    const { repo, root, base } = based({ 'a.ts': 'one\n', 'b.ts': 'two\n' })
    repo.write('a.ts', 'one\nchanged <<<<<< six\n'); repo.write('c.ts', 'new\n')
    gitCalls.n = 0
    expect(markersCheck(root, base, ['a.ts', 'b.ts', 'c.ts']).ok).toBe(true)
    expect(gitCalls.n).toBe(0)
  })
})
