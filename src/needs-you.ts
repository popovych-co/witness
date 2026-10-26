import { createHash } from 'node:crypto'
import { grantOf, shownCmd } from './allowlist.js'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import type { Aside } from './drive.js'
import { TARGETLESS } from './drive-presence.js'
import { handoffLine, resolveDriver } from './harness.js'
import { readStream } from './journal.js'
import { unmetNeeds } from './needs.js'
import type { DecisionEntry } from './rounds.js'
import { findById, type Canon } from './scan.js'
import { hasControl } from './toon.js'
import { pendingTxn } from './txn.js'
import { owedDecisions, parkedGates } from './verbs/next.js'
import { recoverChoice } from './verbs/recover.js'

// Row 203. What needs the human, derived once from the journal, the canon and drive's
// set-asides, for its three readers: drive's report, its notifier, and `witness wait`. Drive
// passes its full asides; `wait` and `next` pass the live folder's, which carry no text, so a
// row falls back to a template rendered here from canon. The key never depends on that text:
// drive, `next` and `wait` compute the same token for the same state.

export type WaitKind =
  | 'pending-txn' | 'design-look' | 'trust-grant' | 'need' | 'decision' | 'conversation' | 'merge'
  | 'parked' | 'stuck' | 'capped'

export interface NeedYou {
  kind: WaitKind; target: string; rows: string[]; key: string
  // A line the report says but nobody waits on (a grill with nothing queued): never counted,
  // notified or woken for, and outside the token.
  notice?: true
}

export type AsideFacts = Pick<Aside, 'target' | 'kind'> & Partial<Pick<Aside, 'gate' | 'stop' | 'line' | 'why' | 'trust'>>

export const WAIT_LABEL: Record<WaitKind, string> = {
  'pending-txn': 'pending transaction', 'design-look': 'design look', 'trust-grant': 'trust grant', need: 'unmet need',
  decision: 'decision', conversation: 'conversation', merge: 'merge', parked: 'parked', stuck: 'stuck', capped: 'capped',
}

// The kinds `next` never routes: the chat names each, with its command (final review).
export const HELD_KINDS: ReadonlySet<WaitKind> = new Set(['merge', 'parked', 'stuck', 'capped'])

// The kinds the report counts as waits (each target once), in the order a human answers them.
export const WAIT_KINDS: ReadonlySet<WaitKind> =
  new Set(['pending-txn', 'design-look', 'trust-grant', 'need', 'decision', 'conversation', 'merge'])

const prOf = (line: string): string | undefined => /PR #(\d+)/.exec(line)?.[1]

// Row 205. One wait per command, each with its source and the grant that names it. A command
// the verb would not take (anything outside printable ASCII) gets a note, never a `run:`. An
// aside with no commands (one read from the live folder) names the listing form.
function trustRows(a: AsideFacts): string[] {
  if (a.trust === undefined || a.trust.length === 0) return [`wait: trust grant · ${a.target}`, `  run: witness trust ${a.target}`]
  return a.trust.flatMap((c) => [
    `wait: trust grant · ${a.target} · ${shownCmd(c)}`,
    `  ${hasControl(c.cmd) ? 'note' : 'run'}: ${grantOf(a.target, c)}`,
  ])
}

