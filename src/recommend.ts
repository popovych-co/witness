import { cliAct, type Act } from './act.js'
import type { Entry } from './journal.js'
import {
  actKey, actLive, anchorRecurrence, boundReached, decisionOwed, ladderSpent, lastGateRun, liveActs, partPasses, repairsOnRegate,
  repairGranted, reviseAct, roundBudget, roundsSinceApprove, type GateRunEntry, type GateStateKind, type LineOff, type LiveActs,
} from './rounds.js'
import { checkWaiver } from './checks.js'
import { bookingsOf } from './ledger.js'
import { hasControl, visible } from './toon.js'

// Row 270 (§3.3). What a booking costs and how it ends, in one spelling for every block that offers it.
export const BOOK_TRADEOFF = 'opens a ledger item per part, which waives exactly what it books for this plan; each closes once the part is green on main (the discharge), or by witness dismiss ledger'

// Row 274. When a check's booking is the act, and what it costs, by check: lint's words (row 270), and a
// switch-off's — one item per line, closing once main no longer holds the line.
export function bookWhen(check: string): string {
  return check === 'switch-offs' ? 'the switch-off is right as it stands — say why in the note'
    : 'the red is not this plan\'s to fix — red on the base too, or one only you accept'
}
export function bookTradeoff(check: string): string {
  return check === 'switch-offs'
    ? 'opens a ledger item per line, which waives that line for this plan; each closes once main no longer holds the line (the discharge), or by witness dismiss ledger'
    : BOOK_TRADEOFF
}

// Row 270 (§5, the map's C23). The parts of a checks-only round's withheld check no author can clear:
// every part that does not pass is red on the base too and unjudgeable, the check's waiver is the
// human's, and the round holds a part a booking takes. Empty otherwise — one part the author may own
// (`new`, `red`, `not-measured`) leaves the stop to the revise first.
export function bookOwed(run: GateRunEntry): string[] {
  const check = run.checks.at(-1)
  if (run.checks_only !== true || check === undefined || checkWaiver(check.name) !== 'human') return []
  const failing = (check.parts ?? []).filter((p) => !partPasses(p))
  if (failing.length === 0 || !failing.every((p) => p.state === 'not-judged') || bookingsOf(run, check.name).length === 0) return []
  return failing.map((p) => p.part)
}

// D121. The block: every set of live options renders ranked, with runnable commands.
// This module is PURE — it takes journal entries and ids the caller already resolved and
// returns data. It never loads canon, never reads a finding's claim text, and never
// decides anything a gate predicate consumes.

export type Depth = 'root' | 'deferral' | 'terminal'

export interface Option {
  command: string
  depth: Depth
  why?: string
  when?: string
  tradeoff?: string
  note?: string
  runnable: boolean
  judgeFirst?: string
  // Rows 139/203. The command as data: `command` is its line. Absent only on a choose block's
  // options, which name a spec, not a command (`readyChoice`).
  act?: Act
}

export interface Decision {
  key: string
  options: Option[]
  rule: string
  anchor?: string
  // Row 244. The gate state the block was built for (`liveActs`), so a reader holding the block alone
  // knows whose acts it offers there: the arbiter's menu drops the ones only a human may take (§4.2.6).
  state?: GateStateKind
}

// Commands are emitted raw (D120). Row 239: each is its act's line, which the quoter already
// made one pasteable command; `esc` would wrap a line holding a `"` in TOON's quotes, and pasted
// inside them it is one word, not a command.
export function renderDecision(d: Decision): string[] {
  const n = d.options.length
  const out = [`${d.key}: ${n} option${n === 1 ? '' : 's'} · 1 is recommended`]
  d.options.forEach((o, i) => {
    const tags = [String(i + 1), ...(i === 0 ? ['recommended'] : []), o.depth,
      ...(o.runnable ? [] : ['not runnable'])]
    out.push(tags.join(' · '))
    out.push(`   ${o.command}`)
    if (o.why) out.push(`   why: ${o.why}`)
    if (o.judgeFirst) out.push(`   judge-first: ${o.judgeFirst}`)
    if (o.when) out.push(`   when: ${o.when}`)
    if (o.tradeoff) out.push(`   tradeoff: ${o.tradeoff}`)
    if (o.note) out.push(`   note: ${o.note}`)
  })
  // No run: line when the recommendation cannot be pasted — a run: that needs editing is
  // the promise this block exists to keep, broken.
  if (d.options[0]?.runnable) out.push(`run: ${d.options[0]!.command}`)
  return out
}


