import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './cli.js'
import { loadConfig } from './config.js'
import { primaryRoot } from './gitio.js'
import { isAlive, pause } from './lock.js'

// Row 181 (Task 3b). Every command witness runs takes turns across the worktrees of one
// repo: evidence, gate checks, regression and ship lanes all pass through `execCommand`.
// fewhats's e2e boots a web server and a browser per suite, so two suites at once collide on
// a port or a profile, and each collision costs a round. With a filtered runner a turn costs
// seconds. `drive.parallelSuites: true` relaxes it.
//
// A turn waits while its holder lives and never refuses: the holder is a live process running
// one command, and its session's `drive.sessionTimeoutMs` bounds it. Refusing would have to
// fake a run outcome, and a fake failed run journals a false red.
const POLL_MS = 200
const UNREADABLE_GRACE_MS = 1_000

export const runnerLockPath = (root: string) => join(root, '.witness', 'runner.lock')
// The holder hands its turn to the command it runs: a witness invoked by that command (a
// criterion `cmd:` that runs witness) would otherwise wait on its own parent forever.
export const RUNNER_TURN_ENV = 'WITNESS_RUNNER_TURN'


// A symlink is never a holder: `wx` refuses it while a read follows it, so a dangling one
// would read `absent` forever (the repo lock's fix, src/lock.ts).
function holderOf(p: string): number | 'absent' | 'unreadable' {
  let text: string
  try {
    if (lstatSync(p).isSymbolicLink()) return 'unreadable'
    text = readFileSync(p, 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable'
  }
  try {
    const pid = (JSON.parse(text) as { pid?: unknown }).pid
    return typeof pid === 'number' && Number.isInteger(pid) ? pid : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

const drop = (p: string): boolean => {
  try {
    unlinkSync(p)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

// The release a turn hands back, or undefined when this process did not take one (a
// re-entry, an inherited turn, a path it cannot write). Only the process that wrote the file
// removes it, and only while it still names that process.
function takeTurn(root: string, ctx: Ctx, label: string): (() => void) | undefined {
  const p = runnerLockPath(root)
  const pid = process.pid
  const mine = () => { if (holderOf(p) === pid) drop(p) }
  try {
    mkdirSync(join(root, '.witness'), { recursive: true })
  } catch {
    return undefined                                     // no .witness to hold a turn in: run unturned
  }
  let said = false
  let unreadableSince: number | undefined
  for (;;) {
    try {
      writeFileSync(p, JSON.stringify({ pid }), { flag: 'wx' })
      return mine
    } catch (e) {
      // A turn that cannot be written cannot be waited for either; the command still runs.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
    }
    const holder = holderOf(p)
    if (holder === 'absent') continue
    if (holder === pid) return undefined                 // re-entry: the outer turn releases
    if (typeof holder === 'number' && ctx.env[RUNNER_TURN_ENV] === String(holder)) return undefined   // inherited
    if (holder === 'unreadable') {
      unreadableSince ??= Date.now()
      if (Date.now() - unreadableSince >= UNREADABLE_GRACE_MS) {
        if (!drop(p)) return undefined                   // a lock path it cannot clear: run unturned
        unreadableSince = undefined
        continue
      }
    } else if (!isAlive(holder)) {
      if (!drop(p)) return undefined
      continue
    } else {
      unreadableSince = undefined
      if (!said) { ctx.err(`runner: waiting for pid ${holder} · ${label}`); said = true }
    }
    pause(POLL_MS)
  }
}

function suitesMayOverlap(root: string): boolean {
  const cfg = loadConfig(root)
  return cfg.ok && cfg.value.drive.parallelSuites
}

export function withRunnerTurn<T>(runRoot: string, ctx: Ctx, label: string, fn: (env: Ctx['env']) => T): T {
  const pr = primaryRoot(runRoot)
  if (!pr.ok || suitesMayOverlap(pr.value)) return fn(ctx.env)
  const release = takeTurn(pr.value, ctx, label)
  if (!release) return fn(ctx.env)
  try {
    return fn({ ...ctx.env, [RUNNER_TURN_ENV]: String(process.pid) })
  } finally {
    release()
  }
}
