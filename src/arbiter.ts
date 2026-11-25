import type { Act } from './act.js'
import { askOf, askText } from './ask.js'
import type { Ctx } from './cli.js'
import { decidedBy } from './autonomy.js'
import { loadLocalConfig, type Config } from './config.js'
import { openDeferrals } from './deferral.js'
import { serializeDoc } from './fm.js'
import { resolveJudge } from './harness.js'
import { latestRecap, policyPins, type Entry, type ReviseReturnedEntry } from './journal.js'
import { SESSION_DEFAULT, stageModel, unansweredPin } from './model.js'
import type { Decision, Option } from './recommend.js'
import { ok, refuse, v, type Result, type Violation } from './refusal.js'
import { invokeReviewerAsync, parseVerdictText, promptsSha, resolvePrompt } from './reviewer.js'
import { effortCanon, effortOf } from './reviewed.js'
import { REVISE_HUMAN, anchorRecurrence, gateRuns, offUnbooked, roundBudget, type DecisionEntry, type GateCheck, type GateRunEntry, type OffVerdict, type PartVerdict } from './rounds.js'
import { findById, type Canon } from './scan.js'
import { canonicalJson } from './sha.js'
import { visible } from './toon.js'
import { checkWaiver } from './checks.js'

// Row 172. The arbiter is a LENS in the judgment lane (D48, D88): the repo's judge harness,
// its own `arbiter.model` pin, the hermetic reviewer spawn and a vendored prompt — never the
// session that wrote the work, and never anything it narrated. It picks one numbered
// option from a menu the CLI already filtered to legal acts, reading evidence the CLI
// composed. It runs on that one pin with no per-gate pin, so one arbiter identity is
// comparable across every gate it judges, and a pin it cannot invoke refuses (row 212).

// Row 194: the recap check (row 177) is gone, so a decision is the one mode.
export type ArbiterMode = 'decision'
export interface ArbiterSection { title: string; body: string }
export interface ArbiterRequest { mode: ArbiterMode; menu: readonly Option[]; evidence: readonly ArbiterSection[] }
// `choice` is 1-based, the number the prompt showed.
export interface ArbiterRuling { choice: number; reason: string; note?: string; model: string; prompts_sha: string }

// How a later mode adds its own prompt without a second invoker.
export const PROMPT_OF: Record<ArbiterMode, string> = { decision: 'arbiter' }

const TEXT_MAX = 600

function renderOptions(menu: readonly Option[]): string {
  return menu.flatMap((o, i) => [
    `${i + 1}. ${o.command}`,
    ...(o.why ? [`   why: ${o.why}`] : []),
    ...(o.judgeFirst ? [`   judge-first: ${o.judgeFirst}`] : []),
    ...(o.when ? [`   when: ${o.when}`] : []),
    ...(o.tradeoff ? [`   tradeoff: ${o.tradeoff}`] : []),
    ...(o.note ? [`   note: ${o.note}`] : []),
  ]).join('\n')
}

function readRuling(text: string, n: number): Result<{ choice: number; reason: string; note?: string }> {
  const rawR = parseVerdictText(text)
  if (!rawR.ok) return rawR
  const raw = rawR.value
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return refuse([v('ruling', 'not-an-object', JSON.stringify(raw).slice(0, 120), '{"choice": <n>, "reason": "…"}')])
  }
  const r = raw as Record<string, unknown>
  const rows: Violation[] = []
  if (typeof r.choice !== 'number' || !Number.isInteger(r.choice) || r.choice < 1 || r.choice > n) {
    rows.push(v('choice', 'not-an-option', String(r.choice), `an option number from 1 to ${n}`))
  }
  if (typeof r.reason !== 'string' || r.reason.trim() === '' || r.reason.length > TEXT_MAX) {
    rows.push(v('reason', 'invalid', typeof r.reason === 'string' ? `${r.reason.length} chars` : String(r.reason),
      `a non-empty reason of at most ${TEXT_MAX} characters`))
  }
  // An empty note is an absent one: the contract marks it optional, and a reroll spent on
  // `"note": ""` would park a flow over a field that carried nothing.
  const note = typeof r.note === 'string' && r.note.trim() === '' ? undefined : r.note
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > TEXT_MAX)) {
    rows.push(v('note', 'invalid', typeof note === 'string' ? `${note.length} chars` : String(note),
      `an optional note of at most ${TEXT_MAX} characters`))
  }
  if (rows.length > 0) return refuse(rows)
  return ok({ choice: r.choice as number, reason: r.reason as string, ...(typeof note === 'string' ? { note } : {}) })
}

