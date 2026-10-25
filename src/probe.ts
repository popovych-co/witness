import { resolveSpawn, spawnSync } from './spawn.js'

// Revision 3. The old form passed no `env`, so it silently answered about process.env
// while reviewer.ts:133 spawns `claude` with `env: ctx.env` — two different questions,
// one answer. It also made the finding untestable: helpers.ts runs main() in-process,
// so a test can control ctx.env and nothing else.
//
// Row 164, the same argument one level down: the probe starts the binary through
// resolveSpawn, exactly as a gate will — a probe that resolved differently would call a
// `.cmd` shim missing while the gate ran it. spawnSync, not execFileSync, whose typings
// omit windowsVerbatimArguments; the question is unchanged: did it start and exit 0.
export function probe(cmd: string, args: string[], env: Record<string, string | undefined>): boolean {
  const run = resolveSpawn(cmd, args, env)
  if (!run.ok) return false
  const r = spawnSync(run.value.file, run.value.args, {
    stdio: 'ignore', env: run.value.env as NodeJS.ProcessEnv, windowsVerbatimArguments: run.value.windowsVerbatimArguments,
  })
  return r.error === undefined && r.status === 0
}
