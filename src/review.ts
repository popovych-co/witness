import type { Ctx } from './cli.js'
import { loadLocalConfig, type Config } from './config.js'
import { runBattery } from './battery.js'
import {
  assertReads, batteryFor, gateLenses, gateSetup, gateSpec, lensPrompt, type ChangeClass, type GateName,
} from './gate.js'
import { resolveJudge } from './harness.js'
import { readStream } from './journal.js'
import { stageModel, unansweredPin } from './model.js'
import { ok, refuse, type Result } from './refusal.js'
import { promptsSha } from './reviewer.js'
import {
  answersKey, fellBack, gateRuns, keyOf, type GateKey, type GateRunEntry, type ReviewerVerdict,
} from './rounds.js'
import { anchorMenu, type Reviewed } from './verdict.js'
import { version } from './version.js'

// Row 215. A gate's question asked on demand: the same battery, lenses, docs, setup, pin and
// harness as the gate, and the same prompt a full round would send — journaled nowhere. Advice,
// never evidence: no gate, stamp, recommendation, arbiter or settle pass reads what it returns.
export interface ReviewInput { cls: ChangeClass; reviewedSha: string; reviewed: Reviewed; promptBody: string }
export interface ReviewRun {
  model: string
  verdicts: ReviewerVerdict[]
  malformed: NonNullable<GateRunEntry['malformed']>
  answered?: { round: number; run: string }                       // D3 replay
  earlier?: { round: number; why: string; blocking: number }     // D3 `earlier:`
}

const blockingIn = (verdicts: readonly ReviewerVerdict[]): number =>
  verdicts.flatMap((rv) => rv.findings).filter((f) => f.blocking).length

export async function reviewOnce(
  ctx: Ctx, root: string, cfg: Config, gate: GateName, target: string, input: ReviewInput,
): Promise<Result<ReviewRun>> {
  const spec = gateSpec(gate)
  if (!spec) throw new Error(`review: no gate named ${gate} is registered`)
  const batteryR = batteryFor(cfg, gate, input.cls)
  if (!batteryR.ok) return refuse(batteryR.violations)
  const battery = batteryR.value
  const lensesR = gateLenses(root, cfg, gate, battery)
  if (!lensesR.ok) return refuse(lensesR.violations)
  const lenses = lensesR.value
  assertReads(spec, input.reviewed)                                   // row 216, before any lens runs
  const entries = readStream(root, target)
  const setup = gateSetup(root, spec, entries, battery)
  const hxR = resolveJudge(ctx.env, cfg.harness)
  if (!hxR.ok) return refuse(hxR.violations)
  const harness = hxR.value.harness
  const localR = loadLocalConfig(root)
  if (!localR.ok) return refuse(localR.violations)
  const modelR = stageModel(cfg, gate)
  if (!modelR.ok) return refuse(modelR.violations)
  const pin = modelR.value

  // D3. The gate's own key for these bytes under this setup. A full answer on it is not asked
  // again; a delta round, or a cached replay of one, answered a narrower question.
  const key: GateKey = {
    reviewed_sha: input.reviewedSha, gate, prompts_sha: promptsSha(lenses, setup.text || undefined), pin,
    witness: version(), harness: harness.name,
  }
  const runs = gateRuns(entries, gate).reverse()
  const replay = runs.find((r) => answersKey(r, key) && r.delta === undefined)
  if (replay) {
    return ok({ model: replay.model, verdicts: replay.verdicts ?? [], malformed: [], answered: { round: replay.round, run: replay.run_id } })
  }
  const judged = runs.find((r) => r.reviewed_sha === input.reviewedSha && r.outcome !== 'malformed' && (r.verdicts?.length ?? 0) > 0)
  let earlier: ReviewRun['earlier']
  if (judged) {
    const k = keyOf(judged)
    const fields = [
      k.witness !== key.witness ? 'witness' : '', k.pin !== key.pin ? 'pin' : '',
      k.harness !== key.harness ? 'harness' : '', k.prompts_sha !== key.prompts_sha ? 'prompts' : '',
    ].filter((f) => f !== '').join(' · ')
    const why = judged.delta !== undefined ? 'in delta mode'
      : fellBack(judged) ? 'under another setup (pin)' : `under another setup (${fields})`
    earlier = { round: judged.round, why, blocking: blockingIn(judged.verdicts ?? []) }
  }

  // A review is always a full review (row 185): no delta block, whatever the journal holds.
  const composed = lenses.map((lens) => ({
    name: lens.name, reviewed: input.reviewed,
    prompt: lensPrompt(lens, setup.forLens(lens.name), anchorMenu(input.reviewed), input.promptBody),
  }))
  const pinField = `gates.${gate}.model`
  const ranR = await runBattery(ctx, harness, pin, composed, {
    cwd: root, pinField, timeoutMs: cfg.gates.reviewerTimeoutMs, extensions: localR.value.reviewerExtensions,
  })
  if (!ranR.ok) return refuse(unansweredPin(ranR.violations, pinField, pin, harness.name))
  return ok({ model: pin, verdicts: ranR.value.verdicts, malformed: ranR.value.malformed, ...(earlier ? { earlier } : {}) })
}
