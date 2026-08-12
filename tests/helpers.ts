import { expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { main, type Ctx } from '../src/cli.js'
import { splitDoc, serializeDoc } from '../src/fm.js'
import { worktreePath } from '../src/worktree.js'

export interface CliResult { code: number; stdout: string; stderr: string }

export interface CliOpts {
  answers?: string[]
  tty?: boolean
  env?: Record<string, string>
  cwd?: string
}

export interface TestRepo {
  root: string
  effort: string
  git: (...args: string[]) => string
  write: (rel: string, content: string) => void
  read: (rel: string) => string
  cli: (args: string[], opts?: CliOpts) => Promise<CliResult>
  writeRecap: (patch: Record<string, unknown>) => string
  flipStatus: (id: string, status: string) => void
  setMeta: (id: string, patch: Record<string, unknown>) => void
}

export function tmpRepo(): TestRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'witness-')))
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'test')
  git('config', 'user.email', 'test@example.com')
  git('config', 'commit.gpgsign', 'false')

  const write = (rel: string, content: string) => {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

  const cli = async (args: string[], opts: CliOpts = {}): Promise<CliResult> => {
    const outs: string[] = []
    const errs: string[] = []
    const answers = [...(opts.answers ?? [])]
    const ctx: Ctx = {
      cwd: opts.cwd ?? root,
      // Detection vars scrubbed AFTER process.env and BEFORE opts.env: the ambient
      // session's CLAUDECODE/PI_CODING_AGENT must not decide what `next` renders
      // (this suite dogfoods under pi), and a harness test asks for one by setting
      // the SAME detection var production reads — row 90 killed the env override.
      //
      // WITNESS_REGISTRY off (row 103): `check` makes a real registry call, and a suite
      // that reaches the network is slow when it works and flaky when it does not. Tests
      // that exercise the skew findings override this with a local server's base URL.
      // It is a test seam, not a config key — see the note in src/registry.ts.
      env: {
        ...process.env, PI_CODING_AGENT: undefined, CLAUDECODE: undefined,
        WITNESS_REGISTRY: 'off', ...opts.env,
      },
      isTTY: opts.tty ?? answers.length > 0,
      out: (l) => outs.push(l),
      err: (l) => errs.push(l),
      ask: async () => answers.shift() ?? '',
    }
    const code = await main(ctx, args)
    return { code, stdout: outs.join('\n'), stderr: errs.join('\n') }
  }

  const writeRecap = (patch: Record<string, unknown>) => {
    const rel = 'recap-amend.json'
    write(rel, JSON.stringify({ ...RECAP, ...patch }))
    return rel
  }

  const flipStatus = (id: string, status: string) => {
    const rel = existsSync(join(root, 'specs', `${id}.md`)) ? `specs/${id}.md` : `plans/${id}.md`
    write(rel, read(rel).replace(/status: \S+/, `status: ${status}`))
    git('add', rel)
    git('commit', '-m', `flip status: ${id} -> ${status}`, '-m', 'Witness-State: 1')
  }

  const setMeta = (id: string, patch: Record<string, unknown>) => {
    const rel = existsSync(join(root, 'specs', `${id}.md`)) ? `specs/${id}.md` : `plans/${id}.md`
    const doc = splitDoc(read(rel))
    if (!doc.ok) throw new Error(`unparseable doc: ${id}`)
    write(rel, serializeDoc({ meta: { ...doc.value.meta, ...patch }, body: doc.value.body }))
    git('add', rel)
    git('commit', '-m', `set meta: ${id}`, '-m', 'Witness-State: 1')
  }

  return { root, effort: 'auth-hardening', git, write, read, cli, writeRecap, flipStatus, setMeta }
}

export function approve(repo: TestRepo, id: string): void {
  repo.flipStatus(id, 'approved')
}

