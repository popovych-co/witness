import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { diagnosticKey, keyCounts, newDiagnostics, normalizeSnippet, placeFile, readPart, toDiagnostics, type Diagnostic } from '../src/diagnostics.js'
import type { Result } from '../src/refusal.js'
import { captureCommand } from '../src/runner.js'
import { fakeCtx, fixtureEnv, tmpRepo } from './helpers.js'

const value = <T>(r: Result<T>): T => { if (!r.ok) throw new Error(JSON.stringify(r.violations)); return r.value }
const d = (file: string, snippet: string, rule = 'r'): Diagnostic => ({ tool: 'biome', rule, file, line: 1, snippet })

describe('a part on a tree (row 262)', () => {
  it('places a path alike on any tree: under the folder or its real path, file://, backslashes (Review Focus 2)', () => {
    const dir = tmpRepo().root
    const real = realpathSync(dir)
    expect(placeFile(dir, join(dir, 'src/a.ts'))).toBe('src/a.ts')
    expect(placeFile(dir, join(real, 'src/a.ts'))).toBe('src/a.ts')
    expect(placeFile(dir, `file://${join(real, 'src/a b.ts').replaceAll(' ', '%20')}`)).toBe('src/a b.ts')
    expect(placeFile(dir, 'src\\a.ts')).toBe('src/a.ts')
    expect(placeFile(dir, './src/a.ts')).toBe('src/a.ts')
  })

  it('keeps a path it cannot place as printed, and resolves a cargo span from its manifest up (Review Focus 2)', () => {
    const repo = tmpRepo()
    repo.write('crates/app/src/main.rs', 'fn main() {}\n')
    expect(placeFile(repo.root, '../../packages/a.ts')).toBe('../../packages/a.ts')
    expect(placeFile(repo.root, '/elsewhere/x.rs')).toBe('/elsewhere/x.rs')
    expect(placeFile(repo.root, 'src/main.rs', join(repo.root, 'crates/app'))).toBe('crates/app/src/main.rs')
    expect(placeFile(repo.root, 'crates/app/src/main.rs', join(repo.root, 'crates/app'))).toBe('crates/app/src/main.rs')
  })

  it('a re-indented line keeps its key; a copied one is one new (Review Focus 5)', () => {
    expect(normalizeSnippet('\t  if (x)    return  ')).toBe('if (x) return')
    const base = keyCounts([d('src/a.ts', 'if (x) return')])
    expect(newDiagnostics([d('src/a.ts', normalizeSnippet('    if (x)   return'))], base)).toEqual([])
    const copied = [d('src/a.ts', 'if (x) return'), { ...d('src/a.ts', 'if (x) return'), line: 9 }]
    expect(newDiagnostics(copied, base)).toEqual([copied[1]])
    expect(diagnosticKey(d('src/a.ts', 'x'))).toMatch(/^[0-9a-f]{16}$/)
    expect(diagnosticKey(d('src/b.ts', 'x'))).not.toBe(diagnosticKey(d('src/a.ts', 'x')))
  })

  it("drops witness's own paths and reads a snippet from the tree (settled point 5)", () => {
    const repo = tmpRepo()
    repo.write('src/a.ts', 'const a = 1\n  let   b = 2\n')
    const out = toDiagnostics('biome', [
      { rule: 'r', file: join(repo.root, 'src/a.ts'), line: 2 },
      { rule: 'r', file: '.claude/hooks/canon-guard.mjs', line: 1 },
      { rule: 'format', file: join(repo.root, 'src/a.ts') },
      { rule: 'r', file: '../outside.ts', line: 1 },
    ], repo.root)
    expect(out).toEqual([
      { tool: 'biome', rule: 'r', file: 'src/a.ts', line: 2, snippet: 'let b = 2' },
      { tool: 'biome', rule: 'format', file: 'src/a.ts', snippet: '' },
      { tool: 'biome', rule: 'r', file: '../outside.ts', line: 1, snippet: '' },
    ])
  })

  it('readPart runs the reader and reads its whole stdout (row 262)', () => {
    const repo = tmpRepo()
    mkdirSync(join(repo.root, 'src'), { recursive: true })
    writeFileSync(join(repo.root, 'src/a.ts'), 'BAD\n')
    const results = Array.from({ length: 200 }, (_, i) => ({ ruleId: `lint/r${i}`, level: 'error', locations: [{ physicalLocation: { artifactLocation: { uri: join(repo.root, 'src/a.ts') }, region: { startLine: 1 } } }] }))
    writeFileSync(join(repo.root, 'report.json'), JSON.stringify({ runs: [{ results }] }))
    const ctx = fakeCtx(repo.root, { env: fixtureEnv() })
    expect(captureCommand(repo.root, ctx, 'cat report.json').stdout.length).toBeGreaterThan(4_000)
    const r = value(readPart(repo.root, ctx, 'biome', 'cat report.json; exit 1'))
    expect(r.diagnostics).toHaveLength(200)
    expect(r.reported).toBe(200)
    expect(r.diagnostics[0]).toEqual({ tool: 'biome', rule: 'lint/r0', file: 'src/a.ts', line: 1, snippet: 'BAD' })
  })
})
