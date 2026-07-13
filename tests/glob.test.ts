import { describe, expect, it } from 'vitest'
import { globToRegExp, walkFiles } from '../src/glob.js'
import { tmpRepo } from './helpers.js'

describe('globToRegExp', () => {
  it('matches ** across depths including zero', () => {
    const re = globToRegExp('**/reports/junit.xml')
    expect(re.test('reports/junit.xml')).toBe(true)
    expect(re.test('packages/a/reports/junit.xml')).toBe(true)
    expect(re.test('reports/junit.xmlx')).toBe(false)
    expect(re.test('junit.xml')).toBe(false)
  })

  it('keeps * within one segment', () => {
    const re = globToRegExp('packages/*/reports/*.xml')
    expect(re.test('packages/a/reports/junit.xml')).toBe(true)
    expect(re.test('packages/a/b/reports/junit.xml')).toBe(false)
  })

  it('escapes regex metacharacters in literals', () => {
    expect(globToRegExp('a+b/c.xml').test('a+b/c.xml')).toBe(true)
    expect(globToRegExp('a+b/c.xml').test('aab/cxxml')).toBe(false)
  })

  it('supports a trailing **', () => {
    const re = globToRegExp('fixtures/**')
    expect(re.test('fixtures/a/b.ts')).toBe(true)
    expect(re.test('fixture/a.ts')).toBe(false)
  })
})

describe('walkFiles', () => {
  it('lists files recursively, skipping .git and node_modules', () => {
    const repo = tmpRepo()
    repo.write('a.txt', 'x')
    repo.write('sub/deep/b.txt', 'x')
    repo.write('node_modules/pkg/c.txt', 'x')
    const files = walkFiles(repo.root)
    expect(files).toContain('a.txt')
    expect(files).toContain('sub/deep/b.txt')
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false)
    expect(files.some((f) => f.startsWith('.git/'))).toBe(false)
  })
})
