import { describe, expect, it } from 'vitest'
import { BREADTH_TAG, breadthCopy, breadthPath } from '../src/breadth.js'

// Row 280 (C45). The breadth copy a lint guard must also catch: the anchored file beside itself, its
// declared names renamed to fresh ones in code only, every line's indentation doubled.
describe('the breadth copy (row 280)', () => {
  it('renames declared names to fresh ones in declaration order, in code only (row 280)', () => {
    const src = "const load = 1\n// const from = 2\nfunction keep(x) { return load + x }\nconst s = 'load'\n"
    expect(breadthCopy('src/a.ts', src)!.text).toBe("const $wb0 = 1\n// const from = 2\nfunction $wb1(x) { return $wb0 + x }\nconst $wb2 = 'load'\n")
  })

  it('never renames a keyword, a contextual keyword, or a property after a lone dot; renames a spread', () => {
    expect(breadthCopy('src/a.ts', 'const from = o.from\nconst f = [...from]\n')!.text).toBe('const from = o.from\nconst $wb0 = [...from]\n')
    expect(breadthCopy('src/a.ts', 'const a = [1]\nconst b = [...a, o.a]\n')!.text).toBe('const $wb0 = [1]\nconst $wb1 = [...$wb0, o.a]\n')
  })

  it('renames inside a template hole, never its text', () => {
    expect(breadthCopy('src/a.ts', 'const n = 1\nconst t = `n is ${n}`\n')!.text).toBe('const $wb0 = 1\nconst $wb1 = `n is ${$wb0}`\n')
  })

  it('leaves strings, block comments and a name inside a longer word or a number alone', () => {
    const src = 'const e5 = 1 /* const x */\nconst y = "e5" + 1e5 + e5x\n'
    expect(breadthCopy('src/a.ts', src)!.text).toBe('const $wb0 = 1 /* const x */\nconst $wb1 = "e5" + 1e5 + e5x\n')
  })

  it("doubles each line's leading whitespace", () => {
    expect(breadthCopy('src/a.ts', 'function f() {\n  return 1\n\tif (x) {}\n}\n')!.text).toBe('function $wb0() {\n    return 1\n\t\tif (x) {}\n}\n')
    expect(breadthCopy('src/a.ts', 'function f() {\r\n\r\n  return 1\r\n}\r\n')!.text).toBe('function $wb0() {\r\n\r\n    return 1\r\n}\r\n')
  })

  it('keeps a test suffix in the name, and refuses outside the JS/TS family', () => {
    expect(BREADTH_TAG).toBe('-witness-breadth')
    expect(breadthPath('src/a.test.ts')).toBe('src/a-witness-breadth.test.ts')
    expect(breadthPath('src/record.ts')).toBe('src/record-witness-breadth.ts')
    expect(breadthPath('Makefile')).toBe('Makefile-witness-breadth')
    expect(breadthPath('src/.eslintrc.cjs')).toBe('src/.eslintrc-witness-breadth.cjs')
    expect(breadthCopy('src/a.tsx', 'const a = <b/>\n')).toEqual({ path: 'src/a-witness-breadth.tsx', text: 'const $wb0 = <b/>\n' })
    expect(breadthCopy('src/lib.rs', 'fn x() {}\n')).toBeUndefined()
    expect(breadthCopy('README.md', '# x\n')).toBeUndefined()
  })
})
