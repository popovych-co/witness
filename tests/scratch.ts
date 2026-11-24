import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import type { RunnerTask } from 'vitest'
import { getCurrentTest } from 'vitest/suite'

// The tests' one owner of scratch directories (row 268, issue #99). Imports nothing of src and
// never helpers.ts: tests/scratch-setup.ts is a setup file, and a setup file that loaded src would
// bind its modules before a test file's vi.mock could (tests/setup-files.test.ts).

export interface ScratchOpts {
  // File lifetime even when made inside a test: a cache one test fills and later tests of the
  // file read (tests/shells.ts stubScript, the `copyOf` maps).
  shared?: boolean
  // Printed under the kept line when the directory is kept: what a failing test's reader needs
  // from it (fakeScenario's fake trails).
  report?: (dir: string) => string
}

interface Made { home: string; dir: string; report?: (dir: string) => string }

// What the running file made outside any test (a beforeAll, an afterAll, a describe body, module
// scope) or asked to share. Each test file evaluates this module afresh, so the list is its own.
const fileMade: Made[] = []

// A directory owned by the scope vitest is running when it is made: inside a test (its body, a
// beforeEach, an afterEach) by that test, anywhere else — or when `shared` — by the test file.
// A passing or skipped owner's directories are removed when it finishes; a failed owner's are
// kept, and each is named on stderr. The directory is `<home>/<name>` in a home of its own, so a
// sibling a test makes beside it (`${dir}-origin.git`, `join(dir, '..', …)`) is in the home and
// goes with it. Realpath'd, so it compares equal to what git and the CLI report on macOS.
export function scratchDir(prefix: string, opts: ScratchOpts = {}): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const dir = join(home, prefix.replace(/-+$/, '') || 'scratch')
  mkdirSync(dir)
  const made: Made = { home, dir, ...(opts.report ? { report: opts.report } : {}) }
  const test = opts.shared ? undefined : getCurrentTest()
  if (test) onTestFinished(() => settle([made], test.result?.state === 'fail'))
  else fileMade.push(made)
  return dir
}

// The file's own directories, settled once its every test and hook has run: kept when anything
// in the file failed (they are the shared state the failing test read), else removed.
export function settleFile(file: Readonly<RunnerTask>): void {
  settle(fileMade.splice(0), failed(file))
}

function failed(task: Readonly<RunnerTask>): boolean {
  return task.result?.state === 'fail' || ('tasks' in task && task.tasks.some(failed))
}

// A removal that fails, fails its owner: on macOS and Linux `rmSync(…, { force: true })` fails
// only while something still writes into the directory — a process the test left running. Every
// directory is still tried before the first error is thrown.
function settle(made: Made[], keep: boolean): void {
  let error: unknown
  for (const m of made) {
    try {
      if (keep) {
        const report = m.report?.(m.dir)
        console.error(report ? `scratch kept: ${m.dir}\n${report}` : `scratch kept: ${m.dir}`)
      } else rmSync(m.home, { recursive: true, force: true })
    } catch (e) {
      error ??= e
    }
  }
  if (error !== undefined) throw error
}
