import { trustedCommands, untrustedCmdsFor } from './allowlist.js'
import { arbitrate, decisionEvidence, menuFor } from './arbiter.js'
import { keptStopLine, policyFor, type KeptStop } from './autonomy.js'
import { EXIT, type Ctx } from './cli.js'
import type { Config } from './config.js'
import { designUnseen } from './design.js'
import { liftedHolds } from './needs.js'
import { gateSpec } from './gate.js'
import { readStream } from './journal.js'
import { recommend, renderDecision } from './recommend.js'
import { renderRefusal } from './refusal.js'
import type { DecisionEntry, GateRunEntry } from './rounds.js'
import { criteriaOwner, loadCanon } from './scan.js'
import { cmd, kv } from './toon.js'
import { actOfCommand, applyDecision, type DecisionAct } from './verbs/decide.js'
import { owedDecisions, owedRun } from './verbs/next.js'
import { pendingTxn } from './txn.js'

// Row 173. Under `autonomy: on` a stop is settled where it is produced — the end of
// `witness gate`, and `next` for anything still owed — through the one door every human
// decision already takes (`applyDecision`). The coding agent never types a decision; the
// CLI acts on its own recommendation, or on the arbiter it launched, and journals which.

export type Settled =
  | { kind: 'none' }
  | { kind: 'decided'; by: 'policy' | 'arbiter'; decision: DecisionEntry['decision']; rule: string }
  | { kind: 'routed'; line: string }                                       // a re-run the CLI names and never executes
  | { kind: 'kept'; stop: KeptStop; line: string }
  | { kind: 'left'; why: string; code: number }

// The commands a failed check of `run` names that the repo STILL does not trust. A grant
// made since the stop moves a command out of this list, which is what turns the kept trust
// stop into a re-run (autonomy.ts arm 5). Under WITNESS_TRUST_CMDS=1 nothing is blocked.
export function stillUntrusted(root: string, env: Ctx['env'], run: GateRunEntry): string[] {
  if (env.WITNESS_TRUST_CMDS === '1') return []
  const trusted = new Set(trustedCommands(root))
  return [...new Set(run.checks.filter((c) => !c.ok).flatMap((c) => c.untrusted ?? []))].filter((c) => !trusted.has(c))
}

