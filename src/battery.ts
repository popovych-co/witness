import type { Ctx } from './cli.js'
import type { Harness } from './harness.js'
import { SESSION_DEFAULT } from './model.js'
import { ok, refuse, type Result, type Violation } from './refusal.js'
import { invokeReviewerAsync, parseVerdictText, toolsFor, type InvokeExtras } from './reviewer.js'
import type { ReviewerVerdict } from './rounds.js'
import { parseVerdict, verdictViolations, type Reviewed } from './verdict.js'

export interface BatteryLens { name: string; prompt: string; reviewed: Reviewed }
export interface BatteryRun {
  verdicts: ReviewerVerdict[]                                    // battery order
  malformed: Array<{ reviewer: string; violations: Violation[] }> // battery order
  rerolled: string[]   // lens names that took the self-repair reroll · battery order
}

interface LensRun {
  verdict?: ReviewerVerdict
  malformed?: Violation[]
  rerolled: boolean
}

// Row 169, amended by row 212: every lens is asked on the stage's one model, and a lens that
// cannot be invoked refuses at once — there is no stand-in to fall back to.
async function runLens(
  ctx: Ctx, harness: Harness, model: string, lens: BatteryLens, opts: { cwd: string; pinField?: string } & InvokeExtras,
): Promise<Result<LensRun>> {
  let prompt = lens.prompt
  let rerolled = false
  for (let attempt = 0; ; attempt++) {
    const r = await invokeReviewerAsync(ctx, harness, {
      ...opts, prompt, model: model === SESSION_DEFAULT ? undefined : model, lens: lens.name,
      tools: toolsFor(lens.reviewed),          // row 217: read-only file tools only for content named by path
    })
    if (!r.ok) return refuse(r.violations)
    const rawR = parseVerdictText(r.value.text)
    const parsedR = rawR.ok ? parseVerdict(rawR.value) : rawR
    const violations = parsedR.ok ? verdictViolations(parsedR.value, lens.reviewed) : parsedR.violations
    if (parsedR.ok && violations.length === 0) {
      return ok({
        verdict: { reviewer: lens.name, coverage: parsedR.value.coverage, findings: parsedR.value.findings },
        rerolled,
      })
    }
    if (attempt === 0) {
      // one self-repair reroll per reviewer — a single flaky verdict would
      // otherwise poison the whole round as 'malformed'; the reroll is not
      // part of the gate key, so cached rounds replay the settled result
      rerolled = true
      prompt += `\n## Previous attempt rejected\n\n${
        violations.map((x) => `- ${x.field}: ${x.rule} — got ${x.got}; want ${x.want}`).join('\n')
      }\n\nRe-emit the complete corrected verdict JSON.\n`
      continue
    }
    return ok({ malformed: violations, rerolled })
  }
}

// Lenses launch together and are aggregated only once every one has settled, in battery
// order — the order a lens finishes in must never reach the journal. A lens that cannot be
// invoked refuses the whole gate (row 212), the first such lens in battery order speaking
// for it.
export async function runBattery(
  ctx: Ctx, harness: Harness, model: string, lenses: readonly BatteryLens[],
  opts: { cwd: string; pinField?: string } & InvokeExtras,
): Promise<Result<BatteryRun>> {
  const results = await Promise.all(lenses.map((l) => runLens(ctx, harness, model, l, opts)))
  const runs: LensRun[] = []
  for (const r of results) {
    if (!r.ok) return refuse(r.violations)
    runs.push(r.value)
  }
  return ok({
    verdicts: runs.flatMap((r) => (r.verdict ? [r.verdict] : [])),
    malformed: runs.flatMap((r, i) => (r.malformed ? [{ reviewer: lenses[i]!.name, violations: r.malformed }] : [])),
    rerolled: lenses.filter((_, i) => runs[i]!.rerolled).map((l) => l.name),
  })
}
