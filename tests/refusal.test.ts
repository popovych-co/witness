import { describe, expect, it } from 'vitest'
import { renderRefusal, v } from '../src/refusal.js'

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
