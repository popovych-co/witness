import { join } from 'node:path'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { designUnseen } from '../design.js'
import '../gates/index.js'
import { gateSpec, liveExits, renderGateRun } from '../gate.js'
import { newDeferralId, type DeferralKind } from '../deferral.js'
import { recommend, renderDecision } from '../recommend.js'
import { writeDoc } from '../fm.js'
import { acquireLock } from '../lock.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'
import { appendEntry, entryLine, journalRel, policyPins, readStream, streamExists, type Entry } from '../journal.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { effortOf } from '../reviewed.js'
import { findById, loadCanon } from '../scan.js'
import { newRunId } from '../drift.js'
import { renderRefusal, v } from '../refusal.js'
import { short } from '../sha.js'
import { cmd, kv, rows } from '../toon.js'
import {
  ROUND_BOUND, anchorRecurrence, boundReached, lastGateRun, openReopen, pendingDecision, repairGranted,
  roundsSinceApprove, type DecisionEntry,
} from '../rounds.js'
import { prepareStamp, writeStamp } from '../stamp.js'

const asEntry = (e: DecisionEntry) => e as unknown as { t: 'human-decision'; [k: string]: unknown }

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function flagValues(argv: string[], flag: string): string[] {
  return argv.flatMap((a, i) => (a === flag && argv[i + 1] !== undefined ? [argv[i + 1]!] : []))
}

