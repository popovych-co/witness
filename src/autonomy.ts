import type { Config } from './config.js'
import type { Entry } from './journal.js'
import type { Decision } from './recommend.js'
import { boundReached, fellBack, type DecisionEntry, type GateRunEntry } from './rounds.js'
import { cmd, kv } from './toon.js'

// Rows 171-175. PURE, like recommend.ts: the setting's rendering, the kept-stop names, and
// (row 171) the policy that acts on a stop under `autonomy: on`. It takes facts its caller
// resolved and returns data — it never loads canon, config or the trust list.

// The stops that reach a human whatever the setting says (design §3 G2). Named once here,
// because every surface that prints the set must print the same set.
export type KeptStop = 'design-look' | 'unmet-need' | 'trust-grant'

export const KEPT_STOP_NAMES: Record<KeptStop, string> = {
  'design-look': 'design look',
  'unmet-need': 'unmet need',
  'trust-grant': 'trust grant',
}

// Printed first on `next`, `start`, `gate` and `decide --show` whenever the repo has opted
// in, so a skill learns the mode from CLI output and never from memory (A1, A8).
export function autonomyLines(cfg: Pick<Config, 'autonomy'>): string[] {
  if (!cfg.autonomy) return []
  return [kv('autonomy', 'on'),
    kv('kept-stops', (Object.keys(KEPT_STOP_NAMES) as KeptStop[]).map((k) => KEPT_STOP_NAMES[k]).join(' · '))]
}

// `cmd`, not `kv`: a detail can carry a quoted command, and `kv` would quote the whole
// line into something that no longer pastes (D120).
export function keptStopLine(stop: KeptStop, detail: string): string {
  return cmd('kept-stop', `${KEPT_STOP_NAMES[stop]} — ${detail}`)
}

// Row 171. What the policy does with a stop: take a rendered command (a `witness decide`
// the CLI executes, or a re-run it only names), hand the stop to the arbiter, or leave it
// for a human because it is a kept stop.
export type Policy = { kind: 'take'; command: string } | { kind: 'arbiter' } | { kind: 'human'; stop: KeptStop }

// `untrusted` is caller-resolved — the commands a failed check of `run` names that the repo
// STILL does not trust — so this module never reads allow.json (D154's precedent for
// `untrustedCmds`).
export type StopFacts =
  | { at: 'gate'; gate: string; target: string; entries: Entry[]; run: GateRunEntry; block: Decision; untrusted: readonly string[] }
  | { at: 'choose' | 'recover'; block: Decision }
  | { at: 'start'; target: string; unmet: readonly string[] }

// The rules whose recommendation the CLI takes as it stands (design §7 A2's table). Each is
// a fix with a right answer — revise here, revise upstream, approve over nits, re-run a
// stale or malformed round — so no judgment is owed and none is spent.
const TAKEN = new Set(['blocking-here', 'blocking-parent', 'bound-recurrence', 'non-blocking-only',
  'stale-below-bound', 'malformed-rerun'])

// An ordered first-match list, like recommend.ts's rule table, and dispatched by GATE before
// RULE: the recommender's rules overlap, so a design stop with only non-blocking findings
// matches `non-blocking-only` before `reserved-stop-clean` (E8), and a rule-keyed policy
// would approve the one look the user kept for themselves.
export function policyFor(facts: StopFacts): Policy {
  if (facts.at === 'start') return { kind: 'human', stop: 'unmet-need' }
  if (facts.at !== 'gate') return { kind: 'take', command: facts.block.options[0]!.command }

  const { gate, target, entries, run, block, untrusted } = facts
  const failed = run.checks.filter((c) => !c.ok)
  const blocks = (run.verdicts ?? []).some((rv) => rv.findings.some((f) => f.blocking))
  const clean = failed.length === 0 && !blocks
  // Option 1 only when it pastes: a placeholder (`<effort>`) means no upstream resolved,
  // and filling an id is exactly what the arbiter may never do either — but it can pick
  // another option, so the stop goes there rather than to a command that would refuse.
  const first = (): Policy => {
    const o = block.options[0]
    return o !== undefined && o.runnable ? { kind: 'take', command: o.command } : { kind: 'arbiter' }
  }

  if (untrusted.length > 0) return { kind: 'human', stop: 'trust-grant' }
  // A verdict that describes bytes no longer there, or a round that judged nothing, is a free
  // re-run before it is anything else: no human or arbiter can honestly act on it, and the
  // standing and fallback arms below would hand it to one with the re-run filtered away.
  if (block.rule === 'stale-below-bound' || block.rule === 'malformed-rerun') return first()
  if (gate === 'design' && clean) return { kind: 'human', stop: 'design-look' }
  if ((gate === 'ship' || gate === 'decompose') && clean && run.standing !== undefined) return { kind: 'arbiter' }
  if (fellBack(run)) return { kind: 'arbiter' }
  // A trust failure granted since the stop: the check never ran, so the fix is a re-run,
  // not a revise — sending the author back would have them "fix" a command nobody judged.
  if (failed.some((c) => (c.untrusted?.length ?? 0) > 0) && !boundReached(entries, gate)) {
    return { kind: 'take', command: `witness gate ${gate} ${target}` }
  }
  if (block.rule === 'checks-failed') {
    // amendment-ack is the one check an approve clears, so approving is a judgment about the
    // amendment against the ask — the arbiter's, never the rule's (§11 call 10).
    return failed.every((c) => c.name === 'amendment-ack') ? { kind: 'arbiter' } : first()
  }
  if (TAKEN.has(block.rule) || block.rule.startsWith('anchor-recurrence-')) return first()
  // bound · bound-stale · ladder-spent · pin-contradiction · reserved-stop-clean · manual-stop
  return { kind: 'arbiter' }
}

// Row 173. Who made a disposition, in one spelling for every surface that says so
// (`decide --show`, `log`, `status`).
export function decidedBy(d: Pick<DecisionEntry, 'selected' | 'arbiter'>): string {
  if (d.selected === 'policy') return 'policy'
  if (d.selected === 'arbiter') return `arbiter · ${d.arbiter?.model ?? 'unknown'}`
  if (d.selected === 'affirmation') return 'human · affirmation'
  return 'human'
}
