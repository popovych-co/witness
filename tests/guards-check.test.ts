import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planChangeSet } from '../src/change-set.js'
import { checksSignature } from '../src/checks.js'
import { loadConfig } from '../src/config.js'
import { diffBase } from '../src/evidence.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { guardsCheck, noteUnmeasured } from '../src/guard.js'
import { appendEntry, readStream, type Entry } from '../src/journal.js'
import type { GateRunEntry } from '../src/rounds.js'
import { fakeCtx, fakeScenario, gateEnv, putVerdict, shippableRepo, unwrap } from './helpers.js'

// A shippable plan whose stream the test writes: marking rounds, guards and decisions as entries.
async function checkBench() {
  const { repo, wt, planId } = await shippableRepo()
  mkdirSync(join(wt, 'tests'), { recursive: true })
  writeFileSync(join(wt, 'tests/guard.test.ts'), "it('rotates', () => {})\n")
  const blob = (p: string) => execFileSync('git', ['hash-object', '--', p], { cwd: wt, encoding: 'utf8' }).trim()
  let n = 0
  const marked = (gate = 'implement', anchor = 'src/token.ts', guard = 'lint') => appendEntry(repo.root, planId, {
    v: 1, t: 'gate-run', gate, artifact: planId, round: ++n, run_id: `r${n}`, reviewed_sha: 's', prompts_sha: 'p', witness: '0',
    model: 'm', pin: 'm', harness: 'claude-code', checks: [], reviewed_tree: 'a'.repeat(40),
    verdicts: [{ reviewer: 'code-reviewer', coverage: [], findings: [{ anchor, claim: 'c', blocking: true, guard }] }], outcome: 'stopped',
  } as unknown as Entry)
  const proven = (gate = 'implement', anchor = 'src/token.ts', files: Record<string, string> = { 'tests/guard.test.ts': blob('tests/guard.test.ts') }) =>
    appendEntry(repo.root, planId, { v: 1, t: 'guard', gate, anchor, round: n, run: `r${n}`, kind: 'test', tests: ['rotates'], files, base: 'b', red: 'r', green: 'g', ms: 1 } as unknown as Entry)
  const decided = (gate: string, decision: string) =>
    appendEntry(repo.root, planId, { v: 1, t: 'human-decision', gate, artifact: planId, round: n, decision } as unknown as Entry)
  const check = (gate: 'implement' | 'ship' = 'implement') => guardsCheck(repo.root, wt, planId, gate)
  return { repo, wt, planId, marked, proven, decided, check }
}

