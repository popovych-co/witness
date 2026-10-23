import { describe, expect, it } from 'vitest'
import { journalStamp, pctOf, readFill, reached, sessionHash, sessionIdOf, windowLabel, withoutSession } from '../src/context.js'
import { measuredEnv } from './helpers.js'

const S = 'ce2ad214-aaaa'
const env = (r: unknown, extra: Record<string, string> = {}) =>
  ({ CLAUDE_CODE_SESSION_ID: S, WITNESS_CONTEXT: typeof r === 'string' ? r : JSON.stringify(r), ...extra })

describe('the harness reading (row 191 §4.1)', () => {
  it('trusts a reading whose session is the harness session', () => {
    expect(readFill(env({ session: S, tokens: 31627, window: 1000000, percent: 3 })))
      .toEqual({ measured: true, reading: { session: S, tokens: 31627, window: 1000000 } })
  })
  it.each([
    ['absent', { CLAUDE_CODE_SESSION_ID: S }, 'no adapter'],
    ['empty', env(''), 'no adapter'],
    ['unparseable', env('{nope'), 'malformed'],
    ['an array', env('[1]'), 'malformed'],
    ['tokens over the window', env({ session: S, tokens: 2000001, window: 1000000 }), 'malformed'],
    ['fractional tokens', env({ session: S, tokens: 1.5, window: 1000000 }), 'malformed'],
    ['a zero window', env({ session: S, tokens: 0, window: 0 }), 'malformed'],
    ['another session (a chat session’s value inherited by drive)', env({ session: 'other', tokens: 5, window: 100 }), 'stale'],
    ['no session variable', { WITNESS_CONTEXT: JSON.stringify({ session: S, tokens: 5, window: 100 }) }, 'stale'],
    ['tokens absent — Claude Code before the first response', env({ session: S, window: 1000000 }), 'no reading yet'],
    ['tokens 0 — Pi before the first response', env({ session: S, tokens: 0, window: 100000 }), 'no reading yet'],
    ['tokens null — Pi right after a compaction', env({ session: S, tokens: null, window: 100000 }), 'no reading yet'],
    // D192. Pi's adapter writes the session alone when the harness gives no usage at all: a reading
    // not taken yet when it is this session's, another session's when it is not. A window that is
    // there is still checked.
    ['the session alone — Pi with no usage to give', env({ session: S }), 'no reading yet'],
    ['the session alone, another session’s', env({ session: 'other' }), 'stale'],
    ['tokens with no window', env({ session: S, tokens: 5 }), 'no reading yet'],
    ['a zero window with no tokens', env({ session: S, window: 0 }), 'malformed'],
  ])('%s → unmeasured', (_, e, reason) => expect(readFill(e)).toEqual({ measured: false, reason }))
  it('reads PI_SESSION_ID under pi, and ignores the claude variable there', () => {
    const r = JSON.stringify({ session: 'p1', tokens: 6020, window: 100000 })
    expect(readFill({ PI_CODING_AGENT: 'true', PI_SESSION_ID: 'p1', WITNESS_CONTEXT: r })).toMatchObject({ measured: true })
    expect(readFill({ PI_CODING_AGENT: 'true', CLAUDE_CODE_SESSION_ID: 'p1', WITNESS_CONTEXT: r })).toEqual({ measured: false, reason: 'stale' })
  })
  it('takes the session id from the variable the resolved harness names, and never an empty one', () => {
    expect(sessionIdOf({ CLAUDE_CODE_SESSION_ID: S })).toBe(S)
    expect(sessionIdOf({ PI_CODING_AGENT: 'true', PI_SESSION_ID: 'p1', CLAUDE_CODE_SESSION_ID: S })).toBe('p1')
    expect(sessionIdOf({ CLAUDE_CODE_SESSION_ID: '' })).toBeUndefined()
    expect(sessionIdOf({})).toBeUndefined()
  })
  // The fixture the measured-verb tests build their env from.
  it('measuredEnv is a reading the CLI trusts, and without a count it is no reading yet', () => {
    expect(readFill(measuredEnv('S1', 170000, 1000000)))
      .toEqual({ measured: true, reading: { session: 'S1', tokens: 170000, window: 1000000 } })
    expect(readFill(measuredEnv('S1', undefined, 1000000))).toEqual({ measured: false, reason: 'no reading yet' })
  })
})

describe('the journal stamp (row 191 §4.8)', () => {
  it('hashes the session to 12 hex chars, stably, never echoing the id', () => {
    expect(sessionHash(S)).toMatch(/^[0-9a-f]{12}$/)
    expect(sessionHash(S)).toBe(sessionHash(S))
    expect(sessionHash(S)).not.toContain('ce2ad214')
  })
  it('stamps the session alone without a trusted reading, and the reading with one', () => {
    expect(journalStamp({ CLAUDE_CODE_SESSION_ID: S })).toEqual({ session: sessionHash(S) })
    expect(journalStamp(env({ session: S, tokens: 5, window: 100 }))).toEqual({ session: sessionHash(S), tokens: 5, window: 100 })
    expect(journalStamp({})).toBeUndefined()
  })
})

describe('drive is a scheduler, not a session (row 191 §4.9)', () => {
  it('withoutSession drops the reading and every harness session variable, and nothing else', () => {
    const env = { CLAUDE_CODE_SESSION_ID: S, PI_SESSION_ID: 'p1', WITNESS_CONTEXT: '{}', CLAUDECODE: '1', PATH: '/bin' }
    expect(withoutSession(env)).toEqual({ CLAUDECODE: '1', PATH: '/bin' })
    expect(env).toHaveProperty('CLAUDE_CODE_SESSION_ID', S)          // a copy: the caller's env stands
    expect(journalStamp(withoutSession(measuredEnv('S1', 5, 100)))).toBeUndefined()
  })
})

describe('the fill arithmetic (row 191 §4.5)', () => {
  it('floors the display so it agrees with the limit test', () => {
    expect(pctOf(196000, 1000000)).toBe(19)
    expect(reached(196000, 1000000, 20)).toBe(false)
    expect(reached(200000, 1000000, 20)).toBe(true)
  })
  it('labels windows', () => {
    expect(windowLabel(1000000)).toBe('1M')
    expect(windowLabel(200000)).toBe('200k')
    expect(windowLabel(1048576)).toBe('1M')          // not round: read approximately
    expect(windowLabel(1500000)).toBe('1.5M')
    expect(windowLabel(131072)).toBe('131k')
    expect(windowLabel(999_999)).toBe('1M')          // rounds to 1000k, which is a million
    expect(windowLabel(999)).toBe('999')
  })
})
