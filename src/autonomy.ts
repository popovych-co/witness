import { cliAct, runRow, type Act } from './act.js'
import type { Config } from './config.js'
import type { Entry } from './journal.js'
import type { Decision } from './recommend.js'
import { boundReached, fellBack, type DecisionEntry, type GateRunEntry } from './rounds.js'
import { cmd, kv, logSafe } from './toon.js'

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

// Row 179's kept stop for one plan's start: what is missing, then how to satisfy it. Drive's
// set-aside and the chat's notice (row 195) print it. Row 239 (design §3.4): a need's text is its
// author's, so it is prose on the kept stop's own line, which a skill never runs, and each satisfy
// prints on a row of its own under it (`runRow`). Joined to the prose, a text that spells a command
// would plant it ahead of the real one; ruling R16(a): so would a line break in it, which starts a
// row of its own, so the text is spelled out (`logSafe`).
export function unmetNeedLine(needs: ReadonlyArray<{ text: string; satisfyAct: Act }>): string {
  return [keptStopLine('unmet-need', logSafe(needs.map((u) => u.text).join(' · '))), ...needs.map((u) => runRow(u.satisfyAct))].join('\n')
}

// Row 171. What the policy does with a stop: take an act (a `witness decide` the CLI
// executes, or a re-run it only names), pick a spec, hand the stop to the arbiter, or leave it
// for a human because it is a kept stop. Row 239 (the plan's B7): an act, run as its argv, and
// never a printed line read back; `pick` answers a choose block, whose options name specs, not
// commands (`readyChoice`).
export type Policy = { kind: 'take'; act: Act } | { kind: 'pick'; id: string } | { kind: 'arbiter' } | { kind: 'human'; stop: KeptStop }

// `untrusted` is caller-resolved — the commands a failed check of `run` names that the repo
// STILL does not trust — so this module never reads allow.json (D154's precedent for
// `untrustedCmds`).
export type StopFacts =
  | { at: 'gate'; gate: string; target: string; entries: Entry[]; run: GateRunEntry; block: Decision; untrusted: readonly string[] }
  | { at: 'choose'; block: Decision }
  | { at: 'recover'; block: Decision }
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
  if (facts.at === 'choose') return { kind: 'pick', id: facts.block.options[0]!.command }
  // `recoverChoice` builds every option from an act; one without an act is no command to take.
  if (facts.at === 'recover') {
    const act = facts.block.options[0]?.act
    return act !== undefined ? { kind: 'take', act } : { kind: 'arbiter' }
  }

  const { gate, target, entries, run, block, untrusted } = facts
  const failed = run.checks.filter((c) => !c.ok)
  const blocks = (run.verdicts ?? []).some((rv) => rv.findings.some((f) => f.blocking))
  const clean = failed.length === 0 && !blocks
  // Option 1 only when it has no word to fill: a placeholder (`<effort>`) means no upstream
  // resolved, and filling an id is exactly what the arbiter may never do either — but it can
  // pick another option, so the stop goes there rather than to a command that would refuse.
  // Row 239 (the plan's B4): read off the act's inputs, not `runnable`, which Windows also
  // clears for a line it will not offer to paste; the CLI runs the argv with no shell.
  const first = (): Policy => {
    const act = block.options[0]?.act
    return act !== undefined && act.inputs.length === 0 ? { kind: 'take', act } : { kind: 'arbiter' }
  }

  if (untrusted.length > 0) return { kind: 'human', stop: 'trust-grant' }
  // A verdict that describes bytes no longer there, or a round that judged nothing, is a free
  // re-run before it is anything else: no human or arbiter can honestly act on it, and the
  // standing arms below would hand it to one with the re-run filtered away.
  if (block.rule === 'stale-below-bound' || block.rule === 'malformed-rerun') return first()
  // Row 212. A 0.25.x round that fell back to a model nobody pinned is no verdict to weigh:
  // re-run it on the pin (free — it never spent the budget), ahead of every arbiter arm.
  if (fellBack(run)) return { kind: 'take', act: cliAct('gate', gate, target) }
  if (gate === 'design' && clean) return { kind: 'human', stop: 'design-look' }
  if ((gate === 'ship' || gate === 'decompose') && clean && run.standing !== undefined) return { kind: 'arbiter' }
  // A trust failure granted since the stop: the check never ran, so the fix is a re-run,
  // not a revise — sending the author back would have them "fix" a command nobody judged.
  if (failed.some((c) => (c.untrusted?.length ?? 0) > 0) && !boundReached(entries, gate)) {
    return { kind: 'take', act: cliAct('gate', gate, target) }
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