describe('the guards check (row 281)', () => {
  it('no marked finding: green, and no guards term (row 281)', async () => {
    const b = await checkBench()
    expect(b.check()).toEqual({ name: 'guards', ok: true, detail: "no marked finding since the gate's last reset" })
  })

  it('a marked finding with no guard is owed: red, naming the act', async () => {
    const b = await checkBench()
    b.marked()
    const c = b.check()
    expect(c).toMatchObject({ ok: false, guards: [{ anchor: 'src/token.ts', mark: 'lint', state: 'owed' }] })
    expect(c.detail).toContain(`owed: src/token.ts (lint) — witness guard ${b.planId} --finding 'src/token.ts'`)
  })

  it('a proven guard answers it', async () => {
    const b = await checkBench()
    b.marked(); b.proven()
    expect(b.check()).toMatchObject({ ok: true, guards: [{ anchor: 'src/token.ts', mark: 'lint', state: 'proven', kind: 'test' }] })
  })

  it('a guard whose overlay file changed since its proof is stale (Review Focus 5)', async () => {
    const b = await checkBench()
    b.marked(); b.proven()
    writeFileSync(join(b.wt, 'tests/guard.test.ts'), "it('rotates', () => { throw 1 })\n")
    const c = b.check()
    expect(c).toMatchObject({ ok: false, guards: [{ state: 'stale', moved: ['tests/guard.test.ts'] }] })
    expect(c.detail).toContain('stale: src/token.ts')
    rmSync(join(b.wt, 'tests/guard.test.ts'))
    expect(b.check()).toMatchObject({ ok: false, guards: [{ state: 'stale', moved: ['tests/guard.test.ts'] }] })
  })

  it('a stale guard the judge or the human books reads waived (final review I1)', async () => {
    const b = await checkBench()
    b.marked(); b.proven()
    writeFileSync(join(b.wt, 'tests/guard.test.ts'), "it('rotates', () => { throw 1 })\n")
    expect(b.check()).toMatchObject({ ok: false, guards: [{ state: 'stale' }] })
    appendEntry(b.repo.root, b.planId, { v: 1, t: 'human-decision', gate: 'implement', artifact: b.planId, round: 1, decision: 'book',
      book: { check: 'guards', items: [], findings: ['src/token.ts'] } } as unknown as Entry)
    expect(b.check()).toMatchObject({ ok: true, guards: [{ anchor: 'src/token.ts', state: 'waived' }] })
  })

  it("a not-measured note counts only where the check can verify it now: a forged one never reaches the judge (push security review)", async () => {
    const b = await checkBench()
    b.marked()
    noteUnmeasured(b.repo.root, b.planId, 'src/token.ts', 'load-failure')
    expect(b.check().guards![0]!.unmeasured).toBeUndefined()
    noteUnmeasured(b.repo.root, b.planId, 'src/token.ts', 'breadth-unprobed')            // a TS file: breadth can copy it
    expect(b.check().guards![0]!.unmeasured).toBeUndefined()
    noteUnmeasured(b.repo.root, b.planId, 'src/token.ts', 'tree-unknown')                // the bench round's tree is 'a'×40, held by none
    expect(b.check().guards![0]!.unmeasured).toBe('tree-unknown')
  })

  it('a guard proven at implement does not answer a mark at ship', async () => {
    const b = await checkBench()
    b.marked('implement'); b.proven('implement'); b.marked('ship')
    expect(b.check('ship')).toMatchObject({ ok: false, guards: [{ state: 'owed' }] })
    expect(b.check('implement')).toMatchObject({ ok: true })
  })

  it("marks before the gate's last reset owe nothing", async () => {
    const b = await checkBench()
    b.marked(); b.decided('implement', 'approve')
    expect(b.check()).toMatchObject({ ok: true, detail: "no marked finding since the gate's last reset" })
  })

  it('the signature moves when a guard is proven', async () => {
    const b = await checkBench()
    b.marked()
    const before = b.check()
    b.proven()
    const after = b.check()
    expect(checksSignature([before])).not.toBe(checksSignature([after]))
    expect(checksSignature([{ ...before, detail: 'other' }])).toBe(checksSignature([before]))
  })
})

describe('the gates run the guards check (row 281)', () => {
  it('the implement and ship gates run the check: a marked round re-gated without a guard stops judged, the battery still runs', async () => {
    const { repo, wt, planId } = await shippableRepo()
    const cfg = unwrap(loadConfig(repo.root))
    const base = unwrap(diffBase(wt, cfg))
    const files = () => planChangeSet(wt, base)
    const scenario = fakeScenario()
    const runs = () => readStream(repo.root, planId).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]
    const gate = () => runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'implement', planId, { fresh: false, manual: false })
    putVerdict(scenario, { coverage: files().slice(0, 5).map((f) => ({ anchor: f, note: 'read' })),
      findings: [{ anchor: 'src/token.ts', claim: 'rotates late', blocking: true, guard: 'test' }] })
    await gate()
    expect(runs().at(-1)!.checks.find((c) => c.name === 'guards')).toMatchObject({ ok: true })
    writeFileSync(join(wt, 'src/token.ts'), `${execFileSync('git', ['show', 'HEAD:src/token.ts'], { cwd: wt, encoding: 'utf8' })}// revised\n`)
    execFileSync('git', ['commit', '-qam', 'revise'], { cwd: wt })
    putVerdict(scenario, { coverage: files().slice(0, 5).map((f) => ({ anchor: f, note: 'read' })), findings: [] })
    await gate()
    const last = runs().at(-1)!
    expect(last.round).toBe(2)
    expect(last.checks.find((c) => c.name === 'guards')).toMatchObject({ ok: false, guards: [{ anchor: 'src/token.ts', mark: 'test', state: 'owed' }] })
    expect(last.checks_only).toBeUndefined()
    expect(last.verdicts?.length).toBeGreaterThan(0)
    expect(last.outcome).toBe('stopped')
  }, 120_000)
})