export function needsYou(root: string, ctx: Ctx, cfg: Config, canon: Canon, aside: readonly AsideFacts[]): NeedYou[] {
  const items: NeedYou[] = []
  const named = new Set<string>()
  const add = (kind: WaitKind, target: string, rows: string[], key = `${kind}:${target}`) => {
    named.add(target)
    items.push({ kind, target, rows, key })
  }
  // A crash no session could recover blocks every write: it is named first (F4).
  const txn = pendingTxn(root)
  if (txn !== undefined) {
    items.push({ kind: 'pending-txn', target: TARGETLESS, key: 'pending-txn:-',
      rows: [`wait: pending transaction · ${txn.op}`, `  run: ${recoverChoice(root, txn).options[0]!.command}`] })
  }
  for (const a of aside.filter((x) => x.kind === 'kept' && (x.stop === 'design-look' || x.stop === 'trust-grant'))) {
    if (named.has(a.target)) continue
    if (a.stop === 'design-look') {
      add('design-look', a.target,
        [`wait: design look · ${a.target}`, `  run: witness design ${a.target} --open`, `  then: witness decide design ${a.target} --show`])
    } else add('trust-grant', a.target, trustRows(a))
  }
  for (const u of unmetNeeds(canon)) {
    const held = u.type === 'spec' && u.holds.length > 0
    add('need', u.doc, [
      held ? `wait: held criterion · ${u.doc} · ${u.text} holds ${u.holds.join(' · ')}` : `wait: unmet need · ${u.doc} · ${u.text}`,
      `  run: ${u.satisfy}`,
    ], `need:${u.doc}:${u.need}`)
  }
  for (const o of owedDecisions(root, canon)) {
    if (named.has(o.target)) continue
    add('decision', o.target, [`wait: decision · ${o.gate} ${o.target}`, `  run: witness decide ${o.gate} ${o.target} --show`],
      `decision:${o.target}:${o.gate}`)
  }
  const driver = resolveDriver(ctx.env, cfg.harness)
  for (const a of aside.filter((x) => x.kind === 'conversation' || x.kind === 'merge')) {
    if (named.has(a.target)) continue
    if (a.kind === 'conversation') {
      // Row 196. A target-less conversation is a grill: of a queued ask, or — with nothing
      // queued — of what to build next, which waits on nobody, so it is said and not counted.
      // An aside read from the live folder carries no line, and drive publishes one only for a
      // queued ask.
      const ask = a.target === TARGETLESS && a.line !== undefined ? / --ask (\S+)/.exec(a.line)?.[1] : undefined
      if (a.target === TARGETLESS && a.line !== undefined && ask === undefined) {
        items.push({ kind: 'conversation', target: TARGETLESS, key: 'conversation:-', notice: true,
          rows: ['nothing queued — /witness <what to build> in a chat'] })
        continue
      }
      const who = a.target === TARGETLESS ? `brainstorm${ask !== undefined ? ` · ask ${ask}` : ''}` : a.target
      add('conversation', a.target, [`wait: conversation · ${who}`,
        ...(driver.ok ? [`  run: ${handoffLine(driver.value.harness, root, undefined)}`] : [])])
    } else {
      const meta = findById(canon, a.target)?.meta.pr
      const pr = (a.line !== undefined ? prOf(a.line) : undefined) ?? (meta !== undefined ? String(meta) : undefined)
      add('merge', a.target, [`wait: merge · ${a.target}${pr ? ` · PR #${pr}` : ''}`, ...(pr ? [`  run: gh pr merge ${pr}`] : [])])
    }
  }
  for (const p of parkedGates(root, canon)) {
    const stopped = readStream(root, p.target)
      .filter((e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === p.gate)
      .map((e) => e as unknown as DecisionEntry).filter((d) => d.decision === 'stop').at(-1)
    const why = stopped?.selected === 'policy' && stopped.note ? stopped.note : `parked at ${p.anchor}`
    items.push({ kind: 'parked', target: p.target, key: `parked:${p.target}:${p.gate}`,
      rows: [`parked: ${p.target} · ${p.gate} round ${p.round} — ${why}`, `  run: ${p.reopen}`] })
  }
  // A capped target the policy could not park carries no gate (drive.ts): it is stuck too. One
  // the policy parked is the parked row above, read from the journal.
  for (const a of aside.filter((x) => x.kind === 'stuck' || (x.kind === 'capped' && x.gate === undefined))) {
    // Final review: the way back is named — a fix witness cannot see is the human's `retry`.
    items.push({ kind: a.kind as 'stuck' | 'capped', target: a.target, key: `${a.kind}:${a.target}`,
      rows: [`stuck: ${a.target} — ${a.why ?? `witness log ${a.target}`}`,
        ...(a.target !== TARGETLESS ? [`  run: witness retry ${a.target}`] : [])] })
  }
  return items
}

// The first 12 hex of a sha1 over the sorted keys of what is owed: order-free, text-free.
export function needsYouToken(items: readonly NeedYou[]): string {
  const keys = [...new Set(items.filter((i) => i.notice !== true).map((i) => i.key))].sort()
  return createHash('sha1').update(keys.join('\n')).digest('hex').slice(0, 12)
}
