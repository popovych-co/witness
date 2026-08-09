import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { screensDir } from '../src/evidence.js'
import { readStream } from '../src/journal.js'
import { fakeCtx, fakeScenario, fixtureEnv, gateEnv, putVerdict, shippableRepo } from './helpers.js'

// A vitest test that, when WITNESS_SCREENS_DIR is set, writes a PNG there — the
// stand-in for a Puppeteer capture. Tagged so the criteria runner reaches it.
const CAPTURE_TEST = `import { expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
it('renders the screen @spec:auth-refresh', () => {
  const dir = process.env.WITNESS_SCREENS_DIR
  if (dir) writeFileSync(join(dir, 'initial.png'), Buffer.from('PNGBYTES-v1'))
  expect(1).toBe(1)
})
`

describe('capture convention', () => {
  it('exports WITNESS_SCREENS_DIR and clears the dir each evidence cycle', async () => {
    const { repo, wt, planId } = await shippableRepo()
    // a stale capture from a prior cycle must not survive into this one
    const dir = screensDir(wt, planId)
    writeFileSync(join(dir, 'stale.png'), Buffer.from('OLD'))
    writeFileSync(join(wt, 'tests/capture.test.ts'), CAPTURE_TEST)
    execFileSync('git', ['add', '-A'], { cwd: wt })
    await repo.cli(['test-evidence', planId, '--phase', 'green'], { cwd: wt, env: fixtureEnv() })
    expect(existsSync(join(dir, 'initial.png'))).toBe(true)
    expect(existsSync(join(dir, 'stale.png'))).toBe(false)      // cleared
    expect(readFileSync(join(dir, 'initial.png'), 'utf8')).toBe('PNGBYTES-v1')
  })

  it('screens live under an ignored path — never in the diff', async () => {
    const { wt, planId } = await shippableRepo()
    writeFileSync(join(screensDir(wt, planId), 'x.png'), Buffer.from('P'))
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: wt, encoding: 'utf8' })
    expect(untracked).not.toContain('.witness/screens/')
  })
})

describe('witnessed capture shas', () => {
  it('journals {name, sha} per PNG on the green test-evidence entry', async () => {
    const { repo, wt, planId } = await shippableRepo()
    writeFileSync(join(wt, 'tests/capture.test.ts'), CAPTURE_TEST)
    execFileSync('git', ['add', '-A'], { cwd: wt })
    await repo.cli(['test-evidence', planId, '--phase', 'green'], { cwd: wt, env: fixtureEnv() })
    const evid = readStream(repo.root, planId).filter((e) => e.t === 'test-evidence' && e.phase === 'green')
    const captures = (evid.at(-1) as { captures?: Array<{ name: string; sha: string }> }).captures ?? []
    expect(captures.map((c) => c.name)).toEqual(['initial.png'])
    const wantSha = createHash('sha256').update(Buffer.from('PNGBYTES-v1')).digest('hex')
    expect(captures[0]!.sha).toBe(wantSha)
  })

  it('records no captures field when the suite screenshots nothing', async () => {
    const { repo, wt, planId } = await shippableRepo()   // token.test.ts only — no capture test
    await repo.cli(['test-evidence', planId, '--phase', 'green'], { cwd: wt, env: fixtureEnv() })
    const evid = readStream(repo.root, planId).filter((e) => e.t === 'test-evidence' && e.phase === 'green')
    expect((evid.at(-1) as { captures?: unknown }).captures).toBeUndefined()
  })
})

function treeClean(files: string[]) {
  return { coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })), findings: [] }
}

