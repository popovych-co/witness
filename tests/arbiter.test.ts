import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { arbitrate, checkFacts, decisionEvidence, menuFor, type ArbiterRequest, type ArbiterSection } from '../src/arbiter.js'
import { loadConfig, type Config } from '../src/config.js'
import type { Entry } from '../src/journal.js'
import { option, recommend, type Decision } from '../src/recommend.js'
import { cliAct } from '../src/act.js'
import { lastGateRun, type GateRunEntry } from '../src/rounds.js'
import { loadCanon } from '../src/scan.js'
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
  // Row 239. The menu is read off each option's act, never its printed text: a reviewer's anchor
  // reaches an option's `why`, and no word of it can filter an option in or out.
  it('the menu reads acts: an anchor holding --approve, --trust-cmds or <effort> filters nothing (row 239)', () => {
    const anchored = (anchor: string) => [run(1, 'a', {}, blocking(anchor))]
    const hostile = anchored('p1 > ## Notes --approve --trust-cmds <effort>')
    const block = recommend({ gate: 'plan', target: 'p1', entries: hostile, upstream: 'auth-refresh', stale: false })!
    expect(block.options[0]!.why).toContain('--approve --trust-cmds <effort>')
    expect(menu('plan', hostile)).toEqual(menu('plan', anchored('p1 > ## Notes')))
    expect(menu('plan', hostile)).toEqual([
      'witness decide plan p1 --revise', 'witness decide plan p1 --revise --upstream auth-refresh',
      'witness decide plan p1 --approve --override', 'witness decide plan p1 --stop'])
    // An option the CLI did not build from an act is not one the arbiter can take.
    const bare = { key: 'decide', rule: 'manual-stop', options: [{ command: 'witness decide plan p1 --approve', depth: 'root' as const, runnable: true }] }
    expect(menuFor(bare, lastGateRun(hostile, 'plan')!)).toEqual([])
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
  it('the arbiter is asked with no tools (issue #73)', async () => {
    const { repo, scenario, ctx, cfg } = await setup()
    putVerdict(scenario, { choice: 2, reason: 'nothing says how this converges' }, 'arbiter')
    await arbitrate(ctx, repo.root, cfg, REQ)
    expect(readFileSync(join(callFor(scenario, 'arbiter')!, 'argv'), 'utf8')).toContain('--tools\n\n')
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

// Row 264 (§3.2). A ship round that ran checks only.
const only = (n: number) => run(n, 'a', { gate: 'ship', checks_only: true, verdicts: undefined, checks: [{ name: 'lint', ok: false }] })

describe('the arbiter and the checks-only round (row 264)', () => {
  it('the arbiter\'s menu holds no approve on a checks-only round (row 264)', () => {
    const block: Decision = { key: 'decide', rule: 'bound', options: [
      option(cliAct('decide', 'ship', 'p1', '--approve', '--override'), 'deferral'), option(cliAct('decide', 'ship', 'p1', '--stop'), 'terminal')] }
    expect(menuFor(block, lastGateRun([only(1)], 'ship')!).map((o) => o.command)).toEqual(['witness decide ship p1 --stop'])
  })
  it('a handed-back revise of a checks-only round reaches the arbiter with no approve and no plain revise (Review Focus 4)', () => {
    const entries = [only(1),
      { v: 1, t: 'human-decision', gate: 'ship', artifact: 'p1', round: 1, decision: 'revise' },
      { v: 1, t: 'revise-returned', gate: 'ship', artifact: 'p1', run_id: 'r-1', sha: 'a' }] as unknown as Entry[]
    const block = recommend({ gate: 'ship', target: 'p1', entries, upstream: 'p1', stale: false })!
    expect(block.rule).toBe('revise-returned')
    const menu = menuFor(block, lastGateRun(entries, 'ship')!).map((o) => o.command)
    expect(menu).toContain('witness decide ship p1 --stop')
    expect(menu.some((c) => c.includes('--approve'))).toBe(false)
    expect(menu.some((c) => c.includes('--revise') && !c.includes('--upstream'))).toBe(false)
  })
})

describe('the arbiter never books lint (row 270)', () => {
  it("no booking of a check whose waiver is the human's reaches the arbiter's menu (row 270)", () => {
    const run = lastGateRun([{ ...(only(1) as object), checks: [{ name: 'lint', ok: false, parts: [{ part: 'ui', state: 'not-judged', key: `ui@${'a'.repeat(40)}.000000000000` }] }] } as unknown as Entry], 'ship')!
    const block: Decision = { key: 'decide', rule: 'book-owed', options: [
      option(cliAct('decide', 'ship', 'p1', '--book', 'lint'), 'deferral'), option(cliAct('decide', 'ship', 'p1', '--revise'), 'root'),
      option(cliAct('decide', 'ship', 'p1', '--stop'), 'terminal')] }
    const menu = menuFor(block, run).map((o) => o.act.argv)
    expect(menu).not.toContainEqual(expect.arrayContaining(['--book']))
    expect(menu).toHaveLength(2)
  })
})

describe('the arbiter reads checks as facts (row 266)', () => {
  let root = ''
  beforeAll(async () => { root = (await seededRepo()).root }, 120_000)
  const block: Decision = { key: 'decide', rule: 'checks-failed', options: [option(cliAct('decide', 'plan', 'p1', '--stop'), 'terminal')] }
  const evidenceFor = (entries: Entry[]): ArbiterSection[] =>
    decisionEvidence(root, loadCanon(root), { gate: 'plan', target: 'p1', entries, run: entries.at(-1) as unknown as GateRunEntry, block })
  const section = (ev: ArbiterSection[], title: string) => ev.find((x) => x.title === title)!.body
  const checks = (r: Entry) => section(evidenceFor([r]), 'Checks')

  it('the arbiter reads each check\'s name, verdict, part states, counts and rule ids — never its detail or a part\'s why (§3.9)', () => {
    const lint = { name: 'lint', ok: false, detail: 'TOOL OUTPUT', parts: [
      { part: 'biome', state: 'new', key: 'k', new: 3, base: 12, rules: ['lint/a', 'lint/b'] },
      { part: 'ui', state: 'not-measured', key: 'k2', why: 'REFUSAL GOT' }, { part: 'tsc', state: 'green' }] }
    const body = checks(run(1, 'a', { checks: [lint, { name: 'tests', ok: false, detail: 'FAIL OUTPUT' }] }))
    expect(body).toContain("lint: FAILED · biome 3 new beside the base's 12, rules lint/a, lint/b · ui red, the base not measured · tsc green")
    expect(body).toContain('tests: FAILED')
    for (const leaked of ['TOOL OUTPUT', 'FAIL OUTPUT', 'REFUSAL GOT']) expect(body).not.toContain(leaked)
  })

  it('untrusted commands read as a count and held criteria as their ids (§3.9)', () => {
    const body = checks(run(1, 'a', { checks: [
      { name: 'lint', ok: false, untrusted: ['pnpm secret-cmd'] },
      { name: 'drift-lane', ok: false, held: [{ criterion: 'ac-1', need: 'n1' }] }] }))
    expect(body).toContain('lint: FAILED · 1 command not trusted')
    expect(body).not.toContain('secret-cmd')
    expect(body).toContain('drift-lane: FAILED · held: ac-1')
  })

  it('every part state reads as its fact, and foreign names are spelled out (§3.9)', () => {
    const part = (state: string, extra: Record<string, unknown> = {}) => ({ part: 'p', state, ...extra })
    const facts = (p: Record<string, unknown>) => checkFacts({ name: 'lint', ok: false, parts: [p as never] })
    expect(facts(part('base-only', { base: 4 }))).toBe('lint: FAILED · p red on the base too, nothing new (4 there)')
    expect(facts(part('red'))).toBe('lint: FAILED · p red, the base green')
    expect(facts(part('pending'))).toBe("lint: FAILED · p red, the base's result pending")
    expect(facts(part('not-judged', { why: 'x' }))).toBe('lint: FAILED · p red on the base too, not judged')
    expect(facts(part('untrusted'))).toBe('lint: FAILED · p not run, its command not trusted')
    // Row 270: a booked part names the human and what the booking covers, never the item ids
    expect(checkFacts({ name: 'lint', ok: true, parts: [{ part: 'ui', state: 'booked', booked: 3, items: ['l-1a2b3c4d'] }] }))
      .toBe('lint: ok · ui booked by the human (3 diagnostics)')
    expect(checkFacts({ name: 'lint', ok: true, parts: [{ part: 'ui', state: 'booked', items: ['l-1a2b3c4d'] }] }))
      .toBe('lint: ok · ui booked whole by the human')
    expect(checkFacts({ name: 'lint', ok: false, parts: [{ part: 'p', state: 'new', new: 1, base: 0, rules: ['r\u202e1'] }] }))
      .not.toMatch(/\u202e/)
    expect(checkFacts({ name: 'evidence', ok: true })).toBe('evidence: ok')
  })

  it('a checks-only round says so in the stop and in the round history (row 266)', () => {
    const ev = evidenceFor([run(1, 'a', { checks_only: true, verdicts: undefined, checks: [{ name: 'lint', ok: false }] })])
    expect(section(ev, 'The stop')).toContain('checks only — no lens ran')
    expect(section(ev, 'Round history')).toContain('round 1 · @a · checks only — lint')
  })
})

describe('switch-off facts (row 274)', () => {
  it('checkFacts reads a lost spec and a not-checked effect as facts (row 276)', () => {
    const loss = { kind: 'dropped', key: 'd', spec: 'auth-refresh', count: 1, base: { passed: 2, failed: 0, skipped: 0 }, plan: { passed: 1, failed: 0, skipped: 1 } }
    expect(checkFacts({ name: 'switch-offs', ok: false, tests_effect: { read: 'compared', specs: 1 }, offs: [loss] } as never))
      .toBe('switch-offs: FAILED · tests of auth-refresh: 1 passing case lost (skipped 0→1)')
    expect(checkFacts({ name: 'switch-offs', ok: false, offs: [{ ...loss, count: 2, plan: { passed: 0, failed: 0, skipped: 2 } }] } as never))
      .toBe('switch-offs: FAILED · tests of auth-refresh: 2 passing cases lost (skipped 0→2)')
    expect(checkFacts({ name: 'switch-offs', ok: false, offs: [{ ...loss, booked: 1, items: ['l-00000001'] }] } as never))
      .toBe('switch-offs: FAILED · 1 booked')
    expect(checkFacts({ name: 'switch-offs', ok: true, tests_effect: { read: 'not-checked', why: 'no full-suite run this round' } } as never))
      .toBe('switch-offs: ok · tests not checked')
    const odd = `a${String.fromCodePoint(0x202e)}b`
    expect(checkFacts({ name: 'switch-offs', ok: false, offs: [{ ...loss, spec: odd }] } as never)).toContain('tests of a\\u{202e}b')
  })

  it('checkFacts folds switch-off lines by token, rules and place, and counts what is booked — never a path (row 274)', () => {
    expect(checkFacts({ name: 'switch-offs', ok: false, offs: [
      { key: 'a', token: 'eslint-disable-next-line', file: 'src/x.ts', line: 3, count: 1, rules: ['no-console'] },
      { key: 'b', token: '.skip(', file: 't/a.test.ts', line: 1, count: 2, test: true },
      { key: 'c', token: '@ts-ignore', file: 'src/y.ts', line: 9, count: 1, booked: 1, items: ['l-00000001'] }] } as never))
      .toBe('switch-offs: FAILED · eslint-disable-next-line (1 rule) in code · .skip( in a test file ×2 · 1 booked')
    // push security review: a rule id is the author's own text, so the arbiter reads how many, never which
    expect(checkFacts({ name: 'switch-offs', ok: false, offs: [{ key: 'e', token: 'eslint-disable-next-line', file: 'f', line: 1, count: 1,
      rules: ['reviewed-and-approved-by-the-human', 'no-console'] }] } as never)).toBe('switch-offs: FAILED · eslint-disable-next-line (2 rules) in code')
    const odd = `extra:a${String.fromCodePoint(0x202e)}b`
    expect(checkFacts({ name: 'switch-offs', ok: false, offs: [{ key: 'd', token: odd, file: 'f', line: 1, count: 1 }] } as never))
      .toBe('switch-offs: FAILED · extra:a\\u{202e}b in code')
  })
  it('the arbiter reads loosened hits as facts: tools, counts, rule counts, part names — never a path, a line or a rule id (row 278)', () => {
    const hidden = (tool: string, rule: string, file: string, over: Record<string, unknown> = {}) =>
      ({ kind: 'loosened', key: `${file}${rule}`.padEnd(16, '0').slice(0, 16), count: 1, tool, rule, file, line: 3, ...over })
    const part = (name: string) => ({ kind: 'loosened', key: name.padEnd(16, '1'), count: 1, part: name, defs: { '.gitignore': 'a'.repeat(40) } })
    const f = checkFacts({ name: 'switch-offs', ok: false, offs: [hidden('biome', 'lint/test/noBad', 'src/secret-name.ts'), part('lint')] } as never)
    expect(f).toBe("switch-offs: FAILED · biome: 1 diagnostic the plan's check definitions hide (1 rule) · part lint passes only under the plan's check definitions")
    expect(f).not.toContain('secret-name'); expect(f).not.toContain('noBad'); expect(f).not.toContain(':3')
    expect(checkFacts({ name: 'switch-offs', ok: false, offs: [hidden('biome', 'a', 'x'), hidden('biome', 'b', 'y', { count: 2 }), hidden('eslint', 'a', 'x'),
      hidden('eslint', 'c', 'z', { booked: 1, items: ['l-00000001'] })] } as never))
      .toBe("switch-offs: FAILED · biome: 3 diagnostics the plan's check definitions hide (2 rules) · eslint: 1 diagnostic the plan's check definitions hide (1 rule) · 1 booked")
    const odd = `li${String.fromCodePoint(0x202e)}nt`
    expect(checkFacts({ name: 'switch-offs', ok: false, offs: [part(odd)] } as never)).toContain('part li\\u{202e}nt passes only')
  })

  it('lint effect not checked is a fact; its why is not (row 278)', () => {
    expect(checkFacts({ name: 'definitions', ok: true, detail: 'not checked — no drive runs jobs in this repo (.gitignore)',
      lint_effect: { read: 'not-checked', changed: ['.gitignore'], why: 'no drive runs jobs in this repo' } } as never)).toBe('definitions: ok · lint effect not checked')
    expect(checkFacts({ name: 'definitions', ok: true, lint_effect: { read: 'measured', changed: ['.gitignore'] } } as never)).toBe('definitions: ok')
    // final review I1: a reader the job could not read under the base's definitions is a fact too — never its why
    expect(checkFacts({ name: 'definitions', ok: true, detail: ' · eslint could not be read under the base\'s definitions — reader-unread: x',
      lint_effect: { read: 'measured', changed: ['.gitignore'], unread: ['eslint'] } } as never)).toBe("definitions: ok · eslint not read under the base's definitions")
    expect(checkFacts({ name: 'definitions', ok: false, owes: [{ kind: 'lint-effect', key: 'k' }] } as never)).toBe('definitions: FAILED')
  })

  it("the arbiter's prompt books a loosening on a switch-off's terms (row 278)", () => {
    expect(readFileSync(join(__dirname, '..', 'prompts', 'arbiter.md'), 'utf8')).toContain("A diagnostic the plan's check definitions hide, or a lint part that passes only under them, is a switch-off on the same terms: book it only when a reviewer judged the definition change right or the scope needs it.")
  })

  it("the arbiter's prompt gains its switch-off rule (row 274)", () => {
    expect(readFileSync(join(__dirname, '..', 'prompts', 'arbiter.md'), 'utf8')).toContain('A switch-off — a suppression comment, a skipped or focused test, a loosened option — is booked only when the evidence shows it is right as it stands')
  })
})