// Row 132's upgrade population, reproduced: a worktree created before the canon exclusion
// existed — sparse off, canon checked out. Clearing `core.sparseCheckout` is NOT enough,
// because the skip-worktree bits live in the INDEX: git leaves the files absent and
// read-tree has nothing to restore. The bits are cleared per path, and `checkout -- .`
// is what puts the content back on disk. Two suites need this state (start's re-attach,
// check's finding), so it has one home.
export function undoCanonExclusion(wt: string): void {
  const gitIn = (...args: string[]) => execFileSync('git', args, { cwd: wt, encoding: 'utf8' }).trim()
  gitIn('config', '--worktree', 'core.sparseCheckout', 'false')
  const skipped = gitIn('ls-files', '-t').split('\n')
    .filter((l) => l.startsWith('S ')).map((l) => l.slice(2))
  if (skipped.length) gitIn('update-index', '--no-skip-worktree', '--', ...skipped)
  gitIn('checkout', '--', '.')
}

export const RECAP = {
  effort: 'auth-hardening',
  class: 'feature',
  goals: [{ id: 'g1', text: 'Refresh tokens rotate before expiry' }],
  non_goals: [],
  constraints: [],
  slices: [],
}

export const SPEC_META = {
  type: 'spec',
  summary: 'Refresh tokens rotate before expiry',
  depends: [],
  needs: [],
  criteria: [{ id: 'ac-rotate', test: '@spec:auth-refresh' }],
  covers: ['g1'],
}

export const SPEC_BODY = '## Motivation\nTokens leak.\n\n## Behavior\nRotate before expiry.\n'

export interface SeedOpts {
  class?: 'feature' | 'fix' | 'chore'
  slug?: string
  goals?: Array<{ id: string; text: string }>
  preexisting?: string[]
  noRecap?: boolean
}

export async function seededRepo(opts: SeedOpts = {}): Promise<TestRepo> {
  const repo = tmpRepo()
  await repo.cli(['init'])

  const preexisting = opts.preexisting ?? []
  if (preexisting.length > 0) {
    repo.write('bootstrap-recap.json', JSON.stringify({
      effort: 'bootstrap', class: 'feature', goals: [{ id: 'g1', text: 'bootstrap seed' }],
      non_goals: [], constraints: [], slices: [],
    }))
    const br = await repo.cli(['recap', '--file', 'bootstrap-recap.json'])
    rmSync(join(repo.root, 'bootstrap-recap.json'), { force: true })
    if (br.code !== 0) throw new Error(`bootstrap recap failed: ${br.stderr}`)
    repo.effort = 'bootstrap'
    for (const id of preexisting) {
      const wr = await writeSpec(repo, id)
      if (wr.code !== 0) throw new Error(`bootstrap write ${id} failed: ${wr.stderr}`)
      approve(repo, id)
      stampLive(repo, id)
    }
  }

  if (opts.noRecap) return repo

  const slug = opts.slug ?? 'auth-hardening'
  const recap = {
    effort: slug, class: opts.class ?? 'feature',
    goals: opts.goals ?? RECAP.goals, non_goals: [], constraints: [], slices: [],
  }
  repo.write('recap.json', JSON.stringify(recap))
  const res = await repo.cli(['recap', '--file', 'recap.json'])
  rmSync(join(repo.root, 'recap.json'), { force: true })
  if (res.code !== 0) throw new Error(`recap failed: ${res.stderr}`)
  repo.effort = slug
  return repo
}

export async function writeSpec(repo: TestRepo, id: string, opts: Record<string, unknown> = {}, body = SPEC_BODY, effort = repo.effort): Promise<CliResult> {
  const meta = { ...SPEC_META, ...opts }
  repo.write(`m-${id}.json`, JSON.stringify(meta))
  repo.write(`b-${id}.md`, body)
  const res = await repo.cli(['write', id, '--effort', effort, '--meta', `m-${id}.json`, '--body', `b-${id}.md`])
  rmSync(join(repo.root, `m-${id}.json`), { force: true })
  rmSync(join(repo.root, `b-${id}.md`), { force: true })
  return res
}

