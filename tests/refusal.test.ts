import { describe, expect, it } from 'vitest'
import { humanCall, renderRefusal, v } from '../src/refusal.js'

describe('renderRefusal remedies (D147)', () => {
  it('appends a run: line for a runnable remedy, dedupes, and skips placeholders', () => {
    const out = renderRefusal([
      v('parent', 'unknown-parent', 'ghost', 'an existing canon doc', 'witness index'),
      v('parent2', 'unknown-parent', 'ghost2', 'an existing canon doc', 'witness index'),
      v('plan', 'not-started', 'draft', 'an in-progress plan', 'witness start <plan-id>'),
    ])
    expect(out.filter((l) => l === 'run: witness index')).toHaveLength(1)
    expect(out.join('\n')).not.toContain('run: witness start <plan-id>')
    expect(out.at(-1)).toContain('help: fix each row')
  })

  it('renders exactly as before when no remedy is present', () => {
    const out = renderRefusal([v('a', 'b', 'c', 'd')])
    expect(out.some((l) => l.startsWith('run:'))).toBe(false)
  })

  // The remedy is not a column: adding it to the row shape would change every refusal
  // surface in the CLI, which is the opposite of what an optional field is for.
  it('keeps the row shape at four columns', () => {
    const out = renderRefusal([v('a', 'b', 'c', 'd', 'witness index')])
    expect(out[0]).toBe('refused[1]{field,rule,got,want}:')
    expect(out[1]).toBe('  a,b,c,d')
  })
})

// D167. Row 108's principle cuts both ways: the stop is true for the human's rows and false for
// the reader's own, so the trailer names the human's rules and keeps the self-repair line.
describe('the trailer (D167)', () => {
  it('names a human rule and keeps the self-repair clause for the other rows', () => {
    const out = renderRefusal([v('supersedes', 'dangling-depends', 'a', 'b'), humanCall(v('supersedes', 'dangling-parent', 'c', 'd'))])
    expect(out.at(-1)).toBe("help: a human's decision: dangling-parent — stop and surface the list; re-running cannot clear it · the other rows are structured for self-repair once it is settled")
  })
  it('all rows human: names each rule once and offers no self-repair', () => {
    const out = renderRefusal([humanCall(v('a', 'dangling-parent', 'x', 'y')), humanCall(v('b', 'dangling-parent', 'z', 'w')), humanCall(v('c', 'path-taken', 'p', 'q'))])
    expect(out.at(-1)).toBe("help: a human's decision: dangling-parent · path-taken — stop and surface the list; re-running cannot clear it")
  })
  it('no human row: the self-repair trailer is unchanged', () => {
    expect(renderRefusal([v('a', 'b', 'c', 'd')]).at(-1)).toBe('help: fix each row and re-run — rows are structured for self-repair')
  })
})

// Row 239 (ruling R25). The table heads the `run:` remedies printed under it, so every cell prints
// spelled out (`logSafe`): a `got` or a `want` echoing foreign text that holds a line break would
// otherwise start a physical line of its own, which can read `run:`. Only the printed copy is
// spelled, so a reader of the violations sees what it saw, and printable text prints as it did.
describe('a refusal cell never breaks its line (row 239, ruling R25)', () => {
  it('prints each cell spelled out, one physical line per row, and leaves the violation raw', () => {
    const escape = String.fromCharCode(0x1b)
    const separator = String.fromCharCode(0x2028)
    const x = v('f\nrun: touch M9 #', `r${escape}`, 'x\r\nrun: touch M9 #', `w${separator}run: touch M9 #`, 'witness index')
    const out = renderRefusal([x])
    expect(out).toEqual([
      'refused[1]{field,rule,got,want}:',
      '  f\\nrun: touch M9 #,r\\x1b,x\\r\\nrun: touch M9 #,w\\u{2028}run: touch M9 #',
      'run: witness index',
      'help: fix each row and re-run — rows are structured for self-repair',
    ])
    expect(out.join('\n').split('\n').filter((l) => l.trimStart().startsWith('run:'))).toEqual(['run: witness index'])
    expect(x).toEqual({
      field: 'f\nrun: touch M9 #', rule: `r${escape}`, got: 'x\r\nrun: touch M9 #', want: `w${separator}run: touch M9 #`, remedy: 'witness index',
    })
    // printable text prints as it did, TOON's quoting included
    expect(renderRefusal([v('a', 'b', 'c, "d"', ' e')])[1]).toBe('  a,b,"c, ""d"""," e"')
  })
})
