import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUSY_DIR } from '../src/busy.js'
import { loadConfig } from '../src/config.js'
import { acquireDriveLock } from '../src/drive-presence.js'
import { readStream } from '../src/journal.js'
import { driveWillDecide, readLive, writeLive, type LiveState } from '../src/live.js'
import { needsYou } from '../src/needs-you.js'
import type { DecisionEntry } from '../src/rounds.js'
import { loadCanon } from '../src/scan.js'
import { PLAN_BLOCKING, fakeCtx, fakeScenario, gateEnv, hermeticEnv, plannedRepo, putVerdict, type TestRepo } from './helpers.js'

// Row 240 (design §4.1.5, R5). The chat leaves drive's stops to drive: under a live 0.29 drive that
// is still deciding, `next` settles no stop drive will decide and names it once instead of routing
// the human to it, and `needsYou` (wait, the report, drive's notifier) does not list it.

const PLAN = 'auth-refresh-plan-1'
const OTHER = process.ppid
const cfgOf = (repo: TestRepo) => { const r = loadConfig(repo.root); if (!r.ok) throw new Error('cfg'); return r.value }
const decisions = (repo: TestRepo) =>
  (readStream(repo.root, PLAN).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[]).filter((d) => d.gate === 'plan')

// A plan stop the policy settles itself (blocking-here → revise), owed in the chat's repo.
async function owedStop(): Promise<TestRepo> {
  const repo = await plannedRepo({ autonomy: false })
  const scenario = fakeScenario()
  putVerdict(scenario, PLAN_BLOCKING)
  await repo.cli(['gate', 'plan', PLAN], { env: gateEnv(scenario) })
  const { autonomyOn } = await import('./helpers.js')
  autonomyOn(repo)
  return repo
}
// A live 0.29 drive: this process holds the drive lock, and publishes its state.
function liveDrive(repo: TestRepo, state: Omit<LiveState, 'pid'>): () => void {
  const lock = acquireDriveLock(repo.root, {})
  if (!lock.ok) throw new Error('drive lock')
  writeLive(repo.root, { pid: process.pid, ...state })
  return lock.value
}
const chatNext = (repo: TestRepo) => repo.cli(['next'], { env: { CLAUDECODE: '1' } })

describe('the chat leaves drive\'s stops to drive (row 240)', () => {
  it('the chat\'s next under a live drive settles no stop drive will decide (#88)', async () => {
    const repo = await owedStop()
    const release = liveDrive(repo, { asides: [], deciding: true })
    try {
      await chatNext(repo)
      expect(decisions(repo)).toEqual([])
    } finally { release() }
  }, 60_000)

  it('it names that stop once — note: being decided — and never prints next: witness decide for it', async () => {
    const repo = await owedStop()
    const release = liveDrive(repo, { asides: [], deciding: true })
    try {
      const out = (await chatNext(repo)).stdout.split('\n')
      expect(out.filter((l) => l === `note: being decided — plan ${PLAN}`)).toHaveLength(1)
      expect(out.some((l) => l.startsWith('next: witness decide'))).toBe(false)
    } finally { release() }
  }, 60_000)

  it('a stop drive set aside as left for a human is the chat\'s to settle and to show', async () => {
    const repo = await owedStop()
    const release = liveDrive(repo, { asides: [{ target: PLAN, kind: 'decision', gate: 'plan' }], deciding: true })
    try {
      await chatNext(repo)
      expect(decisions(repo).map((d) => `${d.decision} · ${d.selected}`)).toEqual(['revise · policy'])
    } finally { release() }
  }, 60_000)

  it('a drive that stopped settling publishes deciding: false and the filters lift', async () => {
    const repo = await owedStop()
    const release = liveDrive(repo, { asides: [], deciding: false })
    try {
      await chatNext(repo)
      expect(decisions(repo)).toHaveLength(1)
    } finally { release() }
  }, 60_000)

  it('a --flow drive decides only its flow: a stop outside it is the chat\'s', async () => {
    const repo = await owedStop()
    const release = liveDrive(repo, { asides: [], deciding: true, scope: { flow: 'auth-refresh' } })   // another canon id
    try {
      await chatNext(repo)
      expect(decisions(repo)).toHaveLength(1)
    } finally { release() }
  }, 60_000)

  it('a stop under another process\'s live settle lock is skipped with the same note', async () => {
    const repo = await owedStop()
    mkdirSync(join(repo.root, BUSY_DIR), { recursive: true })
    writeFileSync(join(repo.root, BUSY_DIR, `${PLAN}.settle.json`), JSON.stringify({ pid: OTHER, since: Date.now(), until: Date.now() + 3_600_000 }))
    const out = (await chatNext(repo)).stdout.split('\n')
    expect(decisions(repo)).toEqual([])
    expect(out).toContain(`note: being decided — plan ${PLAN}`)
    expect(out.some((l) => l.startsWith('next: witness decide'))).toBe(false)
  }, 60_000)

  it('driveWillDecide: live, deciding, in scope, not set aside', () => {
    const base: LiveState = { pid: 1, asides: [], deciding: true }
    expect(driveWillDecide(base, PLAN)).toBe(true)
    expect(driveWillDecide(undefined, PLAN)).toBe(false)
    expect(driveWillDecide({ ...base, deciding: false }, PLAN)).toBe(false)
    expect(driveWillDecide({ ...base, scope: { flow: 'x-plan-1' } }, PLAN)).toBe(false)
    expect(driveWillDecide({ ...base, asides: [{ target: PLAN, kind: 'decision' }] }, PLAN)).toBe(false)
  })

  it('a live file without deciding (hand-written, or older) reads as not deciding', async () => {
    const repo = await owedStop()
    mkdirSync(join(repo.root, '.witness', 'live'), { recursive: true })
    writeFileSync(join(repo.root, '.witness', 'live', 'drive.json'), JSON.stringify({ pid: process.pid, asides: [], scope: { flow: '../x' } }))
    const live = readLive(repo.root, loadCanon(repo.root))
    expect(live?.deciding).toBe(false)
    expect(live?.scope).toBeUndefined()                       // a flow that is no id is dropped
  }, 60_000)
})

