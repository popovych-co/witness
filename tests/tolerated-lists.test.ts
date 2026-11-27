import { describe, expect, it } from 'vitest'
import { biomePairs, pairKey } from '../src/tolerated-lists.js'

describe('the tolerated lists (rows 283, 285)', () => {
  it('biomePairs reads one exact path per override at info, nothing else (row 283)', () => {
    const text = JSON.stringify({ overrides: [
      { includes: ['src/a.ts'], linter: { rules: { suspicious: { noConsole: 'info', noDebugger: 'info' } } } },
      { includes: ['src/**'], linter: { rules: { style: { useConst: 'info' } } } },
      { includes: ['src/b.ts'], linter: { rules: { style: { useConst: 'off' } } } },
      { includes: ['src/c.ts', 'src/d.ts'], linter: { rules: { style: { useConst: 'info' } } } },
      { includes: ['src/e.ts'], linter: { rules: { style: { useConst: 'info' } } }, formatter: { enabled: false } },
    ] })
    expect([...biomePairs(text)].sort()).toEqual([pairKey('src/a.ts', 'lint/suspicious/noConsole'), pairKey('src/a.ts', 'lint/suspicious/noDebugger')].sort())
    expect(biomePairs('{').size).toBe(0)
    expect(biomePairs('[]').size).toBe(0)
  })
})
