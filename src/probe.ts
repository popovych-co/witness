import { execFileSync } from 'node:child_process'

// Revision 3. The old form passed no `env`, so it silently answered about process.env
// while reviewer.ts:113 spawns `claude` with `env: ctx.env` — two different questions,
// one answer. It also made the finding untestable: helpers.ts runs main() in-process,
// so a test can control ctx.env and nothing else.
export function probe(cmd: string, args: string[], env: Record<string, string | undefined>): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', env: env as NodeJS.ProcessEnv })
    return true
  } catch {
    return false
  }
}
