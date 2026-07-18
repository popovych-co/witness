import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { canonicalSha } from '../src/sha.js'
import { designStamp } from '../src/design.js'
import { splitDoc } from '../src/fm.js'
import {
  approve, fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, writeDesign, writeSpec,
} from './helpers.js'

const CLEAN = {
  coverage: [
    { anchor: 'design#save-bar', note: 'primary action visible' },
    { anchor: 'booking-form > ## Behavior', note: 'every behavior has a home' },
  ],
  findings: [] as never[],
}

async function designed() {
  const repo = await seededRepo()
  await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
  approve(repo, 'booking-form')
  await writeDesign(repo, 'booking-form')
  const scenario = fakeScenario()
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
  return { repo, scenario, ctx }
}

describe('design gate', () => {
  it('always stops even on a clean verdict; the critic sees the artifact ids', async () => {
    const { repo, scenario, ctx } = await designed()
    putVerdict(scenario, CLEAN)
    const { runGate } = await import('../src/gate.js')
    await import('../src/gates/index.js')
    const code = await runGate(ctx, 'design', 'booking-form', { fresh: false, manual: false })
    expect(code).toBe(1)                                   // FINDINGS — stopped, not auto-passed
    const call = readFileSync(join(scenario, 'claude-calls/call-1/stdin'), 'utf8')
    expect(call).toContain('design#save-bar')
    const runs = readStream(repo.root, 'booking-form').filter((e) => e.t === 'gate-run')
    expect(runs.length).toBe(1)
    expect((runs[0] as { standing?: string }).standing).toBeTruthy()
  })

  it('decide --approve stamps design:{sha,spec} and journals it', async () => {
    const { repo, scenario, ctx } = await designed()
    putVerdict(scenario, CLEAN)
    const { runGate } = await import('../src/gate.js')
    await import('../src/gates/index.js')
    await runGate(ctx, 'design', 'booking-form', { fresh: false, manual: false })
    const dec = await repo.cli(['decide', 'design', 'booking-form', '--approve'])
    expect(dec.code).toBe(0)
    const doc = splitDoc(repo.read('specs/booking-form.md'))
    expect(doc.ok && designStamp({ rel: '', meta: doc.value.meta, body: doc.value.body, violations: [] })).toBeTruthy()
    if (doc.ok) expect((doc.value.meta.design as { spec: string }).spec).toBe(canonicalSha(doc.value.meta, doc.value.body))
    expect(readStream(repo.root, 'booking-form').some((e) => e.t === 'design-stamp')).toBe(true)
  })

  it('stops when the artifact is missing', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')
    const scenario = fakeScenario()
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    putVerdict(scenario, CLEAN)
    const { runGate } = await import('../src/gate.js')
    await import('../src/gates/index.js')
    const code = await runGate(ctx, 'design', 'booking-form', { fresh: false, manual: false })
    expect(code).toBe(1)
    const runs = readStream(repo.root, 'booking-form').filter((e) => e.t === 'gate-run')
    expect((runs[0] as { checks: Array<{ name: string; ok: boolean }> }).checks.find((c) => c.name === 'artifact')?.ok).toBe(false)
  })
})
