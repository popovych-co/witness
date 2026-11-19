import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BUSY_DIR } from '../src/busy.js'
import type { Ctx } from '../src/cli.js'
import { loadConfig, type Config } from '../src/config.js'
import { PAUSE_POLL_MS, RETRY_DUE_MS, driveLoop } from '../src/drive.js'
import { gateSpec } from '../src/gate.js'
import '../src/gates/index.js'
import { appendEntry, readStream } from '../src/journal.js'
import type { Option } from '../src/recommend.js'
import type { DecisionEntry } from '../src/rounds.js'
import { loadCanon } from '../src/scan.js'
import { fakeClock, fakeCtx, fakeScenario, fixtureEnv, noopOpener, plannedRepo, writeLocalConfig, type TestRepo } from './helpers.js'

// Row 240 (design §4.1.4, R4; P17 and P25 inverted). A settle the door refused with exit 3 waits
// for its retry as drive's own timer: out of the fill, never published, listed or paused for. The
// act whose making cost a model call is kept and applied again when due, with no second call.

const arbiter = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../src/arbiter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/arbiter.js')>()
  return {
    ...real,
    arbitrate: async (_c: unknown, _r: string, _f: unknown, req: { menu: readonly Option[] }) => {
      arbiter.calls++
      const i = req.menu.findIndex((o) => o.act !== undefined && o.act.argv.includes('--stop'))
      return { ok: true, value: { choice: i + 1, reason: 'stand-in', model: 'm', prompts_sha: 'p' } }
    },
  }
})

const PLAN = 'auth-refresh-plan-1'
const OTHER = process.ppid
const cfgOf = (repo: TestRepo): Config => {
  const r = loadConfig(repo.root)
  if (!r.ok) throw new Error(`config refused: ${JSON.stringify(r.violations)}`)
  return r.value
}
const autoCtx = (repo: TestRepo, out: string[]): Ctx => fakeCtx(repo.root, {
  env: fixtureEnv({ WITNESS_KEEP_AWAKE_BIN: noopOpener(), WITNESS_DRIVE_IDLE_MAX_MS: '0', WITNESS_DRIVE_AGENT_BIN: agent() }),
  out: (l) => out.push(l),
})
const agent = (): string => {
  const bin = join(fakeScenario(), 'agent')
  writeFileSync(bin, '#!/bin/sh\necho tick\n', { mode: 0o755 })
  return bin
}
// The door's exit 3 without its 30-second wait: a folder where the repo lock goes is a lock no
// write can take, refused `lock-unwritable` after the unreadable grace.
const jamLock = (root: string) => mkdirSync(join(root, '.witness', 'lock'), { recursive: true })
const freeLock = (root: string) => rmSync(join(root, '.witness', 'lock'), { recursive: true, force: true })
const decisions = (repo: TestRepo) =>
  (readStream(repo.root, PLAN).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[])
    .filter((d) => d.gate === 'plan').map((d) => `r${d.round} ${d.decision} · ${d.selected ?? 'human'}`)

async function boundStop(): Promise<TestRepo> {
  const repo = await plannedRepo()
  writeLocalConfig(repo.root, { notify: noopOpener() })
  const sha = gateSpec('plan')!.currentSha!(repo.root, loadCanon(repo.root), cfgOf(repo), PLAN)
  for (let round = 1; round <= 3; round++) {
    appendEntry(repo.root, PLAN, {
      v: 1, t: 'gate-run', gate: 'plan', artifact: PLAN, round, run_id: `r-${round}`, reviewed_sha: sha,
      prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped',
      verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [{ blocking: true, anchor: `${PLAN} > ## Step: s${round}`, claim: 'x' }] }],
    } as never)
  }
  repo.git('add', '-A'); repo.git('commit', '-qm', 'journal', '-m', 'Witness-State: 1')
  return repo
}
// A fake clock whose n-th sleep of `ms` runs `on` first.
const clockWith = (on: (ms: number, n: number) => void) => {
  const c = fakeClock(0)
  const counts = new Map<number, number>()
  const sleep = c.sleep
  return Object.assign(c, { sleep: async (ms: number) => { const n = (counts.get(ms) ?? 0) + 1; counts.set(ms, n); on(ms, n); await sleep(ms) } })
}

