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
