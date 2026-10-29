import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')

// What a setup file loads, through its own relative imports.
function loads(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return []
  seen.add(file)
  const text = readFileSync(file, 'utf8')
  const rel = [...text.matchAll(/from '(\.[^']+)'/g)].map((m) => m[1]!)
  return rel.flatMap((r) => {
    const target = join(dirname(file), r.replace(/\.js$/, '.ts'))
    return [target, ...(target.includes(`${join(ROOT, 'tests')}`) ? loads(target, seen) : [])]
  })
}

// A setup file loads before a test file's vi.mock takes hold, so one that reached src — directly
// or through helpers.ts — bound src's modules first: tests/console.test.ts's child_process mock
// recorded nothing and 10 tests failed on CI (PR #63).
it('setup files load nothing of src, directly or through helpers.ts', () => {
  const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')
  const files = [...(config.match(/setupFiles: \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => join(ROOT, m[1]!))
  expect(files.length).toBeGreaterThan(0)
  for (const f of files) {
    const reached = loads(f).filter((t) => t.includes(`${join(ROOT, 'src')}`) || t.endsWith(join('tests', 'helpers.ts')))
    expect(reached, f).toEqual([])
  }
})
