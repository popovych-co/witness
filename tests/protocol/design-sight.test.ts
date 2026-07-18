import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  approve, fakeScenario, gateEnv, putVerdict, seededRepo, writeDesign, writeSpec, DESIGN_HTML,
} from '../helpers.js'

const CLEAN = {
  coverage: [{ anchor: 'design#save-bar', note: 'r' }, { anchor: 'auth-refresh > ## Behavior', note: 'r' }],
  findings: [],
}

function recorder(): { cmd: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-proto-'))
  const log = join(dir, 'opened.txt')
  const cmd = join(dir, 'rec.sh')
  writeFileSync(cmd, `#!/bin/sh\necho "$1" >> "${log}"\n`)
  chmodSync(cmd, 0o755)
  return { cmd, log }
}

async function waitForLines(log: string, n: number, ms = 3000): Promise<string[]> {
  const deadline = Date.now() + ms
  for (;;) {
    if (existsSync(log)) {
      const lines = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
      if (lines.length >= n) return lines
    }
    if (Date.now() >= deadline) return existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
    await new Promise((r) => setTimeout(r, 25))
  }
}

// The loop as a human runs it, and the two ways sight goes stale.
describe('design sight — protocol', () => {
  it('register → next asks to show → show → gate → approve stamps', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ui: true })
    approve(repo, 'auth-refresh')
    await writeDesign(repo, 'auth-refresh')
    const { cmd, log } = recorder()
    const abs = join(repo.root, 'designs/auth-refresh.html')

    const routed = await repo.cli(['next'])
    expect(routed.stdout).toContain('design auth-refresh --open')

    // the gate will not run until it has been shown
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const early = await repo.cli(['gate', 'design', 'auth-refresh'], { env: gateEnv(scenario) })
    expect(early.code).toBe(2)
    expect(early.stderr).toContain('design-unseen')

    const shown = await repo.cli(['design', 'auth-refresh', '--open'], { env: { SPECFLOW_OPENER: cmd } })
    expect(shown.code).toBe(0)
    expect(await waitForLines(log, 1)).toEqual([abs])

    const gate = await repo.cli(['gate', 'design', 'auth-refresh'], { env: gateEnv(scenario) })
    expect(gate.code).toBe(1)

    const decided = await repo.cli(['decide', 'design', 'auth-refresh', '--approve'])
    expect(decided.code).toBe(0)
    expect(readFileSync(join(repo.root, 'specs/auth-refresh.md'), 'utf8')).toContain('design:')
  })

  it('a revise round re-arms sight: re-authoring invalidates it, --open restores it', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ui: true })
    approve(repo, 'auth-refresh')
    await writeDesign(repo, 'auth-refresh')
    const { cmd, log } = recorder()
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)

    await repo.cli(['design', 'auth-refresh', '--open'], { env: { SPECFLOW_OPENER: cmd } })
    await repo.cli(['gate', 'design', 'auth-refresh'], { env: gateEnv(scenario) })
    const revised = await repo.cli(['decide', 'design', 'auth-refresh', '--revise', '--note', 'bar is buried'])
    expect(revised.code).toBe(0)

    // vary the TEXT, not the ids — this round gets re-gated, and renaming an id would
    // make the verdict's `design#save-bar` anchor unresolvable (a malformed round, for
    // reasons that have nothing to do with sight)
    await writeDesign(repo, 'auth-refresh', DESIGN_HTML.replace('Bookings', 'Bookings v2'))
    const stale = await repo.cli(['gate', 'design', 'auth-refresh'], { env: gateEnv(scenario) })
    expect(stale.code).toBe(2)
    expect(stale.stderr).toContain('design-unseen')

    const reshown = await repo.cli(['design', 'auth-refresh', '--open'], { env: { SPECFLOW_OPENER: cmd } })
    expect(reshown.code).toBe(0)
    expect((await waitForLines(log, 2)).length).toBe(2)   // shown once per authored version

    const gate2 = await repo.cli(['gate', 'design', 'auth-refresh'], { env: gateEnv(scenario) })
    expect(gate2.code).toBe(1)
    const decided = await repo.cli(['decide', 'design', 'auth-refresh', '--approve'])
    expect(decided.code).toBe(0)
  })
})
