import type { Ctx } from './cli.js'
import type { Harness } from './harness.js'
import { SESSION_DEFAULT } from './model.js'
import { ok, refuse, type Result, type Violation } from './refusal.js'
import { invokeReviewerAsync, parseVerdictText, type InvokeExtras } from './reviewer.js'
import type { ReviewerVerdict } from './rounds.js'
import { parseVerdict, verdictViolations, type Reviewed } from './verdict.js'

export interface BatteryLens { name: string; prompt: string; reviewed: Reviewed }
export interface BatteryRun {
  verdicts: ReviewerVerdict[]                                    // battery order
  malformed: Array<{ reviewer: string; violations: Violation[] }> // battery order
  fallback: string[]   // chain ids any lens failed to invoke on · chain order · each once
  rerolled: string[]   // lens names that took the self-repair reroll · battery order
  model: string        // chain[highest rung any lens answered on] — chain[0] when none answered
}

interface LensRun {
  verdict?: ReviewerVerdict
  malformed?: Violation[]
  failedOn: number[]   // rungs this lens could not invoke on
  rung: number         // the rung it answered on
  rerolled: boolean
}

// Row 169. Every lens walks the fallback chain on its own, from the pin. One lens that fell
// back makes the whole round a fallback round: `model` is the highest rung anyone answered
// on, so `fellBack` holds exactly when the sequential battery would have held it (106/107).
async function runLens(
  ctx: Ctx, harness: Harness, chain: readonly string[], lens: BatteryLens, opts: { cwd: string } & InvokeExtras,
): Promise<Result<LensRun>> {
  let rung = 0
  let prompt = lens.prompt
  let rerolled = false
  const failedOn: number[] = []
  for (let attempt = 0; ; attempt++) {
    let answered: string | undefined
    for (;;) {
      const id = chain[rung]!
      const r = await invokeReviewerAsync(ctx, harness, {
        ...opts, prompt, model: id === SESSION_DEFAULT ? undefined : id, lens: lens.name,
      })
      if (r.ok) { answered = r.value.text; break }
      if (rung >= chain.length - 1) return refuse(r.violations)
      failedOn.push(rung)
      rung += 1
    }
    const rawR = parseVerdictText(answered)
    const parsedR = rawR.ok ? parseVerdict(rawR.value) : rawR
    const violations = parsedR.ok ? verdictViolations(parsedR.value, lens.reviewed) : parsedR.violations
    if (parsedR.ok && violations.length === 0) {
      return ok({
        verdict: { reviewer: lens.name, coverage: parsedR.value.coverage, findings: parsedR.value.findings },
        failedOn, rung, rerolled,
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
    return ok({ malformed: violations, failedOn, rung, rerolled })
  }
}

// Lenses launch together and are aggregated only once every one has settled, in battery
// order — the order a lens finishes in must never reach the journal. A lens that exhausts the
// chain refuses the whole gate, the first such lens in battery order speaking for it.
export async function runBattery(
  ctx: Ctx, harness: Harness, chain: readonly string[], lenses: readonly BatteryLens[],
  opts: { cwd: string } & InvokeExtras,
): Promise<Result<BatteryRun>> {
  const results = await Promise.all(lenses.map((l) => runLens(ctx, harness, chain, l, opts)))
  const runs: LensRun[] = []
  for (const r of results) {
    if (!r.ok) return refuse(r.violations)
    runs.push(r.value)
  }
  const failed = new Set(runs.flatMap((r) => r.failedOn))
  return ok({
    verdicts: runs.flatMap((r) => (r.verdict ? [r.verdict] : [])),
    malformed: runs.flatMap((r, i) => (r.malformed ? [{ reviewer: lenses[i]!.name, violations: r.malformed }] : [])),
    fallback: [...new Set(chain.filter((_, i) => failed.has(i)))],
    rerolled: lenses.filter((_, i) => runs[i]!.rerolled).map((l) => l.name),
    model: chain[Math.max(0, ...runs.map((r) => r.rung))]!,
  })
}
