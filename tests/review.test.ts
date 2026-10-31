import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { acquireLock } from '../src/lock.js'
import {
  approve, callCount, callFor, DESIGN_HTML, fakeScenario, gateEnv, patchConfig, putVerdict, seededRepo, witnessDesign,
  writeDesign, writeSpec, type TestRepo,
} from './helpers.js'

// As in tests/gate-design.test.ts:12-18.
const CLEAN = {
  coverage: [
    { anchor: 'design#save-bar', note: 'primary action visible' },
    { anchor: 'booking-form > ## Behavior', note: 'every behavior has a home' },
  ],
  findings: [] as never[],
}
const BLOCKING = { coverage: CLEAN.coverage, findings: [{ blocking: true, anchor: 'design#save-bar', claim: 'Save sits below the fold.' }] }
const V2 = DESIGN_HTML.replace('New service', 'Edit service')

let repo: TestRepo
let scenario: string
let env: Record<string, string>

beforeEach(async () => {
  repo = await seededRepo()
  await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
  approve(repo, 'booking-form')
  patchConfig(repo, { docs: { design: ['docs/ui/canon.md'] } })
  repo.write('docs/ui/canon.md', '# Canon\nOne primary action.\n')
  repo.git('add', 'witness.config.yaml', 'docs/ui/canon.md')
  repo.git('commit', '-m', 'design canon')
  scenario = fakeScenario()
  env = gateEnv(scenario)
})

const stdinOf = (n: number) => readFileSync(join(scenario, `claude-calls/call-${n}/stdin`), 'utf8')
const gate = () => repo.cli(['gate', 'design', 'booking-form'], { env })
const review = (...extra: string[]) => repo.cli(['review', 'design', 'booking-form', ...extra], { env })