// The rule of the first row of a rendered refusal (`refused[N]{field,rule,got,want}:`).
function refusedRule(lines: readonly string[]): string | undefined {
  const at = lines.findIndex((l) => /^refused\[\d+\]\{/.test(l))
  return at >= 0 ? lines[at + 1]?.trim().split(',')[1] : undefined
}

const leftLine = (gate: string, target: string, why: string) =>
  cmd('autonomy', `left for a human — ${why} · witness decide ${gate} ${target} --show`)

export async function settleStop(ctx: Ctx, root: string, cfg: Config, gate: string, target: string): Promise<Settled> {
  const spec = gateSpec(gate)
  if (!spec) return { kind: 'none' }
  const entries = readStream(root, target)
  const owed = owedRun(entries, gate)
  // `--manual` keeps that run's stop for a human "for that run regardless" — including when
  // `next` meets it turns later (Review Focus 4).
  if (owed === undefined || owed.manual) return { kind: 'none' }

  const canon = loadCanon(root)
  const now = spec.currentSha?.(root, canon, cfg, target)
  const stale = (now !== undefined && now !== owed.reviewed_sha) || liftedHolds(criteriaOwner(canon, target), owed).length > 0
  const block = recommend({
    gate, target, entries, upstream: spec.upstreamOf?.(root, canon, target), stale,
    untrustedCmds: untrustedCmdsFor(root, criteriaOwner(canon, target)),
  })
  if (block === undefined) return { kind: 'none' }
  const untrusted = stillUntrusted(root, ctx.env, owed)
  const policy = policyFor({ at: 'gate', gate, target, entries, run: owed, block, untrusted })

  const settle = async (act: DecisionAct, by: 'policy' | 'arbiter'): Promise<Settled> => {
    // The refusal's rule is read off the rows the door printed, so the line that leaves the
    // stop can say WHY — the quiet ctx of `next` would otherwise swallow it.
    const errs: string[] = []
    const code = await applyDecision({ ...ctx, err: (l) => { errs.push(l); ctx.err(l) } }, act)
    if (code !== EXIT.OK) {
      const rule = refusedRule(errs)
      // An arbiter choice the door refuses would stay owed, and every `next` would pay for the
      // same model call to reach the same refusal (F4). It parks instead — once, reversibly,
      // as the policy's act — exactly as a second malformed answer does. A lock or a pending
      // transaction is transient (exit 3), so that stop is left to be tried again.
      if (by === 'arbiter' && code === EXIT.REFUSED) {
        return settle({
          gate, target, decision: 'stop', selected: 'policy', runId: owed.run_id,
          note: `parked by the policy — the arbiter's choice was refused (${rule ?? 'refused'})`,
        }, 'policy')
      }
      const why = `the ${by} decision was refused (${rule ?? `exit ${code}`})`
      ctx.out(leftLine(gate, target, why))
      return { kind: 'left', why, code }
    }
    return {
      kind: 'decided', by, rule: block.rule,
      decision: act.decision === 'revise' && act.upstream !== undefined ? 'revise-upstream' : act.decision,
    }
  }

  if (policy.kind === 'human') {
    // Row 178: an autonomous critic ran on a look nobody opened, so the human's first act is
    // to open it — `decide design --approve` refuses until they have.
    const unseen = policy.stop === 'design-look' && designUnseen(root, cfg.paths, target) !== undefined
    const detail = policy.stop === 'design-look'
      ? unseen
        ? `the human opens the look with witness design ${target} --open · then approves it or sends a note — witness decide design ${target} --show`
        : `the human approves the screen or sends a note — witness decide design ${target} --show`
      : `${untrusted.join(' · ')} — the human runs witness gate ${gate} ${target} in a terminal and answers each prompt`
    const line = keptStopLine(policy.stop, detail)
    renderDecision(block).forEach((l) => ctx.out(l))
    ctx.out(line)
    return { kind: 'kept', stop: policy.stop, line }
  }

  if (policy.kind === 'take') {
    const actR = actOfCommand(policy.command)
    if (!actR.ok) {
      // Not a decision: a re-run the CLI names and never executes — the stage owns it.
      const line = cmd('autonomy', `re-run owed — ${policy.command}`)
      ctx.out(line)
      return { kind: 'routed', line }
    }
    return settle({ ...actR.value, selected: 'policy', runId: owed.run_id }, 'policy')
  }

  ctx.out(cmd('arbiter', `judging ${gate} ${target} · ${block.rule}`))
  const menu = menuFor(block, owed)
  const ruling = await arbitrate(ctx, root, cfg, {
    mode: 'decision', menu,
    evidence: decisionEvidence(root, canon, { gate, target, entries, run: owed, block }),
  })
  if (!ruling.ok) {
    // Row 172 / §11 call 17: a second malformed answer parks the flow — reported, reversible,
    // and journaled as the policy's act so `next` never re-asks the arbiter about it.
    if (ruling.violations[0]?.rule === 'arbiter-malformed') {
      renderRefusal(ruling.violations).forEach((l) => ctx.err(l))
      return settle({
        gate, target, decision: 'stop', note: 'parked by the policy — the arbiter answered malformed twice',
        selected: 'policy', runId: owed.run_id,
      }, 'policy')
    }
    const rule = ruling.violations[0]?.rule ?? 'unknown'
    renderRefusal(ruling.violations).forEach((l) => ctx.err(l))
    renderDecision(block).forEach((l) => ctx.out(l))
    const why = `the arbiter could not be invoked (${rule})`
    ctx.out(leftLine(gate, target, why))
    return { kind: 'left', why, code: EXIT.REFUSED }
  }
  const chosen = menu[ruling.value.choice - 1]!
  const actR = actOfCommand(chosen.command)
  if (!actR.ok) {
    renderRefusal(actR.violations).forEach((l) => ctx.err(l))
    const why = 'the arbiter chose an option the CLI could not read'
    ctx.out(leftLine(gate, target, why))
    return { kind: 'left', why, code: EXIT.REFUSED }
  }
  // The one placeholder the arbiter may fill (A3): `<why>`, with its note or its reason. A
  // prefilled note stays as the CLI wrote it; the reason is journaled beside it either way.
  const note = actR.value.note === '<why>' ? (ruling.value.note ?? ruling.value.reason) : actR.value.note
  return settle({
    ...actR.value, ...(note !== undefined ? { note } : {}),
    selected: 'arbiter', reason: ruling.value.reason,
    arbiter: { model: ruling.value.model, prompts_sha: ruling.value.prompts_sha },
    runId: owed.run_id,
  }, 'arbiter')
}

// The gate's exit after its tail settled: an approve is a pass, any other decision leaves
// work owed, and a stop the CLI did not settle keeps the code the gate already had.
export function settledCode(code: number, s: Settled): number {
  if (s.kind === 'decided') return s.decision === 'approve' ? EXIT.OK : EXIT.FINDINGS
  if (s.kind === 'left') return s.code
  return code
}

export interface SettleReport { gate: string; target: string; settled: Settled }

// Row 173. `next` settles every decision the repo owes, in tier-2 order, before it routes —
// a decision left pending by a crash, or one that was waiting when autonomy was turned on,
// is resolved by the same policy the gate's tail applies. Read-only under CI (a runner
// must never spend a model call or journal a decision) and while a transaction is pending
// (recovery outranks everything). Each stop's own output is silenced: `next` prints one
// line per report, above its routing block.
export async function settleOwed(ctx: Ctx, root: string, cfg: Config): Promise<SettleReport[]> {
  if (ctx.env.CI) return []
  if (pendingTxn(root) !== undefined) return []
  const quiet: Ctx = { ...ctx, out: () => {}, err: () => {} }
  const out: SettleReport[] = []
  for (const o of owedDecisions(root, loadCanon(root))) {
    out.push({ gate: o.gate, target: o.target, settled: await settleStop(quiet, root, cfg, o.gate, o.target) })
  }
  return out
}

export function settledLine(r: SettleReport): string | undefined {
  const s = r.settled
  switch (s.kind) {
    case 'decided': return kv('decided', `${r.gate} ${r.target} → ${s.decision} · ${s.by} · ${s.rule}`)
    case 'routed': return s.line
    case 'kept': return s.line
    case 'left': return leftLine(r.gate, r.target, s.why)
    case 'none': return undefined
  }
}
