import { createHash } from 'node:crypto'
import { cliAct, exitsLine, runRow, type Act } from './act.js'
import { grantAct, grantRowsOf } from './allowlist.js'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import type { Aside } from './drive.js'
import { TARGETLESS } from './drive-presence.js'
import { handoffLine, resolveDriver } from './harness.js'
import { readStream } from './journal.js'
import { unmetNeeds } from './needs.js'
import type { Decision } from './recommend.js'
import type { DecisionEntry } from './rounds.js'
import { findById, type Canon } from './scan.js'
import { cmd, logSafe, visible } from './toon.js'
import { pendingTxn } from './txn.js'
import { owedDecisions, parkedGates } from './verbs/next.js'
import { recoverChoice } from './verbs/recover.js'

// Row 203. What needs the human, derived once from the journal, the canon and drive's
// set-asides, for its three readers: drive's report, its notifier, and `witness wait`. Drive
// passes its full asides; `wait` and `next` pass the live folder's, which carry no text, so a
// row falls back to a template rendered here from canon. The key never depends on that text:
// drive, `next` and `wait` compute the same token for the same state.

// Rows 139/203. A command a trust grant names, escaped as every row prints it, beside its source,
// with the grant only when the verb would take it: a model never holds the raw bytes of an unsafe
// command, nor an act for one.
export interface TrustGrant { cmd: string; source: string; grant?: Act }   // cmd, source: visible(); no grant when unsafe

interface ItemBase {
  target: string; key: string
  // A line the report says but nobody waits on (a grill with nothing queued): never counted,
  // notified or woken for, and outside the token.
  notice?: true
}

// Rows 139/203. Each item is a model: the facts its rows print and the acts its commands are, so a
// reader of the model is handed what the text offers. `needYouRows` lays it out.
export type NeedYou = ItemBase & (
  | { kind: 'pending-txn'; op: string; recover: Decision }
  | { kind: 'design-look'; open: Act; show: Act }
  | { kind: 'trust-grant'; commands?: TrustGrant[]; list: Act }          // no commands: read from the live folder
  | { kind: 'need'; need: string; text: string; holds: string[]; satisfy: Act }
  | { kind: 'decision'; gate: string; show: Act }
  | { kind: 'conversation'; ask?: string; handoff?: string }
  | { kind: 'merge'; pr?: string }
  // why: the policy's note, or `parked at <anchor>` with a reviewer's anchor as printed (R5/R17): a renderer spells it out
  | { kind: 'parked'; gate: string; round: number; why: string; reopen: Act[] }
  | { kind: 'stuck'; why?: string; retry?: Act }
  | { kind: 'capped'; why?: string; retry?: Act })                       // two members, so `Extract` narrows each

export type WaitKind = NeedYou['kind']

export type AsideFacts = Pick<Aside, 'target' | 'kind'> & Partial<Pick<Aside, 'gate' | 'stop' | 'line' | 'why' | 'trust'>>

export const WAIT_LABEL: Record<WaitKind, string> = {
  'pending-txn': 'pending transaction', 'design-look': 'design look', 'trust-grant': 'trust grant', need: 'unmet need',
  decision: 'decision', conversation: 'conversation', merge: 'merge', parked: 'parked', stuck: 'stuck', capped: 'capped',
}

// The kinds `next` never routes: the chat names each, with its command (final review). Row 239: an
// item of one of them is a `HeldItem`, the only kind `waitingRows` lays out.
type HeldKind = 'merge' | 'parked' | 'stuck' | 'capped'
export const HELD_KINDS: ReadonlySet<WaitKind> = new Set<HeldKind>(['merge', 'parked', 'stuck', 'capped'])
export type HeldItem = Extract<NeedYou, { kind: HeldKind }>
export const isHeld = (item: NeedYou): item is HeldItem => HELD_KINDS.has(item.kind)

// The kinds the report counts as waits (each target once), in the order a human answers them.
export const WAIT_KINDS: ReadonlySet<WaitKind> =
  new Set(['pending-txn', 'design-look', 'trust-grant', 'need', 'decision', 'conversation', 'merge'])

const prOf = (line: string): string | undefined => /PR #(\d+)/.exec(line)?.[1]