describe('needsYou under a deciding drive (row 240)', () => {
  it('omits an owed decision drive will decide, and lists one it set aside or one outside its scope', async () => {
    const repo = await owedStop()
    const canon = loadCanon(repo.root)
    const decisionItems = (asides: Parameters<typeof needsYou>[4], scope?: Parameters<typeof needsYou>[5]) =>
      needsYou(repo.root, fakeCtx(repo.root), cfgOf(repo), canon, asides, scope).filter((i) => i.kind === 'decision').map((i) => i.target)
    expect(decisionItems([], { deciding: true })).toEqual([])
    expect(decisionItems([{ target: PLAN, kind: 'decision', gate: 'plan' }], { deciding: true })).toEqual([PLAN])
    expect(decisionItems([], { deciding: true, flow: 'other-plan-1' })).toEqual([PLAN])
    expect(decisionItems([], { deciding: false })).toEqual([PLAN])
    expect(decisionItems([])).toEqual([PLAN])                 // no live drive: as today
  }, 60_000)

  it('omits a pending transaction under a deciding drive until drive set the recovery aside', async () => {
    const repo = await owedStop()
    // crashPoint exits the process, so the crashed write runs in a child of its own
    const here = resolve(import.meta.dirname, '..')
    const crashed = spawnSync(join(here, 'node_modules', '.bin', 'tsx'), [join(here, 'src', 'bin.ts'), 'ask', 'crashed'],
      { cwd: repo.root, env: hermeticEnv({ WITNESS_CRASH_AFTER: 'journal-append' }), encoding: 'utf8' })
    expect(crashed.status).toBe(9)
    const canon = loadCanon(repo.root)
    const kinds = (asides: Parameters<typeof needsYou>[4], scope?: Parameters<typeof needsYou>[5]) =>
      needsYou(repo.root, fakeCtx(repo.root), cfgOf(repo), canon, asides, scope).map((i) => i.kind)
    expect(kinds([])).toContain('pending-txn')
    expect(kinds([], { deciding: true })).not.toContain('pending-txn')
    expect(kinds([{ target: '-', kind: 'stuck' }], { deciding: true })).toContain('pending-txn')
  }, 60_000)

  it('wait is unchanged: a stop under a live settle lock is still listed with no drive', async () => {
    const repo = await owedStop()
    mkdirSync(join(repo.root, BUSY_DIR), { recursive: true })
    writeFileSync(join(repo.root, BUSY_DIR, `${PLAN}.settle.json`), JSON.stringify({ pid: OTHER, since: Date.now(), until: Date.now() + 3_600_000 }))
    const items = needsYou(repo.root, fakeCtx(repo.root), cfgOf(repo), loadCanon(repo.root), [])
    expect(items.some((i) => i.kind === 'decision' && i.target === PLAN)).toBe(true)
  }, 60_000)
})

