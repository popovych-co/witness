import { describe, expect, it } from 'vitest'
import type { Diagnostic } from '../src/diagnostics.js'
import type { ReaderTool } from '../src/settings.js'
import { biomeList, biomeListText, biomePairs, eslintList, eslintListText, extendsWitness, pairKey, parseEslintList, writable } from '../src/tolerated-lists.js'
import { tmpRepo } from './helpers.js'

const d = (rule: string, file: string, line: number, tool: ReaderTool = 'eslint'): Diagnostic => ({ tool, rule, file, line, snippet: `x${line}` })

describe('the tolerated lists (rows 283, 285)', () => {
  it('biomePairs reads one exact path per override at info, nothing else (row 283)', () => {
    const text = JSON.stringify({ overrides: [
      { includes: ['src/a.ts'], linter: { rules: { suspicious: { noConsole: 'info', noDebugger: 'info' } } } },
      { includes: ['src/**'], linter: { rules: { style: { useConst: 'info' } } } },
      { includes: ['src/b.ts'], linter: { rules: { style: { useConst: 'off' } } } },
      { includes: ['src/c.ts', 'src/d.ts'], linter: { rules: { style: { useConst: 'info' } } } },
      { includes: ['src/e.ts'], linter: { rules: { style: { useConst: 'info' } } }, formatter: { enabled: false } },
    ] })
    expect([...biomePairs(text)].sort()).toEqual([pairKey('src/a.ts', 'lint/suspicious/noConsole'), pairKey('src/a.ts', 'lint/suspicious/noDebugger')].sort())
    expect(biomePairs('{').size).toBe(0)
    expect(biomePairs('[]').size).toBe(0)
  })
})

