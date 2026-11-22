import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jsonStyle, parseJsonc, payloadLinted, readBiomeConfig } from '../src/lint-config.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'witness-lint-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

describe('jsonStyle (row 250)', () => {
  const SPACED = '{\n  "a": 1\n}\n'
  it.each([
    ['no config, no file', {}, undefined, '  ', 80, 2],
    ['no config, a tabbed file', {}, '{\n\t"a": 1\n}\n', '\t', 80, 2],
    ['an empty biome.json: Biome defaults to tabs', { 'biome.json': '{}' }, SPACED, '\t', 80, 2],
    ['a config that extends: the file decides', { 'biome.json': '{"extends":["ultracite/biome/core"]}' }, SPACED, '  ', 80, 2],
    ['formatter settings', { 'biome.json': '{"formatter":{"indentStyle":"space","indentWidth":4,"lineWidth":100}}' }, undefined, '    ', 100, 4],
    ['json.formatter over formatter', { 'biome.json': '{"formatter":{"indentStyle":"tab"},"json":{"formatter":{"indentStyle":"space"}}}' }, undefined, '  ', 80, 2],
    ['biome.jsonc with comments and trailing commas', { 'biome.jsonc': '{ // c\n "formatter": { "indentStyle": "space", }, /* x */ }' }, undefined, '  ', 80, 2],
  ] as const)('%s', (_name, files, existing, indent, lineWidth, tabWidth) => {
    expect(jsonStyle(dirWith(files), existing)).toEqual({ indent, lineWidth, tabWidth })
  })

  it('parses JSONC: comments outside strings and trailing commas', () => {
    expect(parseJsonc('{"a": "//not a comment", /* c */ "b": [1,],}')).toEqual({ a: '//not a comment', b: [1] })
  })

  it('reads no config from an unparseable biome.json', () => {
    expect(readBiomeConfig(dirWith({ 'biome.json': '{ broken' }))).toBeUndefined()
  })
})

// The probe's truth table (t0b-biome.log, Biome 2.4.9) for one hook under `.witness/hooks/`.
describe('payloadLinted reads Biome config by the probed truth table (row 250)', () => {
  const HOOK = '.witness/hooks/guard-state.mjs'
  const STAR = '{"files":{"includes":["**"]}}'
  it.each([
    ['{}', undefined, true],
    ['{"files":{"includes":["!.witness","!.pi"]}}', undefined, false],
    ['{"files":{"includes":["**","!.witness"]}}', undefined, false],
    ['{"files":{"includes":["**","!**/.witness"]}}', undefined, false],
    ['{"files":{"includes":["**","!.witness/**"]}}', undefined, false],
    ['{"files":{"includes":["**","!.witness/hooks"]}}', undefined, false],
    ['{"files":{"includes":["**","!!.witness"]}}', undefined, false],
    ['{"files":{"includes":["!.witness","**"]}}', undefined, true],
    ['{"files":{"includes":["src/**"]}}', undefined, false],
    ['{"extends":["./base.json"],"files":{"includes":["!.witness"]}}', STAR, false],
    ['{"extends":["./base.json"],"files":{"includes":["src/**"]}}', STAR, true],
    ['{"extends":["./base.json"],"files":{"includes":["**"]}}', '{"files":{"includes":["!.witness"]}}', true],
    ['{"overrides":[{"includes":[".witness/**"],"formatter":{"enabled":false},"linter":{"enabled":false}}]}', undefined, true],
    ['{"overrides":[{"includes":[".witness/**"],"formatter":{"enabled":false},"linter":{"enabled":false},"assist":{"enabled":false}}]}', undefined, false],
    ['{"formatter":{"enabled":false},"linter":{"enabled":false},"assist":{"enabled":false}}', undefined, false],
    [readFileSync(join(REPO, 'fixtures/settings/biome-fewhats.json'), 'utf8'), undefined, false],
  ] as const)('%s → checked: %s', (biome, base, checked) => {
    const dir = dirWith({ 'biome.json': biome, ...(base === undefined ? {} : { 'base.json': base }) })
    expect(payloadLinted(dir, [HOOK]) !== undefined).toBe(checked)
  })

  it('says nothing without a config, or for files Biome does not read', () => {
    expect(payloadLinted(dirWith({}), [HOOK])).toBeUndefined()
    expect(payloadLinted(dirWith({ 'biome.json': '{}' }), ['.claude/commands/witness.md', '.witness/hooks/session-dashboard.sh'])).toBeUndefined()
  })

  it('names each checked path and its top directory', () => {
    expect(payloadLinted(dirWith({ 'biome.json': '{}' }), ['.pi/extensions/witness.ts', '.witness/hooks/canon-guard.mjs'])).toEqual({
      config: 'biome.json', paths: ['.pi/extensions/witness.ts', '.witness/hooks/canon-guard.mjs'], dirs: ['.pi', '.witness'],
    })
  })
})
