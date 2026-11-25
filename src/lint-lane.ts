// Row 261. Ship's lint lane: every part of `ship.lint` runs on its own, whatever an earlier one
// did, so a red first part never hides what the others say. Parts take no turn (row 255).
//
// Row 263 (§3.2 base-red). A red part asks for the base's result by key (`baseLintKey`); missing
// while a drive holds the repo it is `pending` — red, as a red lint always was — and the key rides
// this check's `parts`, which the base-lint job owes. Red on the base too, a part with a bound
// reader is judged per diagnostic: only the plan's new ones are red. An opaque part, or a report
// either side could not read, is `not judged`, never green.
//
// Row 270 (§3.2's waiver, §3.3; the map's C17, C19, C20). A red part with a bound reader reads the
// plan's own tree whatever its base, but `pending`: its errors are what a booking takes (`book`). The
// plan's own open bookings then apply: a whole one at the part's key covers whatever is not passing,
// until main moves; per-diagnostic ones cover exactly their keys, and anything further stays red.
import { ensureTrusted } from './allowlist.js'
import { BASE_LINT, baseLintKey, baseLintResult } from './base-lint.js'
import type { Ctx } from './cli.js'
import type { Config, LintPart } from './config.js'
import { diagnosticKey, keyCounts, newDiagnostics, readPart, type Diagnostic } from './diagnostics.js'
import { jobReading } from './jobs.js'
import { openItems, type CheckItem } from './ledger.js'
import { boundReader } from './lint-parts.js'
import { partPasses, type GateCheck, type PartVerdict } from './rounds.js'
import { execCommand, type RunOutcome } from './runner.js'
import { visible } from './toon.js'

export interface PartRun { part: LintPart; trust: 'trusted' | 'declined' | 'blocked'; run?: RunOutcome }

// Per part, in order: trust (checked at `trustRoot`, the primary checkout), then the run in `dir`.
export async function runParts(dir: string, trustRoot: string, ctx: Ctx, parts: readonly LintPart[]): Promise<PartRun[]> {
  const out: PartRun[] = []
  for (const part of parts) {
    const trust = await ensureTrusted(trustRoot, ctx, part.cmd)
    out.push(trust === 'trusted' ? { part, trust, run: execCommand(dir, ctx, part.cmd, { turn: false }) } : { part, trust })
  }
  return out
}

export { partPasses }

const MAX_RULES = 20
const MAX_LISTED = 10
// Row 270. Past this many distinct keys a part books whole: an item's subject rides the journal.
export const MAX_BOOK_KEYS = 500

// A verdict and its detail segment. `untrusted` names a command trust did not grant (the part's,
// or its reader's when the judgment needed it); `newOnes` the plan's diagnostics a booking takes
// (its new ones on a red base, all of them otherwise); `treeKeys` every key the plan's tree holds,
// once its reader read it.
interface Judged {
  verdict: PartVerdict; untrusted?: { cmd: string; trust: string }; newOnes?: Diagnostic[]; treeKeys?: ReadonlyMap<string, number>
}

const rulesOf = (ds: readonly Diagnostic[]): string[] => [...new Set(ds.map((d) => d.rule))].sort().slice(0, MAX_RULES)
const total = (m: Readonly<Record<string, number>>): number => Object.values(m).reduce((a, n) => a + n, 0)

function bookOf(ds: readonly Diagnostic[]): Record<string, number> | undefined {
  const counts = keyCounts(ds)
  return counts.size >= 1 && counts.size <= MAX_BOOK_KEYS ? Object.fromEntries(counts) : undefined
}

type Reader = ReturnType<typeof boundReader>