describe('implement gate — capture preconditions', () => {
  it('a pinned UI plan with zero captures refuses screens-matched-nothing, journals nothing', async () => {
    const { repo, planId } = await shippableRepo()          // green evidence, but no screenshots
    repo.setMeta(planId, { 'design-from': 'a'.repeat(64) })  // mark UI-work
    const errs: string[] = []
    const ctx = fakeCtx(repo.root, { env: gateEnv(fakeScenario()), err: (l) => errs.push(l) })
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(2)  // REFUSED
    expect(errs.join('\n')).toContain('screens-matched-nothing')
    const runs = readStream(repo.root, planId).filter((e) => e.t === 'gate-run')
    expect(runs.length).toBe(0)                              // no reviewer invoked, nothing journaled
  })

  it('a doctored capture (sha ≠ witnessed) refuses capture-sha-mismatch', async () => {
    const { repo, wt, planId } = await shippableRepo()
    writeFileSync(join(wt, 'tests/capture.test.ts'), CAPTURE_TEST)  // writes initial.png = "PNGBYTES-v1"
    execFileSync('git', ['add', '-A'], { cwd: wt })
    await repo.cli(['test-evidence', planId, '--phase', 'green'], { cwd: wt, env: fixtureEnv() })
    repo.setMeta(planId, { 'design-from': 'a'.repeat(64) })
    // swap the bytes AFTER witnessing — the adversary CLI-witnessing exists for
    writeFileSync(join(screensDir(wt, planId), 'initial.png'), Buffer.from('DOCTORED'))
    const errs: string[] = []
    const ctx = fakeCtx(repo.root, { env: gateEnv(fakeScenario()), err: (l) => errs.push(l) })
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(2)
    expect(errs.join('\n')).toContain('capture-sha-mismatch')
  })

  it('a non-UI plan (no pin) skips the capture check entirely', async () => {
    const { repo, wt, planId } = await shippableRepo()
    const scenario = fakeScenario()
    const cfg = (await import('../src/config.js')).loadConfig(repo.root)
    const { diffBase, changedFiles } = await import('../src/evidence.js')
    const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
    putVerdict(scenario, treeClean(changedFiles(wt, base.ok ? base.value : '')))
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(0)  // green path
  })
})

async function uiPlanRepo() {
  const { repo, wt, planId, specId } = await shippableRepo()
  writeFileSync(join(wt, 'tests/capture.test.ts'), CAPTURE_TEST)   // initial.png
  execFileSync('git', ['add', '-A'], { cwd: wt })
  await repo.cli(['test-evidence', planId, '--phase', 'green'], { cwd: wt, env: fixtureEnv() })
  // design canon (registered) + living design artifact + the pin
  repo.write('docs/design.md', 'Every screen opens with a Bookings eyebrow; primary action is a sticky save bar.')
  const cfgPath = join(repo.root, 'witness.config.yaml')
  writeFileSync(cfgPath, readFileSync(cfgPath, 'utf8') + 'docs:\n  design: [docs/design.md]\n')
  repo.write('designs/auth-refresh.html', '<section id="hero"><h1>New service</h1></section>')
  repo.git('add', 'docs/design.md', 'witness.config.yaml', 'designs/auth-refresh.html')
  repo.git('commit', '-m', 'design canon + living design')
  repo.setMeta(planId, { 'design-from': 'a'.repeat(64) })
  return { repo, wt, planId, specId }
}

