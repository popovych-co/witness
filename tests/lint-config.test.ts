import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonStyle, parseJsonc, readBiomeConfig } from '../src/lint-config.js'

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
