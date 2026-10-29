import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { arbitrate, menuFor, type ArbiterRequest } from '../src/arbiter.js'
import { loadConfig, type Config } from '../src/config.js'
import type { Entry } from '../src/journal.js'
import { recommend } from '../src/recommend.js'
import { lastGateRun } from '../src/rounds.js'
import { callCount, callFor, fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo } from './helpers.js'

const run = (round: number, sha: string, extra: Record<string, unknown> = {}, findings: unknown[] = []): Entry => ({
  v: 1, t: 'gate-run', gate: 'plan', artifact: 'p1', round, run_id: `r-${round}`, reviewed_sha: sha,
  prompts_sha: 'ps', witness: '0.16.0', model: 'm', pin: 'm', harness: 'claude-code',
  checks: [], outcome: 'stopped', verdicts: [{ reviewer: 'lens', coverage: [], findings }], ...extra,
} as unknown as Entry)
const blocking = (anchor: string) => [{ blocking: true, anchor, claim: 'x' }]
const failed = (...names: string[]) => names.map((name) => ({ name, ok: false, detail: 'x' }))

describe('menuFor (A3)', () => {
  const menu = (gate: string, entries: Entry[], o: { untrustedCmds?: string[]; upstream?: string | null } = {}) => {
    const block = recommend({ gate, target: 'p1', entries, upstream: o.upstream === null ? undefined : (o.upstream ?? 'auth-refresh'), stale: false, untrustedCmds: o.untrustedCmds })!
    return menuFor(block, lastGateRun(entries, gate)!).map((x) => x.command)
  }
  it('offers the block minus abandon, trust grants and unresolved ids', () => {
    expect(menu('plan', [run(1, 'a'), run(2, 'b'), run(3, 'c')])).toEqual([
      'witness decide plan p1 --approve --override', 'witness decide plan p1 --revise --upstream auth-refresh',
      'witness decide plan p1 --revise --repair', 'witness decide plan p1 --stop'])
    const pinned = [run(1, 'a', {}, [{ blocking: true, anchor: 'S', claim: 'x', contradicts_pin: 1 }])]
    expect(menu('plan', pinned, { untrustedCmds: ['echo ok'] })).toContain('witness decide plan p1 --approve')
    expect(menu('plan', pinned, { untrustedCmds: ['echo ok'] }).some((c) => c.includes('--trust-cmds'))).toBe(false)
    expect(menu('plan', [run(1, 'a', {}, blocking('S')), run(2, 'b', {}, blocking('S'))], { upstream: null }).some((c) => c.includes('<'))).toBe(false)
  })
  it('drops every approve while a deterministic check failed (A3)', () => {
    expect(menu('plan', [run(1, 'a'), run(2, 'b'), run(3, 'c', { checks: failed('drift-lane') })]).filter((c) => c.includes('--approve'))).toEqual([])
    expect(menu('plan', [run(1, 'a', { checks: failed('lint') }, [{ blocking: true, anchor: 'S', claim: 'x', contradicts_pin: 1 }])]).filter((c) => c.includes('--approve'))).toEqual([])
  })
  it('keeps the acknowledgement when amendment-ack alone failed, and the <why> note for the arbiter to fill', () => {
    expect(menu('decompose', [run(1, 'a', { gate: 'decompose', standing: 'feature scope', checks: failed('amendment-ack') })])).toContain('witness decide decompose p1 --approve')
    expect(menu('ship', [run(1, 'a', { gate: 'ship', standing: 'ship always stops' })])).toContain('witness decide ship p1 --revise --note "<why>"')
  })
})

