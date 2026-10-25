import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { ensureTrusted } from './allowlist.js'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { mergeReports, reportFiles, type TestOutcome } from './junit.js'
import { ok, refuse, v, type Result, type Violation } from './refusal.js'
import { withRunnerTurn } from './runner-lock.js'
import { execSync } from './spawn.js'

export type RunnerConfig =
  | { mode: 'filtered'; template: string; reportGlob?: string }
  | { mode: 'full-suite'; reportGlob: string; suiteCmd: string }

// The values' own shapes (a runner with {id}, a junit: report) are refused when the file loads
// (row 193); what is left is what only a combination says, and what an older file never set.
export function runnerConfig(cfg: Config): Result<RunnerConfig> {
  const { runner, report } = cfg.criteria
  if (runner === undefined) {
    return refuse([v('criteria.runner', 'required', 'absent', 'a filtered template containing {id}, or full-suite')])
  }
  if (runner === 'full-suite') {
    if (report === undefined) {
      return refuse([v('criteria.report', 'required', 'absent', 'junit:<glob> — full-suite mode reads merged junit reports')])
    }
    if (cfg.ship.test === undefined) {
      return refuse([v('ship.test', 'required', 'absent', 'the suite command full-suite mode executes')])
    }
    return ok({ mode: 'full-suite', reportGlob: report.slice('junit:'.length), suiteCmd: cfg.ship.test })
  }
  return report === undefined
    ? ok({ mode: 'filtered', template: runner })
    : ok({ mode: 'filtered', template: runner, reportGlob: report.slice('junit:'.length) })
}

export function criteriaExcludes(cfg: Config): string[] {
  return [`${cfg.paths.specs}/**`, `${cfg.paths.plans}/**`, '.witness/**', ...cfg.criteria.exclude]
}

export interface RunOutcome {
  exitZero: boolean
  output: string
}

export function execCommand(runRoot: string, ctx: Ctx, cmd: string): RunOutcome {
  return withRunnerTurn(runRoot, ctx, cmd, (env) => runCommand(runRoot, { ...ctx, env }, cmd))
}

function runCommand(runRoot: string, ctx: Ctx, cmd: string): RunOutcome {
  try {
    // D158. Suite stdout is unbounded and only the last 4000 chars are kept — but at
    // Node's 1 MiB default a chatty GREEN suite threw ENOBUFS into the catch and read
    // as a failed lane. 64 MiB: the same bound the reviewer spawn uses.
    const out = execSync(cmd, { cwd: runRoot, env: ctx.env as NodeJS.ProcessEnv, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })
    return { exitZero: true, output: String(out).slice(-4000) }
  } catch (e) {
    const err = e as { stdout?: unknown; stderr?: unknown }
    return { exitZero: false, output: `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`.slice(-4000) }
  }
}

// Row 171. The command a trust refusal names — `got` of the first `untrusted-*` row, which
// both runner refusals above and below set to the command itself.
export function untrustedOf(violations: readonly Violation[]): string | undefined {
  return violations.find((x) => x.rule.startsWith('untrusted-'))?.got
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
