import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ok } from '../src/refusal.js'
import { readStream } from '../src/journal.js'
import { registerGate, runGate, type GateInput } from '../src/gate.js'
import type { GateRunEntry } from '../src/rounds.js'
import { canonicalSha } from '../src/sha.js'
import { findById } from '../src/scan.js'
import { fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, writeSpec } from './helpers.js'

// ship battery default is [drift-reviewer, code-reviewer]; override code-reviewer's
// reviewed object to screens, skip drift-reviewer. Real ship resolve is irrelevant.
let registered = false
function registerSynthetic() {
  if (registered) return
  registered = true
  registerGate({
    gate: 'ship',
    targetKind: 'plan',
    async resolve(root, _ctx, canon, _cfg, target) {
      const doc = findById(canon, target)!
      return ok<GateInput>({
        class: 'feature',
        reviewedSha: canonicalSha(doc.meta, doc.body),
        reviewed: { kind: 'docs', docs: [{ id: target, body: doc.body }] },
        promptBody: 'DEFAULT-BODY',
        lensOverrides: {
          'code-reviewer': {
            reviewed: { kind: 'screens', captures: [{ name: 'home.png', path: '/w/home.png' }] },
            promptBody: 'READ /w/home.png',
          },
        },
        skipLenses: ['drift-reviewer'],
        checks: [{ name: 'synthetic', ok: true }],
        stamps: [],
      })
    },
  })
}

const CLEAN_SCREEN = { coverage: [{ anchor: 'home.png', note: 'seen' }], findings: [] }
const runs = (root: string) => readStream(root, 'auth-refresh').filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]

describe('per-lens review override + skip', () => {
  it('the overridden lens sees screens + its body; the skipped lens never runs', async () => {
    registerSynthetic()
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN_SCREEN)
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    expect(await runGate(ctx, 'ship', 'auth-refresh', { fresh: false, manual: false })).toBe(0)
    // drift-reviewer skipped → only ONE claude call, and it is code-reviewer's
    const only = readFileSync(join(scenario, 'claude-calls/call-1/stdin'), 'utf8')
    expect(() => readFileSync(join(scenario, 'claude-calls/call-2/stdin'), 'utf8')).toThrow()
    expect(only).toContain('READ /w/home.png')       // override body
    expect(only).toContain('- home.png')             // screens anchor menu
    expect(only).not.toContain('DEFAULT-BODY')       // default body not used for this lens
    expect(runs(repo.root)[0]!.skipped).toEqual(['drift-reviewer'])
  })
})
