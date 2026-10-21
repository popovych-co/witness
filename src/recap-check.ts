import { arbitrate, type ArbiterSection } from './arbiter.js'
import { askText, checkReason, oneLine, recapChecks, type AskStatus } from './ask.js'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import type { Option } from './recommend.js'
import { ok, refuse, type Result } from './refusal.js'
import type { Canon } from './scan.js'
import { rows } from './toon.js'
import type { RecapInput } from './verbs/recap.js'

// Row 177. Under autonomy nobody confirms a recap, so the arbiter does, in its `recap` mode:
// the same lens, invoker, chain and reroll as a gate stop's arbiter (row 172), with its own
// prompt. The menu names the class, so the CLI checks the class from the arbiter's choice
// rather than trusting its prose: an accept naming a class the recap does not carry sends
// the recap back. That is the hole the check exists for — a feature recapped as a fix or a
// chore skips the design stage, the human's one kept look at a new screen.
const CLASSES = ['feature', 'fix', 'chore'] as const

export const RECAP_MENU: readonly Option[] =
  ['accept as feature', 'accept as fix', 'accept as chore', 'reject'].map((command) => ({ command, depth: 'root', runnable: false }))

export type RecapVerdict =
  | { kind: 'judged'; accepted: boolean; rule: 'recap-check' | 'recap-class'   // recap-class: an accept naming a class the recap does not carry
      decided?: 'feature' | 'fix' | 'chore'                                    // the class the choice named · absent on reject
      reason: string; note?: string; arbiter: { model: string; prompts_sha: string } }
  | { kind: 'malformed' }                                                      // arbitrate refused arbiter-malformed

const OUTCOME = { approve: 'accepted', revise: 'rejected', stop: 'parked' } as Record<string, string>

export function recapEvidence(root: string, canon: Canon, ask: AskStatus, recap: RecapInput): ArbiterSection[] {
  // The recap exactly as it would be journaled — the same fields the entry carries — so the
  // arbiter judges the document the effort is born from, and no stray key in the file reaches
  // it. The ask it answers is its own section above.
  const { effort, class: cls, goals, non_goals, constraints, slices } = recap
  const drafted = { effort, class: cls, goals, non_goals, constraints, slices }
  // Agent-written canon text, one line each: a summary must never open a section of its own.
  const specs = canon.docs.filter((d) => d.meta.type === 'spec')
    .sort((a, b) => String(a.meta.id).localeCompare(String(b.meta.id)))
    .map((d) => ({ id: d.meta.id, summary: oneLine(String(d.meta.summary ?? '')), ui: d.meta.ui === true, status: d.meta.status }))
  const sections: ArbiterSection[] = [
    { title: 'The ask', body: `${ask.id} — ${askText(ask.text)}` },
    { title: 'The recap', body: `\`\`\`json\n${JSON.stringify(drafted, null, 2)}\n\`\`\`` },
    { title: 'Canon index', body: rows('specs', ['id', 'summary', 'ui', 'status'], specs).join('\n') },
  ]
  const prior = recapChecks(root, ask.id).map((e) => {
    const why = e.reason !== undefined ? checkReason({ rule: String(e.rule), class: e.class, decided: e.decided, reason: e.reason }) : ''
    return oneLine(`check ${e.round}: ${OUTCOME[e.decision] ?? e.decision}${why ? ` — ${why}` : ''}${e.note ? ` · note: ${e.note}` : ''}`)
  })
  if (prior.length > 0) sections.push({ title: 'Prior checks of this ask', body: prior.join('\n') })
  return sections
}

export async function checkRecap(ctx: Ctx, root: string, cfg: Config, canon: Canon,
  input: { ask: AskStatus; recap: RecapInput }): Promise<Result<RecapVerdict>> {
  const r = await arbitrate(ctx, root, cfg, { mode: 'recap', menu: RECAP_MENU, evidence: recapEvidence(root, canon, input.ask, input.recap) })
  if (!r.ok) {
    // A1's answer to a second malformed ruling, applied to an ask: a park, so no later `next`
    // re-asks the arbiter without bound. Any other refusal journals nothing and exits.
    if (r.violations.some((x) => x.rule === 'arbiter-malformed')) return ok({ kind: 'malformed' })
    return refuse(r.violations)
  }
  const { choice, reason, note, model, prompts_sha } = r.value
  const base = { kind: 'judged' as const, reason, ...(note !== undefined ? { note } : {}), arbiter: { model, prompts_sha } }
  const decided = CLASSES[choice - 1]
  if (decided === undefined) return ok({ ...base, accepted: false, rule: 'recap-check' })
  const accepted = decided === input.recap.class
  return ok({ ...base, accepted, rule: accepted ? 'recap-check' : 'recap-class', decided })
}

export function recapCheckEntry(ask: string, round: number, recap: RecapInput, v: RecapVerdict): {
  t: 'human-decision'; gate: 'recap'; artifact: string; round: number; decision: 'approve' | 'revise' | 'stop'
  selected: 'arbiter' | 'policy'; rule: string; reason?: string; note?: string
  arbiter?: { model: string; prompts_sha: string }; effort: string; class: RecapInput['class']; decided?: 'feature' | 'fix' | 'chore'
} {
  const head = { t: 'human-decision' as const, gate: 'recap' as const, artifact: ask, round }
  const scope = { effort: recap.effort, class: recap.class }
  if (v.kind === 'malformed') {
    return { ...head, decision: 'stop', selected: 'policy', rule: 'arbiter-malformed',
      note: 'parked by the policy — the arbiter answered malformed twice', ...scope }
  }
  return {
    ...head, decision: v.accepted ? 'approve' : 'revise', selected: 'arbiter', rule: v.rule,
    reason: v.reason, ...(v.note !== undefined ? { note: v.note } : {}), arbiter: v.arbiter,
    ...scope, ...(v.decided !== undefined ? { decided: v.decided } : {}),
  }
}
