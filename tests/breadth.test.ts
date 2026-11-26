import { describe, expect, it } from 'vitest'
import { breadthCopy, breadthPath, breadthSeed } from '../src/breadth.js'

// Row 280 (C45). The breadth copy a lint guard must also catch: the anchored file beside itself under a
// name drawn fresh each run, its local names renamed to fresh ones in code only, every line's
// indentation doubled. Tests pass a fixed seed.
const SEED = { stem: 'copy', prefix: '$wb' }
const copy = (src: string, path = 'src/a.ts') => breadthCopy(path, src, SEED)!.text

describe('the breadth copy (row 280)', () => {
  it('renames declared names to fresh ones in declaration order, in code only (row 280)', () => {
    const src = "const load = 1\n// const from = 2\nfunction keep(x) { return load + x }\nconst s = 'load'\n"
    expect(copy(src)).toBe("const $wb0 = 1\n// const from = 2\nfunction $wb1($wb2) { return $wb0 + $wb2 }\nconst $wb3 = 'load'\n")
  })

  it('never renames a keyword, a contextual keyword, or a property after a lone dot; renames a spread', () => {
    expect(copy('const from = o.from\nconst f = [...from]\n')).toBe('const from = o.from\nconst $wb0 = [...from]\n')
    expect(copy('const a = [1]\nconst b = [...a, o.a]\n')).toBe('const $wb0 = [1]\nconst $wb1 = [...$wb0, o.a]\n')
  })

  it('renames inside a template hole, never its text', () => {
    expect(copy('const n = 1\nconst t = `n is ${n}`\n')).toBe('const $wb0 = 1\nconst $wb1 = `n is ${$wb0}`\n')
    // a binding named `$` never renames a hole's opener; a nested template's holes too
    expect(copy('const $ = 1\nconst t = `a ${$} b ${t ? `c ${$}` : ""}`\n')).toBe('const $wb0 = 1\nconst $wb1 = `a ${$wb0} b ${$wb1 ? `c ${$wb0}` : ""}`\n')
  })

  it('leaves strings, block comments and a name inside a longer word or a number alone', () => {
    expect(copy('const e5 = 1 /* const x */\nconst y = "e5" + 1e5 + e5x\n')).toBe('const $wb0 = 1 /* const x */\nconst $wb1 = "e5" + 1e5 + e5x\n')
  })

  it("doubles each line's leading whitespace", () => {
    expect(copy('function f() {\n  return 1\n\tif (x) {}\n}\n')).toBe('function $wb0() {\n    return 1\n\t\tif (x) {}\n}\n')
    expect(copy('function f() {\r\n\r\n  return 1\r\n}\r\n')).toBe('function $wb0() {\r\n\r\n    return 1\r\n}\r\n')
  })

  it('renames parameters, catch bindings and destructured bindings, keeping a shorthand key (slice 2 review I2)', () => {
    expect(copy('function rotate(elapsed: number, ttl = 5, ...rest: string[]) { return elapsed > ttl }\n'))
      .toBe('function $wb0($wb1: number, $wb2 = 5, ...$wb3: string[]) { return $wb1 > $wb2 }\n')
    expect(copy('const f = (row, key) => row[key]\nconst g = x => x\n')).toBe('const $wb0 = ($wb1, $wb2) => $wb1[$wb2]\nconst $wb3 = $wb4 => $wb4\n')
    expect(copy('try { a() } catch (err) { log(err) }\n')).toBe('try { a() } catch ($wb0) { log($wb0) }\n')
    expect(copy('const { storedRow, ttl: life = 1, deep: { k } } = o\nuse(storedRow, life, k)\n'))
      .toBe('const { storedRow: $wb0, ttl: $wb1 = 1, deep: { k: $wb2 } } = o\nuse($wb0, $wb1, $wb2)\n')
    expect(copy('const [first, , [second]] = xs\n')).toBe('const [$wb0, , [$wb1]] = xs\n')
    expect(copy('class C {\n  rotateDue(elapsed: number): boolean {\n    return elapsed > 1\n  }\n}\n'))
      .toBe('class $wb0 {\n    rotateDue($wb1: number): boolean {\n        return $wb1 > 1\n    }\n}\n')
  })

  it("reads a regex literal as one, so a quote or a comment opener inside it never shifts what is code (security review)", () => {
    expect(copy("const re = /'/g\nconst name = 'x'\n")).toBe("const $wb0 = /'/g\nconst $wb1 = 'x'\n")
    expect(copy('const re = /\\/*/\nconst later = 1\n')).toBe('const $wb0 = /\\/*/\nconst $wb1 = 1\n')
    expect(copy('const a = 4\nconst half = a / 2 / 1\n')).toBe('const $wb0 = 4\nconst $wb1 = $wb0 / 2 / 1\n')
  })

  it('a fresh-name prefix that a name in the file already starts with is lengthened', () => {
    expect(breadthCopy('src/a.ts', 'const $wb0x = 1\n', SEED)!.text).toBe('const $wbq0 = 1\n')
  })

  it('names the copy with the seed stem, keeping the suffix; refuses outside the JS/TS family', () => {
    expect(breadthPath('src/a.test.ts', 'copy')).toBe('src/copy.test.ts')
    expect(breadthPath('src/record.ts', 'copy')).toBe('src/copy.ts')
    expect(breadthPath('Makefile', 'copy')).toBe('copy')
    expect(breadthPath('src/.eslintrc.cjs', 'copy')).toBe('src/copy.cjs')
    expect(breadthCopy('src/a.tsx', 'const a = <b/>\n', SEED)).toEqual({ path: 'src/copy.tsx', text: 'const $wb0 = <b/>\n' })
    expect(breadthCopy('src/lib.rs', 'fn x() {}\n', SEED)).toBeUndefined()
    expect(breadthCopy('README.md', '# x\n', SEED)).toBeUndefined()
  })

  it('a seed is drawn fresh each run: a lowercase stem and a letter prefix, never the same twice (slice 2 review I1)', () => {
    const a = breadthSeed(); const b = breadthSeed()
    expect(a.stem).toMatch(/^[a-z]{8}$/)
    expect(a.prefix).toMatch(/^[a-z]{5}$/)
    expect([a.stem, a.prefix]).not.toEqual([b.stem, b.prefix])
  })
})
