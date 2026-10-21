import { describe, expect, it } from 'vitest'
import { duration, limitIn, sessionLimit, waitFor } from '../src/usage.js'

const at = (iso: string) => Date.parse(iso)
const NOW = at('2026-10-19T19:30:00Z')                     // 12:30 in America/Los_Angeles (PDT)
const LA = (when: string) => `You've hit your session limit · resets ${when} (America/Los_Angeles)`

describe('limitIn (B4)', () => {
  it('reads the session-limit line pi and claude print', () => {
    expect(limitIn(LA('2pm'), NOW)).toEqual({ kind: 'usage', text: LA('2pm'), resetAt: at('2026-10-19T21:00:00Z') })
  })
  it.each([
    [LA('12am'), '2026-10-20T07:00:00Z'],
    ["You've hit your weekly limit · resets 10:59am (America/Los_Angeles)", '2026-10-20T17:59:00Z'],
    ["You've hit your usage limit · resets 7:20pm (America/Los_Angeles)", '2026-10-20T02:20:00Z'],
    ['You’ve hit your weekly limit · resets Oct 22, 4pm (America/Los_Angeles)', '2026-10-22T23:00:00Z'],
    ['Claude AI usage limit reached|1792440000', '2026-10-19T20:00:00Z'],
  ])('%s resets at %s', (text, iso) => {
    expect(limitIn(text, NOW)).toMatchObject({ kind: 'usage', resetAt: at(iso) })
  })
  it('reads the rate-limit and overloaded bodies and the two network lines as transient', () => {
    for (const text of [
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
      '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"}}',
      'Request timed out.', 'API Error: Connection error.',
    ]) expect(limitIn(text, NOW)).toEqual({ kind: 'transient', text })
  })
  it.each([
    "You've hit your monthly spend limit.",
    "You've hit your session limit",
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage"}}',
    'HTTP 429', 'the rate limit test passed', 'Request timed out. retrying',
  ])('%s is not a limit', (text) => {
    expect(limitIn(text, NOW)).toBeUndefined()
  })
  it('a zone it cannot resolve leaves the reset unknown', () => {
    expect(limitIn("You've hit your session limit · resets 2pm (Mars/Olympus)", NOW)).toEqual(
      { kind: 'usage', text: "You've hit your session limit · resets 2pm (Mars/Olympus)" })
  })
})

describe('sessionLimit · waitFor · duration (B4)', () => {
  it('reads only the last three lines · transient only on a non-zero exit', () => {
    expect(sessionLimit({ code: 0, tail: ['a', LA('2pm')] }, NOW)?.kind).toBe('usage')
    expect(sessionLimit({ code: 1, tail: [LA('2pm'), 'a', 'b', 'c'] }, NOW)).toBeUndefined()
    expect(sessionLimit({ code: 0, tail: ['Request timed out.'] }, NOW)).toBeUndefined()
    expect(sessionLimit({ code: 1, tail: ['Request timed out.'] }, NOW)?.kind).toBe('transient')
  })
  it('waits to the reset plus a minute and backs off on repeats', () => {
    const lim = limitIn(LA('2pm'), NOW)!
    expect(waitFor(lim, 0, NOW)).toBe(5_460_000)                         // 1h31m
    const stale = { kind: 'usage' as const, text: 'x', resetAt: NOW }
    expect([0, 1, 2, 3, 5].map((s) => waitFor(stale, s, NOW) / 60_000)).toEqual([1, 15, 30, 60, 60])
    expect(waitFor({ kind: 'usage', text: 'x' }, 0, NOW) / 60_000).toBe(15)
    expect([0, 1, 4, 5, 9].map((s) => waitFor({ kind: 'transient', text: 'x' }, s, NOW) / 60_000)).toEqual([1, 2, 16, 30, 30])
  })
  it('a time-of-day reset that just passed reads as now', () => {
    const tenPast = at('2026-10-19T21:10:00Z')                           // 14:10 PDT
    expect(limitIn(LA('2pm'), tenPast)).toMatchObject({ resetAt: tenPast })
  })
  it('renders durations', () => {
    expect([5_460_000, 45_000, 720_000, 25_200_000].map(duration)).toEqual(['1h31m', '45s', '12m', '7h'])
  })
})

// Final review F13. A limit is a line the harness or the provider wrote, from its start; text
// that only quotes one (a test's expectation, an agent's summary) is not a limit.
describe('limit shapes are anchored (B4)', () => {
  it.each(['Sonnet', 'Opus', 'Fable'])("reads claude's %s limit", (name) => {
    expect(limitIn(`You've hit your ${name} limit · resets 6pm (Europe/Kyiv)`, NOW)?.kind).toBe('usage')
  })
  it.each([
    "exit 1: You've hit your session limit · resets 2pm (America/Los_Angeles)",
    "API Error: You've hit your session limit · resets 2pm (America/Los_Angeles)",
    "Error: You've hit your session limit · resets 2pm (America/Los_Angeles)",
  ])('reads %s after a known prefix', (text) => {
    expect(limitIn(text, NOW)).toMatchObject({ kind: 'usage', text: LA('2pm'), resetAt: at('2026-10-19T21:00:00Z') })
  })
  it.each([
    "expected 'You've hit your session limit · resets 2pm (America/Los_Angeles)' to be undefined",
    "  ✓ the agent said: You've hit your session limit · resets 2pm (America/Los_Angeles)",
    'AssertionError: expected {"type":"error","error":{"type":"rate_limit_error"}} to equal {}',
  ])('a line quoting a limit is not one: %s', (text) => {
    expect(limitIn(text, NOW)).toBeUndefined()
  })
  it('the limit text ends where its reset does', () => {
    expect(limitIn(`${LA('2pm')}. Upgrade for more.`, NOW)?.text).toBe(LA('2pm'))
  })
  it('a successful session whose summary quotes a limit waits for nothing', () => {
    expect(sessionLimit({ code: 0, tail: ['done', `I saw "${LA('2pm')}" in the log`] }, NOW)).toBeUndefined()
  })
})
