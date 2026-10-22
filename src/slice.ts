import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './cli.js'
import { loadConfig } from './config.js'
import { pctOf, reached, readFill, sessionHash, sessionIdOf, windowLabel, type Fill } from './context.js'
import { readStream, type Entry, type EntryType, type JournalCtx } from './journal.js'
import type { CanonDoc } from './scan.js'
import { implementGated, stepProgress, stepsLine, type Progress } from './steps.js'
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
// a fresh session from handing over before it has done anything.
export function sessionActed(root: string, hash: string): boolean {
  const dir = join(root, '.witness', 'journal')
  if (!existsSync(dir)) return false
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).some((f) =>
    readStream(root, f.slice(0, -'.jsonl'.length)).some((e) => ACT_KINDS.has(e.t) && stampOf(e).session === hash))
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
export function stepCloseVerdict(i: {
  fill: Fill; limit: number; budget: number; progress: Progress; growth?: number; closedHere?: number
}): SliceVerdict {
  const { fill, limit, budget, progress, growth, closedHere } = i
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

// Row 191 §4.6 and §4.7. The fill is floored, as `reached` decides (Plan's call 2). The next step
// rounds up, so a step that grew the context at all never reads +0%.
export function contextLine(fill: Fill, limit: number, budget: number, growth?: number): string {
  if (!fill.measured) return `unmeasured (${fill.reason}) — step budget ${budget}`
  const { tokens, window } = fill.reading
  const next = growth === undefined ? '' : ` · next step ≈ +${Math.ceil(growth * 100 / window)}%`
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
// report and never the verb's exit: dispatch-report's relay line keeps the same doctrine.
export function reportStepClose(ctx: Ctx, root: string, plan: CanonDoc, opts: { closed?: string; passingGreen: boolean }): void {
  if (opts.closed === undefined && !opts.passingGreen) return
  const cfg = loadConfig(root)
  if (!cfg.ok) return
  const limit = cfg.value.session.contextLimit
  const budget = cfg.value.implement.stepsPerDispatch
  const entries = readStream(root, String(plan.meta.id))
  const progress = stepProgress(plan, entries)
  const fill = readFill(ctx.env)
  const growth = largestGrowth(entries, progress)
  ctx.out(kv('context', contextLine(fill, limit, budget, growth)))
  const decides = opts.closed !== undefined || (opts.passingGreen && !progress.known && !implementGated(entries))
  if (!decides) return
  const id = sessionIdOf(ctx.env)
  const closedHere = id === undefined ? undefined : closedThisSession(entries, progress, sessionHash(id))
  ctx.out(kv('steps', stepsLine(progress)))
  ctx.out(kv('slice', sliceLine(stepCloseVerdict({ fill, limit, budget, progress, growth, closedHere }))))
}
