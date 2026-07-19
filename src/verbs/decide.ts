import { join } from 'node:path'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { designUnseen } from '../design.js'
import '../gates/index.js'
import { gateSpec, liveExits, renderGateRun } from '../gate.js'
import { writeDoc } from '../fm.js'
import { acquireLock } from '../lock.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'
import { appendEntry, entryLine, journalRel, readStream, streamExists, type Entry } from '../journal.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { findById, loadCanon } from '../scan.js'
import { newRunId } from '../drift.js'
import { renderRefusal, v } from '../refusal.js'
import { short } from '../sha.js'
import { kv } from '../toon.js'
import {
  boundReached, lastGateRun, openReopen, pendingDecision, roundsSinceApprove, type DecisionEntry,
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
    ctx.err('usage: specflow decide <gate> <target> --approve|--revise|--stop [--override] [--note <t>] [--upstream <artifact|effort>] [--show]')
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
    const reopen = openReopen(entries, gate)
    const decisionsAfter = entries
      .slice(entries.lastIndexOf(last as unknown as Entry) + 1)
      .filter((e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === gate)
      .map((e) => e as unknown as DecisionEntry)
    // A caused_by decision is a REOPEN, not a disposition — it can never settle the run
    // above it, and pairing the two is what presented 15 settled findings as current.
    const disposition = decisionsAfter.find((d) => d.caused_by === undefined)

    if (reopen) {
      ctx.out(kv('gate', gate))
      ctx.out(kv('target', target))
      ctx.out(kv('state', 'reopened — the gate must run again'))
      ctx.out(kv('reopened-by', `${reopen.caused_by!.gate} ${reopen.caused_by!.artifact} (round ${reopen.caused_by!.round})`))
      if (reopen.note) ctx.out(kv('note', reopen.note))
      ctx.out(kv('last-run', `round ${last.round} @${short(last.reviewed_sha)} — ${last.outcome}${disposition ? `, ${disposition.decision}` : ''} · specflow log ${target}`))
      ctx.out(kv('exits', liveExits(gate, target, entries, true)))
      return EXIT.OK
    }
    if (disposition && disposition.decision !== 'revise' && disposition.decision !== 'revise-upstream') {
      ctx.out(kv('gate', gate))
      ctx.out(kv('target', target))
      ctx.out(kv('state', `settled — ${disposition.decision}`))
      if (disposition.note) ctx.out(kv('note', disposition.note))
      ctx.out(kv('last-run', `round ${last.round} @${short(last.reviewed_sha)} — ${last.outcome} · specflow log ${target}`))
      return EXIT.OK
    }
    // pending (no disposition) or revise (the author's input): the verdict is actionable
    renderGateRun(ctx, last, 'ran')
    if (disposition) {
      ctx.out(kv('decision', disposition.decision))
      if (disposition.note) ctx.out(kv('note', disposition.note))
    }
    ctx.out(kv('exits', liveExits(gate, target, entries, false)))
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

  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }

  // A standing stop is only human judgment if the human was shown the thing. The gate
  // refuses the same way, but the gate does not run at the round bound (gate.ts:176) —
  // and approve is the act that stamps, so the line has to hold here too. Sha-keyed:
  // re-authoring invalidates prior sight, as re-capturing invalidates a witnessed
  // screenshot (D71). Only approve — revise and stop need no sight to be honest.
  if (gate === 'design' && decision === 'approve') {
    const unseen = designUnseen(root, cfgR.value.paths, target)
    if (unseen !== undefined) {
      renderRefusal([v('design', 'design-unseen', `no sight witnessed for ${short(unseen)}`,
        `a human shown this artifact — run: specflow design ${target} --open`)]).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
  }

  const canon = loadCanon(root)

  // A `human-decision` entry is a RECORD — honest about the sha it judged whatever the
  // tree does afterward, which is why D76 declined a write-time staleness check. A stamp
  // is an ASSERTION about current content (`status: approved`, `design: {sha}`), and D75
  // puts staleness checks at consumption. approveMeta reads the artifact from disk and
  // never consults the run, so approving after a re-author blessed unreviewed bytes.
  // `currentSha` is undefined when it cannot be computed (no worktree, missing parent):
  // approve then proceeds, and the entry still honestly records what it judged — this
  // check must never convert an unrelated condition into a misleading refusal.
  if (decision === 'approve') {
    const now = spec.currentSha?.(root, canon, cfgR.value, target)
    if (now !== undefined && now !== anchor.reviewed_sha) {
      // At the bound the gate will not re-run (gate.ts:176), so "go re-gate" would be
      // the lie D67 was written about. Name the exits that actually work: approve is
      // genuinely unavailable here — a human cannot honestly stamp bytes no gate read —
      // but --stop and --revise --upstream both remain, so nothing livelocks.
      renderRefusal([v('gate', 'stale-verdict',
        `verdict @${short(anchor.reviewed_sha)}, content @${short(now)}`,
        atBound
          ? `specflow decide ${gate} ${target} --revise --upstream <id> | --stop (bound reached — the gate will not re-run)`
          : `a verdict describing current content — run: specflow gate ${gate} ${target}`)])
        .forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
  }

  const entry: DecisionEntry = {
    v: 1, t: 'human-decision', gate, artifact: target, round: anchor.round,
    decision: decision === 'revise' && upstream ? 'revise-upstream' : decision,
    ...(override ? { override: true } : {}),
    ...(note ? { note } : {}),
  }
  const journalMulti = [{ stream: target, line: '' }]
  const files = [journalRel(target)]
  const stamps = decision === 'approve' ? (spec.approveStamps?.(root, canon, target) ?? []) : []
  const metaStamps = decision === 'approve' ? (spec.approveMeta?.(root, canon, cfgR.value, target) ?? []) : []
  const prepared = stamps.flatMap((s) => {
    const doc = findById(canon, s.artifact)
    return doc && String(doc.meta.status) !== s.to
      ? [prepareStamp(doc, s.to, 'gate-approve', { run_id: newRunId() })] : []
  })
  const metaWrites = metaStamps.map((m) => {
    const doc = findById(canon, m.artifact)!
    const mEntry = { v: 1 as const, t: m.entryType as 'design-stamp', artifact: m.artifact, ...m.patch, run_id: newRunId() }
    return {
      rel: doc.rel, meta: { ...doc.meta, ...m.patch }, body: doc.body, stream: m.artifact,
      entry: mEntry as unknown as { t: 'design-stamp'; [k: string]: unknown },
      line: entryLine(mEntry as unknown as { t: 'design-stamp'; [k: string]: unknown }),
    }
  })
  let reopen: { stream: string; entry: DecisionEntry } | undefined
  if (entry.decision === 'revise-upstream' && upstream) {
    const upDoc = findById(canon, upstream)
    if (gate === 'design') {
      // upstream from the design gate is the spec's SLICING — reopen the effort's
      // decompose (scope-level changes chain decompose → recap --amend, Decision 52)
      if (!streamExists(root, upstream)) {
        renderRefusal([v('upstream', 'unknown-effort', upstream, 'the effort slug whose decompose to reopen')]).forEach((l) => ctx.err(l))
        return EXIT.REFUSED
      }
      entry.upstream = { artifact: upstream, gate: 'decompose' }
      reopen = {
        stream: upstream,
        entry: {
          v: 1, t: 'human-decision', gate: 'decompose', artifact: upstream, round: anchor.round,
          decision: 'revise', caused_by: { artifact: target, gate, round: anchor.round },
          ...(note ? { note } : {}),
        },
      }
    } else if (gate === 'decompose') {
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
  for (const m of metaWrites) { files.push(m.rel, journalRel(m.stream)); journalMulti.push({ stream: m.stream, line: m.line }) }

  const lockR = acquireLock(root)
  if (!lockR.ok) { renderRefusal(lockR.violations).forEach((l) => ctx.err(l)); return EXIT.BLOCKED }
  try {
    const txn = withTxn(root, { op: `decide-${gate}`, files: [...new Set(files)], journalMulti }, () => {
      appendEntry(root, target, asEntry(entry))
      if (reopen) appendEntry(root, reopen.stream, asEntry(reopen.entry))
      for (const s of prepared) writeStamp(root, s)
      for (const m of metaWrites) {
        writeDoc(join(root, m.rel), { meta: m.meta, body: m.body })
        appendEntry(root, m.stream, m.entry)
      }
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