export function needsYou(root: string, ctx: Pick<Ctx, 'env'>, cfg: Config, canon: Canon, aside: readonly AsideFacts[]): NeedYou[] {
  const items: NeedYou[] = []
  const named = new Set<string>()
  const add = (item: NeedYou) => {
    named.add(item.target)
    items.push(item)
  }
  // A crash no session could recover blocks every write: it is named first (F4).
  const txn = pendingTxn(root)
  if (txn !== undefined) {
    items.push({ kind: 'pending-txn', target: TARGETLESS, key: 'pending-txn:-', op: txn.op, recover: recoverChoice(root, txn) })
  }
  for (const a of aside.filter((x) => x.kind === 'kept' && (x.stop === 'design-look' || x.stop === 'trust-grant'))) {
    if (named.has(a.target)) continue
    const t = a.target
    if (a.stop === 'design-look') {
      add({ kind: 'design-look', target: t, key: `design-look:${t}`,
        open: cliAct('design', t, '--open'), show: cliAct('decide', 'design', t, '--show') })
    } else {
      const commands = (a.trust ?? []).map((c): TrustGrant => {
        const grant = grantAct(t, c)
        return { cmd: visible(c.cmd), source: visible(c.source), ...(grant !== undefined ? { grant } : {}) }
      })
      add({ kind: 'trust-grant', target: t, key: `trust-grant:${t}`, ...(commands.length > 0 ? { commands } : {}), list: cliAct('trust', t) })
    }
  }
  for (const u of unmetNeeds(canon)) {
    add({ kind: 'need', target: u.doc, key: `need:${u.doc}:${u.need}`, need: u.need, text: u.text, holds: u.holds,
      satisfy: u.satisfyAct })
  }
  for (const o of owedDecisions(root, canon)) {
    if (named.has(o.target)) continue
    add({ kind: 'decision', target: o.target, key: `decision:${o.target}:${o.gate}`, gate: o.gate,
      show: cliAct('decide', o.gate, o.target, '--show') })
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
        items.push({ kind: 'conversation', target: TARGETLESS, key: 'conversation:-', notice: true })
        continue
      }
      add({ kind: 'conversation', target: a.target, key: `conversation:${a.target}`, ...(ask !== undefined ? { ask } : {}),
        ...(driver.ok ? { handoff: handoffLine(driver.value.harness, root, undefined) } : {}) })
    } else {
      const meta = findById(canon, a.target)?.meta.pr
      const pr = (a.line !== undefined ? prOf(a.line) : undefined) ?? (meta !== undefined ? String(meta) : undefined)
      add({ kind: 'merge', target: a.target, key: `merge:${a.target}`, ...(pr ? { pr } : {}) })
    }
  }
  for (const p of parkedGates(root, canon)) {
    const stopped = readStream(root, p.target)
      .filter((e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === p.gate)
      .map((e) => e as unknown as DecisionEntry).filter((d) => d.decision === 'stop').at(-1)
    // A journaled note is parsed JSON: held as the string it prints as.
    const why = stopped?.selected === 'policy' && stopped.note ? String(stopped.note) : `parked at ${p.anchor}`
    items.push({ kind: 'parked', target: p.target, key: `parked:${p.target}:${p.gate}`,
      gate: p.gate, round: p.round, why, reopen: p.reopen })
  }
  // A capped target the policy could not park carries no gate (drive.ts): it is stuck too. One
  // the policy parked is the parked row above, read from the journal.
  for (const a of aside.filter((x) => x.kind === 'stuck' || (x.kind === 'capped' && x.gate === undefined))) {
    // Final review: the way back is named — a fix witness cannot see is the human's `retry`.
    items.push({ kind: a.kind as 'stuck' | 'capped', target: a.target, key: `${a.kind}:${a.target}`,
      ...(a.why !== undefined ? { why: a.why } : {}),
      ...(a.target !== TARGETLESS ? { retry: cliAct('retry', a.target) } : {}) })
  }
  return items
}