// Row 270 (C20). A red part whose base gave no per-diagnostic judgment — green, not measured, red
// but unreadable or unread — reads the plan's own tree with its bound reader: every error there is
// what a booking takes, and on a green base the plan's red. A reader trust has not granted makes the
// part `untrusted`, as the base-red path does. A report that cannot be read, or holds no error while
// the part is red (slice 2 review M8), leaves the part to book whole.
async function readPlanTree(root: string, wt: string, ctx: Ctx, reader: Reader, j: Judged): Promise<Judged> {
  if (reader === undefined) return j
  const trust = await ensureTrusted(root, ctx, reader.cmd)
  if (trust !== 'trusted') {
    return { verdict: { part: j.verdict.part, state: 'untrusted', ...(j.verdict.key !== undefined ? { key: j.verdict.key } : {}) }, untrusted: { cmd: reader.cmd, trust } }
  }
  const here = readPart(wt, ctx, reader.tool, reader.cmd)
  if (!here.ok || here.value.reported === 0) return j
  const all = here.value.diagnostics
  const book = bookOf(all)
  const counted = j.verdict.state === 'red' && all.length > 0 ? { new: all.length, rules: rulesOf(all) } : {}
  return { verdict: { ...j.verdict, ...counted, ...(book !== undefined ? { book } : {}) }, newOnes: all, treeKeys: keyCounts(all) }
}

async function judge(root: string, wt: string, ctx: Ctx, cfg: Config, base: string, r: PartRun): Promise<Judged> {
  const reader = boundReader(cfg, r.part)
  const j = await judgeBase(root, wt, ctx, cfg, base, r, reader)
  return j.read ? j.judged : readPlanTree(root, wt, ctx, reader, j.judged)
}

// T2c's judgment against the base. `read` once the plan's tree was read against a red base's keys
// (or the part needs no reading: green, untrusted, pending).
async function judgeBase(root: string, wt: string, ctx: Ctx, cfg: Config, base: string, r: PartRun, reader: Reader):
Promise<{ judged: Judged; read: boolean }> {
  const done = (judged: Judged) => ({ judged, read: true })
  const open = (judged: Judged) => ({ judged, read: false })
  const part = r.part.name
  if (r.run === undefined) return done({ verdict: { part, state: 'untrusted' }, untrusted: { cmd: r.part.cmd, trust: r.trust } })
  if (r.run.exitZero) return done({ verdict: { part, state: 'green' } })
  const key = baseLintKey(r.part, reader?.cmd, base)
  const reading = jobReading(root, { kind: BASE_LINT, key, shards: 1 })
  // Final review: with scratch runs off (an older file read in memory) no drive can lint the base,
  // so a missing result is not measured — `pending` would promise a run that never comes.
  if (reading.state === 'pending' && cfg.scratch.prepare === undefined) {
    return open({ verdict: { part, state: 'not-measured', key, why: 'scratch runs are off — scratch.prepare is not set · witness migrate proposes one' } })
  }
  if (reading.state === 'pending') return done({ verdict: { part, state: 'pending', key } })
  if (reading.state === 'not-measured') return open({ verdict: { part, state: 'not-measured', key, why: reading.why } })
  const res = baseLintResult(reading.results[0])
  if (res === undefined) return open({ verdict: { part, state: 'not-measured', key, why: 'the base result is malformed' } })
  if (res.exit === 0) return open({ verdict: { part, state: 'red', key } })
  const notJudged = (why: string): Judged => ({ verdict: { part, state: 'not-judged', key, why } })
  if (res.unread !== undefined) return open(notJudged(`red on the base too — its diagnostics could not be read: ${res.unread}`))
  if (reader === undefined || res.read === undefined) return open(notJudged('red on the base too — no reader for this part'))
  const trust = await ensureTrusted(root, ctx, reader.cmd)
  if (trust !== 'trusted') return done({ verdict: { part, state: 'untrusted', key }, untrusted: { cmd: reader.cmd, trust } })
  const here = readPart(wt, ctx, reader.tool, reader.cmd)
  if (!here.ok) {
    const first = here.violations[0]!
    return done(notJudged(`red on the base too — this tree's diagnostics could not be read: ${first.rule}: ${first.got}`))
  }
  // Slice 2 review M8: a red part whose reader reports nothing here is no evidence of "nothing new".
  // Errors it reported on witness's own paths only are evidence (slice 3 review): they are dropped
  // on both trees, and the part reads base-only.
  if (here.value.reported === 0) return done(notJudged("red on the base too — this tree's reader reported no error while the part is red"))
  const treeKeys = keyCounts(here.value.diagnostics)
  const fresh = newDiagnostics(here.value.diagnostics, new Map(Object.entries(res.read.keys)))
  if (fresh.length === 0) return done({ verdict: { part, state: 'base-only', key, base: res.read.total }, treeKeys })
  const book = bookOf(fresh)
  return done({
    verdict: { part, state: 'new', key, new: fresh.length, base: res.read.total, rules: rulesOf(fresh), ...(book !== undefined ? { book } : {}) },
    newOnes: fresh, treeKeys,
  })
}