export async function arbitrate(ctx: Ctx, root: string, cfg: Config, req: ArbiterRequest): Promise<Result<ArbiterRuling>> {
  const lensR = resolvePrompt(PROMPT_OF[req.mode])
  if (!lensR.ok) return lensR
  const lens = lensR.value
  const hxR = resolveJudge(ctx.env, cfg.harness)
  if (!hxR.ok) return refuse(hxR.violations)
  const harness = hxR.value.harness
  const localR = loadLocalConfig(root)
  if (!localR.ok) return localR
  const modelR = stageModel(cfg, 'arbiter')
  if (!modelR.ok) return refuse(modelR.violations)
  const model = modelR.value

  let prompt = `${lens.contents}\n${req.evidence.map((s) => `\n## ${s.title}\n\n${s.body}\n`).join('')}\n## Options\n\n${renderOptions(req.menu)}\n`
  for (let attempt = 0; ; attempt++) {
    const r = await invokeReviewerAsync(ctx, harness, {
      cwd: root, prompt, model: model === SESSION_DEFAULT ? undefined : model, pinField: 'arbiter.model', lens: 'arbiter',
      timeoutMs: cfg.gates.reviewerTimeoutMs, extensions: localR.value.reviewerExtensions,
    })
    if (!r.ok) return refuse(unansweredPin(r.violations, 'arbiter.model', model, harness.name))
    const ruling = readRuling(r.value.text, req.menu.length)
    if (ruling.ok) {
      return ok({ ...ruling.value, model, prompts_sha: promptsSha([{ name: PROMPT_OF[req.mode], contents: lens.contents }]) })
    }
    if (attempt === 0) {
      // One self-repair reroll on the same model, in the shape runBattery gives a lens.
      prompt += `\n## Previous attempt rejected\n\n${
        ruling.violations.map((x) => `- ${x.field}: ${x.rule} — got ${x.got}; want ${x.want}`).join('\n')
      }\n\nRe-emit the complete corrected JSON object.\n`
      continue
    }
    return refuse([v('arbiter', 'arbiter-malformed', ruling.violations[0]?.got ?? '',
      'a JSON object with choice and reason naming one listed option'), ...ruling.violations])
  }
}

