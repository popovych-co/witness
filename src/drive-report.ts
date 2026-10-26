import { basename } from 'node:path'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import type { Aside } from './drive.js'
import { readStream, streamIds, type Entry } from './journal.js'
import { needsYou, WAIT_KINDS } from './needs-you.js'
import type { DecisionEntry } from './rounds.js'
import { loadCanon } from './scan.js'

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

// Every `run:` and `then:` line is raw: a command is never kv-escaped (D120).
export function driveReport(
  root: string, ctx: Ctx, cfg: Config, start: RunStart, aside: readonly Aside[], run: { autonomous: boolean; stopped?: string },
): Report {
  const canon = loadCanon(root)
  const since = entriesSince(root, start)
  const merged = since.filter(({ entry }) => entry.t === 'status' && (entry as { cause?: unknown }).cause === 'merge')
    .map(({ entry }) => `merged: ${String(entry.artifact)} · PR #${String((entry as { pr?: unknown }).pr)}`)

  // Row 203. The waits, each target once, in the order a human answers them, then the parked
  // gates and the stuck targets: one derivation, read by the notifier and `witness wait` too.
  const items = needsYou(root, ctx, cfg, canon, aside)
  const waiting = items.filter((i) => WAIT_KINDS.has(i.kind))
  const waits = waiting.flatMap((i) => i.rows)
  const parked = items.filter((i) => i.kind === 'parked').flatMap((i) => i.rows)
  const stuck = items.filter((i) => i.kind === 'stuck' || i.kind === 'capped').flatMap((i) => i.rows)
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
  // A crash is one wait whatever it names; a notice waits on nobody.
  const w = new Set(waiting.filter((i) => i.notice !== true).map((i) => i.kind === 'pending-txn' ? '-txn' : i.target)).size
  const p = items.filter((i) => i.kind === 'parked').length
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