// The first `drop.get(key)` diagnostics of each key left out: what a per-diagnostic booking covers.
function less(ds: readonly Diagnostic[], drop: ReadonlyMap<string, number>): Diagnostic[] {
  const taken = new Map<string, number>()
  return ds.filter((d) => {
    const k = diagnosticKey(d)
    const n = taken.get(k) ?? 0
    if (n >= (drop.get(k) ?? 0)) return true
    taken.set(k, n + 1)
    return false
  })
}

const subjectKeys = (i: CheckItem): string[] => ('diagnostics' in i.subject ? Object.keys(i.subject.diagnostics) : [])

// Row 270 (C17, C19). `onPart` is every open item on this part. `cleared` names the per-diagnostic
// ones, of any plan, whose every key this tree lacks: the merge stamp's observation. The plan's own
// items then apply: a whole one at the part's key makes any state but a passing one or `untrusted`
// read `booked`; per-diagnostic ones take their keys out of `book`, and nothing left reads `booked`.
function applyBookings(j: Judged, onPart: readonly CheckItem[], plan: string): Judged {
  const tree = j.treeKeys
  const cleared = tree === undefined ? []
    : onPart.filter((i) => 'diagnostics' in i.subject && subjectKeys(i).every((k) => !tree.has(k))).map((i) => i.id)
  const seen = (x: Judged): Judged => (cleared.length > 0 ? { ...x, verdict: { ...x.verdict, cleared } } : x)
  const v = j.verdict
  if (partPasses(v) || v.state === 'untrusted') return seen(j)
  const mine = onPart.filter((i) => i.plan === plan)
  const booked = { part: v.part, state: 'booked' as const, ...(v.key !== undefined ? { key: v.key } : {}) }
  const whole = mine.find((i) => 'whole' in i.subject && v.key !== undefined && i.part_key === v.key)
  if (whole !== undefined) return seen({ verdict: { ...booked, items: [whole.id] } })
  const want = v.book
  if (want === undefined) return seen(j)
  const applied = mine.filter((i) => subjectKeys(i).some((k) => Object.hasOwn(want, k)))
  if (applied.length === 0) return seen(j)
  const drop = new Map<string, number>()
  for (const i of applied) {
    if ('diagnostics' in i.subject) for (const [k, n] of Object.entries(i.subject.diagnostics)) drop.set(k, (drop.get(k) ?? 0) + n)
  }
  const rest: Record<string, number> = {}
  for (const [k, n] of Object.entries(want)) if (n > (drop.get(k) ?? 0)) rest[k] = n - (drop.get(k) ?? 0)
  const covered = total(want) - total(rest)
  const items = applied.map((i) => i.id)
  if (total(rest) === 0) return seen({ verdict: { ...booked, booked: covered, items } })
  const newOnes = j.newOnes === undefined ? undefined : less(j.newOnes, drop)
  const counted = (v.state === 'red' || v.state === 'new') && newOnes !== undefined ? { new: newOnes.length, rules: rulesOf(newOnes) } : {}
  return seen({ ...j, verdict: { ...v, ...counted, book: rest, booked: covered, items }, ...(newOnes !== undefined ? { newOnes } : {}) })
}

