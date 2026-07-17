import { EXIT, type Ctx } from '../cli.js'
import '../gates/index.js'
import { gateSpec, renderGateRun } from '../gate.js'
import { acquireLock } from '../lock.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'
import { appendEntry, entryLine, journalRel, readStream } from '../journal.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { findById, loadCanon } from '../scan.js'
import { newRunId } from '../drift.js'
import { renderRefusal, v } from '../refusal.js'
import { kv } from '../toon.js'
import {
  boundReached, lastGateRun, pendingDecision, roundsSinceApprove, type DecisionEntry,
} from '../rounds.js'
import { prepareStamp, writeStamp } from '../stamp.js'

const asEntry = (e: DecisionEntry) => e as unknown as { t: 'human-decision'; [k: string]: unknown }

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--note' && argv[i - 1] !== '--upstream')
  const [gate, target] = positional
  const spec = gate ? gateSpec(gate) : undefined
  if (!gate || !target || !spec) {
    ctx.err('usage: specflow decide <gate> <target> --approve|--revise|--stop [--override] [--note <t>] [--upstream <artifact>] [--show]')
    return EXIT.REFUSED
  }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const entries = readStream(root, target)
  const last = lastGateRun(entries, gate)
  const pending = pendingDecision(entries, gate)

  if (argv.includes('--show')) {
    if (!last) { ctx.out(kv('decide', `no gate-runs for ${gate} ${target}`)); return EXIT.OK }
    renderGateRun(ctx, last, 'ran')
    const lastDecision = [...entries].reverse().find(
      (e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === gate,
    ) as unknown as DecisionEntry | undefined
    if (lastDecision) {
      ctx.out(kv('decision', lastDecision.decision))
      if (lastDecision.note) ctx.out(kv('note', lastDecision.note))
    }
    return EXIT.OK
  }

  const picked = (['--approve', '--revise', '--stop'] as const).filter((f) => argv.includes(f))
  if (picked.length !== 1) {
    renderRefusal([v('decision', 'one-of-required', picked.join(' ') || '(none)', '--approve | --revise | --stop')])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const decision = picked[0]!.slice(2) as 'approve' | 'revise' | 'stop'
  const note = flagValue(argv, '--note')
  const override = argv.includes('--override')
  const upstream = flagValue(argv, '--upstream')
  const atBound = boundReached(entries, gate)

  // at the bound the gate refuses to run again, so no fresh pending decision can
  // ever exist — the endgame decisions must stay reachable anchored to the last
  // run, or the target livelocks (incident c2692b93)
  const boundEndgame = atBound && (decision === 'stop' || (decision === 'approve' && override) ||
    (decision === 'revise' && upstream !== undefined))
  const anchor = pending ?? (boundEndgame ? last : undefined)
  if (!anchor) {
    // at the bound "run the gate" is a lie — it would only short-circuit back
    // here; name the decisions that actually work instead
    renderRefusal([atBound && last
      ? v('decision', 'bound', `${roundsSinceApprove(entries, gate)} rounds`,
          '--approve --override | --revise --upstream <id> | --stop (bound reached — the gate will not run again)')
      : v('gate', 'nothing-pending', `${gate} ${target}`,
          `a stopped gate-run awaiting a decision — run: specflow gate ${gate} ${target}`),
    ]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const blockedCode = guardTxn(ctx, root)
  if (blockedCode !== undefined) return blockedCode

  if (decision === 'revise' && atBound && upstream === undefined) {
    renderRefusal([v('decision', 'bound', `${roundsSinceApprove(entries, gate)} rounds`,
      '--approve --override | --revise --upstream <id> | --stop (bound reached — upstream reopens the parent and resets the budget)')])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  if (decision === 'approve' && atBound && !override) {
    renderRefusal([v('decision', 'override-required', 'approve at the round bound',
      'specflow decide … --approve --override')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  const canon = loadCanon(root)
  const entry: DecisionEntry = {
    v: 1, t: 'human-decision', gate, artifact: target, round: anchor.round,
    decision: decision === 'revise' && upstream ? 'revise-upstream' : decision,
    ...(override ? { override: true } : {}),
    ...(note ? { note } : {}),
  }
  const journalMulti = [{ stream: target, line: '' }]
  const files = [journalRel(target)]
  const stamps = decision === 'approve' ? (spec.approveStamps?.(root, canon, target) ?? []) : []
  const prepared = stamps.flatMap((s) => {
    const doc = findById(canon, s.artifact)
    return doc && String(doc.meta.status) !== s.to
      ? [prepareStamp(doc, s.to, 'gate-approve', { run_id: newRunId() })] : []
  })
  let reopen: { stream: string; entry: DecisionEntry } | undefined
  if (entry.decision === 'revise-upstream' && upstream) {
    const upDoc = findById(canon, upstream)
    if (gate === 'decompose') {
      // upstream from decompose is the scope itself — no second stream, hand off to recap --amend
      entry.upstream = { artifact: target, gate: 'recap' }
    } else if (!upDoc) {
      renderRefusal([v('upstream', 'unknown-artifact', upstream, 'a canon doc id')]).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    } else {
      const upGate = upDoc.meta.type === 'plan' ? 'plan' : 'decompose'
      entry.upstream = { artifact: upstream, gate: upGate }
      reopen = {
        stream: upstream,
        entry: {
          v: 1, t: 'human-decision', gate: upGate, artifact: upstream, round: anchor.round,
          decision: 'revise', caused_by: { artifact: target, gate, round: anchor.round },
          ...(note ? { note } : {}),
        },
      }
    }
  }

  journalMulti[0]!.line = entryLine(asEntry(entry))
  if (reopen) { journalMulti.push({ stream: reopen.stream, line: entryLine(asEntry(reopen.entry)) }); files.push(journalRel(reopen.stream)) }
  for (const s of prepared) { files.push(s.rel, journalRel(s.stream)); journalMulti.push({ stream: s.stream, line: s.line }) }

  const lockR = acquireLock(root)
  if (!lockR.ok) { renderRefusal(lockR.violations).forEach((l) => ctx.err(l)); return EXIT.BLOCKED }
  try {
    const txn = withTxn(root, { op: `decide-${gate}`, files: [...new Set(files)], journalMulti }, () => {
      appendEntry(root, target, asEntry(entry))
      if (reopen) appendEntry(root, reopen.stream, asEntry(reopen.entry))
      for (const s of prepared) writeStamp(root, s)
      crashPoint(ctx.env, 'decide-journal')
      return stateCommit(root, [...new Set(files)], `decide(${gate}): ${target} ${entry.decision}`)
    })
    if (!txn.ok) { renderRefusal(txn.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  } finally {
    lockR.value()
  }

  ctx.out(kv('decided', `${gate} ${target} → ${entry.decision}${override ? ' (override)' : ''}`))
  if (entry.decision === 'revise' || entry.decision === 'revise-upstream') {
    ctx.out('revise-context: (reconstructed from the journal — survives session death)')
    renderGateRun(ctx, anchor, 'ran')
    if (note) ctx.out(kv('note', note))
    if (gate === 'decompose') ctx.out(`help: scope itself implicated → specflow recap --amend ${target}`)
    else if (entry.upstream) ctx.out(`help: reopened ${entry.upstream.artifact} (${entry.upstream.gate} stage) — linked via caused_by`)
  }
  return EXIT.OK
}
