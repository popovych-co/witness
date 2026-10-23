import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './cli.js'
import { loadConfig, type Config } from './config.js'
import { pctOf, reached, readFill, sessionHash, sessionIdOf, windowLabel, type Fill } from './context.js'
import { relayLine, resolveDriver } from './harness.js'
import { readStream, type Entry, type EntryType, type JournalCtx } from './journal.js'
import type { CanonDoc } from './scan.js'
import { implementGated, redInFlight, stepProgress, stepsLine, vacuousEvidence, type Progress } from './steps.js'
import { kv } from './toon.js'

// Plan's call 8 (row 191 §4.8). An act is the session's own stage work. What the CLI writes on a
// session's behalf is bookkeeping (`status`, the lazy merge stamp, among it), so a session cannot
// hand over before it has done anything.
export const ACT_KINDS: ReadonlySet<string> = new Set<EntryType>([
  'recap', 'write', 'design-write', 'design-reconfirm', 'gate-run', 'human-decision',
  'test-evidence', 'step-close', 'dispatch', 'drift-check', 'adopt',
])

// The stamp a line carries (§4.8). Lines written before row 191, or outside a harness session,
// carry none.
const stampOf = (e: Entry): Partial<JournalCtx> =>
  typeof e.ctx === 'object' && e.ctx !== null ? (e.ctx as Partial<JournalCtx>) : {}

// Row 191 §4.5. Whether this session has done stage work yet, in any stream: the guard that keeps
// a fresh session from handing over before it has done anything. A vacuous red is no act (final
// review I3): it observed the behavior already there, so a session opened over the limit that only
// re-ran one would hand over, and so would every fresh session after it.
export function sessionActed(root: string, hash: string): boolean {
  const dir = join(root, '.witness', 'journal')
  if (!existsSync(dir)) return false
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).some((f) =>
    readStream(root, f.slice(0, -'.jsonl'.length))
      .some((e) => ACT_KINDS.has(e.t) && !vacuousEvidence(e) && stampOf(e).session === hash))
}

// The entries that closed a step, in stream order. A legacy plan's closes are not the CLI's to
// see, so it has none.
const closings = (entries: Entry[], p: Progress): Entry[] =>
  (p.known ? p.steps : [])
    .flatMap((s) => (s.closedAt === undefined ? [] : [s.closedAt]))
    .sort((a, b) => a - b)
    .map((i) => entries[i])
    .filter((e): e is Entry => e !== undefined)

// Row 191 §4.5. A step's growth runs from the entry that closed the previous step to the one that
// closed it, within one session: a pair across sessions spans two contexts, not a step. It stays
// in tokens, so a window that changed mid-plan (a model switch) converts with the current one. A
// fall is no sample (P2: Pi's estimate can drop between turns), and the largest rise is `g`: the
// goal is staying under the limit, and an extra relay costs only one warm-up.
export function largestGrowth(entries: Entry[], p: Progress): number | undefined {
  const closes = closings(entries, p).map(stampOf)
  const samples = closes.slice(1).flatMap((later, i) => {
    const earlier = closes[i]!
    const sameSession = earlier.session !== undefined && earlier.session === later.session
    return sameSession && typeof earlier.tokens === 'number' && typeof later.tokens === 'number' && later.tokens > earlier.tokens
      ? [later.tokens - earlier.tokens]
      : []
  })
  return samples.length ? Math.max(...samples) : undefined
}

// Row 191 §4.7. The steps this session closed, read from the session each closing entry carries:
// what the step budget counts when the fill cannot be read.
export function closedThisSession(entries: Entry[], p: Progress, hash: string): number {
  return closings(entries, p).filter((e) => stampOf(e).session === hash).length
}

export type SliceVerdict = { kind: 'gate' } | { kind: 'continue' } | { kind: 'end'; why: string } | { kind: 'own-count'; budget: number }