describe('arbitrate (A3)', () => {
  const REQ: ArbiterRequest = { mode: 'decision', evidence: [{ title: 'The stop', body: 'gate: plan · target: p1' }], menu: [
    { command: 'witness decide plan p1 --approve', depth: 'root', runnable: true, why: 'the finding misreads the spec' },
    { command: 'witness decide plan p1 --stop', depth: 'terminal', runnable: true, when: 'the work cannot converge' }] }
  // init pins the arbiter, so the rewrite is what leaves it on the session default.
  async function setup(config = 'schema: 1\n') {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', config)
    const scenario = fakeScenario()
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const cfgR = loadConfig(repo.root)
    if (!cfgR.ok) throw new Error('config')
    return { repo, scenario, ctx, cfg: cfgR.value as Config }
  }

  it('asks the judge harness under the arbiter lens and returns the numbered option', async () => {
    const { repo, scenario, ctx, cfg } = await setup()
    putVerdict(scenario, { choice: 2, reason: 'nothing says how this converges' }, 'arbiter')
    const r = await arbitrate(ctx, repo.root, cfg, REQ)
    expect(r.ok && r.value).toMatchObject({ choice: 2, reason: 'nothing says how this converges', model: 'session-default' })
    expect(r.ok && r.value.prompts_sha).toMatch(/^[0-9a-f]{64}$/)
    const asked = readFileSync(join(callFor(scenario, 'arbiter')!, 'stdin'), 'utf8')
    expect(asked).toContain('## The stop')
    expect(asked).toContain('1. witness decide plan p1 --approve')
    expect(asked).toContain('2. witness decide plan p1 --stop')
  })
  it('rerolls once on an answer that names no listed option', async () => {
    const { repo, scenario, ctx, cfg } = await setup()
    putVerdict(scenario, { choice: 9, reason: 'x' }, 'arbiter')
    putVerdict(scenario, { choice: 1, reason: 'fine' }, 2)
    const r = await arbitrate(ctx, repo.root, cfg, REQ)
    expect(r.ok && r.value.choice).toBe(1)
    expect(readFileSync(join(scenario, 'claude-calls', 'call-2', 'stdin'), 'utf8')).toContain('## Previous attempt rejected')
  })
  it('refuses arbiter-malformed after the second invalid answer', async () => {
    const { repo, scenario, ctx, cfg } = await setup()
    putVerdict(scenario, 'no ruling here', 'arbiter')
    const r = await arbitrate(ctx, repo.root, cfg, REQ)
    expect(!r.ok && r.violations[0]!.rule).toBe('arbiter-malformed')
    expect(callCount(scenario)).toBe(2)
  })
  it('a dead pin refuses with the invocation rows and the pin, asking no other model (row 212)', async () => {
    const { repo, scenario, ctx, cfg } = await setup('schema: 1\ngates:\n  model: test-model-1\n')
    writeFileSync(join(scenario, 'claude-fail-arbiter'), 'test-model-1')
    const r = await arbitrate(ctx, repo.root, cfg, REQ)
    expect(!r.ok && r.violations.map((x) => x.rule)).toEqual(expect.arrayContaining(['reviewer-invocation', 'pin-unanswered']))
    expect(!r.ok && r.violations.find((x) => x.rule === 'pin-unanswered')!.field).toBe('arbiter.model')
    expect(callCount(scenario)).toBe(1)
  })
  it('a pin this harness cannot run is refused under arbiter.model (row 212)', async () => {
    const { repo, ctx, cfg } = await setup('schema: 1\ngates:\n  model: anthropic/test-model-1\n')
    const r = await arbitrate(ctx, repo.root, cfg, REQ)
    expect(!r.ok && r.violations[0]).toMatchObject({ field: 'arbiter.model', rule: 'provider-unrunnable' })
  })
  it('refuses with the invocation rows when its model cannot be invoked', async () => {
    const { repo, scenario, ctx, cfg } = await setup()
    writeFileSync(join(scenario, 'claude-fail-arbiter'), '')
    const r = await arbitrate(ctx, repo.root, cfg, REQ)
    expect(!r.ok && r.violations[0]!.rule).toBe('reviewer-invocation')
  })
})

describe('the look is never the arbiter\'s to approve (F1)', () => {
  it('drops every approve at the design gate, at the bound and below it', () => {
    const d = (round: number, sha: string, extra: Record<string, unknown> = {}) => run(round, sha, { gate: 'design', ...extra }, blocking('design#save-bar'))
    const at = (entries: Entry[]) => {
      const block = recommend({ gate: 'design', target: 'p1', entries, upstream: 'auth-hardening', stale: false })!
      return menuFor(block, lastGateRun(entries, 'design')!).map((x) => x.command)
    }
    expect(at([d(1, 'a'), d(2, 'b'), d(3, 'c')]).filter((c) => c.includes('--approve'))).toEqual([])
    expect(at([d(1, 'a', { pin: 'pinned-model' })]).filter((c) => c.includes('--approve'))).toEqual([])
    expect(at([d(1, 'a'), d(2, 'b'), d(3, 'c')])).toContain('witness decide design p1 --stop')
  })
})
