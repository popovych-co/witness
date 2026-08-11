import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gateSpec, runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import { liveExits, notePrefill } from '../src/rounds.js'
import { loadCanon } from '../src/scan.js'
import { runShip } from '../src/ship.js'
import { cmd, kv } from '../src/toon.js'
import {
  addOrigin, approve, fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, shippableRepo,
  writePlan, writeSpec,
} from './helpers.js'

const BLOCKING = {
  coverage: [
    { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
    { anchor: 'auth-refresh > ## Behavior', note: 'read' },
  ],
  findings: [{ blocking: true, anchor: 'auth-refresh-plan-1 > ## Step: s1', claim: 'step is untestable' }],
}

async function stoppedPlanGate() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  const scenario = fakeScenario()
  putVerdict(scenario, BLOCKING)
  await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
  return repo
}

describe('cmd emits commands raw', () => {
  it('does not quote a command containing double quotes', () => {
    const line = cmd('exits', 'witness decide plan p1 --revise --note "<why>" | --stop')
    expect(line).toBe('exits: witness decide plan p1 --revise --note "<why>" | --stop')
  })

  it('does not quote a command containing a comma', () => {
    expect(cmd('run', 'witness dismiss s1 --note "a, b"')).toBe('run: witness dismiss s1 --note "a, b"')
  })

  it('kv still escapes non-command values', () => {
    expect(kv('note', 'spent, and an edit forfeits approve')).toBe('note: "spent, and an edit forfeits approve"')
  })
})

describe('decide --show prints a pasteable exits line', () => {
  it('does not wrap or double the quotes', async () => {
    const repo = await stoppedPlanGate()
    const s = await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--show'])
    const line = s.stdout.split('\n').find((l) => l.startsWith('exits:'))!
    expect(line).not.toContain('""')
    expect(line.startsWith('exits: "')).toBe(false)
    expect(line).toContain('witness decide plan auth-refresh-plan-1 --approve')
  })
})

describe('every gate resolves its own upstream', () => {
  it('plan resolves to the parent spec; implement and ship resolve to the plan', async () => {
    const repo = await stoppedPlanGate()
    const canon = loadCanon(repo.root)
    expect(gateSpec('plan')!.upstreamOf!(repo.root, canon, 'auth-refresh-plan-1')).toBe('auth-refresh')
    expect(gateSpec('implement')!.upstreamOf!(repo.root, canon, 'auth-refresh-plan-1')).toBe('auth-refresh-plan-1')
    expect(gateSpec('ship')!.upstreamOf!(repo.root, canon, 'auth-refresh-plan-1')).toBe('auth-refresh-plan-1')
  })

  it('decompose resolves to the effort itself', async () => {
    const repo = await stoppedPlanGate()
    const canon = loadCanon(repo.root)
    expect(gateSpec('decompose')!.upstreamOf!(repo.root, canon, repo.effort)).toBe(repo.effort)
  })

  it('design resolves to the owning effort, and undefined when none owns it', async () => {
    const repo = await stoppedPlanGate()
    const canon = loadCanon(repo.root)
    expect(gateSpec('design')!.upstreamOf!(repo.root, canon, 'auth-refresh')).toBe(repo.effort)
    expect(gateSpec('design')!.upstreamOf!(repo.root, canon, 'no-such-spec')).toBeUndefined()
  })

  it('plan returns undefined for an unknown plan', async () => {
    const repo = await stoppedPlanGate()
    const canon = loadCanon(repo.root)
    expect(gateSpec('plan')!.upstreamOf!(repo.root, canon, 'no-such-plan')).toBeUndefined()
  })
})

describe('liveExits', () => {
  it('omits the upstream option when no upstream resolves', async () => {
    const repo = await stoppedPlanGate()
    const entries = readStream(repo.root, 'auth-refresh-plan-1')
    const line = liveExits('plan', 'auth-refresh-plan-1', entries, false, undefined)
    expect(line).not.toContain('--upstream')
    expect(line).toContain('--approve')
  })

  it('names the resolved upstream when one is given', async () => {
    const repo = await stoppedPlanGate()
    const entries = readStream(repo.root, 'auth-refresh-plan-1')
    const line = liveExits('plan', 'auth-refresh-plan-1', entries, false, 'auth-refresh')
    expect(line).toContain('--revise --upstream auth-refresh')
    expect(line).not.toContain('<id>')
  })

  it('prefills the note from the anchoring run findings', async () => {
    const repo = await stoppedPlanGate()
    const entries = readStream(repo.root, 'auth-refresh-plan-1')
    expect(notePrefill(entries, 'plan')).toContain('auth-refresh-plan-1 > ## Step: s1')
    expect(liveExits('plan', 'auth-refresh-plan-1', entries, false, 'auth-refresh')).not.toContain('<why>')
  })

  it('falls back to <why> when the run offers no facts', () => {
    expect(notePrefill([], 'plan')).toBe('<why>')
  })
})