// Row 108. The bound is the designed terminus, not a malfunction, and renderRefusal
// appends `help: fix each row and re-run — rows are structured for self-repair`, which is
// false here twice over: there is no row to fix, and re-running is exactly what the bound
// forbids (gate.ts short-circuits before invoking). The old code knew — it packed the
// exits list into a violation row's `want` column — so the human at the terminus was
// handed a violations table instructing them to self-repair. This prints `--show`'s
// surface instead: state, then the exits that actually work. The exit code is unchanged;
// the decision the human asked for still did not happen.
function renderBound(
  ctx: Ctx, gate: string, target: string, entries: Entry[], stale: boolean,
  upstream: string | undefined, note?: string,
): number {
  ctx.err(kv('gate', gate))
  ctx.err(kv('target', target))
  ctx.err(kv('state', `bound reached — ${roundsSinceApprove(entries, gate)} rounds; the gate will not run again`))
  if (note !== undefined) ctx.err(kv('note', note))
  // D121. The endgame is exactly where a bare list of legal flags is least useful: every
  // remaining act carries a cost, and which cost is worth paying is the whole question.
  const d = recommend({ gate, target, entries, upstream, stale })
  if (d) renderDecision(d).forEach((l) => ctx.err(l))
  else ctx.err(cmd('exits', liveExits(gate, target, entries, stale, upstream)))
  return EXIT.REFUSED
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--note' && argv[i - 1] !== '--upstream' && argv[i - 1] !== '--pin')
  const [gate, target] = positional
  const spec = gate ? gateSpec(gate) : undefined
  if (!gate || !target || !spec) {
    ctx.err('usage: witness decide <gate> <target> --approve|--revise|--stop [--override] [--repair] [--note <t>] [--upstream <artifact|effort>] [--pin <policy>]… [--show]')
    return EXIT.REFUSED
  }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const entries = readStream(root, target)
  const last = lastGateRun(entries, gate)
  const pending = pendingDecision(entries, gate)

  // Hoisted above `--show` (D94): both the anchor rule below and `--show`'s staleness
  // line need `spec.currentSha`, which takes canon and config. A decision verb that
  // cannot read the config cannot honestly report state either, so refusing here — and
  // for `--show` too — is the correct order rather than a regression.
  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const canon = loadCanon(root)
  const upstreamId = spec.upstreamOf?.(root, canon, target)

  if (argv.includes('--show')) {
    if (!last) { ctx.out(kv('decide', `no gate-runs for ${gate} ${target}`)); return EXIT.OK }
    const reopen = openReopen(entries, gate)
    const decisionsAfter = entries
      .slice(entries.lastIndexOf(last as unknown as Entry) + 1)
      .filter((e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === gate)
      .map((e) => e as unknown as DecisionEntry)
    // A caused_by decision is a REOPEN, not a disposition — it can never settle the run
    // above it, and pairing the two is what presented 15 settled findings as current.
    // The LAST disposition is the state (D94): `find` returned the first, so a
    // revise→approve reported `decision: revise` on a gate that is settled.
    const disposition = decisionsAfter.filter((d) => d.caused_by === undefined).at(-1)
    // Staleness is a fact about content, not about being reopened. Hardcoding it printed
    // `witness gate …` in the one state where the gate answers changed-nothing. An
    // uncomputable sha is NOT staleness — same doctrine as the approve-time check.
    const shownSha = spec.currentSha?.(root, canon, cfgR.value, target)
    const stale = shownSha !== undefined && shownSha !== last.reviewed_sha

    if (reopen) {
      ctx.out(kv('gate', gate))
      ctx.out(kv('target', target))
      ctx.out(kv('state', 'reopened — the gate must run again'))
      ctx.out(kv('reopened-by', `${reopen.caused_by!.gate} ${reopen.caused_by!.artifact} (round ${reopen.caused_by!.round})`))
      if (reopen.note) ctx.out(kv('note', reopen.note))
      ctx.out(kv('last-run', `round ${last.round} @${short(last.reviewed_sha)} — ${last.outcome}${disposition ? `, ${disposition.decision}` : ''} · witness log ${target}`))
      ctx.out(cmd('exits', liveExits(gate, target, entries, stale, upstreamId)))
      return EXIT.OK
    }
    if (disposition && disposition.decision !== 'revise' && disposition.decision !== 'revise-upstream') {
      ctx.out(kv('gate', gate))
      ctx.out(kv('target', target))
      ctx.out(kv('state', `settled — ${disposition.decision}`))
      if (disposition.note) ctx.out(kv('note', disposition.note))
      ctx.out(kv('last-run', `round ${last.round} @${short(last.reviewed_sha)} — ${last.outcome} · witness log ${target}`))
      // no exits: the gate is genuinely terminal here. Point at the one verb that owns
      // what comes next rather than re-deriving routing in a second place (D101).
      ctx.out('help: witness next')
      return EXIT.OK
    }
    // pending (no disposition) or revise (the author's input): the verdict is actionable
    renderGateRun(ctx, last, 'ran', { entries, help: false, upstream: upstreamId })
    const shownPins = policyPins(entries)
    if (shownPins.length > 0) ctx.out(rows('pins', ['ordinal', 'text'], shownPins as unknown as Array<Record<string, unknown>>).join('\n'))
    if (disposition) {
      ctx.out(kv('decision', disposition.decision))
      if (disposition.note) ctx.out(kv('note', disposition.note))
    }
    // The surface a human actually reads while deciding, so it is the one that most owes a
    // ranking rather than a menu. `undefined` is stale with no decision pending, where no
    // act but the re-gate is legal and the exits line already says exactly that (D131).
    const shown = recommend({ gate, target, entries, upstream: upstreamId, stale })
    if (shown) renderDecision(shown).forEach((l) => ctx.out(l))
    else ctx.out(cmd('exits', liveExits(gate, target, entries, stale, upstreamId)))
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
  const repair = argv.includes('--repair')
  const upstream = flagValue(argv, '--upstream')
  const pinTexts = flagValues(argv, '--pin')
  if (pinTexts.length > 0 && gate !== 'implement') {
    renderRefusal([v('pin', 'pin-scope', gate, 'policy pins are implement-gate decisions on a plan')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const badPin = pinTexts.find((t) => t.trim() === '' || t.length > 500)
  if (badPin !== undefined) {
    renderRefusal([v('pin', 'pin-empty', badPin === '' ? '(empty)' : `${badPin.length} chars`,
      'non-empty policy text ≤500 chars')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const atBound = boundReached(entries, gate)

  // Row 109. The grant is a REVISE — the human is sending the artifact back, they are just
  // paying for the round that verifies the fix. Refusing the other spellings is not
  // pedantry: `--approve --repair` reads as "approve and let it re-run", which is not a
  // state this machine has, and silently ignoring the flag would journal an approve the
  // human believed was something else.
  if (repair && decision !== 'revise') {
    renderRefusal([v('repair', 'repair-scope', `--${decision}`,
      'witness decide … --revise --repair — a repair grant sends the artifact back for one verified round')])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  if (repair && !atBound) {
    renderRefusal([v('repair', 'repair-not-at-bound',
      `${roundsSinceApprove(entries, gate)} of ${ROUND_BOUND} rounds spent`,
      `the round bound — below it a plain revise already re-gates: witness decide ${gate} ${target} --revise --note "<why>"`)])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  if (repair && repairGranted(entries, gate)) {
    renderRefusal([v('repair', 'repair-spent', 'one repair round was already granted in this budget window',
      liveExits(gate, target, entries, false, upstreamId))]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  // at the bound the gate refuses to run again, so no fresh pending decision can
  // ever exist — the endgame decisions must stay reachable anchored to the last
  // run, or the target livelocks (incident c2692b93)
  const boundEndgame = atBound && (decision === 'stop' || (decision === 'approve' && override) ||
    (decision === 'revise' && (upstream !== undefined || repair)))

  // D94: a revise is the author's INPUT, not a disposition — it leaves the run
  // undisposed, and with the content unchanged `gate` answers `changed-nothing` and
  // appends nothing, so a pending decision can never reappear. Every exit the human is
  // shown then refuses, and the only escape found in the field was an edit they did not
  // need. The verdict still describes current content, so approving it is a true
  // statement about bytes a battery read.
  //
  // `undefined` means the sha CANNOT be computed (no worktree, missing parent) and must
  // never read as "moved" — the same doctrine the approve-time staleness check states
  // below. That check still runs and still refuses a genuinely stale approve.
  const afterLast = last
    ? entries.slice(entries.lastIndexOf(last as unknown as Entry) + 1)
        .filter((e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === gate)
        .map((e) => e as unknown as DecisionEntry)
    : []
  const onlyRevises = afterLast.length > 0 &&
    afterLast.every((d) => d.decision === 'revise' || d.decision === 'revise-upstream')
  const nowSha = last !== undefined ? spec.currentSha?.(root, canon, cfgR.value, target) : undefined
  const unchanged = last !== undefined && (nowSha === undefined || nowSha === last.reviewed_sha)
  const revisedAnchor = onlyRevises && unchanged && (decision === 'approve' || decision === 'stop')

  const anchor = pending ?? ((boundEndgame || revisedAnchor) ? last : undefined)
  if (!anchor) {
    if (atBound && last) {
      // liveExits, not a hardcoded triple: it drops --approve --override when content
      // moved, which is the same set the stale-verdict refusal below names. A human
      // cannot honestly stamp bytes no battery read, at the bound or anywhere else.
      return renderBound(ctx, gate, target, entries, nowSha !== undefined && nowSha !== last.reviewed_sha, upstreamId)
    }
    renderRefusal([v('gate', 'nothing-pending', `${gate} ${target}`,
      `a stopped gate-run awaiting a decision — run: witness gate ${gate} ${target}`)])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const blockedCode = guardTxn(ctx, root)
  if (blockedCode !== undefined) return blockedCode

  if (decision === 'revise' && atBound && upstream === undefined && !repair) {
    return renderBound(ctx, gate, target, entries,
      last !== undefined && nowSha !== undefined && nowSha !== last.reviewed_sha, upstreamId,
      'upstream reopens the parent and resets the budget; --repair buys one more round here')
  }

  // Row 111. Every reason an approve cannot happen, in ONE refusal. These used to fire
  // sequentially: `--approve` reported `override-required`, and only the re-run carrying
  // `--override` reported the `stale-verdict` that was the actual blocker — the operator
  // learned the real state one refusal later than the tool knew it, and at the bound that
  // costs a round of thinking on an exit that was never available.
  if (decision === 'approve') {
    const blockers = []
    if (atBound && !override) {
      blockers.push(v('decision', 'override-required', 'approve at the round bound',
        'witness decide … --approve --override'))
    }
    // A standing stop is only human judgment if the human was shown the thing. The gate
    // refuses the same way, but the gate does not run at the round bound (gate.ts:176) —
    // and approve is the act that stamps, so the line has to hold here too. Sha-keyed:
    // re-authoring invalidates prior sight, as re-capturing invalidates a witnessed
    // screenshot (D71). Only approve — revise and stop need no sight to be honest.
    if (gate === 'design') {
      const unseen = designUnseen(root, cfgR.value.paths, target)
      if (unseen !== undefined) {
        blockers.push(v('design', 'design-unseen', `no sight witnessed for ${short(unseen)}`,
          `a human shown this artifact — run: witness design ${target} --open`))
      }
    }
    // A `human-decision` entry is a RECORD — honest about the sha it judged whatever the
    // tree does afterward, which is why D76 declined a write-time staleness check. A stamp
    // is an ASSERTION about current content (`status: approved`, `design: {sha}`), and D75
    // puts staleness checks at consumption. approveMeta reads the artifact from disk and
    // never consults the run, so approving after a re-author blessed unreviewed bytes.
    // `currentSha` is undefined when it cannot be computed (no worktree, missing parent):
    // approve then proceeds, and the entry still honestly records what it judged — this
    // check must never convert an unrelated condition into a misleading refusal.
    const now = spec.currentSha?.(root, canon, cfgR.value, target)
    if (now !== undefined && now !== anchor.reviewed_sha) {
      // At the bound the gate will not re-run (gate.ts:176), so "go re-gate" would be
      // the lie D67 was written about. `liveExits` names the ones that actually work —
      // including the repair grant while it is unspent, which is the exit an operator who
      // just fixed the finding is looking for.
      blockers.push(v('gate', 'stale-verdict',
        `verdict @${short(anchor.reviewed_sha)}, content @${short(now)}`,
        atBound
          ? `${liveExits(gate, target, entries, true, upstreamId)} (bound reached — the gate will not re-run as it stands)`
          : `a verdict describing current content — run: witness gate ${gate} ${target}`))
    }
    if (blockers.length > 0) {
      renderRefusal(blockers).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
  }

  // D121. Recorded, never consumed: divergence between what the block recommended and what
  // the human chose is the only feedback loop the recommender has, and without the record it
  // is transcript archaeology. `recommended` is the VERB of option 1 — the shape of
  // `decision` — so the two are directly comparable in a log query. The full command would
  // carry a prefilled note that changes with the findings, which would make two identical
  // recommendations look different.
  const rec = recommend({
    gate, target, entries, upstream: upstreamId,
    // The truth, not `false`. The hardcode existed because a stale state produced no rule at
    // all and the entry's fields would have been empty; with the stale rule in place it only
    // misattributes — D130's audit was reporting rules that were never rendered.
    stale: nowSha !== undefined && nowSha !== anchor.reviewed_sha,
  })
  const recommendedVerb = rec?.options[0]?.command.match(/--(approve|revise|stop)/)?.[1]
  const entry: DecisionEntry = {
    v: 1, t: 'human-decision', gate, artifact: target, round: anchor.round,
    decision: decision === 'revise' && upstream ? 'revise-upstream' : decision,
    ...(override ? { override: true } : {}),
    ...(repair ? { repair: true as const } : {}),
    ...(note ? { note } : {}),
    ...(recommendedVerb ? { recommended: recommendedVerb } : {}),
    ...(rec?.rule ? { rule: rec.rule } : {}),
    ...(rec?.anchor ? { anchor: rec.anchor } : {}),
  }
  // D122. A deferral is `--approve --override` (ships with the cause alive) or
  // `--revise --repair` (buys a round without answering anything). One obligation per
  // blocking anchor on the run being disposed of, pointing at the run rather than copying
  // its findings — those already have a home. Kind is `lens-suspicion` when every
  // occurrence of the anchor came from ONE lens across genuinely changed content: that
  // pattern is a tool problem, and filing it as an artifact debt sends the human to fix
  // code that was never wrong.
  const deferring = (decision === 'approve' && override) || repair
  const deferralEntries = deferring
    ? [...new Set((anchor.verdicts ?? []).flatMap((rv) => rv.findings.filter((f) => f.blocking)
        .map((f) => (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`))))]
        .map((a) => {
          const lenses = new Set((anchor.verdicts ?? [])
            .filter((rv) => rv.findings.some((f) => f.blocking &&
              (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`) === a))
            .map((rv) => rv.reviewer))
          // The battery SIZE is part of the discriminator, not just the reporting count:
          // plan, decompose and design each run exactly one lens, so `lenses.size === 1`
          // is trivially true there and every recurring finding at those gates would be
          // filed as a tool problem. The signal is one lens out of SEVERAL disagreeing.
          const battery = (anchor.verdicts ?? []).length
          return {
            v: 1 as const, t: 'deferral' as const, id: newDeferralId(), artifact: target,
            gate, round: anchor.round, anchor: a,
            kind: (lenses.size === 1 && battery > 1 && anchorRecurrence(entries, gate, a) >= 2
              ? 'lens-suspicion' : 'artifact-debt') as DeferralKind,
            caused_by_run: anchor.run_id,
          }
        })
    : []
  const priorPins = entries.filter((e) => e.t === 'policy-pin').length
  const pinEntries = pinTexts.map((text, i) => ({
    v: 1 as const, t: 'policy-pin' as const, artifact: target, gate, round: anchor.round,
    ordinal: priorPins + i + 1, text: text.trim(),
  }))
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
    } else if (upDoc.meta.type === 'plan') {
      entry.upstream = { artifact: upstream, gate: 'plan' }
      reopen = {
        stream: upstream,
        entry: {
          v: 1, t: 'human-decision', gate: 'plan', artifact: upstream, round: anchor.round,
          decision: 'revise', caused_by: { artifact: target, gate, round: anchor.round },
          ...(note ? { note } : {}),
        },
      }
    } else {
      // Row 95: decompose gates are keyed on EFFORTS — `computeNext` asks
      // `openReopen(effortEntries, 'decompose')` and nothing anywhere reads a spec's stream
      // for one — so a decompose reopen written on the spec was unreachable by construction.
      // Resolve the owner, exactly as the design gate's branch above already does.
      const owner = effortOf(root, upstream)
      if (owner === undefined) {
        renderRefusal([v('upstream', 'unknown-owner', upstream,
          'a spec some effort wrote — the decompose reopen is booked on the effort stream')])
          .forEach((l) => ctx.err(l))
        return EXIT.REFUSED
      }
      entry.upstream = { artifact: owner, gate: 'decompose' }
      reopen = {
        stream: owner,
        entry: {
          v: 1, t: 'human-decision', gate: 'decompose', artifact: owner, round: anchor.round,
          decision: 'revise', caused_by: { artifact: target, gate, round: anchor.round },
          ...(note ? { note } : {}),
        },
      }
    }
  }

  journalMulti[0]!.line = entryLine(asEntry(entry))
  for (const p of pinEntries) journalMulti.push({ stream: target, line: entryLine(p) })
  for (const d of deferralEntries) journalMulti.push({ stream: target, line: entryLine(d) })
  if (reopen) { journalMulti.push({ stream: reopen.stream, line: entryLine(asEntry(reopen.entry)) }); files.push(journalRel(reopen.stream)) }
  for (const s of prepared) { files.push(s.rel, journalRel(s.stream)); journalMulti.push({ stream: s.stream, line: s.line }) }
  for (const m of metaWrites) { files.push(m.rel, journalRel(m.stream)); journalMulti.push({ stream: m.stream, line: m.line }) }

  const lockR = acquireLock(root)
  if (!lockR.ok) { renderRefusal(lockR.violations).forEach((l) => ctx.err(l)); return EXIT.BLOCKED }
  try {
    const txn = withTxn(root, { op: `decide-${gate}`, files: [...new Set(files)], journalMulti }, () => {
      appendEntry(root, target, asEntry(entry))
      for (const p of pinEntries) appendEntry(root, target, p)
      for (const d of deferralEntries) appendEntry(root, target, d)
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
  for (const p of pinEntries) ctx.out(kv('pinned', `#${p.ordinal} ${p.text}`))
  for (const d of deferralEntries) {
    ctx.out(kv('obligation', `${d.id} — ${d.anchor} · ${d.kind} · open until a later ${gate} run no longer reports it, or witness dismiss ${target} --deferral ${d.id} --cause <superseded|lens-retired|judged-wrong> --note "<why>"`))
  }
  if (repair) {
    // What was bought, and that it does not come again — a grant the human forgets is
    // spent is a second walk into the same wall.
    ctx.out(kv('repair', `one extra round granted — round ${ROUND_BOUND + 1} of ${ROUND_BOUND + 1} is the last, and the grant does not refresh until an approve, a revise-upstream or a passed run`))
    ctx.out(`help: fix the finding, then re-run: witness gate ${gate} ${target}`)
  }
  if (entry.decision === 'revise' || entry.decision === 'revise-upstream') {
    ctx.out('revise-context: (reconstructed from the journal — survives session death)')
    renderGateRun(ctx, anchor, 'ran', { entries, help: false, upstream: upstreamId })
    const pins = policyPins(readStream(root, target))
    if (pins.length > 0) ctx.out(rows('pins', ['ordinal', 'text'], pins as unknown as Array<Record<string, unknown>>).join('\n'))
    if (note) ctx.out(kv('note', note))
    if (upstream !== undefined && entry.upstream && upstream !== entry.upstream.artifact) {
      ctx.out(kv('upstream', `${upstream} is owned by effort ${entry.upstream.artifact} — the decompose reopen is booked there`))
    }
    if (gate === 'decompose') ctx.out(`help: scope itself implicated → witness recap --amend ${target}`)
    else if (entry.upstream) ctx.out(`help: reopened ${entry.upstream.artifact} (${entry.upstream.gate} stage) — linked via caused_by`)
  }
  return EXIT.OK
}
