// Row 273 (§4 T3, §3.2). A switch-off a plan adds is a judged red at implement and ship: the battery
// still runs, the reviewers are told each line from the tree, and the round stops.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import type { GateRunEntry } from '../src/rounds.js'
import {
  TOKEN_FIXED, callCount, callFor, fakeCtx, fakeScenario, gateEnv, putVerdict, shippableRepo, type TestRepo,
} from './helpers.js'

// vitest-single lands 4 files in the worktree diff — coverage-minimum needs an anchor for each.
const CLEAN = {
  coverage: [
    { anchor: '.gitignore', note: 'read' },
    { anchor: 'package.json', note: 'read' },
    { anchor: 'src/token.ts', note: 'read' },
    { anchor: 'tests/token.test.ts', note: 'read' },
  ],
  findings: [],
}
const PLAIN = { fresh: false, manual: false }

const runs = (repo: TestRepo, id: string) => readStream(repo.root, id).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]

// A shippable plan whose worktree adds `line` to `file` (src/token.ts keeps its seven lines first).
async function offRed(line = '// eslint-disable-next-line no-console', file = 'src/token.ts') {
  const { repo, wt, planId } = await shippableRepo()
  const scenario = fakeScenario(); putVerdict(scenario, CLEAN)
  writeFileSync(join(wt, file), `${file === 'src/token.ts' ? TOKEN_FIXED : ''}${line}\n`)
  const gate = (name = 'implement', env: Record<string, string> = {}) =>
    runGate(fakeCtx(repo.root, { env: gateEnv(scenario, env) }), name, planId, PLAIN)
  const lastRun = () => runs(repo, planId).at(-1)!
  const offsCheck = () => lastRun().checks.find((c) => c.name === 'switch-offs')
  return { repo, wt, planId, scenario, gate, lastRun, offsCheck }
}

describe('the switch-offs check (row 273)', () => {
  it('a switch-off the plan adds is a judged red: the lenses run, the round stops, the line is journaled', async () => {
    const b = await offRed()
    expect(await b.gate()).toBe(1)
    expect(b.lastRun().checks_only).toBeUndefined()
    expect(callCount(b.scenario)).toBeGreaterThan(0)
    expect(b.offsCheck()).toMatchObject({ ok: false,
      offs: [{ token: 'eslint-disable-next-line', file: 'src/token.ts', line: 8, count: 1, rules: ['no-console'] }],
      detail: expect.stringContaining('src/token.ts:8 eslint-disable-next-line (no-console)') })
  }, 240_000)

  it("the reviewers' prompt names each switch-off from the tree (§4 T3: reviewers see it)", async () => {
    const b = await offRed()
    await b.gate()
    const asked = readFileSync(join(callFor(b.scenario, 'code-reviewer')!, 'stdin'), 'utf8')
    expect(asked).toContain('### Switch-offs this plan adds\n\n- src/token.ts:8 — eslint-disable-next-line (no-console)')
  }, 240_000)

  it('a plan that adds none passes it at implement and ship', async () => {
    const { repo, planId } = await shippableRepo()
    const scenario = fakeScenario(); putVerdict(scenario, CLEAN)
    const gate = (name: string) => runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), name, planId, PLAIN)
    const offsOf = () => runs(repo, planId).at(-1)!.checks.find((c) => c.name === 'switch-offs')
    expect(await gate('implement')).toBe(0)
    expect(offsOf()).toMatchObject({ ok: true, detail: expect.stringMatching(/^no switch-off in the lines the plan adds \(\d+ files\)$/) })
    expect(offsOf()!.offs).toBeUndefined()
    const asked = readFileSync(join(callFor(scenario, 'code-reviewer')!, 'stdin'), 'utf8')
    expect(asked).not.toContain('### Switch-offs this plan adds')
    await gate('ship')
    expect(runs(repo, planId).at(-1)!.gate).toBe('ship')
    expect(offsOf()).toMatchObject({ ok: true })
  }, 240_000)

  it('ship runs it too', async () => {
    const { repo, wt, planId } = await shippableRepo()
    const scenario = fakeScenario(); putVerdict(scenario, CLEAN)
    const gate = (name: string) => runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), name, planId, PLAIN)
    expect(await gate('implement')).toBe(0)
    writeFileSync(join(wt, 'src/token.ts'), `${TOKEN_FIXED}// @ts-expect-error a type test\n`)
    expect(await gate('ship')).toBe(1)
    const run = runs(repo, planId).at(-1)!
    expect(run.gate).toBe('ship')
    expect(run.checks.find((c) => c.name === 'switch-offs')).toMatchObject({ ok: false,
      offs: [{ token: '@ts-expect-error', file: 'src/token.ts', line: 8, count: 1 }] })
    expect(readFileSync(join(callFor(scenario, 'code-reviewer')!, 'stdin'), 'utf8'))
      .toContain('### Switch-offs this plan adds\n\n- src/token.ts:8 — @ts-expect-error\n')
  }, 240_000)

  it('a path holding a bidi character is spelled out in the detail and the note (Review Focus 3)', async () => {
    const odd = `src/we${String.fromCodePoint(0x202e)}ird.ts`
    const b = await offRed('// @ts-ignore', odd)
    putVerdict(b.scenario, { ...CLEAN, coverage: [...CLEAN.coverage, { anchor: odd, note: 'read' }] })
    await b.gate()
    const detail = b.offsCheck()!.detail!
    expect(detail).toContain('src/we\\u{202e}ird.ts:1 @ts-ignore')
    expect(detail).not.toContain(String.fromCodePoint(0x202e))
    expect(readFileSync(join(callFor(b.scenario, 'code-reviewer')!, 'stdin'), 'utf8')).toContain('- src/we\\u{202e}ird.ts:1 — @ts-ignore')
  }, 240_000)
})