describe('the writers (row 285)', () => {
  it("the ESLint list is ESLint's own layout plus a final newline (row 285, probe §1–2)", () => {
    const list = eslintList([d('no-restricted-syntax', 'apps/b.ts', 1), d('no-restricted-syntax', 'apps/b.ts', 2), d('no-restricted-syntax', 'apps/a.ts', 1)], new Set(['no-restricted-syntax']), new Set(['no-restricted-syntax']), undefined)
    expect(eslintListText(list)).toBe('{\n  "apps/a.ts": {\n    "no-restricted-syntax": {\n      "count": 1\n    }\n  },\n  "apps/b.ts": {\n    "no-restricted-syntax": {\n      "count": 2\n    }\n  }\n}\n')
  })
  it("a list is written in the repo's JSON style when given one (row 285, row 250)", () => {
    expect(eslintListText({ 'a.ts': { 'no-x': { count: 1 } } }, { indent: '\t', lineWidth: 80, tabWidth: 2 })).toBe('{\n\t"a.ts": {\n\t\t"no-x": {\n\t\t\t"count": 1\n\t\t}\n\t}\n}\n')
  })
  it('a list tolerates every spot of a tolerated rule, growth included (row 285)', () => {
    const three = [d('no-x', 'a.ts', 1), d('no-x', 'a.ts', 2), d('no-x', 'a.ts', 3)]
    expect(eslintList(three, new Set(['no-x']), new Set(['no-x']), { 'a.ts': { 'no-x': { count: 1 } } })).toEqual({ 'a.ts': { 'no-x': { count: 3 } } })
  })
  it("the repo's own entries are kept, never above the base's count (row 285, Review Focus 3)", () => {
    const prior = { 'a.ts': { 'no-console': { count: 2 } } }
    const three = [d('no-console', 'a.ts', 1), d('no-console', 'a.ts', 2), d('no-console', 'a.ts', 3)]
    expect(eslintList(three, new Set(), new Set(), prior)).toEqual(prior)
    expect(eslintList(three.slice(0, 1), new Set(), new Set(), prior)).toEqual({ 'a.ts': { 'no-console': { count: 1 } } })
    expect(eslintList([], new Set(), new Set(), prior)).toEqual({})
    expect(eslintList(three, new Set(), new Set(), undefined)).toEqual({})
  })
  it('a rule a set once named but none applies to now gets no entry (row 285)', () => {
    expect(eslintList([d('no-x', 'a.ts', 1), d('no-x', 'a.ts', 2)], new Set(), new Set(['no-x']), { 'a.ts': { 'no-x': { count: 2 } } })).toEqual({})
  })
  it('a spot with no file, an absolute file or no rule is never listed (row 285)', () => {
    expect(eslintList([d('no-x', '', 1), d('no-x', '/abs/a.ts', 1), d('', 'a.ts', 1), d('?', 'a.ts', 1)], new Set(['no-x', '', '?']), new Set(), undefined)).toEqual({})
  })
  it('an empty list has no text (row 285)', () => { expect(eslintListText({})).toBeUndefined() })
  it('a path or rule named __proto__ is an own key, never a prototype (row 285)', () => {
    const list = eslintList([d('no-x', '__proto__', 1)], new Set(['no-x']), new Set(), undefined)
    expect(Object.keys(list)).toEqual(['__proto__'])
    expect(Object.keys(parseEslintList('{"__proto__": {"no-x": {"count": 1}}}')!)).toEqual(['__proto__'])
  })
  it("the Biome list sets each tolerated rule to info per file, in formatJson's style (row 285, probe B7)", () => {
    const list = biomeList([d('lint/suspicious/noConsole', 'scripts/b.ts', 4, 'biome'), d('lint/suspicious/noConsole', 'scripts/a.ts', 2, 'biome'), d('lint/style/useConst', 'scripts/a.ts', 3, 'biome'), d('plugin', 'scripts/a.ts', 5, 'biome')],
      new Set(['lint/suspicious/noConsole', 'plugin']))
    expect(biomeListText(list)).toBe('{\n  "overrides": [\n    {\n      "includes": ["scripts/a.ts"],\n      "linter": {\n        "rules": {\n          "suspicious": {\n            "noConsole": "info"\n          }\n        }\n      }\n    },\n    {\n      "includes": ["scripts/b.ts"],\n      "linter": {\n        "rules": {\n          "suspicious": {\n            "noConsole": "info"\n          }\n        }\n      }\n    }\n  ]\n}\n')
    expect(biomePairs(biomeListText(list))).toEqual(new Set([pairKey('scripts/a.ts', 'lint/suspicious/noConsole'), pairKey('scripts/b.ts', 'lint/suspicious/noConsole')]))
    expect(biomeListText(biomeList([], new Set()))).toBe('{\n  "overrides": []\n}\n')
  })
  it('a path Biome would read as a glob, or one leaving the root, is never written nor read as a pair (row 285, security review)', () => {
    const rule = 'lint/suspicious/noConsole'
    const odd = ['src/*.ts', 'src/[ab].ts', 'src/{a,b}.ts', 'src/?.ts', 'src/!a.ts', 'src/../x.ts', '../x.ts', 'src\\a.ts', './a.ts']
    expect(biomeList(odd.map((f, i) => d(rule, f, i + 1, 'biome')), new Set([rule]))).toEqual({ overrides: [] })
    for (const f of odd) {
      expect(biomePairs(JSON.stringify({ overrides: [{ includes: [f], linter: { rules: { suspicious: { noConsole: 'info' } } } }] })).size).toBe(0)
    }
  })
  it('a plugin rule is never listed, and only eslint and biome rules are writable (row 285, probe B6)', () => {
    expect(writable('biome', 'plugin')).toBe(false); expect(writable('biome', 'lint/suspicious/noConsole')).toBe(true)
    expect(writable('tsc', 'TS2345')).toBe(false); expect(writable('clippy', 'clippy::unwrap_used')).toBe(false); expect(writable('eslint', 'no-x')).toBe(true)
    expect(writable('eslint', '')).toBe(false); expect(writable('biome', 'format')).toBe(false)
    // final review I1: Biome's a11y group holds digits
    expect(writable('biome', 'lint/a11y/useAltText')).toBe(true)
    const list = biomeList([d('lint/a11y/useAltText', 'src/a.tsx', 1, 'biome')], new Set(['lint/a11y/useAltText']))
    expect(biomePairs(biomeListText(list))).toEqual(new Set([pairKey('src/a.tsx', 'lint/a11y/useAltText')]))
  })
  it("extendsWitness reads biome.json's and biome.jsonc's extends (row 285)", () => {
    const a = tmpRepo(); a.write('biome.json', JSON.stringify({ extends: ['x', './biome.witness.json'] }))
    const b = tmpRepo(); b.write('biome.jsonc', '// a comment\n{ "extends": ["biome.witness.json"] }\n')
    const c = tmpRepo(); c.write('biome.json', JSON.stringify({ extends: ['x'] }))
    const none = tmpRepo()
    expect([extendsWitness(a.root), extendsWitness(b.root), extendsWitness(c.root), extendsWitness(none.root)]).toEqual([true, true, false, undefined])
  })
  it('parseEslintList refuses a count that is no positive integer (row 285)', () => {
    for (const bad of [{ 'a.ts': { r: { count: 0 } } }, { 'a.ts': { r: { count: 1.5 } } }, { 'a.ts': { r: { count: '2' } } }, { 'a.ts': { r: {} } }, { 'a.ts': [] }, []]) {
      expect(parseEslintList(JSON.stringify(bad))).toBeUndefined()
    }
    expect(parseEslintList('{')).toBeUndefined()
    const probe = { 'apps/web/src/a.ts': { 'no-restricted-syntax': { count: 2 } } }
    expect(parseEslintList(JSON.stringify(probe, null, 2))).toEqual(probe)
  })
})
