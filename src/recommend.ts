import type { Entry } from './journal.js'
import {
  anchorRecurrence, boundReached, ladderSpent, lastGateRun, notePrefill, repairGranted,
  roundBudget, roundsSinceApprove, type GateRunEntry,
} from './rounds.js'

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
}

export interface Decision {
  key: string
  options: Option[]
  rule: string
  anchor?: string
}

// Commands are emitted raw (D120): `esc` would quote the `--note "…"` argument and the
// line would paste into a shell as an empty note.
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
}

const RESERVED = new Set(['ship', 'design'])

const blockingAnchors = (r: GateRunEntry): string[] =>
  (r.verdicts ?? []).flatMap((rv) => rv.findings.filter((f) => f.blocking)
    .map((f) => (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`)))

const opt = (command: string, depth: Depth, rest: Partial<Option> = {}): Option =>
  ({ command, depth, runnable: !/<[^>]+>/.test(command), ...rest })

// The rule table is an ORDERED FIRST-MATCH list (D121). The id of the rule that matched is
// what the journal records, so a wrong recommendation is attributable to one line here
// rather than to a weighting — and each rule is testable from one journal state.
// Order: malformed · stale-below-bound · ladder-spent · bound+recurrence · bound ·
//        recurrence · pin-contradiction · blocking-parent · blocking-here ·
//        non-blocking-only · reserved-stop-clean · manual-stop
export function recommend(ctx: GateContext): Decision | undefined {
  const { gate, target, entries, upstream, stale } = ctx
  const last = lastGateRun(entries, gate)
  if (!last) return undefined

  const d = `witness decide ${gate} ${target}`
  const up = upstream === undefined ? `${d} --revise --upstream <effort>` : `${d} --revise --upstream ${upstream}`
  const note = `${d} --revise --note "${notePrefill(entries, gate)}"`
  const atBound = boundReached(entries, gate)
  const budget = roundBudget(entries, gate)
  const spent = roundsSinceApprove(entries, gate)
  const rounds = `round ${spent} of ${budget}`

  const stopOpt = opt(`${d} --stop`, 'terminal', {
    when: 'this work should not continue as scoped',
    tradeoff: 'parks the flow — next stops offering it and reopening is an explicit act',
  })
  const overrideOpt = opt(`${d} --approve --override`, 'deferral', {
    when: 'you have read the finding and judge it wrong',
    tradeoff: 'stamps the artifact over a live blocking finding; mints an obligation that stays open in status until a later battery no longer reports it (the discharge)',
  })
  const repairOpt = opt(`${d} --revise --repair`, 'deferral', {
    when: 'the edit you just made is the fix and you want it verified rather than assumed',
    tradeoff: 'buys exactly one round; the discharge is that round passing, and the grant does not refresh until an approve, a revise-upstream or a passed run',
  })

  // 1 — malformed. D126 removed it from pendingDecision, so reaching here means a caller
  // asked anyway; answer with the acts that actually help rather than four dispositions.
  if (last.outcome === 'malformed') {
    return {
      key: 'next', rule: 'malformed-rerun',
      options: [
        opt(`witness gate ${gate} ${target}`, 'root', {
          why: `the battery emitted ${last.malformed?.length ?? 0} schema violation(s) and no verdict — this round judged nothing, and malformed rounds do not spend the budget, so re-running is free`,
          note: 'a second malformed round on the same pin and prompts trips malformed-streak, which names the config remedy',
        }),
        opt(`witness calibrate ${last.model} --only ${gate}`, 'root', {
          when: 'the battery has malformed more than once — the lens or the model is at fault, not the artifact',
          tradeoff: 'spends a calibration run; nothing about this artifact changes',
        }),
      ],
    }
  }

  // 2 — stale below the bound: no decision exists, the caller renders the re-gate act.
  if (stale && !atBound) return undefined

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
        { ...overrideOpt, when: 'the recurring finding comes from one lens while the content genuinely changed each round — that pattern is a lens problem, files a lens suspicion rather than a debt against the artifact' },
      ],
    }
  }

  // 4 — at the bound with a recurring anchor: escalate.
  if (atBound && primary !== undefined && recurrence >= 2) {
    return {
      key: 'decide', rule: 'bound-recurrence', anchor: primary,
      options: [
        opt(up, 'root', { why: `${primary} survived ${recurrence} rounds across distinct reviewed shas — patching here has failed every time, and upstream is unspent for this anchor` }),
        overrideOpt,
        ...(repairGranted(entries, gate) ? [] : [repairOpt]),
        stopOpt,
      ],
    }
  }

  // 5 — at the bound otherwise.
  if (atBound) {
    return {
      key: 'decide', rule: stale ? 'bound-stale' : 'bound', anchor: primary,
      options: [
        ...(stale ? [] : [opt(`${d} --approve --override`, 'deferral', {
          why: `the round budget is spent (${spent} of ${budget}) and the gate will not run again; nothing below the bound remains`,
          tradeoff: overrideOpt.tradeoff,
        })]),
        ...(stale
          ? [opt(up, 'root', { why: 'verdict and content disagree, so --approve is not offered — no battery read the current bytes — and the gate will not re-run' })]
          : [opt(up, 'root', { when: 'the parent artifact is what is wrong', tradeoff: 'reopens the parent stage and resets this budget' })]),
        ...(repairGranted(entries, gate) ? [] : [repairOpt]),
        stopOpt,
        opt(`witness abandon ${target}`, 'terminal', {
          when: 'this work should be discarded, not parked',
          tradeoff: 'irreversible — unlike --stop, nothing reopens it',
        }),
      ],
    }
  }

  // 6 — recurrence below the bound: escalate, patch-again becomes the alternative.
  if (primary !== undefined && recurrence >= 2) {
    return {
      key: 'decide', rule: `anchor-recurrence-${recurrence}`, anchor: primary,
      options: [
        opt(up, 'root', { why: `${primary} was found in ${recurrence} rounds across distinct reviewed shas — one honest fix already failed at this seam, so the likelier fault is above it` }),
        opt(note, 'root', { when: 'the previous fix was the wrong fix and you now know the right one', tradeoff: `spends ${rounds}; recurring again leaves only the endgame set` }),
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
        opt(note, 'root', { why: `a finding contradicts policy pin #${pinned.contradicts_pin} — the gate escalated the conflict rather than burning a round on it, and only you can settle which side holds` }),
        opt(`${d} --approve`, 'root', { when: 'the pin still holds and the finding is the thing that is wrong', tradeoff: 'the lens will raise it again on the next round unless the pin is restated' }),
        stopOpt,
      ],
    }
  }

  // 8 / 9 — blocking findings, by where they anchor.
  if (anchors.length > 0) {
    const parented = upstream !== undefined && anchors.every((a) => a.startsWith(`${upstream} `) || a.startsWith(`${upstream}>`))
    return parented
      ? {
          key: 'decide', rule: 'blocking-parent', anchor: primary,
          options: [
            opt(up, 'root', { why: `${anchors.length} of ${anchors.length} blocking findings anchor to ${upstream}, not to this artifact — it is faithful to a parent that is wrong` }),
            opt(note, 'root', { when: 'this artifact can route around the parent gap without the parent changing', tradeoff: 'leaves the parent wrong for everything else that derives from it' }),
            stopOpt,
          ],
        }
      : {
          key: 'decide', rule: 'blocking-here', anchor: primary,
          options: [
            opt(note, 'root', { why: `${anchors.length} blocking finding${anchors.length === 1 ? '' : 's'} anchored inside this artifact (${anchors.slice(0, 2).join(', ')}); ${rounds}` }),
            opt(up, 'root', { when: 'the finding is only true because the parent asks for something unbuildable here', tradeoff: 'reopens the parent stage and resets this budget; a wrong upstream spends a whole stage cycle' }),
            stopOpt,
          ],
        }
  }

  const checksFailed = last.checks.filter((c) => !c.ok)
  const nonBlocking = (last.verdicts ?? []).flatMap((rv) => rv.findings).length

  // 10 — non-blocking findings only.
  if (checksFailed.length === 0 && nonBlocking > 0) {
    return {
      key: 'decide', rule: 'non-blocking-only',
      options: [
        opt(`${d} --approve`, 'root', { why: `${nonBlocking} finding${nonBlocking === 1 ? '' : 's'}, none blocking; all ${last.checks.length} checks green` }),
        opt(note, 'root', { when: 'a non-blocking finding is one you want fixed before it becomes load-bearing', tradeoff: `spends ${rounds} on findings the battery already judged non-blocking` }),
        stopOpt,
      ],
    }
  }

  // 11 — a reserved stop with clean evidence.
  if (checksFailed.length === 0 && last.standing !== undefined) {
    return {
      key: 'decide', rule: 'reserved-stop-clean',
      options: [
        opt(`${d} --approve`, 'root', {
          why: `${last.checks.length} of ${last.checks.length} checks green, 0 findings — approve is what the evidence supports`,
          judgeFirst: RESERVED.has(gate)
            ? (gate === 'ship'
              ? 'whether this change should exist. The lenses judged the code against the plan; nothing judged the plan against the product, and no lens can'
              : 'the look itself — the critic judged canon-compliance and coverage, not whether this is the right design')
            : 'whether this cut is how you would ship it. Coverage is checked; the shape of the cut is not',
        }),
        opt(note, 'root', { when: 'the evidence is right and the thing itself is wrong', tradeoff: `costs ${rounds}; the gate re-runs on your edit` }),
        stopOpt,
      ],
    }
  }

  // 12 — stopped, clean, no standing stop: the --manual flag is the only reason.
  return {
    key: 'decide', rule: 'manual-stop',
    options: [
      opt(`${d} --approve`, 'root', {
        why: `${last.checks.length - checksFailed.length} of ${last.checks.length} checks green, 0 blocking findings — nothing in the evidence stopped this round; the stop is the --manual flag armed for this run`,
      }),
      opt(note, 'root', { when: 'you armed --manual because you expect the battery to miss something and you can name it', tradeoff: `spends ${rounds} on a round the evidence passed` }),
      stopOpt,
    ],
  }
}
