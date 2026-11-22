import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatJson, type JsonStyle } from '../src/json-format.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = (f: string) => readFileSync(join(REPO, 'fixtures/settings', f), 'utf8')
const TAB: JsonStyle = { indent: '\t', lineWidth: 80, tabWidth: 2 }

describe("formatJson writes Biome's default JSON (row 250)", () => {
  it('matches Biome on the shapes file, with spaces and with tabs', () => {
    expect(formatJson(JSON.parse(fixture('shapes.json')))).toBe(fixture('shapes-after.json'))
    expect(formatJson(JSON.parse(fixture('shapes.json')), TAB)).toBe(fixture('shapes-after-tab.json'))
  })
  it('keeps a line of exactly 80 columns, and breaks at 81 (the trailing comma counts)', () => {
    expect(formatJson({ k: ['a'.repeat(69)] })).toBe(`{\n  "k": ["${'a'.repeat(69)}"]\n}\n`)
    expect(formatJson({ k: ['a'.repeat(70)] })).toBe(`{\n  "k": [\n    "${'a'.repeat(70)}"\n  ]\n}\n`)
    expect(formatJson({ k: ['a'.repeat(68)], z: 1 })).toBe(`{\n  "k": ["${'a'.repeat(68)}"],\n  "z": 1\n}\n`)
    expect(formatJson({ k: ['a'.repeat(69)], z: 1 })).toBe(`{\n  "k": [\n    "${'a'.repeat(69)}"\n  ],\n  "z": 1\n}\n`)
    expect(formatJson({ k: ['a'.repeat(68)], z: 1 }, TAB)).toBe(`{\n\t"k": ["${'a'.repeat(68)}"],\n\t"z": 1\n}\n`)
  })
  it('prints empty containers bare', () => {
    expect(formatJson({})).toBe('{}\n')
    expect(formatJson({ a: [], b: {} })).toBe('{\n  "a": [],\n  "b": {}\n}\n')
  })
})