const at = (d: Diagnostic): string =>
  `${d.file === '' ? '-' : visible(d.file)}${d.line !== undefined ? `:${d.line}` : ''} ${visible(d.rule)}`

// A plain command's part (source `ship.lint`) reads as 0.30's lane did: its command when green, its
// output's tail when red, `<cmd>: <trust>` untrusted. A named part prefixes its name. A red part whose
// base gives no judgment still shows its own output, so the author sees what is red.
function segment(r: PartRun, j: Judged): string {
  const plain = r.part.source === 'ship.lint'
  const name = r.part.name
  const tail = r.run?.output.slice(-300) ?? ''
  const v = j.verdict
  const listed = (ds: readonly Diagnostic[]) =>
    `${ds.slice(0, MAX_LISTED).map(at).join(' · ')}${ds.length > MAX_LISTED ? ` · and ${ds.length - MAX_LISTED} more` : ''}`
  // Row 270: the ledger items applied, as witness minted them — spelled out all the same.
  const ids = `(${(v.items ?? []).map(visible).join(', ')})`
  const also = v.booked !== undefined && v.state !== 'booked' ? ` · ${v.booked} booked ${ids}` : ''
  switch (v.state) {
    case 'green': return plain ? r.part.cmd : `${name}: ok`
    case 'untrusted': return plain && r.run === undefined ? `${j.untrusted!.cmd}: ${j.untrusted!.trust}` : `${name}: ${j.untrusted!.cmd}: ${j.untrusted!.trust}`
    case 'red':
      if (plain) return tail
      return j.newOnes !== undefined && j.newOnes.length > 0
        ? `${name}: red — ${v.new} new, the base green: ${listed(j.newOnes)}${also}`
        : `${name}: red — ${tail}`
    case 'base-only': return `${name}: ok — red on the base too, nothing new (${v.base} there)`
    case 'new': return `${name}: red — ${v.new} new beside the base's ${v.base}: ${listed(j.newOnes!)}${also}`
    case 'pending': return `${name}: red — the base's result is pending: drive lints the base, then run the gate again — ${tail}`
    case 'not-measured': return `${name}: red — the base is not measured: ${v.why}${also} — ${tail}`
    case 'not-judged': return `${name}: red — not judged: ${v.why}${also} — ${tail}`
    case 'booked': return v.booked === undefined
      ? `${name}: ok — booked whole until main moves ${ids}`
      : `${name}: ok — booked: ${v.booked} diagnostic${v.booked === 1 ? '' : 's'} ${ids}`
  }
}

// `base` is the plan's base commit: a red part's base result is keyed by it. `plan` names whose
// bookings waive (row 270, C17): only the plan's own open items, read from the root's ledger.
export async function lintCheck(root: string, wt: string, ctx: Ctx, cfg: Config, base: string, plan: string): Promise<GateCheck> {
  const parts = cfg.ship.lint
  if (parts === undefined) return { name: 'lint', ok: false, detail: 'ship.lint not configured' }
  const runs = await runParts(wt, root, ctx, parts)
  const open = openItems(root)
  const judged: Judged[] = []
  for (const r of runs) {
    // M-g (T2e slice 3): a part reads lint's own items alone, never another kind or check.
    judged.push(applyBookings(await judge(root, wt, ctx, cfg, base, r),
      open.filter((i): i is CheckItem => i.kind === 'booked-check' && i.check === 'lint' && i.part === r.part.name), plan))
  }
  const untrusted = judged.flatMap((j) => (j.untrusted !== undefined ? [j.untrusted.cmd] : []))
  return {
    name: 'lint',
    ok: judged.every((j) => partPasses(j.verdict)),
    detail: runs.map((r, i) => segment(r, judged[i]!)).join(' · '),
    ...(untrusted.length > 0 ? { untrusted } : {}),
    parts: judged.map((j) => j.verdict),
  }
}