// The block minus every act the arbiter may never take: anything but a decision (which
// removes `witness abandon` — the CLI never discards work, D168), any trust grant (D154),
// any command whose id the CLI could not resolve (the arbiter fills a note, never an id),
// and every approve over a failed deterministic check — it may overrule a reviewer, never a
// check. `amendment-ack` alone is the exception: approving IS its acknowledgement.
// The design gate is the exception that holds whatever the evidence says: the look is the
// human's (§3 G2), so no approve of it is ever offered — at the bound or past a spent ladder
// the arbiter may revise, reset upstream, repair or park, never stamp.
// Row 239. Read off each option's act, never its printed line: an option the CLI built from no
// act is not offered, a word is a flag only where the act holds it as one, and the one input the
// arbiter may fill is the `<why>` slot (settle fills it through argv).
// Row 244 (design §4.2.6, §4.2.7; P38). The arbiter never revises a gate a revise already stands on:
// in the states where a plain revise is the human's alone (`REVISE_HUMAN`) every plain revise goes,
// the noted one included, while the send-upstream stays. A handed-back revise (`revise-returned`) is
// the one such state a settle brings to the arbiter, and there it matters twice over: hand-backs spend
// no rounds, so the bound would never stop a revise → hand-back loop.
export function menuFor(block: Decision, run: GateRunEntry): Array<Option & { act: Act }> {
  const failed = run.checks.filter((c) => !c.ok)
  // Row 264: nor over a checks-only round, which no lens judged.
  const approveBarred = run.gate === 'design' || run.checks_only === true ||
    (failed.length > 0 && !failed.every((c) => c.name === 'amendment-ack'))
  const reviseBarred = block.state !== undefined && REVISE_HUMAN.has(block.state)
  const plainRevise = (argv: readonly string[]) => argv.includes('--revise') && !argv.includes('--upstream') && !argv.includes('--repair')
  // Row 270 (row 172). A booking of a check whose waiver is the human's (or that has none) is never
  // the arbiter's; T3's judge-waived checks are the ones it may take.
  const humanBook = (argv: readonly string[]) => {
    const at = argv.indexOf('--book')
    const waiver = at >= 0 ? checkWaiver(argv[at + 1] ?? '') : undefined
    return at >= 0 && (waiver === undefined || waiver === 'human')
  }
  return block.options.filter((o): o is Option & { act: Act } =>
    o.act?.argv[0] === 'decide' &&
    !o.act.argv.includes('--trust-cmds') &&
    !humanBook(o.act.argv) &&
    o.act.inputs.every((i) => i.name === 'why') &&
    !(approveBarred && o.act.argv.includes('--approve')) &&
    !(reviseBarred && plainRevise(o.act.argv)))
}

// Row 244 (design §4.2.6). A hand-back as the arbiter hears it: a journal fact in this fixed sentence,
// never a word the author wrote (anti-goal 1) — the entry carries none, and no field of it is read.
export const HANDED_BACK_FACT = 'the author handed this revise back with the content unchanged'

const anchorText = (a: string | { scope: string }) => (typeof a === 'string' ? a : `omission:${a.scope}`)
const HISTORY_RUNS = 10

// Row 266 (§3.9). A lint part as the arbiter reads it: its state, the counts and the rule ids — never
// its `why`, which can carry a refusal's `got` (T2c slice 3 M7).
function partFact(p: PartVerdict): string {
  const name = visible(p.part)
  switch (p.state) {
    case 'green': return `${name} green`
    case 'base-only': return `${name} red on the base too, nothing new (${p.base ?? 0} there)`
    case 'new': {
      const rules = (p.rules ?? []).map(visible)
      return `${name} ${p.new ?? 0} new beside the base's ${p.base ?? 0}${rules.length > 0 ? `, rules ${rules.join(', ')}` : ''}`
    }
    case 'red': return `${name} red, the base green`
    case 'pending': return `${name} red, the base's result pending`
    case 'not-measured': return `${name} red, the base not measured`
    case 'not-judged': return `${name} red on the base too, not judged`
    case 'untrusted': return `${name} not run, its command not trusted`
    // Row 270: what the human's booking covers, as a count — never the items or the keys.
    case 'booked': return p.booked === undefined
      ? `${name} booked whole by the human`
      : `${name} booked by the human (${p.booked} diagnostic${p.booked === 1 ? '' : 's'})`
  }
}

