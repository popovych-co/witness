// Row 261. Ship's lint lane: every part of `ship.lint` runs on its own, whatever an earlier one
// did, so a red first part never hides what the others say. Parts take no turn (row 255).
//
// Row 263 (§3.2 base-red). A red part asks for the base's result by key (`baseLintKey`); missing
// while a drive holds the repo it is `pending` — red, as a red lint always was — and the key rides
// this check's `parts`, which the base-lint job owes. Red on the base too, a part with a bound
// reader is judged per diagnostic: only the plan's new ones are red. An opaque part, or a report
// either side could not read, is `not judged`, never green.
import { ensureTrusted } from './allowlist.js'
import { BASE_LINT, baseLintKey, baseLintResult } from './base-lint.js'
import type { Ctx } from './cli.js'
import type { Config, LintPart } from './config.js'
import { newDiagnostics, readPart, type Diagnostic } from './diagnostics.js'
import { jobReading } from './jobs.js'
import { boundReader } from './lint-parts.js'
import type { GateCheck, PartVerdict } from './rounds.js'
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

// Only a green part and a part red on the base with nothing new pass.
export const partPasses = (v: PartVerdict): boolean => v.state === 'green' || v.state === 'base-only'

const MAX_RULES = 20
const MAX_LISTED = 10

// A verdict and its detail segment. `untrusted` names a command trust did not grant (the part's,
// or its reader's when the judgment needed it); `newOnes` the plan's new diagnostics.
interface Judged { verdict: PartVerdict; untrusted?: { cmd: string; trust: string }; newOnes?: Diagnostic[] }

async function judge(root: string, wt: string, ctx: Ctx, cfg: Config, base: string, r: PartRun): Promise<Judged> {
  const part = r.part.name
  if (r.run === undefined) return { verdict: { part, state: 'untrusted' }, untrusted: { cmd: r.part.cmd, trust: r.trust } }
  if (r.run.exitZero) return { verdict: { part, state: 'green' } }
  const reader = boundReader(cfg, r.part)
  const key = baseLintKey(r.part, reader?.cmd, base)
  const reading = jobReading(root, { kind: BASE_LINT, key, shards: 1 })
  if (reading.state === 'pending') return { verdict: { part, state: 'pending', key } }
  if (reading.state === 'not-measured') return { verdict: { part, state: 'not-measured', key, why: reading.why } }
  const res = baseLintResult(reading.results[0])
  if (res === undefined) return { verdict: { part, state: 'not-measured', key, why: 'the base result is malformed' } }
  if (res.exit === 0) return { verdict: { part, state: 'red', key } }
  const notJudged = (why: string): Judged => ({ verdict: { part, state: 'not-judged', key, why } })
  if (res.unread !== undefined) return notJudged(`red on the base too — its diagnostics could not be read: ${res.unread}`)
  if (reader === undefined || res.read === undefined) return notJudged('red on the base too — no reader for this part')
  const trust = await ensureTrusted(root, ctx, reader.cmd)
  if (trust !== 'trusted') return { verdict: { part, state: 'untrusted', key }, untrusted: { cmd: reader.cmd, trust } }
  const here = readPart(wt, ctx, reader.tool, reader.cmd)
  if (!here.ok) {
    const first = here.violations[0]!
    return notJudged(`red on the base too — this tree's diagnostics could not be read: ${first.rule}: ${first.got}`)
  }
  // Slice 2 review M8: a red part whose reader finds nothing here is no evidence of "nothing new".
  if (here.value.length === 0) return notJudged("red on the base too — this tree's reader reported no error while the part is red")
  const fresh = newDiagnostics(here.value, new Map(Object.entries(res.read.keys)))
  if (fresh.length === 0) return { verdict: { part, state: 'base-only', key, base: res.read.total } }
  const rules = [...new Set(fresh.map((d) => d.rule))].sort().slice(0, MAX_RULES)
  return { verdict: { part, state: 'new', key, new: fresh.length, base: res.read.total, rules }, newOnes: fresh }
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
  switch (v.state) {
    case 'green': return plain ? r.part.cmd : `${name}: ok`
    case 'untrusted': return plain && r.run === undefined ? `${j.untrusted!.cmd}: ${j.untrusted!.trust}` : `${name}: ${j.untrusted!.cmd}: ${j.untrusted!.trust}`
    case 'red': return plain ? tail : `${name}: red — ${tail}`
    case 'base-only': return `${name}: ok — red on the base too, nothing new (${v.base} there)`
    case 'new': {
      const listed = j.newOnes!.slice(0, MAX_LISTED).map(at).join(' · ')
      const more = j.newOnes!.length > MAX_LISTED ? ` · and ${j.newOnes!.length - MAX_LISTED} more` : ''
      return `${name}: red — ${v.new} new beside the base's ${v.base}: ${listed}${more}`
    }
    case 'pending': return `${name}: red — the base's result is pending: drive lints the base, then run the gate again — ${tail}`
    case 'not-measured': return `${name}: red — the base is not measured: ${v.why} — ${tail}`
    case 'not-judged': return `${name}: red — not judged: ${v.why} — ${tail}`
  }
}

// `base` is the plan's base commit: a red part's base result is keyed by it.
export async function lintCheck(root: string, wt: string, ctx: Ctx, cfg: Config, base: string): Promise<GateCheck> {
  const parts = cfg.ship.lint
  if (parts === undefined) return { name: 'lint', ok: false, detail: 'ship.lint not configured' }
  const runs = await runParts(wt, root, ctx, parts)
  const judged: Judged[] = []
  for (const r of runs) judged.push(await judge(root, wt, ctx, cfg, base, r))
  const untrusted = judged.flatMap((j) => (j.untrusted !== undefined ? [j.untrusted.cmd] : []))
  return {
    name: 'lint',
    ok: judged.every((j) => partPasses(j.verdict)),
    detail: runs.map((r, i) => segment(r, judged[i]!)).join(' · '),
    ...(untrusted.length > 0 ? { untrusted } : {}),
    parts: judged.map((j) => j.verdict),
  }
}