// Row 191 §4.5 and §4.7, in this order. There is no first-step exemption: the step has already
// finished, so a slice that ends here still made progress. A legacy plan (progress unknown) keeps
// rule 2, and rule 1 stays with the skill, which knows its steps. Unmeasured, the CLI counts this
// session's closes against the step budget where it can see both; where it cannot, the skill
// keeps its own count, as before row 191.
//
// `redOpen` (final review I1, D192): a red in flight (steps.ts `redInFlight`: the latest non-vacuous
// run saw a failure, whatever step it names or none) is work the session is in the middle
// of, and a session never relays mid-red, so the slice goes on until its green. A closing green
// clears it, so this answers a close made while a red stands: a `step-close`.
// It outranks rule 1 too: a red re-opened once every step has closed would send the session to a
// gate whose evidence check fails on it, spending a round on a tree mid-red.
export function stepCloseVerdict(i: {
  fill: Fill; limit: number; budget: number; progress: Progress; redOpen: boolean; growth?: number; closedHere?: number
}): SliceVerdict {
  const { fill, limit, budget, progress, redOpen, growth, closedHere } = i
  if (redOpen) return { kind: 'continue' }
  if (progress.known && progress.next === undefined) return { kind: 'gate' }
  if (fill.measured) {
    const { tokens, window } = fill.reading
    if (reached(tokens, window, limit)) return { kind: 'end', why: `${pctOf(tokens, window)}% reached the ${limit}% limit` }
    if (progress.known && growth !== undefined && reached(tokens + growth, window, limit)) {
      return { kind: 'end', why: `${pctOf(tokens, window)}% + next step ≈ ${pctOf(tokens + growth, window)}% passes the ${limit}% limit` }
    }
    return { kind: 'continue' }
  }
  if (!progress.known || closedHere === undefined) return { kind: 'own-count', budget }
  if (closedHere >= budget) {
    return { kind: 'end', why: `${closedHere} step(s) closed this session · step budget ${budget} (context unmeasured)` }
  }
  return { kind: 'continue' }
}

// Row 191 §4.6 and §4.7. The fill is floored, as `reached` decides (Plan's call 2). The next step is
// the difference of the two floored shares, so it adds up to the projection the verdict prints
// beside it (D192: rounded up on its own, 30,001 tokens read +4% beside 17% + next step ≈ 20%), and
// a step that grew the context at all never reads +0%.
export function contextLine(fill: Fill, limit: number, budget: number, growth?: number): string {
  if (!fill.measured) return `unmeasured (${fill.reason}) — step budget ${budget}`
  const { tokens, window } = fill.reading
  const next = growth === undefined
    ? ''
    : ` · next step ≈ +${Math.max(pctOf(tokens + growth, window) - pctOf(tokens, window), 1)}%`
  return `${pctOf(tokens, window)}% of ${windowLabel(window)} · limit ${limit}%${next}`
}

export function sliceLine(v: SliceVerdict): string {
  switch (v.kind) {
    case 'continue': return 'continue'
    case 'end': return `end — ${v.why}`
    case 'gate': return 'gate — no steps remain'
    case 'own-count': return `own count — the CLI cannot count this session's steps · end after ${v.budget} step(s) by your own count`
  }
}

