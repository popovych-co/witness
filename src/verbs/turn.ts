import { EXIT, type Ctx } from '../cli.js'
import { refuseClash } from '../clash.js'
import { contained, JOB_HOST_ENV, jobHost } from '../contain.js'
import { primaryRoot } from '../gitio.js'
import { renderRefusal } from '../refusal.js'
import { sayNoJob } from '../runner.js'
import { withRunnerTurn } from '../runner-lock.js'
import { resolveSpawn, spawnSync } from '../spawn.js'
import { worktreeFlow, worktreePath } from '../worktree.js'

// Row 218. The repo's test turn, for a test a session runs itself. Witness's own runs take turns
// in `execCommand` (row 181), but a session also runs its inner TDD loop, a probe test or a ship
// resolution's check, and those ran outside the turn: under `drive.parallelSuites: false` two
// worktrees' suites still met on what a machine has one of (a port, an installed build, a
// certificate). `witness turn -- <command> [args…]` runs the command in the turn — waiting while
// another worktree's run holds it — and on Windows inside a job, so whatever it starts ends
// with it; it exits with the command's code.
//
// Argv, never a shell: resolved as every harness CLI is (row 164), so an `npx` or `pnpm` shim
// starts on Windows. No trust grant: the command is the caller's own, not the repo config's.
// Rejected: a guard refusing test runs outside the turn — no rule tells a test command from any
// other, and the canon guard fails open on ambiguity (D133).
export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const cmd = argv[0] === '--' ? argv.slice(1) : argv
  const [file, ...args] = cmd
  if (file === undefined) {
    ctx.err('usage: witness turn -- <command> [args…]')
    return EXIT.REFUSED
  }
  // Row 243 (design §4.1.2). In a plan's worktree a turn is the session's test of that plan's tree,
  // so it is refused while a clash there is unresolved — before the turn is taken; the command never
  // runs. At the primary root, or anywhere outside a plan's worktree, no plan's kept refs apply.
  const rootR = primaryRoot(ctx.cwd)
  const planId = rootR.ok ? worktreeFlow(ctx.cwd, rootR.value) : undefined
  if (rootR.ok && planId !== undefined) {
    const clashed = refuseClash(ctx, rootR.value, planId, worktreePath(rootR.value, planId))
    if (clashed !== undefined) return clashed
  }
  return withRunnerTurn(ctx.cwd, ctx, cmd.join(' '), (turnEnv) => {
    const host = jobHost(turnEnv)
    const env = process.platform === 'win32' ? { ...turnEnv, [JOB_HOST_ENV]: host.ok ? 'job' : 'none' } : turnEnv
    const resolved = resolveSpawn(file, args, env)
    if (!resolved.ok) {
      renderRefusal(resolved.violations).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
    if (process.platform === 'win32') sayNoJob(ctx, host)
    const run = contained(resolved.value, host)
    const r = spawnSync(run.file, run.args, {
      cwd: ctx.cwd, env: run.env as NodeJS.ProcessEnv, stdio: 'inherit', windowsVerbatimArguments: run.windowsVerbatimArguments,
    })
    if (r.error) {
      ctx.err(`turn: ${file}: ${r.error.message}`)
      return EXIT.REFUSED
    }
    return r.status ?? EXIT.FINDINGS
  })
}
