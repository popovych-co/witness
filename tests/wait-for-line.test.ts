import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { waitForLine } from './helpers.js'

// A shell's `>>` creates the file before the command writes to it, so a reader that takes
// existence for the write read an empty file (tests/opener.test.ts, CI-only). And a fixed short
// deadline is a race on a loaded runner; the wait ends on the line, bounded only as a backstop.
it('waits for the line, not for the file that will hold it', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'witness-line-')), 'opened.txt')
  spawn('sh', ['-c', `: > "${log}"; sleep 0.5; echo /tmp/look.html >> "${log}"`], { stdio: 'ignore' })
  expect((await waitForLine(log)).trim()).toBe('/tmp/look.html')
})

it('outlasts a writer slower than the old 3 s deadline', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'witness-line-')), 'opened.txt')
  spawn('sh', ['-c', `sleep 3.5; echo /tmp/look.html >> "${log}"`], { stdio: 'ignore' })
  expect((await waitForLine(log)).trim()).toBe('/tmp/look.html')
})