// Row 191 §4.4. A step close is the one point inside a plan where the slice is decided, read from
// the stream the close was just written to, so a fresh session continues with nothing lost. A
// green that closes no step (a re-record, a fix round) only reports the fill. A legacy plan's
// closes are not the CLI's to see (§4.3), so until its implement gate every passing green
// decides. The close is journaled before this runs, so a config that will not load costs the
// report and never the verb's exit: dispatch-report's relay line keeps the same doctrine. It says
// so on stderr (D192), so the missing report is never silent.
export function reportStepClose(ctx: Ctx, root: string, plan: CanonDoc, opts: { closed?: string; passingGreen: boolean }): void {
  if (opts.closed === undefined && !opts.passingGreen) return
  const cfg = loadConfig(root)
  if (!cfg.ok) {
    ctx.err(`warn: no context line — witness.config.yaml did not load (${cfg.violations[0]!.rule})`)
    return
  }
  const limit = cfg.value.session.contextLimit
  const budget = cfg.value.implement.stepsPerDispatch
  const entries = readStream(root, String(plan.meta.id))
  const progress = stepProgress(plan, entries)
  const fill = readFill(ctx.env)
  // §4.5's `g` is the size of the next step, so once every step is closed there is none to project.
  const growth = progress.known && progress.next !== undefined ? largestGrowth(entries, progress) : undefined
  ctx.out(kv('context', contextLine(fill, limit, budget, growth)))
  const decides = opts.closed !== undefined || (opts.passingGreen && !progress.known && !implementGated(entries))
  if (!decides) return
  const id = sessionIdOf(ctx.env)
  const closedHere = id === undefined ? undefined : closedThisSession(entries, progress, sessionHash(id))
  const redOpen = redInFlight(entries)
  ctx.out(kv('steps', stepsLine(progress)))
  ctx.out(kv('slice', sliceLine(stepCloseVerdict({ fill, limit, budget, progress, redOpen, growth, closedHere }))))
}

// Row 191 §4.10 (amends row 79). Under a measured harness how many slices a plan takes cannot be
// known in advance, so the run's shape is the rule that will cut it, beside the step budget an
// unmeasured session counts against instead.
export function slicesLine(cfg: Config): string {
  return `by context — relay at ${cfg.session.contextLimit}% (step budget ${cfg.implement.stepsPerDispatch} if unmeasured)`
}

// Row 191 §4.8. A measured fill names its session (readFill checks it against the harness's), so
// a session whose fill reached the limit always has one to look for.
const actedYet = (root: string, env: Ctx['env']): boolean => {
  const id = sessionIdOf(env)
  return id !== undefined && sessionActed(root, sessionHash(id))
}

// Row 191 §4.4–§4.6. The hand-overs outside a step close: after a revise is handed to the
// session, at a ship exit, and at `next`. The work continues in this same home, so the relay
// carries no `run:`. Only the fill decides here: other stages have no repeated unit to project
// a next act from (§4.5). Unmeasured, nothing hands over, which is the behavior before row 191
// (§4.7). `guard` is the act guard: at `next` and at a ship exit it keeps a session from
// handing over before it has done anything, since neither always follows an act. At a revise
// the decision itself was the act (Plan's call 7). A driver that will not resolve has no relay
// to name, so nothing prints.
export function reportHandover(ctx: Ctx, root: string, cfg: Config, opts: { guard: boolean }): boolean {
  const fill = readFill(ctx.env)
  const limit = cfg.session.contextLimit
  if (!fill.measured || !reached(fill.reading.tokens, fill.reading.window, limit)) return false
  if (opts.guard && !actedYet(root, ctx.env)) return false
  const driver = resolveDriver(ctx.env, cfg.harness)
  if (!driver.ok) return false
  ctx.out(kv('context', contextLine(fill, limit, cfg.implement.stepsPerDispatch)))
  ctx.out(kv('relay', relayLine(driver.value.harness)))
  return true
}

// Row 191 §4.5 "Before any work". A session already at the limit when it opens cannot hand over
// (it has done nothing yet), and with no first-step exemption at a step close each of its slices
// will be one step, so the CLI says so where the session begins. Deterministic, so a fresh
// session's second `next` repeats it (Plan's call 9).
export function reportOpening(ctx: Ctx, root: string, cfg: Config): void {
  const fill = readFill(ctx.env)
  const limit = cfg.session.contextLimit
  if (!fill.measured) return
  const { tokens, window } = fill.reading
  if (!reached(tokens, window, limit) || actedYet(root, ctx.env)) return
  ctx.out(kv('warn', `this session opens at ${pctOf(tokens, window)}% of ${windowLabel(window)} — over the ${limit}% limit before any work; each slice will be one step`))
}
