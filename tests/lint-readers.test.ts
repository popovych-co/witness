import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseReport } from '../src/lint-readers.js'
import type { Result } from '../src/refusal.js'

const fx = (name: string) => readFileSync(join(import.meta.dirname, '..', 'fixtures', 'readers', name), 'utf8')
const value = <T>(r: Result<T>): T => { if (!r.ok) throw new Error(JSON.stringify(r.violations)); return r.value }
const rule = (r: Result<unknown>): string => (r.ok ? 'ok' : r.violations[0]!.rule)

describe('readers (row 262)', () => {
  it("biome's SARIF: its errors with rules, files and lines; format has no line", () => {
    const file = '/repo/apps/web/src/app/laptop/release-state.ts'
    expect(value(parseReport('biome', fx('biome-2.4.9.sarif'), 1))).toEqual([
      { rule: 'lint/suspicious/noDebugger', file, line: 56 },
      { rule: 'lint/suspicious/noVar', file, line: 55 },
      { rule: 'lint/correctness/noUnusedVariables', file, line: 55 },
      { rule: 'format', file },
    ])
  })

  it("ESLint's JSON: severity 2 only, its line from source, a parse error as fatal", () => {
    const r = value(parseReport('eslint', fx('eslint-10.8.0.json'), 1))
    expect(r.map((d) => [d.rule, d.file, d.line])).toEqual([
      ['workspaces/no-relative-imports', '/repo/packages/logger/src/index.ts', 61],
      ['workspaces/require-dependency', '/repo/packages/logger/src/index.ts', 61],
    ])
    expect(r[0]!.text).toContain('../../../apps/web/src/lib/x')
    const fatal = JSON.stringify([{ filePath: '/repo/a.ts', messages: [{ ruleId: null, fatal: true, severity: 2, line: 3, column: 1 }, { ruleId: 'x', severity: 1, line: 1 }] }])
    expect(value(parseReport('eslint', fatal, 1))).toEqual([{ rule: 'fatal', file: '/repo/a.ts', line: 3 }])
  })

  it("cargo's JSON lines: errors with code, span file, line and text; artifacts and warnings are none", () => {
    expect(value(parseReport('clippy', fx('cargo-clippy.jsonl'), 101))).toEqual([
      { rule: 'clippy::needless_return', file: 'src/main.rs', line: 3, text: '    return 1;', base: '/repo/crates/app' },
      { rule: '', file: '', base: '/repo/crates/app' },
    ])
  })

  it("tsc's lines: file, line and code; the global form; a banner is no diagnostic", () => {
    expect(value(parseReport('tsc', fx('tsc-6.0.3.txt'), 2))).toEqual([
      { rule: 'TS2322', file: 'apps/web/src/app/laptop/release-state.ts', line: 54 },
      { rule: 'TS2307', file: 'packages/logger/src/index.ts', line: 61 },
      { rule: 'TS5083', file: '' },
    ])
  })

  it('a report that is not one fails closed (Review Focus 1)', () => {
    expect(rule(parseReport('biome', '> fewhats@0.0.0 lint:sarif /repo\n> biome check --reporter=sarif .\n\n{"runs":[]}', 1))).toBe('reader-unread')
    expect(rule(parseReport('eslint', '', 2))).toBe('reader-unread')
    expect(rule(parseReport('clippy', '{"reason":"build-finished","success":false}\nerror: could not compile `app`', 101))).toBe('reader-unread')
    expect(rule(parseReport('tsc', "src/a.ts:3:1 - error TS2322: Type 'string' is not assignable", 2))).toBe('reader-unread')
    expect(rule(parseReport('biome', '{"runs":[{"results":[]}]}', 1))).toBe('reader-unread')
    expect(value(parseReport('biome', '{"runs":[{"results":[]}]}', 0))).toEqual([])
    expect(value(parseReport('tsc', '', 0))).toEqual([])
  })

  it('a rule id outside the charset reads ?', () => {
    const sarif = JSON.stringify({ runs: [{ results: [{ ruleId: 'evil\u001b[2J', level: 'error', locations: [] }] }] })
    expect(value(parseReport('biome', sarif, 1))).toEqual([{ rule: '?', file: '' }])
  })
})

describe('readers read through the lists (row 283)', () => {
  it('an ESLint suppressed message of kind file is a tolerated spot, a directive one is not (row 283)', () => {
    const out = JSON.stringify([{ filePath: '/r/a.ts', messages: [], suppressedMessages: [
      { ruleId: 'no-x', severity: 2, line: 3, suppressions: [{ kind: 'file', justification: '' }] },
      { ruleId: 'no-y', severity: 2, line: 4, suppressions: [{ kind: 'directive', justification: '' }] },
      { ruleId: 'no-z', severity: 1, line: 5, suppressions: [{ kind: 'file', justification: '' }] },
    ] }])
    expect(value(parseReport('eslint', out, 0))).toEqual([{ rule: 'no-x', file: '/r/a.ts', line: 3, tolerated: true }])
  })

  it('ESLint exit 2 with a whole report (unused suppressions) reads the report, never reader-unread (row 283, probe Q5)', () => {
    expect(value(parseReport('eslint', '[]', 2))).toEqual([])
    expect(rule(parseReport('eslint', 'not json', 2))).toBe('reader-unread')
    expect(rule(parseReport('biome', JSON.stringify({ runs: [{ results: [] }] }), 1))).toBe('reader-unread')
  })

  it('a suppressedMessages that is not an array reads reader-unread (row 283)', () => {
    expect(rule(parseReport('eslint', JSON.stringify([{ filePath: '/r/a.ts', messages: [], suppressedMessages: 'x' }]), 0))).toBe('reader-unread')
  })

  it('a red ESLint exit with only tolerated spots reports no error: unread (row 283)', () => {
    const out = JSON.stringify([{ filePath: '/r/a.ts', messages: [], suppressedMessages: [
      { ruleId: 'no-x', severity: 2, line: 3, suppressions: [{ kind: 'file', justification: '' }] },
    ] }])
    expect(rule(parseReport('eslint', out, 1))).toBe('reader-unread')
  })

  it('a Biome note is a candidate, never an error, and a red exit with only notes is unread (row 283)', () => {
    const note = { ruleId: 'lint/suspicious/noConsole', level: 'note', locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///r/a.ts' }, region: { startLine: 2 } } }] }
    const sarif = JSON.stringify({ runs: [{ results: [note] }] })
    expect(value(parseReport('biome', sarif, 0))).toEqual([{ rule: 'lint/suspicious/noConsole', file: 'file:///r/a.ts', line: 2, note: true }])
    expect(rule(parseReport('biome', sarif, 1))).toBe('reader-unread')
  })
})
