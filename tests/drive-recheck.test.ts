import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Ctx } from '../src/cli.js'
import { loadConfig, type Config } from '../src/config.js'
import { RECHECK_FIRST_MS, driveLoop } from '../src/drive.js'
import { journalRel } from '../src/journal.js'
import { worktreePath } from '../src/worktree.js'
import {
  approve, autonomyOn, closedStep, fakeClock, fakeCtx, fakeScenario, fixtureEnv, noopOpener, patchConfig, seededRepo,
  writeLocalConfig, writePlan, writeSpec, type TestRepo,
} from './helpers.js'

// Row 242 (design §4.3.4). A lane that ends having written a transient or pending record is re-checked
// on drive's own timer — 5 minutes, doubling to at most 60 — each re-check a ship session counted
// against drive.caps; never published, listed, notified or paused for. A lane that wrote nothing ends
// stuck, and a drive that is not autonomous sets a transient lane aside as stuck.

const PLAN = 'a-plan-1'
const MIN = 60_000
const cfgOf = (repo: TestRepo): Config => { const r = loadConfig(repo.root); if (!r.ok) throw new Error('cfg'); return r.value }
async function shipping(opts: { spawns?: number; autonomy?: boolean } = {}): Promise<{ repo: TestRepo; head: string }> {
  const repo = await seededRepo()
  await writeSpec(repo, 'a', { criteria: [{ id: 'ac-a', test: '@spec:a' }] })
  approve(repo, 'a')
  await writePlan(repo, PLAN, { parent: 'a', steps: [{ id: 's1', title: 'a', criteria: ['ac-a'] }] })
  approve(repo, PLAN)
  await repo.cli(['start', PLAN])
  closedStep(repo, PLAN, 's1', 'a')
  repo.setMeta(PLAN, { pr: 7 })
  if (opts.spawns !== undefined) {
    patchConfig(repo, { drive: { caps: { spawns: opts.spawns } } })
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-qm', 'caps')
  }
  if (opts.autonomy !== false) autonomyOn(repo)
  writeLocalConfig(repo.root, { notify: noopOpener() })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath(repo.root, PLAN), encoding: 'utf8' }).trim()
  return { repo, head }
}
// The ship session `witness ship` runs: it ends on a transient hold and journals its record.
function transientAgent(repo: TestRepo, head: string, log: string): string {
  const rec = JSON.stringify({ v: 1, t: 'ship-outcome', artifact: PLAN, pr: 7, head, outcome: 'transient', reason: 'the fetch failed' })
  const bin = join(fakeScenario(), 'agent')
  writeFileSync(bin, `#!/bin/sh\necho "$WITNESS_DRIVE" >> "${log}"\nprintf '%s\\n' '${rec}' >> "${join(repo.root, journalRel(PLAN))}"\n`, { mode: 0o755 })
  return bin
}
const autoCtx = (repo: TestRepo, env: Record<string, string>, out: string[], extra: Partial<Ctx> = {}): Ctx => ({
  ...fakeCtx(repo.root, { env: fixtureEnv({ WITNESS_KEEP_AWAKE_BIN: noopOpener(), WITNESS_DRIVE_IDLE_MAX_MS: '0', ...env }), out: (l) => out.push(l) }),
  ...extra,
})

describe('drive re-checks a transient hold (row 242)', () => {
  it('a lane that wrote a transient record is re-checked at 5, 10 and 20 minutes, within drive.caps.spawns', async () => {
    const { repo, head } = await shipping({ spawns: 4 })
    const log = join(fakeScenario(), 'spawned')
    const out: string[] = []
    const clock = fakeClock(0)
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: transientAgent(repo, head, log) }, out), {}, clock)
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toHaveLength(4)
    const waits = clock.slept.filter((ms) => ms >= RECHECK_FIRST_MS)
    expect(waits.slice(0, 3)).toEqual([5 * MIN, 10 * MIN, 20 * MIN])
    // the release keeps the target's use, so the spawn cap trips — the first wake this hold produces
    expect(out.join('\n')).toContain(`drive: capped — ${PLAN} · drive cap: 4 session(s) this run · drive.caps.spawns 4`)
    expect(out.join('\n')).toContain('the fetch failed')
    expect(out.join('\n')).not.toContain('drive: no progress')
  }, 120_000)

  it('a lane that wrote nothing ends stuck', async () => {
    const { repo } = await shipping()
    const bin = join(fakeScenario(), 'agent')
    writeFileSync(bin, '#!/bin/sh\necho tick\n', { mode: 0o755 })
    const out: string[] = []
    const clock = fakeClock(0)
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: bin }, out), {}, clock)
    expect(out.join('\n')).toContain(`drive: no progress — witness ship ${PLAN}`)
    expect(clock.slept.filter((ms) => ms >= RECHECK_FIRST_MS)).toEqual([])
  }, 120_000)

  it('recheck is never published, listed, notified or paused for', async () => {
    const { repo, head } = await shipping({ spawns: 2 })
    const log = join(fakeScenario(), 'spawned')
    const out: string[] = []
    const clock = fakeClock(0)
    let published = ''
    let duringWait = ''
    const sleep = clock.sleep
    clock.sleep = async (ms: number) => {
      if (ms === RECHECK_FIRST_MS && duringWait === '') {
        duringWait = out.join('\n')
        try { published = readFileSync(join(repo.root, '.witness', 'live', 'drive.json'), 'utf8') } catch { published = '' }
      }
      await sleep(ms)
    }
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: transientAgent(repo, head, log) }, out), {}, clock)
    expect(duringWait).not.toBe('')
    expect(duringWait).not.toContain('drive: waiting on you')
    expect(published).not.toContain('recheck')
    expect(published).not.toContain(PLAN)
  }, 120_000)

  it('a non-autonomous drive sets a transient lane aside as stuck', async () => {
    const { repo, head } = await shipping({ autonomy: false })
    const log = join(fakeScenario(), 'spawned')
    const out: string[] = []
    const clock = fakeClock(0)
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: transientAgent(repo, head, log) }, out,
      { isTTY: true, ask: async () => '' }), { maxSpawns: 3 }, clock)
    expect(existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []).toHaveLength(1)
    expect(clock.slept.filter((ms) => ms >= RECHECK_FIRST_MS)).toEqual([])
    expect(out.some((l) => l.startsWith(`stuck: ${PLAN}`) || l.startsWith(`drive: transient — ${PLAN}`))).toBe(true)
  }, 120_000)
})
