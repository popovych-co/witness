import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { diagnosticKey, keyCounts, lineKeys, newDiagnostics, normalizeSnippet, placeFile, readPart, toDiagnostics, type Diagnostic } from '../src/diagnostics.js'
import { biomePairs } from '../src/tolerated-lists.js'
import type { Result } from '../src/refusal.js'
import { captureCommand } from '../src/runner.js'
import { fakeCtx, fixtureEnv, git, tmpRepo } from './helpers.js'

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

describe('readers read through the lists (row 283)', () => {
  const witnessFile = JSON.stringify({ overrides: [{ includes: ['src/a.ts'], linter: { rules: { suspicious: { noConsole: 'info' } } } }] })

  it('a Biome note reads as a tolerated spot only at a pair the witness file lists (row 283)', () => {
    const repo = tmpRepo()
    const at = (file: string, rule: string) => ({ rule, file: join(repo.root, file), line: 1, text: 'console.log(1)', note: true as const })
    const out = toDiagnostics('biome', [at('src/a.ts', 'lint/suspicious/noConsole'), at('src/b.ts', 'lint/suspicious/noConsole'), at('src/a.ts', 'lint/style/useConst')], repo.root, biomePairs(witnessFile))
    expect(out).toEqual([{ tool: 'biome', rule: 'lint/suspicious/noConsole', file: 'src/a.ts', line: 1, snippet: 'console.log(1)', tolerated: true }])
    expect(toDiagnostics('biome', [at('src/a.ts', 'lint/suspicious/noConsole')], repo.root)).toEqual([])
  })

  it('readPart returns tolerated spots beside errors, and errors alone in diagnostics (row 283)', () => {
    const repo = tmpRepo()
    repo.write('src/a.ts', 'A\nB\n')
    const report = [{ filePath: join(repo.root, 'src/a.ts'), source: 'A\nB\n',
      messages: [{ ruleId: 'no-a', severity: 2, line: 1 }],
      suppressedMessages: [{ ruleId: 'no-b', severity: 2, line: 2, suppressions: [{ kind: 'file', justification: '' }] }] }]
    repo.write('report.json', JSON.stringify(report))
    const r = value(readPart(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), 'eslint', 'cat report.json; exit 1'))
    expect(r.diagnostics.map((d) => d.rule)).toEqual(['no-a'])
    expect(r.tolerated.map((d) => d.rule)).toEqual(['no-b'])
    expect(r.tolerated[0]).toEqual({ tool: 'eslint', rule: 'no-b', file: 'src/a.ts', line: 2, snippet: 'B', tolerated: true })
    expect(r.reported).toBe(1)
  })

  it("readPart reads Biome's notes at the run folder's biome.witness.json pairs (row 283)", () => {
    const repo = tmpRepo()
    repo.write('src/a.ts', 'console.log(1)\n')
    repo.write('biome.witness.json', witnessFile)
    const res = (level: string, ruleId: string) => ({ ruleId, level, locations: [{ physicalLocation: { artifactLocation: { uri: `file://${join(repo.root, 'src/a.ts')}` }, region: { startLine: 1 } } }] })
    repo.write('report.json', JSON.stringify({ runs: [{ results: [res('note', 'lint/suspicious/noConsole'), res('note', 'lint/style/useConst'), res('error', 'lint/x/y')] }] }))
    const r = value(readPart(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), 'biome', 'cat report.json; exit 1'))
    expect(r.diagnostics.map((d) => d.rule)).toEqual(['lint/x/y'])
    expect(r.tolerated.map((d) => d.rule)).toEqual(['lint/suspicious/noConsole'])
    expect(r.reported).toBe(1)
  })

  it("lineKeys counts a file's lines by their key, and a missing file is empty (row 283)", () => {
    const repo = tmpRepo()
    repo.write('a.ts', '  } catch {\n} catch {\nx\n')
    git(repo.root, 'add', '-A')
    git(repo.root, 'commit', '-qm', 'a')
    const commit = git(repo.root, 'rev-parse', 'HEAD')
    const key = diagnosticKey({ tool: 'eslint', rule: 'no-x', file: 'a.ts', snippet: '} catch {' })
    expect(lineKeys(repo.root, commit, 'a.ts', 'eslint', 'no-x')!.get(key)).toBe(2)
    expect(lineKeys(repo.root, commit, 'nope.ts', 'eslint', 'no-x')!.size).toBe(0)
    expect(lineKeys(repo.root, 'b'.repeat(40), 'a.ts', 'eslint', 'no-x')).toBeUndefined()
  })
})
