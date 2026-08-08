import type { Ctx } from '../cli.js'
import { EXIT } from '../cli.js'
import { kv, rows } from '../toon.js'
import { renderRefusal, v } from '../refusal.js'
import { loadConfig, loadLocalConfig } from '../config.js'
import { resolveJudge } from '../harness.js'
import { MODEL_ALIASES } from '../model.js'
import { primaryRoot } from '../gitio.js'
import { PROMPT_NAMES } from '../reviewer.js'
import {
  addToLocalOverlay,
  publishScore,
  reportPass,
  runReviewerSuites,
  runSkillSuites,
  SKILL_NAMES,
  type CalReport,
} from '../calibrate.js'

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const args = [...argv]
  const flags = { suite: 'all', only: undefined as string | undefined, samples: 10, publish: false }
  const positional: string[] = []
  while (args.length > 0) {
    const a = args.shift() as string
    if (a === '--suite') flags.suite = args.shift() ?? ''
    else if (a === '--only') flags.only = args.shift()
    else if (a === '--samples') flags.samples = Number(args.shift() ?? '10')
    else if (a === '--publish') flags.publish = true
    else positional.push(a)
  }
  const model = positional[0]
  if (model === undefined || model === '') {
    for (const line of renderRefusal([v('model', 'required', '', 'witness calibrate <exact-model-id>')])) ctx.err(line)
    return EXIT.REFUSED
  }
  if ((MODEL_ALIASES as readonly string[]).includes(model)) {
    for (const line of renderRefusal([v('model', 'alias-refused', model, 'an exact model id')])) ctx.err(line)
    return EXIT.REFUSED
  }
  if (!['all', 'reviewers', 'skills'].includes(flags.suite)) {
    for (const line of renderRefusal([v('--suite', 'unknown-suite', flags.suite, 'all | reviewers | skills')])) ctx.err(line)
    return EXIT.REFUSED
  }

  let runReviewers = flags.suite === 'all' || flags.suite === 'reviewers'
  let runSkills = flags.suite === 'all' || flags.suite === 'skills'
  let reviewerOnly: string | undefined
  let skillOnly: string | undefined
  if (flags.only !== undefined) {
    if ((PROMPT_NAMES as readonly string[]).includes(flags.only)) {
      reviewerOnly = flags.only
      runReviewers = true
      runSkills = false
    } else if ((SKILL_NAMES as readonly string[]).includes(flags.only)) {
      skillOnly = flags.only
      runSkills = true
      runReviewers = false
    } else {
      const want = `reviewer: ${PROMPT_NAMES.join(' ')} · skill: ${SKILL_NAMES.join(' ')}`
      for (const line of renderRefusal([v('--only', 'unknown-name', flags.only, want)])) ctx.err(line)
      return EXIT.REFUSED
    }
  }

  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) {
    for (const line of renderRefusal(rootR.violations)) ctx.err(line)
    return EXIT.REFUSED
  }

  // Decision 88: calibration measures the (harness, model) pair — the same spawn the
  // gate battery will use. Resolved once, threaded into every suite and the overlay.
  const cfgR = loadConfig(rootR.value)
  const hxR = resolveJudge(ctx.env, cfgR.ok ? cfgR.value.raw : {})
  if (!hxR.ok) {
    for (const line of renderRefusal(hxR.violations)) ctx.err(line)
    return EXIT.REFUSED
  }
  const harness = hxR.value.harness
  // Row 89: calibration measures through the SAME spawn as the gate battery, declared
  // extensions included — a reviewer scored without its auth adapter is not the
  // reviewer production runs.
  const localR = loadLocalConfig(rootR.value)
  if (!localR.ok) {
    for (const line of renderRefusal(localR.violations)) ctx.err(line)
    return EXIT.REFUSED
  }
  const extras = {
    timeoutMs: cfgR.ok ? cfgR.value.gates.reviewerTimeoutMs : undefined,
    extensions: localR.value.reviewerExtensions,
  }

  const reviewers = runReviewers ? await runReviewerSuites(ctx, harness, model, flags.samples, reviewerOnly, extras) : undefined
  if (reviewers && !reviewers.ok) {
    for (const line of renderRefusal(reviewers.violations)) ctx.err(line)
    return EXIT.REFUSED
  }
  const skills = runSkills ? await runSkillSuites(ctx, harness, model, flags.samples, { only: skillOnly, extras }) : undefined
  if (skills && !skills.ok) {
    for (const line of renderRefusal(skills.violations)) ctx.err(line)
    return EXIT.REFUSED
  }

  const report: CalReport = { model, reviewers: reviewers?.value ?? [], skills: skills?.value ?? [] }
  ctx.out(kv('calibrate', model))
  if (report.reviewers.length > 0) {
    for (const line of rows('reviewers', ['reviewer', 'catch', 'clean', 'inject', 'pass'], report.reviewers.map((s) => ({
      reviewer: s.reviewer,
      catch: `${s.catches.ok}/${s.catches.total}`,
      clean: `${s.clean.ok}/${s.clean.total}`,
      inject: s.inject.total === 0 ? '-' : `${s.inject.ok}/${s.inject.total}`,
      pass: s.pass ? 'yes' : 'NO',
    })))) ctx.out(line)
  }
  if (report.skills.length > 0) {
    for (const line of rows('skills', ['skill', 'metric', 'score', 'pass'], report.skills.map((s) => ({
      skill: s.skill,
      metric: s.metric,
      score: `${s.ok}/${s.total}`,
      pass: s.pass ? 'yes' : 'NO',
    })))) ctx.out(line)
  }
  const pass = reportPass(report)
  ctx.out(kv('result', pass ? 'PASS' : 'FAIL'))
  if (!pass) return EXIT.FINDINGS
  addToLocalOverlay(rootR.value, model, harness.name)
  ctx.out(kv('overlay', `.witness/calibration.local.yaml + ${harness.name}/${model} (gate-runs stamp calibration: local)`))
  if (flags.publish) {
    const pub = publishScore(rootR.value, model, report)
    if (!pub.ok) {
      for (const line of renderRefusal(pub.violations)) ctx.err(line)
      return EXIT.REFUSED
    }
    ctx.out(kv('published', pub.value.path))
  }
  return EXIT.OK
}
