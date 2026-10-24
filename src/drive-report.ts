import { basename } from 'node:path'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import type { Aside } from './drive.js'
import { TARGETLESS } from './drive-presence.js'
import { handoffLine, resolveDriver } from './harness.js'
import { readStream, streamIds, type Entry } from './journal.js'
import { unmetNeeds } from './needs.js'
import type { DecisionEntry } from './rounds.js'
import { findById, loadCanon } from './scan.js'
import { pendingTxn } from './txn.js'
import { owedDecisions, parkedGates } from './verbs/next.js'
import { recoverChoice } from './verbs/recover.js'

// Row 184. What the run did and what waits, read from the journal written since the run
// began plus the state at its end (design B6). Drive journals nothing of its own (D145), so
// this is the one place its set-asides are said aloud.

export interface RunStart { lines: Map<string, number> }          // stream → entry count when the run began

export function runStart(root: string): RunStart {
  return { lines: new Map(streamIds(root).map((s) => [s, readStream(root, s).length])) }
}

export function entriesSince(root: string, start: RunStart): Array<{ stream: string; entry: Entry }> {
  return streamIds(root).flatMap((stream) =>
    readStream(root, stream).slice(start.lines.get(stream) ?? 0).map((entry) => ({ stream, entry })))
}

export interface Report { lines: string[]; summary: string; merged: number; waiting: number; parked: number; stuck: number }

const prOf = (line: string): string | undefined => /PR #(\d+)/.exec(line)?.[1]

// Every `run:` and `then:` line is raw: a command is never kv-escaped (D120).
export function driveReport(
  root: string, ctx: Ctx, cfg: Config, start: RunStart, aside: readonly Aside[], run: { autonomous: boolean; stopped?: string },
): Report {
  const canon = loadCanon(root)
  const since = entriesSince(root, start)
  const merged = since.filter(({ entry }) => entry.t === 'status' && (entry as { cause?: unknown }).cause === 'merge')
    .map(({ entry }) => `merged: ${String(entry.artifact)} · PR #${String((entry as { pr?: unknown }).pr)}`)

  // The waits, each target once, in the order a human answers them.
  const waits: string[] = []
  const named = new Set<string>()
  const wait = (target: string, rows: string[]) => { named.add(target); waits.push(...rows) }
  // A crash no session could recover blocks every write: it is named first (F4).
  const txn = pendingTxn(root)
  if (txn !== undefined) {
    wait('-txn', [`wait: pending transaction · ${txn.op}`, `  run: ${recoverChoice(root, txn).options[0]!.command}`])
  }
  for (const a of aside.filter((x) => x.kind === 'kept' && (x.stop === 'design-look' || x.stop === 'trust-grant'))) {
    if (named.has(a.target)) continue
    wait(a.target, a.stop === 'design-look'
      ? [`wait: design look · ${a.target}`, `  run: witness design ${a.target} --open`, `  then: witness decide design ${a.target} --show`]
      : [`wait: trust grant · ${a.target} · in a terminal · answer each prompt`, `  run: witness gate ${a.gate ?? '<gate>'} ${a.target}`])
  }
  for (const u of unmetNeeds(canon)) {
    const held = u.type === 'spec' && u.holds.length > 0
    wait(u.doc, [
      held ? `wait: held criterion · ${u.doc} · ${u.text} holds ${u.holds.join(' · ')}` : `wait: unmet need · ${u.doc} · ${u.text}`,
      `  run: ${u.satisfy}`,
    ])
  }
  for (const o of owedDecisions(root, canon)) {
    if (named.has(o.target)) continue
    wait(o.target, [`wait: decision · ${o.gate} ${o.target}`, `  run: witness decide ${o.gate} ${o.target} --show`])
  }
  const driver = resolveDriver(ctx.env, cfg.harness)
  for (const a of aside.filter((x) => x.kind === 'conversation' || x.kind === 'merge')) {
    if (named.has(a.target)) continue
    if (a.kind === 'conversation') {
      // Row 196. A target-less conversation is a grill: of a queued ask, or — with nothing
      // queued — of what to build next, which waits on nobody, so it is said and not counted.
      const ask = a.target === TARGETLESS ? / --ask (\S+)/.exec(a.line)?.[1] : undefined
      if (a.target === TARGETLESS && ask === undefined) { waits.push('nothing queued — /witness <what to build> in a chat'); continue }
      const who = a.target === TARGETLESS ? `brainstorm · ask ${ask}` : a.target
      wait(a.target, [`wait: conversation · ${who}`,
        ...(driver.ok ? [`  run: ${handoffLine(driver.value.harness, root, undefined)}`] : [])])
    } else {
      const pr = prOf(a.line) ?? (findById(canon, a.target)?.meta.pr !== undefined ? String(findById(canon, a.target)!.meta.pr) : undefined)
      wait(a.target, [`wait: merge · ${a.target}${pr ? ` · PR #${pr}` : ''}`, ...(pr ? [`  run: gh pr merge ${pr}`] : [])])
    }
  }

  const parked = parkedGates(root, canon).flatMap((p) => {
    const stopped = readStream(root, p.target)
      .filter((e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === p.gate)
      .map((e) => e as unknown as DecisionEntry).filter((d) => d.decision === 'stop').at(-1)
    const why = stopped?.selected === 'policy' && stopped.note ? stopped.note : `parked at ${p.anchor}`
    return [`parked: ${p.target} · ${p.gate} round ${p.round} — ${why}`, `  run: ${p.reopen}`]
  })
  // A capped target the policy could not park carries no gate (drive.ts): it is stuck too.
  const stuck = aside.filter((a) => a.kind === 'stuck' || (a.kind === 'capped' && a.gate === undefined))
    .map((a) => `stuck: ${a.target} — ${a.why}`)
  const obligations = since.filter(({ entry }) => entry.t === 'deferral').map(({ entry }) => {
    const d = entry as unknown as { id: string; artifact: string; anchor: string; kind: string }
    return `obligation: ${d.id} · ${d.artifact} · ${d.anchor} — ${d.kind}`
  })
  const counts = { policy: 0, arbiter: 0, affirmation: 0, named: 0 }
  for (const { entry } of since) {
    if (entry.t !== 'human-decision') continue
    const d = entry as unknown as DecisionEntry
    if (d.caused_by !== undefined) continue                            // a reopen record, not a decision
    counts[d.selected ?? 'named'] += 1
  }

  const m = merged.length
  const w = named.size
  const p = parkedGates(root, canon).length
  const s = stuck.length
  const tally = `${m} merged · ${w} wait on you · ${p} parked · ${s} stuck`
  const lines = [
    `drive: ${run.stopped !== undefined ? 'stopped' : 'done'} — ${tally}`,
    ...merged, ...waits, ...parked, ...stuck, ...obligations,
    `decisions: policy ${counts.policy} · arbiter ${counts.arbiter} · affirmation ${counts.affirmation} · named ${counts.named}`,
    ...(w > 0 ? ['help: answer the waits above · then /witness or witness drive picks up where this run stopped'] : []),
  ]
  return { lines, summary: `witness drive — ${basename(root)} · ${tally}`, merged: m, waiting: w, parked: p, stuck: s }
}