export interface GateContext {
  gate: string
  target: string
  entries: Entry[]
  upstream: string | undefined
  stale: boolean
  // D154. The artifact's `cmd:` criteria this repo does not trust yet, computed by the
  // CALLER — this module stays pure and never reads allow.json. When non-empty, every
  // plain approve gains a trusting twin so the human can see both prices.
  untrustedCmds?: string[]
}

const RESERVED = new Set(['ship', 'design'])

const blockingAnchors = (r: GateRunEntry): string[] =>
  (r.verdicts ?? []).flatMap((rv) => rv.findings.filter((f) => f.blocking)
    .map((f) => (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`)))

// Rule 8's test (`blocking-parent`), one reading for the rule table and the handed-back block: every
// blocking finding anchors to the parent, so the artifact is faithful to a parent that is wrong.
const parentAnchored = (anchors: readonly string[], upstream: string | undefined): boolean =>
  upstream !== undefined && anchors.length > 0 && anchors.every((a) => a.startsWith(`${upstream} `) || a.startsWith(`${upstream}>`))

// Rows 139/203. Every option that offers a command is built from its act: the block prints the
// act's line, and the option pastes unless a word of it is one the human must fill. Row 239: nor
// when it is withheld (`Act.withheld`). The command is still shown, and its note says why.
export function option(
  act: Act, depth: Depth, rest: Partial<Pick<Option, 'why' | 'when' | 'tradeoff' | 'note' | 'judgeFirst'>> = {},
): Option {
  const { note: given, ...shown } = rest
  const note = [given, act.withheld].filter((n) => n !== undefined).join(' · ')
  return {
    command: act.line, depth, runnable: act.inputs.length === 0 && act.withheld === undefined, act, ...shown,
    ...(note !== '' ? { note } : {}),
  }
}

// The rule table is an ORDERED FIRST-MATCH list (D121). The id of the rule that matched is
// what the journal records, so a wrong recommendation is attributable to one line here
// rather than to a weighting — and each rule is testable from one journal state.
// Order: malformed · stale-below-bound · ladder-spent · bound+recurrence · bound ·
//        recurrence · pin-contradiction · blocking-parent · blocking-here ·
//        waivable · checks-failed · non-blocking-only · reserved-stop-clean · manual-stop
// Row 244 (design §4.2.6). A revise the author handed back is decided by `revise-returned`
// (`revisedBlock`): after stale-below-bound, whose moved row it is once the content or a hold moved
// since, and before malformed-rerun when the revise follows the malformed run (§4.2.3).
// D154. Trust must never be the toll for approval. Where a plain `--approve` is offered
// and the artifact carries untrusted `cmd:` criteria, the block renders BOTH forms — plain
// first, so approving without granting stays the easy path — and names the commands, because
// a grant the human cannot read is not one they made. Applied once, over the finished option
// list, rather than at each of the five rules that offer an approve.
// Row 205. The twin grants what `witness trust` would and nothing else: a command holding a
// character outside printable ASCII is never granted. So the plain approve names every untrusted
// command, each spelled out (`visible`), since all of them stay blocked; the twin is offered only
// while one is grantable, and prices only those.
function withTrustVariants(d: Decision, untrusted: string[]): Decision {
  if (untrusted.length === 0) return d
  const listed = untrusted.map(visible).join(' · ')
  const grantable = untrusted.filter((c) => !hasControl(c))
  const options: Option[] = []
  for (const o of d.options) {
    options.push(o)
    // The obligation-minting `--approve --override` is deliberately excluded: D143 keeps
    // trust off nods, and stacking a grant onto the ledger act would bury it twice over.
    if (o.act?.argv.at(-1) !== '--approve') continue
    options[options.length - 1] = {
      ...o,
      tradeoff: [o.tradeoff, `the listed commands stay blocked at headless gates: ${listed}`]
        .filter(Boolean).join(' · '),
    }
    if (grantable.length === 0) continue
    // The twin is the same stamp plus a grant, so it carries the stamp's depth: next to a
    // deferral approve (checks-failed) it is a deferral too, never a root fix.
    options.push(option(cliAct(...o.act.argv, '--trust-cmds'), o.depth, {
      when: 'you have read these commands and accept them running unattended at every later gate',
      tradeoff: `grants them repo-wide in .witness/allow.json (machine-local): ${grantable.join(' · ')}`,
      note: 'a bare affirmation never grants trust — this form must be named (D143)',
    }))
  }
  return { ...d, options }
}

export function recommend(ctx: GateContext): Decision | undefined {
  const d = recommendCore(ctx)
  return d === undefined ? undefined : withTrustVariants(d, ctx.untrustedCmds ?? [])
}

// Row 244 (#87, design §4.2.1, §4.2.2). The block offers only acts `decide` accepts: its options are
// drawn from the gate's live acts (`liveActs`, from the same journal, upstream and staleness). A
// stopped run awaiting its decision and the bound keep the rule table, each option kept only while
// live; the states a revise leaves are built from their own acts; a settled, a parked (below the
// bound) or an abandoned gate has no block, and its screen prints its acts. Every block carries the
// state it was built for.
function recommendCore(ctx: GateContext): Decision | undefined {
  const { gate, target, entries, upstream, stale } = ctx
  const last = lastGateRun(entries, gate)
  if (!last) return undefined
  const live = liveActs(gate, target, entries, { upstream, stale, holdLifted: false, owed: false, upstreamOwed: false, checksMoved: false })
  if (live.state === 'pending' || live.state === 'at-bound' || (live.state === 'parked' && boundReached(entries, gate))) {
    const d = ruleTable(ctx, last)
    const options = d?.options.filter((o) => o.act !== undefined && actLive(live, actKey(o.act))) ?? []
    return d !== undefined && options.length > 0 ? { ...d, options, state: live.state } : undefined
  }
  const d = REVISED_FAMILY.has(live.state) ? revisedBlock(ctx, live, last) : undefined
  return d === undefined ? undefined : { ...d, state: live.state }
}

// The condition on the revised state's re-gate (design §4.2.2): it is the recommended act only once
// the author has changed the work, since on unchanged content the gate answers changed-nothing.
export const AFTER_EDIT = 'after you change the work'

const REVISED_FAMILY: ReadonlySet<GateStateKind> = new Set<GateStateKind>(['revised', 'handed-back', 'handed-back-moved', 'retracted'])

// Row 244 (design §4.2.2). The block of a state a revise left, one option per live act, in the order
// the state offers them, and the rule each records:
//   revised      `revised`: the re-gate, "after you change the work", then the acts;
//   handed back  `revise-returned`: send upstream first where the blocking finding's anchor is in the
//                parent (rule 8's test, while D123's ladder is unspent), else the park — neither the
//                author nor a reviewer found a fix (§4.2.2, §4.2.6, review fix S2-D). The policy hands
//                it to the arbiter, whose menu holds no revise of it (`menuFor`);
//   moved since  `stale-below-bound`: the re-gate first (§4.2.9), so the policy's stale arm takes it;
//   retracted    `retracted`: the re-review (`--fresh`) first, or on moved content the re-gate.
// Each carries the run's primary anchor, so an upstream taken here spends D123's ladder (P47). On
// moved content a revised gate's one act is the re-gate, and its exits line says so (D131): no block.
function revisedBlock(ctx: GateContext, live: LiveActs, last: GateRunEntry): Decision | undefined {
  const { gate, target, entries } = ctx
  // The malformed round's re-run leads only where `liveActs` leads with it: where the re-gate repairs
  // the round. One on other content after the revise leaves the pairing with the disposed run, and the
  // state's own block stands (S3-3).
  if (live.malformedRerun) return malformedBlock(ctx, last)
  if (live.state === 'revised' && live.acts.length === 1) return undefined
  const anchors = live.anchor === undefined ? [] : blockingAnchors(live.anchor)
  const primary = anchors[0]
  const budget = roundBudget(entries, gate)
  const nextRound = roundsSinceApprove(entries, gate) + 1
  const spends = `spends round ${nextRound} of ${budget}${nextRound >= budget ? ' — the last before the bound' : ''}`
  const handedBack = live.state === 'handed-back' || live.state === 'handed-back-moved'
  const retracted = live.state === 'retracted'
  // The state offers the upstream only where a parent exists and the anchor's ladder is unspent.
  const isUp = (a: Act) => a.argv.includes('--upstream')
  const upFirst = live.state === 'handed-back' && parentAnchored(anchors, ctx.upstream) && live.acts.some(isUp)
  const optionOf = (a: Act): Option => {
    const w = a.argv
    if (w[0] === 'gate' && w.includes('--fresh')) {
      return retracted
        ? option(a, 'root', { why: 'the revise retracted a settled verdict and asked for no edit — a re-review judges the same content again', tradeoff: spends })
        : option(a, 'root', { when: 'you want the same content judged again without an edit', tradeoff: `${spends} on unchanged content` })
    }
    if (w[0] === 'gate') {
      return option(a, 'root', {
        why: live.state === 'handed-back-moved'
          ? 'the author handed the revise back, and the content or a hold moved since — no battery has read what moved'
          : 'the content moved since the revise — the re-gate judges what moved',
        tradeoff: spends,
      })
    }
    if (w.includes('--approve')) {
      return w.includes('--override')
        ? option(a, 'deferral', {
          when: retracted ? 'the retraction was wrong and the verdict stands' : 'you have read the finding and judge it wrong',
          tradeoff: 'stamps the artifact over a live blocking finding; mints an obligation that stays open in status until a later battery no longer reports it (the discharge)',
        })
        : option(a, 'root', {
          when: retracted ? 'the retraction was wrong and the verdict stands' : 'the work needs no change',
          tradeoff: 'stamps the artifact as the last round judged it',
        })
    }
    if (w.includes('--stop')) {
      return option(a, 'terminal', {
        ...(live.state === 'handed-back' && !upFirst
          ? { why: 'the author handed the revise back unchanged — neither the author nor a reviewer found a fix' }
          : { when: 'this work should not continue as scoped' }),
        tradeoff: 'parks the flow — next stops offering it and reopening is an explicit act',
      })
    }
    if (w.includes('--book')) {
      const check = w[w.indexOf('--book') + 1] ?? ''
      return option(a, 'deferral', { when: bookWhen(check), tradeoff: bookTradeoff(check) })
    }
    if (w.includes('--upstream')) {
      return option(a, 'root', {
        ...(upFirst
          ? { why: `${anchors.length} of ${anchors.length} blocking finding${anchors.length === 1 ? '' : 's'} anchor to ${ctx.upstream}, not to this artifact — the author handed the revise back unchanged, and the fix belongs in the parent` }
          : { when: 'the parent artifact is what is wrong' }),
        tradeoff: 'reopens the parent stage and resets this budget',
      })
    }
    return option(a, 'root', {
      when: retracted ? 'the work needs an edit, not a re-review'
        : handedBack ? 'you can name the change the author did not find' : 'the author needs another instruction than the revise gave',
      tradeoff: 'sends the work back with your words; the round is spent by the re-gate that follows it',
    })
  }
  const leads = upFirst ? isUp : (a: Act) => a.argv.includes('--stop')
  const acts = live.state === 'handed-back' ? [...live.acts.filter(leads), ...live.acts.filter((a) => !leads(a))] : live.acts
  const options = acts.map(optionOf)
  const rule = live.state === 'handed-back' ? 'revise-returned' : live.state === 'handed-back-moved' ? 'stale-below-bound' : live.state
  const conditional = live.state === 'revised'
    ? [option(cliAct('gate', gate, target), 'root', {
      when: AFTER_EDIT,
      why: 'the revise sent the work back to its author — once the work changes, the re-gate judges it',
      tradeoff: spends,
    })]
    : []
  return { key: 'decide', rule, ...(primary !== undefined ? { anchor: primary } : {}), options: [...conditional, ...options] }
}

// 1 — malformed. D126 removed it from pendingDecision, so reaching here means a caller asked anyway;
// answer with the act that actually helps rather than four dispositions. Since row 212 the re-run is
// the only one.
function malformedBlock(ctx: GateContext, last: GateRunEntry): Decision {
  const { gate, target, entries, stale } = ctx
  return {
    key: 'next', rule: 'malformed-rerun',
    options: [
      option(cliAct('gate', gate, target), 'root', {
        why: `the battery emitted ${last.malformed?.length ?? 0} schema violation(s) and no verdict — this round judged nothing, and malformed rounds do not spend the budget, so re-running is free${
          // A promise of what appendKind does (row 209): moved content is a fresh round, every
          // lens asked; a revise after it, on the content of the run that revise disposed of, makes
          // it changed-nothing (row 244's pairing); a fallen-back round re-runs.
          last.malformed?.length && !stale && repairsOnRegate(entries, gate)
            ? `, and on unchanged content and setup it re-asks only ${last.malformed.map((m) => m.reviewer).join(' · ')}` : ''}`,
        note: 'a second malformed round on the same pin and prompts trips malformed-streak, which names the config remedy',
      }),
    ],
  }
}

function ruleTable(ctx: GateContext, last: GateRunEntry): Decision | undefined {
  const { gate, target, entries, upstream, stale } = ctx
  const d = (...rest: string[]) => cliAct('decide', gate, target, ...rest)
  const up = d('--revise', '--upstream', upstream ?? '<effort>')
  // Row 239. Bare where the run holds facts: no reviewer text reaches a command.
  const note = reviseAct(gate, target, entries)
  const atBound = boundReached(entries, gate)
  const budget = roundBudget(entries, gate)
  const spent = roundsSinceApprove(entries, gate)
  const rounds = `round ${spent} of ${budget}`

  // The block REPLACED the exits line on every surface, so anything it omits becomes
  // undiscoverable. `liveExits` below the bound offers approve, revise-note, revise-upstream
  // and stop; a rule that lists a subset makes the two disagree, which is the D119 defect
  // class in a new dress. Every rule therefore carries the whole live set and only the ORDER
  // and the prose differ. Omitted rather than flagged when no upstream resolves — `decide`
  // refuses that with `unknown-owner`, so it is an illegal act, not an unresolved one (D129).
  const upAlt = (when: string, tradeoff: string): Option[] =>
    upstream === undefined ? [] : [option(up, 'root', { when, tradeoff })]

  const stopOpt = option(d('--stop'), 'terminal', {
    when: 'this work should not continue as scoped',
    tradeoff: 'parks the flow — next stops offering it and reopening is an explicit act',
  })
  // Offered BELOW the bound as well as at it, and this is the accounted spelling on purpose.
  // Plain `--approve` over a live blocking finding is legal below the bound (`decide` only
  // requires `--override` at the bound) and `liveExits` lists it — but it is the same act
  // with the accounting switched off: it stamps the artifact over the finding and records
  // nothing, which is the unaccounted band-aid D122 exists to prevent. Advertising it beside
  // an accounted one would make the block the place a human learns to skip the ledger, so
  // the block names one approve and it is the one that mints the obligation.
  const overrideOpt = option(d('--approve', '--override'), 'deferral', {
    when: 'you have read the finding and judge it wrong',
    tradeoff: 'stamps the artifact over a live blocking finding; mints an obligation that stays open in status until a later battery no longer reports it (the discharge)',
  })
  // The bound's only discarding act, and it must appear at EVERY bound branch. liveExits
  // carries it unconditionally for a reason it states: nothing else offers it, and under D124
  // `--stop` parks rather than discards, so a bound screen without abandon offers no way to
  // end the work. The bound-recurrence branch omitted it and two existing tests caught that.
  const abandonOpt = option(cliAct('abandon', target), 'terminal', {
    when: 'this work should be discarded, not parked',
    tradeoff: 'irreversible — unlike --stop, nothing reopens it',
  })
  const repairOpt = option(d('--revise', '--repair'), 'deferral', {
    when: 'the edit you just made is the fix and you want it verified rather than assumed',
    tradeoff: 'buys exactly one round; the discharge is that round passing, and the grant does not refresh until an approve, a revise-upstream or a passed run',
  })

  // 1 — malformed (`malformedBlock`).
  if (last.outcome === 'malformed') return malformedBlock(ctx, last)

  // 2 — stale below the bound. Staleness blocks STAMPING, not judging: `--approve` asserts
  // about current content and `decide` refuses it with `stale-verdict`, while a stop, a
  // revise and an upstream judge the WORK and are all legal (probed 2026-08-12, all exit 0).
  // Gated on a decision owed because that is what resolves an anchor: on the reopened
  // and revised screens every decide verb refuses with `nothing-pending`, and there the
  // caller's single re-gate act is the honest answer.
  // Row 244 (design §4.2.5, P34): owed is `decisionOwed`'s, so the guard admits a standing hand-back.
  // Its moved row — the re-gate first, no approve, under this rule — is `revisedBlock`'s, built from
  // the handed-back-moved state's live acts before this table is read; here owed is the pending run.
  if (stale && !atBound) {
    if (decisionOwed(entries, gate) === undefined) return undefined
    const nextRound = spent + 1
    return {
      key: 'decide', rule: 'stale-below-bound',
      // No anchor: the findings describe bytes that no longer exist, and pinning a decision
      // to one of them would file recurrence against a verdict nothing can still reproduce.
      options: [
        option(cliAct('gate', gate, target), 'root', {
          why: `the verdict judged @${last.reviewed_sha.slice(0, 7)} and the content has moved since — no battery has read the current bytes, so every finding above describes a tree that no longer exists`,
          tradeoff: `spends round ${nextRound} of ${budget}${nextRound >= budget ? ' — the last before the bound' : ''}`,
        }),
        option(note, 'root', {
          when: 'you already know the next edit and want no verdict on this state',
          tradeoff: 'spends no round now — the round is spent by the re-gate that follows it',
        }),
        ...upAlt('the parent artifact is what is wrong, whatever the current bytes say',
          'reopens the parent stage and resets this budget'),
        stopOpt,
      ],
    }
  }

  // 2b — book owed (row 270, §5; the map's C23). Every part of the withheld check that does not pass is
  // red on the base too and unjudgeable: no author can clear it, so the booking leads — the human's,
  // never the policy's (`policyFor` leaves it) — naming its discharge; the revise fixes the base's red
  // in this plan instead.
  const owedParts = atBound ? [] : bookOwed(last)
  if (owedParts.length > 0) {
    const name = last.checks.at(-1)!.name
    return {
      key: 'decide', rule: 'book-owed',
      options: [
        option(d('--book', name), 'deferral', {
          why: `${owedParts.map(visible).join(', ')} ${owedParts.length === 1 ? 'is' : 'are'} red on the base too, and which of its errors are this plan's cannot be judged — no author can clear it, so only you book ${name}`,
          tradeoff: BOOK_TRADEOFF,
        }),
        option(note, 'root', {
          when: `the base's ${name} red should be fixed in this plan`,
          tradeoff: `sends the work back to its author; this round spent no budget (${spent} of ${budget} spent)`,
        }),
        ...upAlt('the check fails because of what the stage above asked for', 'reopens the parent stage and resets this budget'),
        stopOpt,
      ],
    }
  }

  // 2c — checks only (row 264, §3.2). A withholding check was red, so no lens ran: there is no verdict
  // to weigh and no approve (row 172). The fix is the author's — the bare revise — and the round spent
  // none of the human's budget. The policy takes it (`TAKEN`). Row 270: a part a booking takes is
  // offered after it, for the red the author finds is not theirs.
  if (last.checks_only === true && !atBound) {
    const name = last.checks.at(-1)?.name ?? 'a check'
    const book = bookingsOf(last, name).length > 0
      ? [option(d('--book', name), 'deferral', { when: 'the red is not this plan\'s to fix — red on the base too, or one only you accept', tradeoff: BOOK_TRADEOFF })]
      : []
    return {
      key: 'decide', rule: 'checks-only',
      options: [
        option(note, 'root', {
          why: `${name} is red, so no lens ran — fix what it names and re-run the gate · this round spent no budget (${spent} of ${budget} spent)`,
        }),
        ...book,
        ...upAlt('the check fails because of what the stage above asked for',
          'reopens the parent stage and resets this budget'),
        stopOpt,
      ],
    }
  }

  const anchors = blockingAnchors(last)
  const primary = anchors[0]
  const recurrence = primary === undefined ? 0 : anchorRecurrence(entries, gate, primary)
  const spentLadder = primary !== undefined && ladderSpent(entries, gate, primary)

  // 3 — the ladder is spent for this anchor.
  if (primary !== undefined && spentLadder && recurrence >= 1) {
    return {
      key: 'decide', rule: 'ladder-spent', anchor: primary,
      options: [
        { ...stopOpt, why: `${primary} has recurred across budget windows and the upstream reset already happened for it — the stage above was re-authored and the finding survived, so the depth ladder is spent`, when: undefined, tradeoff: undefined },
        // Stale content takes the override away here as at `bound-stale`: `decide` refuses to
        // stamp bytes no battery read, and a block must not offer what its verb refuses (D129).
        ...(stale ? [] : [{ ...overrideOpt, when: 'the recurring finding comes from one lens while the content genuinely changed each round — that pattern is a lens problem, files a lens suspicion rather than a debt against the artifact' }]),
      ],
    }
  }

  // 4 — at the bound with a recurring anchor: escalate.
  if (atBound && primary !== undefined && recurrence >= 2) {
    return {
      key: 'decide', rule: 'bound-recurrence', anchor: primary,
      options: [
        option(up, 'root', { why: `${primary} survived ${recurrence} rounds across distinct reviewed shas — patching here has failed every time, and upstream is unspent for this anchor` }),
        ...(stale ? [] : [overrideOpt]),
        ...(repairGranted(entries, gate) ? [] : [repairOpt]),
        stopOpt,
        abandonOpt,
      ],
    }
  }

  // 5 — at the bound otherwise.
  if (atBound) {
    return {
      key: 'decide', rule: stale ? 'bound-stale' : 'bound', anchor: primary,
      options: [
        ...(stale ? [] : [option(d('--approve', '--override'), 'deferral', {
          why: `the round budget is spent (${spent} of ${budget}) and the gate will not run again; nothing below the bound remains`,
          tradeoff: overrideOpt.tradeoff,
        })]),
        ...(stale
          ? [option(up, 'root', { why: 'verdict and content disagree, so --approve is not offered — no battery read the current bytes — and the gate will not re-run' })]
          : [option(up, 'root', { when: 'the parent artifact is what is wrong', tradeoff: 'reopens the parent stage and resets this budget' })]),
        ...(repairGranted(entries, gate) ? [] : [repairOpt]),
        stopOpt,
        abandonOpt,
      ],
    }
  }

  // 6 — recurrence below the bound: escalate, patch-again becomes the alternative.
  if (primary !== undefined && recurrence >= 2) {
    return {
      key: 'decide', rule: `anchor-recurrence-${recurrence}`, anchor: primary,
      options: [
        option(up, 'root', { why: `${primary} was found in ${recurrence} rounds across distinct reviewed shas — one honest fix already failed at this seam, so the likelier fault is above it` }),
        option(note, 'root', { when: 'the previous fix was the wrong fix and you now know the right one', tradeoff: `spends ${rounds}; recurring again leaves only the endgame set` }),
        overrideOpt,
        stopOpt,
      ],
    }
  }

  // 7 — a pin contradiction is a standing stop with its own handling.
  const pinned = (last.verdicts ?? []).flatMap((rv) => rv.findings).find((f) => f.contradicts_pin !== undefined)
  if (pinned !== undefined) {
    return {
      key: 'decide', rule: 'pin-contradiction',
      options: [
        option(note, 'root', { why: `a finding contradicts policy pin #${pinned.contradicts_pin} — the gate escalated the conflict rather than burning a round on it, and only you can settle which side holds` }),
        option(d('--approve'), 'root', { when: 'the pin still holds and the finding is the thing that is wrong', tradeoff: 'the lens will raise it again on the next round unless the pin is restated' }),
        ...upAlt('the pin itself is what should change, and it was set at the stage above',
          'reopens the parent stage and resets this budget'),
        stopOpt,
      ],
    }
  }

  // 8 / 9 — blocking findings, by where they anchor.
  if (anchors.length > 0) {
    return parentAnchored(anchors, upstream)
      ? {
          key: 'decide', rule: 'blocking-parent', anchor: primary,
          options: [
            option(up, 'root', { why: `${anchors.length} of ${anchors.length} blocking findings anchor to ${upstream}, not to this artifact — it is faithful to a parent that is wrong` }),
            option(note, 'root', { when: 'this artifact can route around the parent gap without the parent changing', tradeoff: 'leaves the parent wrong for everything else that derives from it' }),
            overrideOpt,
            stopOpt,
          ],
        }
      : {
          key: 'decide', rule: 'blocking-here', anchor: primary,
          options: [
            option(note, 'root', { why: `${anchors.length} blocking finding${anchors.length === 1 ? '' : 's'} anchored inside this artifact (${anchors.slice(0, 2).join(', ')}); ${rounds}` }),
            ...upAlt('the finding is only true because the parent asks for something unbuildable here',
              'reopens the parent stage and resets this budget; a wrong upstream spends a whole stage cycle'),
            overrideOpt,
            stopOpt,
          ],
        }
  }

  const checksFailed = last.checks.filter((c) => !c.ok)
  const nonBlocking = (last.verdicts ?? []).flatMap((rv) => rv.findings).length

  // 9a — waivable (row 274, the map's C26). Every failed check is the judge's to book and no finding
  // blocks: the revise removes the switch-off and leads; each check's booking keeps it on record for this
  // plan; the approve takes it over the red and books nothing (row 93), so ship meets it again. The
  // policy hands the rule to the arbiter (`policyFor`): whether a switch-off is right as it stands is a
  // judgment, not a rule.
  if (checksFailed.length > 0 && checksFailed.every((c) => checkWaiver(c.name) === 'judge' && bookingsOf(last, c.name).length > 0)) {
    const lines = checksFailed.flatMap((c) => (c.offs ?? []).filter((o): o is LineOff => o.kind !== 'dropped' && o.count - (o.booked ?? 0) > 0))
    const tokens = [...new Set(lines.map((o) => visible(o.token)))]
    return {
      key: 'decide', rule: 'waivable',
      options: [
        option(note, 'root', {
          why: `${lines.length} switch-off line${lines.length === 1 ? '' : 's'} the plan adds (${tokens.join(', ')}) — no finding blocks · remove them, or book what is right as it stands; ${rounds}`,
        }),
        ...checksFailed.map((c) => option(d('--book', c.name), 'deferral', { when: bookWhen(c.name), tradeoff: bookTradeoff(c.name) })),
        ...upAlt('the switch-off is there because of what the stage above asked for',
          'reopens the parent stage and resets this budget'),
        option(d('--approve'), 'deferral', {
          when: 'the switch-off is right and you take it without booking it',
          tradeoff: 'stamps the artifact over the red check — nothing books it, so the next gate meets it again',
        }),
        stopOpt,
      ],
    }
  }

  // 9b — a deterministic check failed and no finding blocks (row 170). Before this rule such a
  // run fell to manual-stop, which recommended approve and blamed a --manual flag nobody set:
  // 31 of 31 manual-stop recommendations in fewhats were exactly this. A failed check is not a
  // reviewer's opinion, so the fix comes first and approving over it is the deferral.
  if (checksFailed.length > 0) {
    const names = checksFailed.map((c) => c.name)
    // amendment-ack is the one check an approve clears: approving IS the acknowledgement it
    // asks for (gates/decompose.ts). Alone, approve leads; beside any other failure, the fix
    // still comes first and the ack rides the approve that follows it.
    if (names.every((n) => n === 'amendment-ack')) {
      return {
        key: 'decide', rule: 'checks-failed',
        options: [
          option(d('--approve'), 'root', { why: `the one failed check is amendment-ack — a spec was amended under in-progress plans · approving is the acknowledgement it asks for; ${rounds}` }),
          option(note, 'root', { when: 'the amendment should not land under the in-progress plans as it stands', tradeoff: `costs ${rounds}; the gate re-runs on your edit` }),
          ...upAlt('what should change is the amendment the stage above made',
            'reopens the parent stage and resets this budget'),
          stopOpt,
        ],
      }
    }
    return {
      key: 'decide', rule: 'checks-failed',
      options: [
        option(note, 'root', { why: `${names.length} deterministic check${names.length === 1 ? '' : 's'} failed: ${names.join(' · ')} — no finding blocks · fix what the check names; ${rounds}` }),
        ...upAlt('the check fails because of what the stage above asked for',
          'reopens the parent stage and resets this budget'),
        option(d('--approve'), 'deferral', {
          when: 'the failing check is wrong or cannot pass for a reason outside this artifact',
          tradeoff: 'stamps the artifact over a failed deterministic check · no obligation is minted — the failure stays visible only until a later gate run passes the check',
        }),
        stopOpt,
      ],
    }
  }

  // 10 — non-blocking findings only.
  if (checksFailed.length === 0 && nonBlocking > 0) {
    return {
      key: 'decide', rule: 'non-blocking-only',
      options: [
        option(d('--approve'), 'root', { why: `${nonBlocking} finding${nonBlocking === 1 ? '' : 's'}, none blocking; all ${last.checks.length} checks green` }),
        option(note, 'root', { when: 'a non-blocking finding is one you want fixed before it becomes load-bearing', tradeoff: `spends ${rounds} on findings the battery already judged non-blocking` }),
        ...upAlt('the finding points at something the stage above got wrong',
          'reopens the parent stage and resets this budget'),
        stopOpt,
      ],
    }
  }

  // 11 — a reserved stop with clean evidence.
  if (checksFailed.length === 0 && last.standing !== undefined) {
    return {
      key: 'decide', rule: 'reserved-stop-clean',
      options: [
        option(d('--approve'), 'root', {
          why: `${last.checks.length} of ${last.checks.length} checks green, 0 findings — approve is what the evidence supports`,
          judgeFirst: RESERVED.has(gate)
            ? (gate === 'ship'
              ? 'whether this change should exist. The lenses judged the code against the plan; nothing judged the plan against the product, and no lens can'
              : 'the look itself — the critic judged canon-compliance and coverage, not whether this is the right design')
            : 'whether this cut is how you would ship it. Coverage is checked; the shape of the cut is not',
        }),
        option(note, 'root', { when: 'the evidence is right and the thing itself is wrong', tradeoff: `costs ${rounds}; the gate re-runs on your edit` }),
        ...upAlt('what is wrong is what this stage was ASKED to build, not how it was built',
          'reopens the parent stage and resets this budget; the work here waits on that cycle'),
        stopOpt,
      ],
    }
  }

  // 12 — stopped, clean, no standing stop: the --manual flag is the only reason.
  return {
    key: 'decide', rule: 'manual-stop',
    options: [
      option(d('--approve'), 'root', {
        why: `${last.checks.length - checksFailed.length} of ${last.checks.length} checks green, 0 blocking findings — nothing in the evidence stopped this round; the stop is the --manual flag armed for this run`,
      }),
      option(note, 'root', { when: 'you armed --manual because you expect the battery to miss something and you can name it', tradeoff: `spends ${rounds} on a round the evidence passed` }),
      ...upAlt('what you armed --manual to catch is a fault in the stage above',
        'reopens the parent stage and resets this budget'),
      stopOpt,
    ],
  }
}