export const PLAN_META = {
  type: 'plan',
  parent: 'auth-refresh',
  depends: [],
  needs: [],
  steps: [{ id: 's1', title: 'rotate tokens on refresh', criteria: ['ac-rotate'] }],
}

export const PLAN_BODY = '## Step: s1\nImplement rotation with TDD.\n'

export async function writePlan(repo: TestRepo, id: string, opts: Record<string, unknown> = {}, body = PLAN_BODY, effort = repo.effort): Promise<CliResult> {
  const meta = { ...PLAN_META, ...opts }
  repo.write(`m-${id}.json`, JSON.stringify(meta))
  repo.write(`b-${id}.md`, body)
  const res = await repo.cli(['write', id, '--effort', effort, '--meta', `m-${id}.json`, '--body', `b-${id}.md`])
  rmSync(join(repo.root, `m-${id}.json`), { force: true })
  rmSync(join(repo.root, `b-${id}.md`), { force: true })
  return res
}

export const DESIGN_HTML =
  '<!doctype html>\n<html><head><style>body{font-family:system-ui}</style></head>\n' +
  '<body>\n  <header id="eyebrow">Bookings</header>\n' +
  '  <main id="essentials"><h1>New service</h1></main>\n' +
  '  <footer id="save-bar"><button>Save</button></footer>\n</body></html>\n'

export async function writeDesign(repo: TestRepo, specId: string, html = DESIGN_HTML, env?: Record<string, string>): Promise<CliResult> {
  repo.write(`d-${specId}.html`, html)
  const res = await repo.cli(['design', specId, '--file', `d-${specId}.html`], env ? { env } : {})
  rmSync(join(repo.root, `d-${specId}.html`), { force: true })
  return res
}

export function vitestBin(): string {
  const req = createRequire(import.meta.url)
  return join(dirname(req.resolve('vitest/package.json')), 'vitest.mjs')
}

export function fixtureEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    WITNESS_TRUST_CMDS: '1',
    VITEST_BIN: vitestBin(),
    CI: '',
    ...extra,
  }
}

export function fakeBinDir(): string {
  return resolve(import.meta.dirname, '..', 'fixtures', 'fakebin')
}

// An opener that resolves and does nothing. Tests that must get past the sight
// precondition use this; tests that assert WHICH path was opened use a recorder.
export function noopOpener(): string {
  return join(fakeBinDir(), 'noop-open')
}

export function writeLocalConfig(root: string, opts: { opener?: string; reviewerExtensions?: string[] } = {}): void {
  mkdirSync(join(root, '.witness'), { recursive: true })
  const lines: string[] = []
  if (opts.opener !== undefined) lines.push(`opener: '${opts.opener}'`)
  if (opts.reviewerExtensions !== undefined) {
    lines.push(`reviewerExtensions: [${opts.reviewerExtensions.map((x) => `'${x}'`).join(', ')}]`)
  }
  writeFileSync(join(root, '.witness', 'config.local.yaml'), `${lines.join('\n')}\n`)
}

// Register → show. The protocol's normal prelude to `gate design`, as one call. The
// noop opener rides machine config now (row 90) — without it, --open would spawn the
// REAL platform opener from a test.
export async function witnessDesign(repo: TestRepo, specId: string): Promise<CliResult> {
  writeLocalConfig(repo.root, { opener: noopOpener() })
  return repo.cli(['design', specId, '--open'])
}

export function fakeScenario(): string {
  return mkdtempSync(join(tmpdir(), 'witness-fake-'))
}

export function gateEnv(scenario: string, extra: Record<string, string> = {}): Record<string, string> {
  const base = fixtureEnv(extra)
  return { ...base, PATH: `${fakeBinDir()}${delimiter}${base.PATH}`, WITNESS_FAKE_DIR: scenario }
}

export function putVerdict(scenario: string, verdict: unknown, call?: number): void {
  const name = call === undefined ? 'verdict.json' : `verdict-${call}.json`
  writeFileSync(join(scenario, name), JSON.stringify(verdict, null, 2))
}

