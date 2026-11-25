import { describe, expect, it } from 'vitest'
import { DEFAULT_DEFINITIONS, definitionEntry, definitionFor, isIgnoreFile } from '../src/definitions.js'

describe('checks.definitions entries (row 277)', () => {
  it('an entry without a slash matches the basename at any depth; with one, from the root (row 277)', () => {
    const e = (xs: string[]) => xs.map((x) => definitionEntry(x)!)
    expect(definitionFor(e(['tsconfig*.json']), 'packages/ui/tsconfig.base.json')?.glob).toBe('tsconfig*.json')
    expect(definitionFor(e(['.gitignore']), 'infra/.gitignore')?.glob).toBe('.gitignore')
    expect(definitionFor(e(['apps/web/biome.json']), 'biome.json')).toBeUndefined()
    expect(definitionFor(e(['apps/web/biome.json']), 'apps/web/biome.json')?.glob).toBe('apps/web/biome.json')
    expect(definitionFor(e(['tsconfig*.json']), 'src/tsconfig.ts')).toBeUndefined()
    expect(definitionFor(e(['package.json#scripts']), 'packages/a/package.json')).toEqual({ glob: 'package.json', member: 'scripts' })
    expect(definitionFor(e(['**/x.json']), 'a/b/x.json')?.glob).toBe('**/x.json')
    expect(isIgnoreFile('infra/.gitignore')).toBe(true)
    expect(isIgnoreFile('.prettierignore')).toBe(true)
    expect(isIgnoreFile('.editorconfig')).toBe(false)
  })

  it('the first matching entry wins (row 277)', () => {
    const e = ['package.json#scripts', 'package.json'].map((x) => definitionEntry(x)!)
    expect(definitionFor(e, 'package.json')).toEqual({ glob: 'package.json', member: 'scripts' })
  })

  it('the default list parses whole, 26 entries (row 277)', () => {
    expect(DEFAULT_DEFINITIONS).toHaveLength(26)
    expect(DEFAULT_DEFINITIONS.every((x) => definitionEntry(x) !== undefined)).toBe(true)
  })
})
