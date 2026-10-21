// Row 182. Usage limits are waited out, never read as failure (design B4). Conservative on
// purpose: only shapes seen verbatim in fewhats's pi logs or claude 2.1.304's strings count.
// A spend limit, the extra-usage 400, a bare 429 or a limit line with no `resets` clause
// each need a human, and waiting cannot fix them — so none of them is a limit here.

export type Limit =
  | { kind: 'usage'; text: string; resetAt?: number }   // epoch ms · absent when the reset did not parse
  | { kind: 'transient'; text: string }

export interface Clock { now(): number; sleep(ms: number): Promise<void> }

// Node fires a timer past 2^31-1 ms at once, so a long sleep is taken in slices.
const MAX_TIMER_MS = 2 ** 31 - 1
export const realClock: Clock = {
  now: () => Date.now(),
  sleep: async (ms) => {
    let left = Math.max(0, ms)
    while (left > 0) {
      const step = Math.min(left, MAX_TIMER_MS)
      await new Promise<void>((done) => setTimeout(done, step))
      left -= step
    }
  },
}

export const USAGE_MARGIN_MS = 60_000
export const SINGLE_WAIT_MAX_MS = 21_600_000   // 6 h: one 5 h session window plus margin
export const TOTAL_WAIT_MAX_MS = 43_200_000    // 12 h

const MINUTE = 60_000
const HOUR = 60 * MINUTE
// A time-of-day reset whose next occurrence is this far away has already passed: the
// message is stale and the limit has reset.
const STALE_TIME_OF_DAY_MS = 23 * HOUR + 30 * MINUTE

const USAGE_LINE = /You[’']ve hit your (?:session|weekly|usage|5-hour|daily) limit · resets (.+)$/
const CLAUDE_EPOCH = /Claude AI usage limit reached\|(\d{9,11})\b/
const TRANSIENT_BODY = /"type":"(?:rate_limit_error|overloaded_error)"/
const TRANSIENT_LINE = /^(?:API Error: )?(?:Request timed out\.|Connection error\.)$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const CLOCK_WHEN = new RegExp(
  `^(?:(${MONTHS.join('|')}) (\\d{1,2}), )?(\\d{1,2})(?::(\\d{2}))?(am|pm)(?: \\(([^)]+)\\))?`)
const IN_WHEN = /^in (?:(\d+)h(?: (\d+)m)?|(\d+)m)\b/

type Fields = { year: number; month: number; day: number; hour: number; minute: number }

// wall-clock fields of instant t in zone tz
const parts = (t: number, tz: string): Fields => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
}).formatToParts(t).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)])) as Fields

// the instant whose wall clock in tz reads y-mo-d h:mi — two passes settle a DST edge
function zonedEpoch(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  let t = Date.UTC(y, mo - 1, d, h, mi)
  for (let i = 0; i < 2; i++) {
    const p = parts(t, tz)
    t -= Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Date.UTC(y, mo - 1, d, h, mi)
  }
  return t
}

const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

// `<when>` → epoch ms, or undefined when it does not parse (an unknown zone included).
function resetOf(when: string, now: number): number | undefined {
  const rel = IN_WHEN.exec(when)
  if (rel) {
    const [, h, hm, m] = rel
    return now + (h !== undefined ? Number(h) * HOUR + Number(hm ?? 0) * MINUTE : Number(m) * MINUTE)
  }
  const c = CLOCK_WHEN.exec(when)
  if (!c) return undefined
  const [, mon, day, hh, mm, ampm, zone] = c
  const h12 = Number(hh)
  const minute = Number(mm ?? 0)
  if (h12 < 1 || h12 > 12 || minute > 59) return undefined
  const hour = (h12 % 12) + (ampm === 'pm' ? 12 : 0)
  const tz = zone ?? localZone()
  try {
    const today = parts(now, tz)
    if (mon !== undefined) {
      const month = MONTHS.indexOf(mon) + 1
      let t = zonedEpoch(today.year, month, Number(day), hour, minute, tz)
      // a date that reads half a year back is next year's (a December message about January)
      if (t < now - 180 * 24 * HOUR) t = zonedEpoch(today.year + 1, month, Number(day), hour, minute, tz)
      return t
    }
    let t = zonedEpoch(today.year, today.month, today.day, hour, minute, tz)
    if (t <= now) {
      const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1))
      t = zonedEpoch(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hour, minute, tz)
    }
    return t - now > STALE_TIME_OF_DAY_MS ? now : t
  } catch {
    return undefined                                    // RangeError: a zone Intl cannot resolve
  }
}

function lineLimit(line: string, now: number): Limit | undefined {
  const u = USAGE_LINE.exec(line)
  if (u) {
    const text = line.slice(u.index).trim()
    const resetAt = resetOf(u[1]!.trim(), now)
    return resetAt === undefined ? { kind: 'usage', text } : { kind: 'usage', text, resetAt }
  }
  const e = CLAUDE_EPOCH.exec(line)
  if (e) return { kind: 'usage', text: line.slice(e.index).trim(), resetAt: Number(e[1]) * 1000 }
  const trimmed = line.trim()
  if (TRANSIENT_BODY.test(trimmed) || TRANSIENT_LINE.test(trimmed)) return { kind: 'transient', text: trimmed }
  return undefined
}

// A usage limit anywhere in the text outranks a transient one: it names its own reset.
export function limitIn(text: string, now: number): Limit | undefined {
  const found = text.split('\n').map((l) => lineLimit(l, now)).filter((l): l is Limit => l !== undefined)
  return found.find((l) => l.kind === 'usage') ?? found[0]
}

// A session's end reads as a limit only from its last three lines. A usage shape counts at
// any exit code (claude may exit 0 on one); a transient shape only on a non-zero exit.
export function sessionLimit(end: { code: number | null; tail: readonly string[] }, now: number): Limit | undefined {
  const limit = limitIn(end.tail.slice(-3).join('\n'), now)
  if (!limit) return undefined
  if (limit.kind === 'transient' && end.code === 0) return undefined
  return limit
}

// `streak` counts the limits met in a row before this one.
export function waitFor(limit: Limit, streak: number, now: number): number {
  const backoff = streak >= 1 ? Math.min(15 * 2 ** (streak - 1), 60) * MINUTE : 0
  if (limit.kind === 'transient') return Math.min(2 ** streak, 30) * MINUTE
  if (limit.resetAt === undefined) return Math.max(backoff, 15 * MINUTE)
  return Math.max(Math.max(0, limit.resetAt - now) + USAGE_MARGIN_MS, backoff)
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h${m ? `${m}m` : ''}`
  if (m > 0) return `${m}m${s % 60 ? `${s % 60}s` : ''}`
  return `${s}s`
}