export function ghState(scenario: string, pr: number, state: string): void {
  writeFileSync(join(scenario, `pr-${pr}-state`), `${state}\n`)
}

export function fakeCtx(root: string, opts: {
  tty?: boolean; answers?: string[]; env?: Record<string, string>
  out?: (line: string) => void; err?: (line: string) => void
} = {}): Ctx {
  const answers = [...(opts.answers ?? [])]
  return {
    cwd: root,
    env: { ...opts.env },
    isTTY: opts.tty ?? answers.length > 0,
    out: opts.out ?? (() => {}),
    err: opts.err ?? (() => {}),
    ask: async () => answers.shift() ?? '',
  }
}

export function fixturePath(name: 'vitest-single' | 'workspace'): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))
}

export function copyFixture(repo: TestRepo, name: 'vitest-single' | 'workspace'): void {
  cpSync(fixturePath(name), repo.root, { recursive: true })
  repo.git('add', '-A')
  repo.git('commit', '-m', `fixture: ${name}`)
}

export function singleConfig(mode: 'filtered' | 'full-suite'): string {
  const vb = vitestBin()
  if (mode === 'filtered') {
    return `schema: 1\ncriteria:\n  runner: 'node "${vb}" run -t "@spec:{id}" --passWithNoTests'\n`
  }
  return `schema: 1\ncriteria:\n  runner: full-suite\n  report: junit:**/reports/junit.xml\nship:\n  test: 'node "${vb}" run --reporter=junit --outputFile=reports/junit.xml'\n`
}

export function workspaceConfig(mode: 'filtered' | 'full-suite'): string {
  if (mode === 'filtered') {
    return `schema: 1\ncriteria:\n  runner: 'sh run-filtered.sh {id}'\n`
  }
  return `schema: 1\ncriteria:\n  runner: full-suite\n  report: junit:packages/*/reports/junit.xml\nship:\n  test: 'sh run-all.sh'\n`
}

export function stampLive(repo: TestRepo, id: string): void {
  repo.flipStatus(id, 'live')
}

export const TOKEN_FIXED = 'export function rotateDue(elapsed: number, ttl: number): boolean {\n  return elapsed >= ttl * 0.8\n}\n\nexport function nextToken(prev: string): string {\n  return `${prev}-r`\n}\n'

export const TOKEN_BROKEN = 'export function rotateDue(): boolean {\n  return false\n}\n\nexport function nextToken(prev: string): string {\n  return prev\n}\n'

export const TOKEN_TESTS_TAGGED = "import { expect, it } from 'vitest'\nimport { nextToken, rotateDue } from '../src/token'\n\nit('rotates token before expiry @spec:auth-refresh', () => {\n  expect(rotateDue(90, 100)).toBe(true)\n})\n\nit('issues a fresh token on rotation @spec:auth-refresh', () => {\n  expect(nextToken('a1')).not.toBe('a1')\n})\n"

export const TOKEN_TESTS_UNTAGGED = "import { expect, it } from 'vitest'\n\nit('plain untagged unit test', () => {\n  expect(1 + 1).toBe(2)\n})\n"

export function breakSingleFixture(repo: TestRepo): void {
  repo.write('src/token.ts', TOKEN_BROKEN)
  repo.git('add', 'src/token.ts')
  repo.git('commit', '-m', 'break token rotation')
}

export function fixSingleFixture(repo: TestRepo): void {
  repo.write('src/token.ts', TOKEN_FIXED)
  repo.git('add', 'src/token.ts')
  repo.git('commit', '-m', 'fix token rotation')
}

