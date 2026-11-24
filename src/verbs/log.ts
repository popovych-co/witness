import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { askText } from '../ask.js'
import { git, primaryRoot } from '../gitio.js'
import { canonExit } from '../departure.js'
import { isId } from '../dsl.js'
import { journalActs, readStream, streamExists, streamIds, type Entry, type ReviseReturnedEntry } from '../journal.js'
import { renderRefusal, v } from '../refusal.js'
import { findById, loadCanon } from '../scan.js'
import { short } from '../sha.js'
import { stepProgress, stepsLine } from '../steps.js'
import { kv, logSafe, rows } from '../toon.js'
import { decidedBy } from '../autonomy.js'
import { duration } from '../usage.js'
import type { DecisionEntry, GateRunEntry } from '../rounds.js'

// Row 214: drive's `journal:` lines print an act as `witness log` does. Rows 205, 244: a journal line
// is foreign text — a hand edit, a session's note, a reviewer's words — so every detail, in every
// branch, is spelled out through logSafe here, the one renderer both readers share: an escape
// sequence or a bidi override never reaches a terminal raw.
export function entryDetail(e: Entry): string {
  return logSafe(detailOf(e))
}

function detailOf(e: Entry): string {
  switch (e.t) {
    case 'recap': {
      const size = (k: string) => (Array.isArray(e[k]) ? (e[k] as unknown[]).length : 0)
      const decisions = size('decisions') > 0 ? ` decisions=${size('decisions')}` : ''
      return `class=${String(e.class)} goals=${size('goals')}${decisions} non_goals=${size('non_goals')} slices=${size('slices')}`
    }
    case 'write': {
      const covers = Array.isArray(e.covers) && e.covers.length ? ` covers=${(e.covers as string[]).join('+')}` : ''
      const carries = Array.isArray(e.carries) && e.carries.length ? ` carries=${(e.carries as string[]).join('+')}` : ''
      return `artifact=${String(e.artifact)} sha=${short(String(e.sha))}${covers}${carries}`
    }
    case 'write-refused': {
      const pairs = Array.isArray(e.rules)
        ? (e.rules as Array<{ field: string; rule: string }>).map((r) => `${r.field}:${r.rule}`).join('+')
        : ''
      return `artifact=${String(e.artifact)} rules=${pairs}`
    }
    case 'gate-run': {
      const g = e as unknown as GateRunEntry
      // Row 187: a round judged against an earlier one says so, and counts what it demoted.
      const demoted = (g.verdicts ?? []).flatMap((rv) => rv.findings).filter((f) => f.demoted !== undefined).length
      return `gate ${g.gate} r${g.round} ${g.outcome} @${g.reviewed_sha.slice(0, 7)}` +
        `${g.delta ? ` · delta since r${g.delta.round}` : ''}${demoted > 0 ? ` · ${demoted} demoted` : ''}`
    }
    case 'human-decision': {
      const d = e as unknown as DecisionEntry
      // Row 173: a decision nobody typed says who made it; a named human one reads as before.
      const by = d.selected !== undefined ? ` · ${decidedBy(d)}` : ''
      return `${d.gate}: ${d.decision}${by}${d.note ? ` — ${d.note.slice(0, 60)}` : ''}`
    }
    case 'test-evidence': {
      // Row 191 §4.3: a cycle names the plan step it closes; a fix round names none.
      const tests = Array.isArray(e.tests) ? (e.tests as Array<{ ok: boolean }>) : []
      const step = typeof e.step === 'string' ? ` step=${e.step}` : ''
      return `phase=${String(e.phase)}${step} tests=${tests.length} failed=${tests.filter((t) => !t.ok).length}` +
        `${e.vacuous === true ? ' vacuous' : ''}${e.reconstructed === true ? ' reconstructed' : ''}`
    }
    case 'step-close':
      return `step=${String(e.step)}`
    case 'ask':
      return `${String(e.id)} — ${askText(String(e.text))}`
    case 'status': {
      const s = e as unknown as { from: string; to: string; cause: string }
      return `${s.from} → ${s.to} (${s.cause})`
    }
    case 'cause': return `cause=${String(e.cause)}`   // row 253
    case 'job-shard': return `${String(e.kind)} ${String(e.key)} ${String(e.shard)}/${String(e.of)} ${String(e.outcome)} ${duration(Number(e.ms))}`   // row 257
    // Row 269: each ledger transition, named — the item, then what happened to it.
    case 'ledger-open': {
      const s = e.subject as { whole?: boolean; diagnostics?: Record<string, number> } | undefined
      const what = s?.whole === true ? 'whole part'
        : `${Object.values(s?.diagnostics ?? {}).reduce((a, n) => a + Number(n), 0)} diagnostics`
      return `${String(e.id)} booked ${String(e.check)} · ${String(e.part)} · ${String(e.plan)} ${String(e.gate)} r${String(e.round)} · ${what}`
    }
    case 'ledger-closed':
      return e.by === 'abandon'
        ? `${String(e.id)} closed — ${String(e.plan)} was abandoned`
        : `${String(e.id)} closed — gone at the merge of ${String(e.plan)}${e.pr === undefined ? '' : ` (pr #${String(e.pr)})`}`
    case 'ledger-dismissed': return `${String(e.id)} dismissed — ${String(e.cause)}: ${String(e.note)}`
    case 'revise-returned': {
      // Row 244: the author's hand-back of a revise (`gate --unchanged`), named as a decision is — the
      // gate, then what happened — with the run it hands back and whether it was `--manual`.
      const r = e as unknown as ReviseReturnedEntry
      return `${String(r.gate)}: handed back · run ${String(r.run_id)}${r.manual === true ? ' · manual' : ''}`
    }
    default: {
      // Row 191 §4.8: `ctx` is about the session that wrote the line, not what the line says.
      const { v: _v, t: _t, ctx: _ctx, ...rest } = e
      return JSON.stringify(rest).slice(0, 100)
    }
  }
}

// D166. Read through `canonExit`, the one reading of a departure: a re-slice that was taken
// back is no longer a lineage step. Rows 205, 239 (B15): `by` is parsed journal text, so the chain
// follows it only as a well-formed id — an ill-formed one (a path, a control character) ends the
// chain and is never read as a stream. A predecessor is a stream named as an id too.
function successorOf(root: string, id: string): string | undefined {
  const exit = canonExit(readStream(root, id))
  return exit?.to === 'superseded' && isId(exit.by) ? exit.by : undefined
}

function predecessorsOf(root: string, id: string): string[] {
  return streamIds(root).filter((s) => isId(s) && successorOf(root, s) === id)
}

export function lineageChain(root: string, id: string): string[] {
  const chain = [id]
  for (let cur = id; ; ) {
    const prev = predecessorsOf(root, cur)[0]
    if (!prev || chain.includes(prev)) break
    chain.unshift(prev); cur = prev
  }
  for (let cur = id; ; ) {
    const next = successorOf(root, cur)
    if (!next || chain.includes(next)) break
    chain.push(next); cur = next
  }
  return chain
}

function commitIndex(root: string): Map<string, number> {
  const map = new Map<string, number>()
  git(root, 'rev-list', '--reverse', 'HEAD').split('\n').filter(Boolean)
    .forEach((sha, i) => map.set(sha, i))
  return map
}

export function mergedRows(root: string): Array<{ stream: string; entry: Entry }> {
  const order = commitIndex(root)
  const rowsOut: Array<{ stream: string; entry: Entry; idx: number; lineNo: number }> = []
  for (const stream of streamIds(root)) {
    const entries = readStream(root, stream)
    const origins = journalActs(root, stream).map((a) => a.commit)
    entries.forEach((entry, lineNo) => {
      const sha = origins[lineNo]
      rowsOut.push({ stream, entry, lineNo, idx: sha !== undefined ? (order.get(sha) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER })
    })
  }
  rowsOut.sort((a, b) => a.idx - b.idx || a.stream.localeCompare(b.stream) || a.lineNo - b.lineNo)
  return rowsOut.map(({ stream, entry }) => ({ stream, entry }))
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { all: { type: 'boolean' }, lineage: { type: 'boolean' } },
    allowPositionals: true,
  })
  const id = positionals[0]
  if (!values.all && !id) {
    renderRefusal([v('id', 'required', 'absent', 'witness log <id> [--lineage] | witness log --all')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value

  if (values.all) {
    const merged = mergedRows(root)
    rows('all', ['n', 'stream', 't', 'detail'], merged.map((r, i) => ({ n: i + 1, stream: logSafe(r.stream), t: logSafe(String(r.entry.t)), detail: entryDetail(r.entry) })))
      .forEach(ctx.out)
    return EXIT.OK
  }

  if (values.lineage) {
    // a lineage member (e.g. a re-slice successor) may have no gate-run/status
    // activity of its own yet — walk the chain by journal existence on the *other*
    // streams rather than requiring id's own stream to exist.
    const chain = lineageChain(root, id!)
    // A stream's id is its file's name, which a commit can make anything: spelled out (row 205).
    ctx.out(`lineage: ${chain.map(logSafe).join(' → ')}`)
    const merged = chain.flatMap((sid) => readStream(root, sid).map((entry) => ({ stream: sid, entry })))
    rows('lineage', ['n', 'stream', 't', 'detail'], merged.map((r, i) => ({ n: i + 1, stream: logSafe(r.stream), t: logSafe(String(r.entry.t)), detail: entryDetail(r.entry) })))
      .forEach(ctx.out)
    return EXIT.OK
  }

  if (!streamExists(root, id!)) {
    renderRefusal([v('id', 'unknown-stream', id!, 'an artifact or effort with a journal stream')]).forEach(ctx.err)
    return EXIT.REFUSED
  }

  const entries = readStream(root, id!)
  rows('entries', ['n', 't', 'detail'], entries.map((e, i) => ({ n: i + 1, t: logSafe(String(e.t)), detail: entryDetail(e) })))
    .forEach(ctx.out)
  // Row 191 §4.3. A plan's stream ends with where the plan stands; an effort has no steps.
  const plan = findById(loadCanon(root), id!)
  if (plan?.meta.type === 'plan') ctx.out(kv('steps', stepsLine(stepProgress(plan, entries))))
  return EXIT.OK
}