describe('no rendered exits line contains a placeholder', () => {
  it('gate, decide --show and next all name a real upstream', async () => {
    const repo = await stoppedPlanGate()
    const show = await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--show'])
    const next = await repo.cli(['next'])
    for (const out of [show.stdout, next.stdout]) {
      expect(out).not.toContain('<id>')
      expect(out).not.toContain('<effort>')
    }
    expect(show.stdout).toContain('--revise --upstream auth-refresh')
  })
})

const STEPS = { steps: [{ id: 's1', title: 'rotate', criteria: ['ac-rotate'] }] }

describe('the bound-hit branch offers the same set as liveExits', () => {
  it('names the repair grant and abandon at round 4', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    const scenario = fakeScenario()
    putVerdict(scenario, BLOCKING)
    let last = ''
    for (let i = 1; i <= 4; i++) {
      await writePlan(repo, 'auth-refresh-plan-1', STEPS, `## Step: s1\nAttempt ${i}.\n`)
      const g = await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
      last = g.stdout
    }
    expect(last).toContain('--revise --repair')
    expect(last).toContain('witness abandon auth-refresh-plan-1')
    expect(last).not.toContain('<id>')
  })
})

const CLEAN = {
  coverage: [
    { anchor: '.gitignore', note: 'read' },
    { anchor: 'package.json', note: 'read' },
    { anchor: 'src/token.ts', note: 'read' },
    { anchor: 'tests/token.test.ts', note: 'read' },
  ],
  findings: [],
}

describe('ship prints one exits set', () => {
  it('gate phase prints no second approve-only line; awaiting-decision names upstream', async () => {
    const seed = await shippableRepo()
    addOrigin(seed.repo)
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const outs: string[] = []
    const ctx = fakeCtx(seed.repo.root, { env: gateEnv(scenario), out: (l) => outs.push(l) })
    await runGate(ctx, 'implement', seed.planId, { fresh: false, manual: false })

    outs.length = 0
    await runShip(ctx, seed.planId)
    const gateHelps = outs.filter((l) => l.startsWith('help:'))
    expect(gateHelps).toHaveLength(1)
    expect(gateHelps[0]).toContain('--revise --upstream')

    outs.length = 0
    await runShip(ctx, seed.planId)
    const awaiting = outs.filter((l) => l.startsWith('help:'))
    expect(awaiting).toHaveLength(1)
    expect(awaiting[0]).toContain('--revise --upstream')
  })
})

// A sweep alone recurs: `liveExits`'s own comment says it was written to abolish three
// hand-copied triples, and four were live three releases later. These two properties are
// what make the next copy — and the next placeholder — fail in CI instead of in the field.
const SRC = fileURLToPath(new URL('../src', import.meta.url))
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })

describe('no source builds its own exits set', () => {
  it('only rounds.ts composes decision verbs into a set', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      if (file.endsWith(join('src', 'rounds.ts'))) continue
      const text = readFileSync(file, 'utf8')
      for (const [i, line] of text.split('\n').entries()) {
        if (line.trimStart().startsWith('//')) continue
        // A set is two or more decision flags joined by ` | ` in one string literal that
        // names the command. The command name is load-bearing: `decide.ts`'s
        // `one-of-required` refusal states the flag GRAMMAR (`--approve | --revise |
        // --stop`) rather than an exits set — it fires on a usage error, before any
        // anchoring run is known, so it must not be routed through `liveExits`, which
        // would answer with upstream and repair options that are meaningless there.
        const flags = (line.match(/--(approve|revise|stop|override|repair)/g) ?? []).length
        if (flags >= 2 && line.includes(' | ') && line.includes('witness decide')) {
          offenders.push(`${file}:${i + 1}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

// Scoped to lines that OFFER A DECISION, which is what D129 governs. `witness status`
// also ends on `help: witness check · index · diff <id> · log <id>` — a menu of verbs
// whose `<id>` is argument syntax the human fills in, not a command the CLI is holding
// out as runnable. Widening this to whole stdout would make the two indistinguishable.
const decisionLines = (stdout: string): string[] =>
  stdout.split('\n').filter((l) => l.startsWith('exits:') || l.includes('witness decide '))

describe('no rendered command carries an unresolved id', () => {
  it('holds across gate, decide --show, next and status', async () => {
    const repo = await stoppedPlanGate()
    for (const argv of [
      ['decide', 'plan', 'auth-refresh-plan-1', '--show'],
      ['next'],
      ['status'],
    ]) {
      const r = await repo.cli(argv)
      const lines = decisionLines(r.stdout)
      expect(lines.length, `${argv.join(' ')} renders no decision line`).toBeGreaterThan(0)
      for (const line of lines) {
        expect(line, argv.join(' ')).not.toContain('<id>')
        expect(line, argv.join(' ')).not.toContain('<effort>')
      }
    }
  })
})