describe('implement gate — design-reviewer wiring', () => {
  it('a UI plan runs design-reviewer over screens with canon + living design injected', async () => {
    const { repo, wt, planId } = await uiPlanRepo()
    const scenario = fakeScenario()
    const cfg = (await import('../src/config.js')).loadConfig(repo.root)
    const { diffBase, changedFiles } = await import('../src/evidence.js')
    const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
    const files = changedFiles(wt, base.ok ? base.value : '')
    putVerdict(scenario, treeClean(files))                                    // calls 1–4 (tree lenses)
    putVerdict(scenario, { coverage: [{ anchor: 'initial.png', note: 'seen' }], findings: [] }, 5)  // design-reviewer
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(0)
    const design = readFileSync(join(scenario, 'claude-calls/call-5/stdin'), 'utf8')
    expect(design).toContain('initial.png')                                   // capture anchor menu
    expect(design).toContain(join(screensDir(wt, planId), 'initial.png'))     // Read-by-path
    expect(design).toContain('Bookings eyebrow')                              // docs.design canon injected
    expect(design).toContain('id="hero"')                                     // living design injected
  })

  it('a design-reviewer blocking finding stops the gate', async () => {
    const { repo, wt, planId } = await uiPlanRepo()
    const scenario = fakeScenario()
    const cfg = (await import('../src/config.js')).loadConfig(repo.root)
    const { diffBase, changedFiles } = await import('../src/evidence.js')
    const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
    putVerdict(scenario, treeClean(changedFiles(wt, base.ok ? base.value : '')))
    putVerdict(scenario, { coverage: [{ anchor: 'initial.png', note: 'seen' }], findings: [{ blocking: true, anchor: 'initial.png', claim: 'primary action below the fold' }] }, 5)
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(1)  // FINDINGS
  })

  it('a non-UI plan drops design-reviewer, journaled skipped', async () => {
    const { repo, wt, planId } = await shippableRepo()   // no pin
    const scenario = fakeScenario()
    const cfg = (await import('../src/config.js')).loadConfig(repo.root)
    const { diffBase, changedFiles } = await import('../src/evidence.js')
    const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
    putVerdict(scenario, treeClean(changedFiles(wt, base.ok ? base.value : '')))
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(0)
    const entry = readStream(repo.root, planId).filter((e) => e.t === 'gate-run').at(-1) as { skipped?: string[] }
    // Row 115: a skip states its cause — a reader cannot otherwise tell "not applicable"
    // from "could not run", and only one of those is benign.
    expect(entry.skipped).toEqual(['design-reviewer — no design-from pin: not UI work'])
    expect(() => readFileSync(join(scenario, 'claude-calls/call-5/stdin'), 'utf8')).toThrow()  // 4 lenses only
  })

  it('a pinned plan whose living design is gone refuses design-artifact-missing', async () => {
    const { repo, wt, planId } = await uiPlanRepo()
    repo.git('rm', 'designs/auth-refresh.html'); repo.git('commit', '-m', 'drop design')
    const errs: string[] = []
    const ctx = fakeCtx(repo.root, { env: gateEnv(fakeScenario()), err: (l) => errs.push(l) })
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(2)
    expect(errs.join('\n')).toContain('design-artifact-missing')
  })

  it('editing the living design re-rolls a cached verdict on unchanged code', async () => {
    const { repo, wt, planId } = await uiPlanRepo()
    const cfg = (await import('../src/config.js')).loadConfig(repo.root)
    const { diffBase, changedFiles } = await import('../src/evidence.js')
    const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
    const files = changedFiles(wt, base.ok ? base.value : '')
    const scenario1 = fakeScenario()
    putVerdict(scenario1, treeClean(files))
    putVerdict(scenario1, { coverage: [{ anchor: 'initial.png', note: 'seen' }], findings: [] }, 5)
    await runGate(fakeCtx(repo.root, { env: gateEnv(scenario1) }), 'implement', planId, { fresh: false, manual: false })
    const before = readStream(repo.root, planId).filter((e) => e.t === 'gate-run').length
    // amend the approved look — code (and tree-sha) unchanged
    repo.write('designs/auth-refresh.html', '<section id="hero"><h1>New service</h1><nav id="save">Save</nav></section>')
    repo.git('add', 'designs/auth-refresh.html'); repo.git('commit', '-m', 'amend design')
    // fresh scenario: the fake-claude call counter is global per WITNESS_FAKE_DIR, so
    // reusing scenario1 here would push design-reviewer's call past its numbered verdict
    const scenario2 = fakeScenario()
    putVerdict(scenario2, treeClean(files))
    putVerdict(scenario2, { coverage: [{ anchor: 'initial.png', note: 'seen' }], findings: [] }, 5)
    expect(await runGate(fakeCtx(repo.root, { env: gateEnv(scenario2) }), 'implement', planId, { fresh: false, manual: false })).toBe(0)
    expect(readStream(repo.root, planId).filter((e) => e.t === 'gate-run').length).toBe(before + 1)  // re-rolled, not resumed
  })
})

describe('calibration screens support', () => {
  it('loads the design-reviewer suite and composes a screens reviewed', async () => {
    const { composeReviewed, loadReviewerSuite, materialize } = await import('../src/calibrate.js')
    const suiteR = loadReviewerSuite('design-reviewer')
    expect(suiteR.ok).toBe(true)
    if (!suiteR.ok) return
    const { dir, files } = materialize(suiteR.value)
    const { reviewed } = composeReviewed(suiteR.value, dir, files)
    expect(reviewed.kind).toBe('screens')
    if (reviewed.kind === 'screens') {
      expect(reviewed.captures.length).toBeGreaterThan(0)
      expect(reviewed.captures.every((c) => c.name.endsWith('.png'))).toBe(true)
    }
  })
})