describe('witness review design (row 215)', () => {
  it('reviews the registered look, unseen, and writes nothing (issue #73)', async () => {
    await writeDesign(repo, 'booking-form')                                 // registered, never --open'd
    putVerdict(scenario, BLOCKING)
    const head = repo.git('rev-parse', 'HEAD'); const lines = readStream(repo.root, 'booking-form').length
    const status = repo.git('status', '--porcelain')
    const local = () => readdirSync(join(repo.root, '.witness'), { recursive: true }).map(String).sort()
    const before = local()
    const r = await repo.cli(['review', 'design', 'booking-form'], { env })
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('review: design booking-form')
    expect(r.stdout).toMatch(/look: designs\/booking-form\.html · [0-9a-f]{7} · registered/)
    expect(r.stdout).toContain('design-critic,true,,design#save-bar,Save sits below the fold.')
    expect(r.stdout).toContain('outcome: 1 blocking')
    expect(r.stdout).toContain("note: a review journals nothing and decides nothing — only the gate's verdict counts")
    expect([repo.git('rev-parse', 'HEAD'), readStream(repo.root, 'booking-form').length, repo.git('status', '--porcelain')])
      .toEqual([head, lines, status])
    expect(local()).toEqual(before)
    expect(callCount(scenario)).toBe(1)
  })

  it("asks exactly the gate's question: the look, then its controls, then the spec (issue #73)", async () => {
    repo.write('d.html', DESIGN_HTML); putVerdict(scenario, CLEAN)
    expect((await repo.cli(['review', 'design', 'booking-form', '--file', 'd.html'], { env })).code).toBe(0)
    const asked = readFileSync(join(scenario, 'claude-calls/call-1/stdin'), 'utf8')
    rmSync(join(repo.root, 'd.html'))
    await writeDesign(repo, 'booking-form'); await witnessDesign(repo, 'booking-form')
    await repo.cli(['gate', 'design', 'booking-form'], { env })
    expect(readFileSync(join(scenario, 'claude-calls/call-2/stdin'), 'utf8')).toBe(asked)
    const at = (s: string) => asked.indexOf(s)
    expect(at('### Design artifact: the look for booking-form')).toBeGreaterThan(-1)
    expect(at('### Design artifact: the look for booking-form')).toBeLessThan(at('### Controls in the look (from markup)'))
    expect(at('### Controls in the look (from markup)')).toBeLessThan(at('### Parent spec: booking-form'))
    expect(asked).toContain('One primary action.')
    expect(asked).not.toContain('designs/booking-form.html')
  })

  it("replays the gate's full answer on these bytes, asking nobody (issue #73)", async () => {
    await writeDesign(repo, 'booking-form'); await witnessDesign(repo, 'booking-form')
    putVerdict(scenario, BLOCKING); await gate()
    const r = await review()
    expect(r.stdout).toContain('answered: gate round 1 · run ')
    expect(r.stdout).toContain('design-critic,true,,design#save-bar,Save sits below the fold.')
    expect(r.code).toBe(1)
    expect(callCount(scenario)).toBe(1)
  })

  it('a delta round is never the answer (issue #73)', async () => {
    await writeDesign(repo, 'booking-form'); await witnessDesign(repo, 'booking-form')
    putVerdict(scenario, BLOCKING); await gate()
    await writeDesign(repo, 'booking-form', V2); await witnessDesign(repo, 'booking-form')
    putVerdict(scenario, CLEAN); await gate()
    expect(stdinOf(2)).toContain('## Delta review')
    const r = await review()
    expect(r.stdout).not.toContain('answered:')
    expect(r.stdout).toContain('earlier: gate round 2 judged these bytes in delta mode — 0 blocking')
    expect(callCount(scenario)).toBe(3)
    expect(stdinOf(3)).not.toContain('## Delta review')
  })

  it('edit-then-revert replays the older full round (issue #73)', async () => {
    await writeDesign(repo, 'booking-form'); await witnessDesign(repo, 'booking-form')
    putVerdict(scenario, BLOCKING); await gate()
    await writeDesign(repo, 'booking-form', V2); await witnessDesign(repo, 'booking-form')
    putVerdict(scenario, CLEAN); await gate()
    await writeDesign(repo, 'booking-form')                                 // back to round 1's bytes, no gate
    const r = await review()
    expect(r.stdout).toContain('answered: gate round 1')
    expect(callCount(scenario)).toBe(2)
  })

  it('a moved look asks again (issue #73)', async () => {
    await writeDesign(repo, 'booking-form'); await witnessDesign(repo, 'booking-form')
    putVerdict(scenario, BLOCKING); await gate()
    await writeDesign(repo, 'booking-form', V2)
    const r = await review()
    expect(callCount(scenario)).toBe(2)
    expect(r.stdout).not.toContain('answered:')
  })

  it('a moved canon doc asks again, and names the round that judged these bytes (issue #73)', async () => {
    await writeDesign(repo, 'booking-form'); await witnessDesign(repo, 'booking-form')
    putVerdict(scenario, BLOCKING); await gate()
    repo.write('docs/ui/canon.md', '# Canon\nOne primary action, always visible.\n')
    repo.git('add', 'docs/ui/canon.md'); repo.git('commit', '-m', 'canon moves')
    const r = await review()
    expect(callCount(scenario)).toBe(2)
    expect(r.stdout).toContain('earlier: gate round 1 judged these bytes under another setup (prompts) — 1 blocking')
  })

  it('a non-blocking note is clean, its claim spelled out (issue #73)', async () => {
    await writeDesign(repo, 'booking-form')
    putVerdict(scenario, { coverage: CLEAN.coverage, findings: [{ blocking: false, anchor: 'design#save-bar', claim: 'Tighten \u001b[2J spacing' }] })
    const r = await review()
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('outcome: clean')
    expect(r.stdout).toContain(',false,')
    expect(r.stdout).toContain('Tighten \\x1b[2J spacing')
    expect(r.stdout).not.toContain('\u001b')
  })

  it('a verdict invalid twice is malformed (issue #73)', async () => {
    await writeDesign(repo, 'booking-form')
    putVerdict(scenario, { coverage: CLEAN.coverage, findings: [{ blocking: true, anchor: 'design#nope', claim: 'x' }] })
    const r = await review()
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('malformed[1]{reviewer,field,rule}:')
    expect(r.stdout).toContain('outcome: malformed — a reviewer answered twice with an invalid verdict; run the review again')
    expect(callCount(scenario)).toBe(2)
  })

  it.each([
    ['no arguments', [], {}, 'usage: witness review design <spec-id> [--file <html>]'],
    ['three positionals', ['design', 'a', 'b'], {}, 'usage: witness review design <spec-id> [--file <html>]'],
    ['another gate', ['plan', 'x'], {}, 'review-scope'],
    ['a drive session', ['design', 'booking-form'], { WITNESS_DRIVE: '1' }, 'review-in-session'],
    ['an unknown id', ['design', 'nope'], {}, 'unknown-spec'],
    ['a spec without ui: true', ['design', 'auth-refresh'], {}, 'not-ui'],
    ['no look and no --file', ['design', 'booking-form'], {}, 'no-design'],
    ['a missing --file', ['design', 'booking-form', '--file', 'missing.html'], {}, 'input-unreadable'],
    ['a directory --file', ['design', 'booking-form', '--file', '.'], {}, 'is not a regular file'],
    ['a look with an external script', ['design', 'booking-form', '--file', 'ext.html'], {}, 'external-ref'],
  ] as Array<[string, string[], Record<string, string>, string]>)('refuses %s, asking nobody (issue #73)', async (_n, args, extra, want) => {
    await writeSpec(repo, 'auth-refresh')
    repo.write('ext.html', DESIGN_HTML.replace('</body>', '<script src="https://x/y.js"></script></body>'))
    const r = await repo.cli(['review', ...args], { env: { ...env, ...extra } })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(want)
    if (want === 'is not a regular file') expect(r.stderr).toContain('input-unreadable')
    expect(callCount(scenario)).toBe(0)
  })

  it('asks the resolved harness (issue #73)', async () => {
    patchConfig(repo, { harness: 'pi' })
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'pi judges')
    await writeDesign(repo, 'booking-form')
    putVerdict(scenario, CLEAN)
    const r = await review()
    expect(r.code, r.stderr).toBe(0)
    expect(callFor(scenario, 'design-critic', 'pi')).toBeDefined()
    expect(callCount(scenario)).toBe(0)
  })

  it('reads a --file relative to a subdirectory, while another process holds the lock (issue #73)', async () => {
    mkdirSync(join(repo.root, 'sub'))
    repo.write('sub/d.html', DESIGN_HTML)
    putVerdict(scenario, CLEAN)
    // Another live pid: acquireLock returns at once for its own pid (src/lock.ts:139).
    const held = acquireLock(repo.root, process.ppid)
    if (!held.ok) throw new Error('lock')
    try {
      const r = await repo.cli(['review', 'design', 'booking-form', '--file', 'd.html'], { env, cwd: join(repo.root, 'sub') })
      expect(r.code, r.stderr).toBe(0)
      expect(r.stdout).toMatch(/look: .*sub\/d\.html · [0-9a-f]{7} · not registered/)
    } finally {
      held.value()
    }
  })
})
