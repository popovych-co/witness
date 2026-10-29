import { askOf, askText } from './ask.js'
import type { Ctx } from './cli.js'
import { decidedBy } from './autonomy.js'
import { loadLocalConfig, type Config } from './config.js'
import { openDeferrals } from './deferral.js'
import { serializeDoc } from './fm.js'
import { resolveJudge } from './harness.js'
import { latestRecap, policyPins, type Entry } from './journal.js'
import { SESSION_DEFAULT, stageModel, unansweredPin } from './model.js'
import { PLACEHOLDER, type Decision, type Option } from './recommend.js'
import { ok, refuse, v, type Result, type Violation } from './refusal.js'
import { invokeReviewerAsync, parseVerdictText, promptsSha, resolvePrompt } from './reviewer.js'
import { effortOf, effortSpecs } from './reviewed.js'
import { anchorRecurrence, gateRuns, roundBudget, type DecisionEntry, type GateRunEntry } from './rounds.js'
import { findById, type Canon } from './scan.js'
import { canonicalJson } from './sha.js'

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
      cwd: root, prompt, model: model === SESSION_DEFAULT ? undefined : model, lens: 'arbiter',
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
// human's (§3 G2), so no approve of it is ever offered — at the bound, on a fallback round or
// past a spent ladder the arbiter may revise, reset upstream, repair or park, never stamp.
export function menuFor(block: Decision, run: GateRunEntry): Option[] {
  const failed = run.checks.filter((c) => !c.ok)
  const approveBarred = run.gate === 'design' || (failed.length > 0 && !failed.every((c) => c.name === 'amendment-ack'))
  return block.options.filter((o) =>
    o.command.startsWith('witness decide ') &&
    !/ --trust-cmds\b/.test(o.command) &&
    !PLACEHOLDER.test(o.command.replace(' --note "<why>"', '')) &&
    !(approveBarred && / --approve\b/.test(o.command)))
}

const anchorText = (a: string | { scope: string }) => (typeof a === 'string' ? a : `omission:${a.scope}`)
const HISTORY_RUNS = 10

// The evidence the arbiter reads, composed by the CLI from the journal and canon. It never
// carries a session transcript: none exists to carry, and the author's narration is
// exactly what the arbiter must not hear (anti-goal 1).
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
        `round: ${run.round} of ${roundBudget(entries, gate)}`,
        `rule: ${block.rule}`,
        `standing: ${run.standing ?? 'none'}`,
        `model: reviewers answered on ${run.model} · pinned ${run.pin ?? run.model}`,
      ].join('\n'),
    },
    {
      title: 'Checks',
      body: run.checks.length === 0 ? 'none'
        : run.checks.map((c) => `- ${c.name}: ${c.ok ? 'ok' : 'FAILED'}${c.detail ? ` — ${c.detail}` : ''}`).join('\n'),
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
    history.push(`- round ${r.round} · @${r.reviewed_sha.slice(0, 7)} · ${r.outcome}${blocks.length ? ` · blocking: ${blocks.join(' · ')}` : ''}`)
    const at = entries.indexOf(r as unknown as Entry)
    for (const e of entries.slice(at + 1)) {
      if (e.t === 'gate-run' && (e as unknown as GateRunEntry).gate === gate) break
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
      for (const s of effortSpecs(root, canon, target)) {
        scope.push(`### The spec: ${String(s.meta.id)}\n\n${serializeDoc({ meta: s.meta, body: s.body })}`)
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
