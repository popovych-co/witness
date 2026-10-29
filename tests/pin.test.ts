import { describe, expect, it } from 'vitest'
import { CLAUDE_THINKING_BUDGET, checkPin, parsePin, THINKING_LEVELS } from '../src/pin.js'

describe('checkPin', () => {
  it('checkPin refuses an alias and a malformed pin with today\'s texts', () => {
    const alias = checkPin('gates.plan.model', 'opus')
    expect(alias.ok).toBe(false)
    if (!alias.ok) {
      expect(alias.violations[0]).toEqual({
        field: 'gates.plan.model', rule: 'alias-refused', got: 'opus',
        want: 'an exact model id — an alias re-points when its vendor ships a new model (Decision 55)',
      })
    }
    const bad = checkPin('arbiter.model', 'google/')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.violations[0]).toMatchObject({ field: 'arbiter.model', rule: 'pin-malformed', want: '[provider/]model[:thinking]' })
    expect(checkPin('gates.ship.model', 'claude-opus-5-5:high')).toEqual({ ok: true, value: 'claude-opus-5-5:high' })
  })
})

describe('parsePin', () => {
  it('parses a bare model id with thinking defaulting to off', () => {
    const r = parsePin('gates.model', 'claude-fable-5')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ provider: undefined, model: 'claude-fable-5', thinking: 'off' })
  })

  it('parses provider-qualified and thinking-suffixed pins', () => {
    const r = parsePin('gates.model', 'google/gemini-3.6-pro:low')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ provider: 'google', model: 'gemini-3.6-pro', thinking: 'low' })
    const bare = parsePin('gates.model', 'claude-fable-5:xhigh')
    expect(bare.ok).toBe(true)
    if (bare.ok) expect(bare.value).toEqual({ provider: undefined, model: 'claude-fable-5', thinking: 'xhigh' })
  })

  it('refuses unknown thinking levels and empty model segments', () => {
    const lvl = parsePin('gates.model', 'claude-fable-5:turbo')
    expect(lvl.ok).toBe(false)
    if (!lvl.ok) expect(lvl.violations[0]!.rule).toBe('unknown-thinking-level')
    for (const bad of ['', ':low', 'google/', 'google/:low']) {
      const r = parsePin('gates.model', bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.violations[0]!.rule).toBe('pin-malformed')
    }
  })

  it('keeps the budget table total over non-off levels', () => {
    for (const level of THINKING_LEVELS) {
      if (level === 'off') continue
      expect(CLAUDE_THINKING_BUDGET[level]).toBeGreaterThan(0)
    }
  })
})