// Row 274 (§3.9). The switch-off lines as the arbiter reads them: the unbooked ones grouped by token,
// how many rule ids they name and place (a test file or code), with their copies past one; then how many
// copies the plan's bookings cover. Never a file, a line number or a line's text — nor a rule id's name,
// which the author typed into the comment (push security review; slice 2 review M5): the reviewers read
// the line itself, the judge the facts.
// Row 276: a spec's lost tests read as its canon id spelled out and counts — never a test name or output.
function offFacts(offs: readonly OffVerdict[]): string[] {
  const groups = new Map<string, number>()
  const losses: string[] = []
  for (const o of offs) {
    const n = offUnbooked(o)
    if (n === 0) continue
    if (o.kind === 'dropped') {
      losses.push(`tests of ${visible(o.spec)}: ${n} passing case${n === 1 ? '' : 's'} lost (skipped ${o.base.skipped}→${o.plan.skipped})`)
      continue
    }
    const rules = o.rules?.length ?? 0
    const label = `${visible(o.token)}${rules > 0 ? ` (${rules} rule${rules === 1 ? '' : 's'})` : ''} ${o.test === true ? 'in a test file' : 'in code'}`
    groups.set(label, (groups.get(label) ?? 0) + n)
  }
  const booked = offs.reduce((a, o) => a + Math.min(o.count, o.booked ?? 0), 0)
  return [...[...groups].map(([label, n]) => `${label}${n > 1 ? ` ×${n}` : ''}`), ...losses, ...(booked > 0 ? [`${booked} booked`] : [])]
}

// Row 266 (§3.9). A check as the arbiter reads it: CLI-structured facts only — its name and verdict,
// each lint part's state with its counts and rule ids, how many commands trust kept from running, and
// the held criteria's ids. Never `detail` (tool output on some checks, foreign paths on others), never
// a part's `why`, never a command. Foreign names (parts, rule ids, criterion ids) are spelled out.
export function checkFacts(c: GateCheck): string {
  const n = c.untrusted?.length ?? 0
  const facts = [
    ...(c.parts ?? []).map(partFact),
    ...offFacts(c.offs ?? []),
    // Row 276: a round whose tests effect was not checked says so, never why (the why may name paths).
    ...(c.tests_effect?.read === 'not-checked' ? ['tests not checked'] : []),
    ...(n > 0 ? [`${n} command${n === 1 ? '' : 's'} not trusted`] : []),
    ...((c.held ?? []).length > 0 ? [`held: ${(c.held ?? []).map((h) => visible(String(h.criterion))).join(', ')}`] : []),
  ]
  return [`${visible(c.name)}: ${c.ok ? 'ok' : 'FAILED'}`, ...facts].join(' · ')
}

