import { execSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { ensureTrusted } from './allowlist.js'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { mergeReports, reportFiles, type TestOutcome } from './junit.js'
import { ok, refuse, v, type Result } from './refusal.js'

export type RunnerConfig =
  | { mode: 'filtered'; template: string; reportGlob?: string }
  | { mode: 'full-suite'; reportGlob: string; suiteCmd: string }

export function runnerConfig(cfg: Config): Result<RunnerConfig> {
  const crit = (cfg.raw.criteria ?? {}) as Record<string, unknown>
  const runner = crit.runner
  if (typeof runner !== 'string' || runner.length === 0) {
    return refuse([v('criteria.runner', 'required', String(runner ?? 'absent'), 'a filtered template containing {id}, or full-suite')])
  }
  if (runner === 'full-suite') {
    const report = crit.report
    if (typeof report !== 'string') {
      return refuse([v('criteria.report', 'required', 'absent', 'junit:<glob> — full-suite mode reads merged junit reports')])
    }
    if (!report.startsWith('junit:')) {
      return refuse([v('criteria.report', 'report-format', report, 'junit:<glob> (only junit is supported)')])
    }
    const ship = (cfg.raw.ship ?? {}) as Record<string, unknown>
    if (typeof ship.test !== 'string' || ship.test.length === 0) {
      return refuse([v('ship.test', 'required', 'absent', 'the suite command full-suite mode executes')])
    }
    return ok({ mode: 'full-suite', reportGlob: report.slice('junit:'.length), suiteCmd: ship.test })
  }
  if (!runner.includes('{id}')) {
    return refuse([v('criteria.runner', 'no-id-placeholder', runner, 'template must interpolate {id} (or use full-suite)')])
  }
  const report = crit.report
  if (report !== undefined) {
    if (typeof report !== 'string' || !report.startsWith('junit:')) {
      return refuse([v('criteria.report', 'report-format', String(report), 'junit:<glob> (only junit is supported)')])
    }
    return ok({ mode: 'filtered', template: runner, reportGlob: report.slice('junit:'.length) })
  }
  return ok({ mode: 'filtered', template: runner })
}

export function criteriaExcludes(cfg: Config): string[] {
  const crit = (cfg.raw.criteria ?? {}) as Record<string, unknown>
  const extra = Array.isArray(crit.exclude) ? (crit.exclude as string[]).filter((g) => typeof g === 'string') : []
  return [`${cfg.paths.specs}/**`, `${cfg.paths.plans}/**`, '.witness/**', ...extra]
}

export interface RunOutcome {
  exitZero: boolean
  output: string
}

export function execCommand(runRoot: string, ctx: Ctx, cmd: string): RunOutcome {
  try {
    const out = execSync(cmd, { cwd: runRoot, env: ctx.env as NodeJS.ProcessEnv, stdio: 'pipe' })
    return { exitZero: true, output: String(out).slice(-4000) }
  } catch (e) {
    const err = e as { stdout?: unknown; stderr?: unknown }
    return { exitZero: false, output: `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`.slice(-4000) }
  }
}

export async function runFiltered(
  runRoot: string, ctx: Ctx, template: string, specId: string, trustRoot = runRoot,
): Promise<Result<RunOutcome>> {
  const trust = await ensureTrusted(trustRoot, ctx, template)
  if (trust !== 'trusted') {
    return refuse([v('criteria.runner', `untrusted-${trust}`, template,
      trust === 'blocked' ? 'allow interactively or set WITNESS_TRUST_CMDS=1' : 'trust was declined')])
  }
  return ok(execCommand(runRoot, ctx, template.replaceAll('{id}', specId)))
}

export async function runFullSuite(
  runRoot: string, ctx: Ctx, rc: Extract<RunnerConfig, { mode: 'full-suite' }>, trustRoot = runRoot,
): Promise<Result<{ run: RunOutcome; tests: TestOutcome[] }>> {
  const trust = await ensureTrusted(trustRoot, ctx, rc.suiteCmd)
  if (trust !== 'trusted') {
    return refuse([v('ship.test', `untrusted-${trust}`, rc.suiteCmd,
      trust === 'blocked' ? 'allow interactively or set WITNESS_TRUST_CMDS=1' : 'trust was declined')])
  }
  for (const f of reportFiles(runRoot, rc.reportGlob)) rmSync(join(runRoot, f))
  const run = execCommand(runRoot, ctx, rc.suiteCmd)
  const merged = mergeReports(runRoot, rc.reportGlob)
  if (!merged.ok) return merged
  return ok({ run, tests: merged.value })
}