// Row 205. One wait per command, each with its source and the grant that names it. A command
// the verb would not take (anything outside printable ASCII) gets a note, never a `run:`. An
// aside with no commands (one read from the live folder) names the listing form. Row 239: the
// grant's rows are the kept stop's (`grantRowsOf`), so one Windows withholds names the listing.
function trustRows(item: Extract<NeedYou, { kind: 'trust-grant' }>): string[] {
  if (item.commands === undefined || item.commands.length === 0) {
    return [`wait: trust grant · ${item.target}`, runRow(item.list)]
  }
  return item.commands.flatMap((c) => [`wait: trust grant · ${item.target} · ${c.cmd} (${c.source})`, ...grantRowsOf(c.grant, item.list)])
}

// Rows 139/203. An item's rows, laid out from its facts: every command a row offers is an act's
// line, and only labels, separators and prose pointers are added here. Row 239 (ruling R16): each
// such row is `runRow`'s, which a Windows-withheld act turns into a note, and the prose a repo, a
// journal or a reviewer wrote on a head line — a need's text and holds, a park's or a stop's why —
// is spelled out (`logSafe`) where it holds a line break, which would start a `run:` row of its own.
export function needYouRows(item: NeedYou): string[] {
  switch (item.kind) {
    case 'pending-txn': {
      // `recoverChoice` builds every option from an act; one without an act offers no row.
      const act = item.recover.options[0]?.act
      return [`wait: pending transaction · ${item.op}`, ...(act !== undefined ? [runRow(act)] : [])]
    }
    case 'design-look':
      return [`wait: design look · ${item.target}`, runRow(item.open), runRow(item.show, 'then')]
    case 'trust-grant':
      return trustRows(item)
    case 'need':
      return [
        item.holds.length > 0
          ? `wait: held criterion · ${item.target} · ${logSafe(item.text)} holds ${logSafe(item.holds.join(' · '))}`
          : `wait: unmet need · ${item.target} · ${logSafe(item.text)}`,
        runRow(item.satisfy),
      ]
    case 'decision':
      return [`wait: decision · ${item.gate} ${item.target}`, runRow(item.show)]
    case 'conversation': {
      if (item.notice === true) return ['nothing queued — /witness <what to build> in a chat']
      const who = item.target === TARGETLESS ? `brainstorm${item.ask !== undefined ? ` · ask ${item.ask}` : ''}` : item.target
      return [`wait: conversation · ${who}`, ...(item.handoff !== undefined ? [`  run: ${item.handoff}`] : [])]
    }
    case 'merge':
      return [`wait: merge · ${item.target}${item.pr ? ` · PR #${item.pr}` : ''}`, ...(item.pr ? [`  run: gh pr merge ${item.pr}`] : [])]
    // Row 239 (design §3.4b). At the bound the reopen is the endgame menu, and a menu pasted whole
    // is a pipeline that runs every act it names: it prints as `exits:`, the label `decide --show`
    // gives a set of choices, and `run:` is kept for one command.
    case 'parked':
      return [`parked: ${item.target} · ${item.gate} round ${item.round} — ${logSafe(item.why)}`,
        item.reopen.length === 1 ? runRow(item.reopen[0]!) : `  exits: ${exitsLine(item.reopen)}`]
    case 'stuck':
    case 'capped':
      return [`stuck: ${item.target} — ${item.why !== undefined ? logSafe(item.why) : `witness log ${item.target}`}`,
        ...(item.retry !== undefined ? [runRow(item.retry)] : [])]
  }
}

// Row 239 (design §3.4). How `next` names an item it does not route: the item's head as a
// `waiting:` line, then the rows `needYouRows` prints under it, each command indented on its own.
// The head is prose a repo or a reviewer can write — a park's note, an anchor — so a command
// joined to it, as the line once did, could be planted ahead of the real one.
export function waitingRows(item: HeldItem): string[] {
  const [head, ...more] = needYouRows(item)
  return [cmd('waiting', head!.replace(/^wait: /, '')), ...more]
}

// The first 12 hex of a sha1 over the sorted keys of what is owed: order-free, text-free.
export function needsYouToken(items: readonly NeedYou[]): string {
  const keys = [...new Set(items.filter((i) => i.notice !== true).map((i) => i.key))].sort()
  return createHash('sha1').update(keys.join('\n')).digest('hex').slice(0, 12)
}
