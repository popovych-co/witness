import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { standingHeld } from '../src/held.js'
import { readStream } from '../src/journal.js'
import type { TestRepo } from './helpers.js'
import { fixtureEnv, heldWorktree, worktreeState } from './helpers.js'
import { scratchDir } from './scratch.js'

const REPO = resolve(import.meta.dirname, '..')
const LOADER = pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href
// The tagged test writes a flag once vitest is inside it, then outlasts the signal.
const SLOW_TAGGED = "import { expect, it } from 'vitest'\nimport { writeFileSync } from 'node:fs'\nimport { rotateDue } from '../src/token'\n\n"
  + "it('rotates token before expiry @spec:auth-refresh', async () => {\n  writeFileSync(process.env.WITNESS_TEST_FLAG!, 'in')\n"
  + "  await new Promise((r) => setTimeout(r, 30000))\n  expect(rotateDue(90, 100)).toBe(true)\n}, 60000)\n"

// Polls every 100 ms; throws on timeout.
async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms
  while (!pred()) {
    if (Date.now() > until) throw new Error(`waitFor: timed out after ${ms} ms`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

// verify-red in a process group of its own (drive stops a session by its group), signalled once the
// red run has written the flag. Resolves how the process ended.
async function stopDuringRed(wt: string, planId: string, sig: NodeJS.Signals): Promise<{ code: number | null; signal: string | null }> {
  const flag = join(scratchDir('witness-flag-'), 'in')
  const child = spawn(process.execPath, ['--import', LOADER, join(REPO, 'src', 'bin.ts'), 'verify-red', planId, '--step', 's1'],
    { cwd: wt, env: fixtureEnv({ WITNESS_TEST_FLAG: flag }) as NodeJS.ProcessEnv, stdio: 'ignore', detached: true })
  const ended = new Promise<{ code: number | null; signal: string | null }>((done) => child.on('exit', (code, signal) => done({ code, signal })))
  await waitFor(() => existsSync(flag), 30_000)
  process.kill(-child.pid!, sig)
  return ended
}
const settled = (repo: TestRepo, wt: string, planId: string, before: Record<string, string>) => {
  expect(standingHeld(repo.root, planId)).toBeUndefined()
  expect(worktreeState(repo, wt, ['src/token.ts', 'src/extra.ts'])).toEqual(before)
  expect(readStream(repo.root, planId).filter((e) => e.t === 'test-evidence')).toEqual([])
}

describe.skipIf(process.platform === 'win32')('verify-red under a signal (row 247, #92)', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('%s to the process group during the red run: the work is back and the ref gone before the process ends, nothing journaled', async (sig) => {
    const { repo, wt, planId, before } = await heldWorktree('stepped', { crash: false, tests: SLOW_TAGGED })
    expect((await stopDuringRed(wt, planId, sig)).signal).toBe(sig)
    settled(repo, wt, planId, before)
  }, 90_000)

  // A runner that catches the signal and exits 1: Task 9 cannot read that as a signal, so only the
  // yield before the journal write keeps its "failure" from being recorded as a red.
  it('a runner that catches SIGTERM and exits 1 still has its run recorded nowhere', async () => {
    const runner = `sh -c 'trap "exit 1" TERM INT; : > "$WITNESS_TEST_FLAG"; sleep 30 & wait' # {id}`
    const { repo, wt, planId, before } = await heldWorktree('stepped', { crash: false, config: { criteria: { runner } } })
    expect((await stopDuringRed(wt, planId, 'SIGTERM')).signal).toBe('SIGTERM')
    settled(repo, wt, planId, before)
  }, 90_000)
})