describe('a refused settle waits for its retry (row 240)', () => {
  it('an exit-3 settle becomes a retry aside the fill never meets, and the kept ruling lands when due with no second call (P25, P17 inverted)', async () => {
    const repo = await boundStop()
    jamLock(repo.root)
    arbiter.calls = 0
    const out: string[] = []
    let duringWait = ''
    let published = ''
    const clock = clockWith((ms, n) => {
      if (ms !== RETRY_DUE_MS || n !== 1) return
      duringWait = out.join('\n')
      try { published = readFileSync(join(repo.root, '.witness', 'live', 'drive.json'), 'utf8') } catch { published = '' }
      freeLock(repo.root)
    })
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, out), { maxSpawns: 1 }, clock)
    expect(duringWait).not.toContain('drive: waits on you')
    expect(duringWait).not.toContain('drive: waiting on you')
    expect(published).not.toContain('retry')
    expect(clock.slept).toContain(RETRY_DUE_MS)
    expect(arbiter.calls).toBe(1)
    expect(decisions(repo)).toEqual(['r3 stop · arbiter'])
  }, 60_000)

  it('a kept act whose run moved is dropped and the stop judged afresh', async () => {
    const repo = await boundStop()
    jamLock(repo.root)
    arbiter.calls = 0
    const sha = gateSpec('plan')!.currentSha!(repo.root, loadCanon(repo.root), cfgOf(repo), PLAN)
    const clock = clockWith((ms, n) => {
      if (ms !== RETRY_DUE_MS || n !== 1) return
      freeLock(repo.root)
      appendEntry(repo.root, PLAN, {
        v: 1, t: 'gate-run', gate: 'plan', artifact: PLAN, round: 4, run_id: 'r-4', reviewed_sha: sha,
        prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped',
        verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [{ blocking: true, anchor: `${PLAN} > ## Step: s4`, claim: 'x' }] }],
      } as never)
      repo.git('add', '-A'); repo.git('commit', '-qm', 'journal', '-m', 'Witness-State: 1')
    })
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, []), { maxSpawns: 1 }, clock)
    expect(arbiter.calls).toBe(2)
    expect(decisions(repo)).toEqual(['r4 stop · arbiter'])
  }, 60_000)

  it('three door refusals in a row set the stop aside for the human', async () => {
    const repo = await boundStop()
    jamLock(repo.root)
    arbiter.calls = 0
    const out: string[] = []
    const clock = clockWith(() => {})
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, out), { maxSpawns: 1 }, clock)
    expect(clock.slept.filter((ms) => ms === RETRY_DUE_MS)).toHaveLength(2)
    expect(out.join('\n')).toContain(`drive: waits on you — ${PLAN} · decision · `)
    expect(arbiter.calls).toBe(1)
    expect(decisions(repo)).toEqual([])
    freeLock(repo.root)
  }, 60_000)

  it('a busy lock never counts toward the three', async () => {
    const repo = await boundStop()
    jamLock(repo.root)
    arbiter.calls = 0
    const busyFile = join(repo.root, BUSY_DIR, `${PLAN}.settle.json`)
    const out: string[] = []
    const clock = clockWith((ms, n) => {
      if (ms === RETRY_DUE_MS && n === 1) {                 // refusal 1 waits: another process takes the stop
        mkdirSync(join(repo.root, BUSY_DIR), { recursive: true })
        writeFileSync(busyFile, JSON.stringify({ pid: OTHER, since: Date.now(), until: Date.now() + 3_600_000 }))
      }
      if (ms === PAUSE_POLL_MS && n === 1) rmSync(busyFile)  // busy, polled, released: then refusal 2
      if (ms === RETRY_DUE_MS && n === 2) freeLock(repo.root) // after refusal 2 the door opens
    })
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, out), { maxSpawns: 1 }, clock)
    expect(out.join('\n')).not.toContain('drive: waits on you')
    expect(arbiter.calls).toBe(1)
    expect(decisions(repo)).toEqual(['r3 stop · arbiter'])
  }, 60_000)
})