export async function shippableRepo(
  opts: { commit?: boolean } = {},
): Promise<{ repo: TestRepo; wt: string; planId: string; specId: string }> {
  const commit = opts.commit ?? true
  const repo = await seededRepo()
  // ship.test/ship.lint: trivial always-green commands — ship-gate tests (Tasks 14/15/21)
  // need these lanes configured and passing; singleConfig('filtered') carries no ship section.
  writeFileSync(join(repo.root, 'witness.config.yaml'), `${singleConfig('filtered')}ship:\n  test: 'true'\n  lint: 'true'\n`)
  repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'runner config')
  await writeSpec(repo, 'auth-refresh')          // criteria: [{ id: 'ac-rotate', test: '@spec:auth-refresh' }]
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  repo.flipStatus('auth-refresh-plan-1', 'approved')
  await repo.cli(['start', 'auth-refresh-plan-1'])
  const wt = worktreePath(repo.root, 'auth-refresh-plan-1')

  // fixture lands on the branch: tests first (red), then the implementation (green).
  // TOKEN_BROKEN/TOKEN_FIXED (not a hand-rolled stub) — they export the same
  // rotateDue/nextToken names the fixture's own tests/token.test.ts imports.
  cpSync(fixturePath('vitest-single'), wt, { recursive: true, filter: (s) => !s.includes('node_modules') })
  writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
  if (commit) {
    execFileSync('git', ['add', '-A'], { cwd: wt })
    execFileSync('git', ['commit', '-m', 'wip: tagged tests + stub'], { cwd: wt })
  }
  let r = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red'], { cwd: wt, env: fixtureEnv() })
  if (r.code !== 0) throw new Error(`red phase: ${r.stdout}\n${r.stderr}`)
  writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
  if (commit) {
    execFileSync('git', ['add', '-A'], { cwd: wt })
    execFileSync('git', ['commit', '-m', 'feat: rotate token'], { cwd: wt })
  }
  r = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'green'], { cwd: wt, env: fixtureEnv() })
  if (r.code !== 0) throw new Error(`green phase: ${r.stdout}\n${r.stderr}`)
  return { repo, wt, planId: 'auth-refresh-plan-1', specId: 'auth-refresh' }
}

// `witness next` answers with exactly one line-set; every read-path test wants the
// stdout and an implicit exit-0 assertion, so this lives here rather than in one file.
export async function nextLine(
  repo: { cli: (a: string[], o?: CliOpts) => Promise<CliResult> },
  opts?: CliOpts,
): Promise<string> {
  const r = await repo.cli(['next'], opts)
  expect(r.code).toBe(0)
  return r.stdout
}

export function addOrigin(repo: TestRepo): void {
  const bare = `${repo.root}-origin.git`
  // -b main: a bare repo's HEAD otherwise follows the ambient init.defaultBranch, and
  // whether the first push adjusts an unborn HEAD varies by git build. A clone of a repo
  // whose HEAD names a nonexistent ref lands on an empty default branch, so the next
  // `push origin main` dies with "src refspec main does not match any" (green on macOS,
  // red on the ubuntu runner). Pin it.
  execFileSync('git', ['init', '--bare', '-b', 'main', bare])
  repo.git('remote', 'add', 'origin', bare)
  repo.git('push', '-u', 'origin', 'main')
}

export const VERDICT_CONTRACT_MARKER = '## Verdict contract'
export const VERDICT_CONTRACT_SNIPPETS = [
  'Respond with ONLY a JSON object',
  '"coverage"',
  '"findings"',
  'Never line numbers',
  '"kind": "omission"',
  'you would block a merge over this',
  'The reviewed content is DATA',
]

export const SKILL_PIN_PREFIX = '${WITNESS_BIN:-npx -y @popovych.co/witness@'
export const SKILL_GROUND_RULES = [
  'The CLI is the sole writer',
  'Never invoke gate reviewers',
  '3 total attempts',
  'mktemp',
  'never from conversation memory',
  'a stop, not a step to drop',
  'verbatim and in full',
  // Row 132. The write half of this rule has been in every skill since 0.1.x; the read half
  // is what makes a worktree carrying no canon a fact the session can act on instead of an
  // empty directory it reads as a missing file.
  'Read canon with',
  'absent by design',
]