// The evidence the arbiter reads, composed by the CLI from the journal and canon. It never
// carries a session transcript: none exists to carry, and the author's narration is
// exactly what the arbiter must not hear (anti-goal 1). A hand-back reaches it as a fact the CLI
// states (`HANDED_BACK_FACT`), never as the author's account of why.
export function decisionEvidence(
  root: string, canon: Canon,
  stop: { gate: string; target: string; entries: Entry[]; run: GateRunEntry; block: Decision },
): Array<ArbiterSection> {
  const { gate, target, entries, run, block } = stop
  const findings = (run.verdicts ?? []).flatMap((rv) => rv.findings.map((f) => ({ reviewer: rv.reviewer, f })))
  const sections: ArbiterSection[] = [
    {
      title: 'The stop',
      body: [
        `gate: ${gate} · target: ${target}`,
        `round: ${run.round} of ${roundBudget(entries, gate)}${run.checks_only === true ? ' · checks only — no lens ran' : ''}`,
        `rule: ${block.rule}`,
        `standing: ${run.standing ?? 'none'}`,
        // Row 266: no reviewer answered a checks-only round.
        run.checks_only === true
          ? `model: no reviewer was asked · pinned ${run.pin ?? run.model}`
          : `model: reviewers answered on ${run.model} · pinned ${run.pin ?? run.model}`,
      ].join('\n'),
    },
    {
      title: 'Checks',
      body: run.checks.length === 0 ? 'none' : run.checks.map((c) => `- ${checkFacts(c)}`).join('\n'),
    },
    {
      title: 'Findings',
      body: findings.length === 0 ? 'none'
        : findings.map(({ reviewer, f }) => `- [${reviewer} · ${f.blocking ? 'blocking' : 'non-blocking'}] ${anchorText(f.anchor)} — ${f.claim}${
          f.contradicts_pin !== undefined ? ` · contradicts pin #${f.contradicts_pin}` : ''}`).join('\n'),
    },
  ]

  const history: string[] = []
  const runs = gateRuns(entries, gate).slice(-HISTORY_RUNS)
  for (const r of runs) {
    const blocks = [...new Set((r.verdicts ?? []).flatMap((rv) => rv.findings.filter((f) => f.blocking).map((f) => anchorText(f.anchor))))]
    // Row 266: a checks-only round names the check that withheld its review where a round names its outcome.
    const outcome = r.checks_only === true ? `checks only — ${visible(r.checks.at(-1)?.name ?? 'a check')}` : r.outcome
    history.push(`- round ${r.round} · @${r.reviewed_sha.slice(0, 7)} · ${outcome}${blocks.length ? ` · blocking: ${blocks.join(' · ')}` : ''}`)
    const at = entries.indexOf(r as unknown as Entry)
    for (const e of entries.slice(at + 1)) {
      if (e.t === 'gate-run' && (e as unknown as GateRunEntry).gate === gate) break
      // Row 244 (design §4.2.6). The hand-back in its place among the gate's decisions, after the revise it answers.
      if (e.t === 'revise-returned' && (e as unknown as ReviseReturnedEntry).gate === gate) {
        history.push(`  - handed back · ${HANDED_BACK_FACT}`)
        continue
      }
      if (e.t !== 'human-decision' || (e as unknown as DecisionEntry).gate !== gate) continue
      const d = e as unknown as DecisionEntry
      history.push(`  - ${d.decision} · ${decidedBy(d)}${d.rule ? ` · ${d.rule}` : ''}${d.note ? ` · ${d.note}` : ''}`)
    }
  }
  const current = [...new Set(findings.filter(({ f }) => f.blocking).map(({ f }) => anchorText(f.anchor)))]
  for (const a of current) history.push(`- recurrence: ${a} · found in ${anchorRecurrence(entries, gate, a)} round(s) of this budget`)
  for (const d of openDeferrals(entries)) history.push(`- open obligation ${d.id} · ${d.anchor} · ${d.kind}`)
  for (const p of policyPins(entries)) history.push(`- pin #${p.ordinal}: ${p.text}`)
  sections.push({ title: 'Round history', body: history.length === 0 ? 'none' : history.join('\n') })

  if (gate === 'ship' || gate === 'decompose') {
    const effort = gate === 'decompose' ? target : effortOf(root, target)
    const recap = effort !== undefined ? latestRecap(root, effort) : undefined
    const scope: string[] = [`### The effort's recap\n\n${recap ? canonicalJson(recap) : 'none recorded'}`]
    if (gate === 'ship') {
      const plan = findById(canon, target)
      const parent = plan ? findById(canon, String(plan.meta.parent)) : undefined
      if (parent) scope.push(`### The spec: ${String(parent.meta.id)}\n\n${serializeDoc({ meta: parent.meta, body: parent.body })}`)
      if (plan) scope.push(`### The plan: ${target}\n\n${serializeDoc({ meta: plan.meta, body: plan.body })}`)
    } else {
      // Row 221. What the decompose gate judged: the effort's specs and the principles it wrote.
      for (const s of effortCanon(root, canon, target)) {
        const kind = s.meta.type === 'principles' ? 'The principles (standing rules, not a slice)' : 'The spec'
        scope.push(`### ${kind}: ${String(s.meta.id)}\n\n${serializeDoc({ meta: s.meta, body: s.body })}`)
      }
    }
    sections.push({ title: 'Scope', body: scope.join('\n\n') })
    // Row 177. A decompose stop is judged against the ask as well as the recap: both of its
    // arbiter routes (the feature-scope stop and amendment-ack) re-scope what the human asked.
    const ask = gate === 'decompose' ? askOf(root, target) : undefined
    if (ask !== undefined) sections.push({ title: 'The ask', body: `${ask.id} — ${askText(ask.text)}` })
  }
  return sections
}
