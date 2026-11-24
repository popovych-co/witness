import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')

// Every line of a `*.ts` under `<repo>/<dir>`, at any depth, that matches `pattern`, outside the
// files `allowed` (repo-relative), as `file:line`.
function offenders(dir: string, allowed: string[], pattern: RegExp): string[] {
  const files = (readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' }))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => relative(ROOT, join(ROOT, dir, f)).split('\\').join('/'))
    .filter((f) => !allowed.includes(f))
    .sort()
  return files.flatMap((f) => readFileSync(join(ROOT, f), 'utf8').split('\n')
    .flatMap((line, i) => (pattern.test(line) ? [`${f}:${i + 1}`] : [])))
}

// One owner per scratch directory (row 268, issue #99): a site that pairs its own temp directory
// with its own removal is a site that can forget the removal, as `witness diff` did.
it('the CLI makes scratch directories only through withScratch (row 268)', () => {
  expect(offenders('src', ['src/scratch.ts'], /\bmkdtemp(Sync)?\b|\btmpdir\b/)).toEqual([])
})

it('tests make scratch directories only through scratchDir (row 268)', () => {
  expect(offenders('tests', ['tests/scratch.ts', 'tests/scratch-owner.test.ts'], /\bmkdtemp(Sync)?\b|\btmpdir\b/)).toEqual([])
})

// scratchDir names a directory's owner by the test vitest is running: a concurrent test would
// hand its directories to a neighbour, and an inverted one (`.fails`) is kept though it reads green.
it('no test runs concurrently or inverts its result (row 268)', () => {
  expect(offenders('tests', ['tests/scratch-owner.test.ts'], /\.(concurrent|fails)\b/)).toEqual([])
})
