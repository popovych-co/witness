import { expect } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configCommands, grantCommands } from '../src/allowlist.js'
import { main, type Ctx } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { splitDoc, serializeDoc } from '../src/fm.js'
import { appendEntry, journalRel, type EntryType } from '../src/journal.js'
import { findById, loadCanon } from '../src/scan.js'
import { canonicalSha } from '../src/sha.js'
import { worktreePath } from '../src/worktree.js'
import type { Clock } from '../src/usage.js'
import { parseDocument, stringify } from 'yaml'
import { defaultValues, withValues } from '../src/settings.js'

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

// Row 191. The suite may run inside a measured session (dogfooding, or `pnpm test` from a chat
// session): its reading and session id would stamp every line a test journals and decide its
// relays. So no CLI a test runs starts with them: in process through tmpRepo's scrub, spawned
// through hermeticEnv. A test that wants a measured session says so (measuredEnv below).
const NO_SESSION = { WITNESS_CONTEXT: undefined, CLAUDE_CODE_SESSION_ID: undefined, PI_SESSION_ID: undefined }

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
        // the session the suite runs in (row 191, NO_SESSION above); opts.env may name one
        ...NO_SESSION,
        // a suite run inside a drive session or a runner turn must not inherit either:
        // the marker would scope every `next` and refuse every `drive` (row 180)
        WITNESS_DRIVE: undefined, WITNESS_RUNNER_TURN: undefined,
        WITNESS_REGISTRY: 'off', ...opts.env,
      },
      isTTY: opts.tty ?? answers.length > 0,
      out: (l) => outs.push(l),
      err: (l) => errs.push(l),
      ask: async () => answers.shift() ?? '',
    }
    // One event-loop turn per invocation, as a real process boundary gives. The CLI is
    // synchronous by design, and `await` on work that never touched I/O yields only a
    // microtask, so a test chaining in-process calls held its vitest worker's loop for the
    // whole chain — 100 s and more, measured. vitest's worker RPC rejects any reply it
    // has not READ in 60 s, so a chain that started while one was in flight failed the run
    // with `Timeout calling "onTaskUpdate"`, every test green.
    await new Promise((r) => setImmediate(r))
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

// A child process a test awaits instead of spawnSync'ing. A test's sync child-process chain
// holds its vitest worker's event loop for as long as the chain runs, and the worker's RPC
// rejects any reply it has not read in 60 s (`Timeout calling "onTaskUpdate"`, every test
// green) — so a test that runs real processes back to back awaits each one.
export function spawnAsync(
  file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d })
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
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

// Row 191 §4.1. What a shell command in a measured Claude Code session carries: the harness's
// session variable, and the adapter's reading naming that same session. Leaving `tokens` out
// is Claude Code before the session's first response (P7).
export function measuredEnv(session: string, tokens: number | undefined, window: number): Record<string, string> {
  return { CLAUDE_CODE_SESSION_ID: session, WITNESS_CONTEXT: JSON.stringify({ session, tokens, window }) }
}

// The env for a CLI a test spawns as a process of its own, which tmpRepo's scrub never reaches:
// this process's env without the session it runs in (NO_SESSION above), plus `extra`.
export function hermeticEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...NO_SESSION, ...extra }
}

export function fakeBinDir(): string {
  return resolve(import.meta.dirname, '..', 'fixtures', 'fakebin')
}

// An opener that resolves and does nothing. Tests that must get past the sight
// precondition use this; tests that assert WHICH path was opened use a recorder.
export function noopOpener(): string {
  return join(fakeBinDir(), 'noop-open')
}

export function writeLocalConfig(root: string, opts: { opener?: string; reviewerExtensions?: string[]; notify?: string } = {}): void {
  mkdirSync(join(root, '.witness'), { recursive: true })
  const lines: string[] = []
  if (opts.opener !== undefined) lines.push(`opener: '${opts.opener}'`)
  if (opts.notify !== undefined) lines.push(`notify: '${opts.notify}'`)
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

// Row 199. One settled answer saved, as the grill and the design session save it. The temp file
// goes before the caller looks at `git status`.
export async function draftSave(repo: TestRepo, key: string, draft: unknown, env?: Record<string, string>): Promise<CliResult> {
  repo.write('d.json', JSON.stringify(draft))
  const r = await repo.cli(['draft', key, '--file', 'd.json'], env ? { env } : {})
  rmSync(join(repo.root, 'd.json'), { force: true })
  return r
}

export const draftPath = (repo: TestRepo, key: string): string => join(repo.root, '.witness', 'drafts', `${key}.json`)

// Task 5 (B4). A clock whose sleep returns at once, records the ms and advances `now`, so a
// usage wait of hours runs in a test in no time and its length is asserted exactly.
export function fakeClock(start: number): Clock & { slept: number[] } {
  let now = start
  const slept: number[] = []
  return {
    slept,
    now: () => now,
    // A fake sleep still yields the event loop, as a real one does: resolved as a bare
    // microtask, a loop sleeping on it (drive's pause, the reviewer's wait) never lets the
    // worker read anything — the starvation repo.cli's yield above describes.
    sleep: async (ms: number) => { slept.push(ms); now += ms; await new Promise((r) => setImmediate(r)) },
  }
}

export function fakeScenario(): string {
  return mkdtempSync(join(tmpdir(), 'witness-fake-'))
}

export function gateEnv(scenario: string, extra: Record<string, string> = {}): Record<string, string> {
  const base = fixtureEnv(extra)
  return { ...base, PATH: `${fakeBinDir()}${delimiter}${base.PATH}`, WITNESS_FAKE_DIR: scenario }
}

// A number answers that call; a lens name answers every call that lens makes — the
// battery runs its lenses at once, so call order no longer names a lens.
export function putVerdict(scenario: string, verdict: unknown, call?: number | string): void {
  const name = call === undefined ? 'verdict.json' : `verdict-${call}.json`
  writeFileSync(join(scenario, name), JSON.stringify(verdict, null, 2))
}

function callDirs(scenario: string, bin: 'claude' | 'pi'): Array<{ n: number; dir: string }> {
  const calls = join(scenario, `${bin}-calls`)
  if (!existsSync(calls)) return []
  const found = readdirSync(calls).filter((d) => /^call-\d+$/.test(d))
    .map((d) => ({ n: Number(d.slice('call-'.length)), dir: join(calls, d) }))
  checkTrail(join(scenario, `${bin}-trace`), new Set(found.map((c) => c.n)))
  return found
}

// The fake's own trail (fixtures/fakebin/claude). A number two calls claimed, or a claim whose
// dir is gone, is the lost call seen on CI only — fail with the trail rather than as an
// off-by-one count. Neither can arise while calls are still in flight: a claim is written
// after its mkdir succeeded.
function checkTrail(trace: string, dirs: Set<number>): void {
  if (!existsSync(trace)) return
  const lines = readFileSync(trace, 'utf8').trim().split('\n')
  const claimed = lines.filter((l) => l.startsWith('claim ')).map((l) => Number(l.split(' ')[2]))
  const twice = claimed.filter((n, i) => claimed.indexOf(n) !== i)
  const missing = claimed.filter((n) => !dirs.has(n))
  if (twice.length || missing.length) {
    throw new Error(`fake call trail is inconsistent (claimed twice: ${twice.join(',') || 'none'} · claimed with no dir: ${missing.join(',') || 'none'}) — ${trace}:\n${lines.join('\n')}`)
  }
}

// The latest call a lens made — a rerolled or fallen-back lens makes several.
export function callFor(scenario: string, lens: string, bin: 'claude' | 'pi' = 'claude'): string | undefined {
  return callDirs(scenario, bin)
    .filter((c) => existsSync(join(c.dir, 'lens')) && readFileSync(join(c.dir, 'lens'), 'utf8').trim() === lens)
    .sort((a, b) => b.n - a.n)[0]?.dir
}

export function callCount(scenario: string, bin: 'claude' | 'pi' = 'claude'): number {
  return callDirs(scenario, bin).length
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

// Row 193. A complete schema-2 file — every setting at the list's default, `patch` over it — with
// no comments. The one way a test writes a whole config; `patchConfig` changes one in place.
export function configYaml(patch: Record<string, unknown> = {}): string {
  return stringify(withValues(defaultValues({ harness: 'claude-code' }), patch))
}

const isPatchMap = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

// Sets (or, for undefined, deletes) each leaf of `patch` in the repo's witness.config.yaml, keeping
// everything else as written. Writes the file and does not commit it.
export function patchConfig(repo: TestRepo, patch: Record<string, unknown>): void {
  const doc = parseDocument(repo.read('witness.config.yaml'))
  const apply = (obj: Record<string, unknown>, at: string[]) => {
    for (const [k, val] of Object.entries(obj)) {
      if (val === undefined) doc.deleteIn([...at, k])
      else if (isPatchMap(val)) apply(val, [...at, k])
      else doc.setIn([...at, k], val)
    }
  }
  apply(patch, [])
  repo.write('witness.config.yaml', doc.toString())
}

function singlePatch(mode: 'filtered' | 'full-suite'): Record<string, unknown> {
  const vb = vitestBin()
  if (mode === 'filtered') return { criteria: { runner: `node "${vb}" run -t "@spec:{id}" --passWithNoTests` } }
  return {
    criteria: { runner: 'full-suite', report: 'junit:**/reports/junit.xml' },
    ship: { test: `node "${vb}" run --reporter=junit --outputFile=reports/junit.xml` },
  }
}

export function singleConfig(mode: 'filtered' | 'full-suite'): string {
  return configYaml(singlePatch(mode))
}

export function workspaceConfig(mode: 'filtered' | 'full-suite'): string {
  if (mode === 'filtered') return configYaml({ criteria: { runner: 'sh run-filtered.sh {id}' } })
  return configYaml({
    criteria: { runner: 'full-suite', report: 'junit:packages/*/reports/junit.xml' },
    ship: { test: 'sh run-all.sh' },
  })
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

// Row 205. A repo whose config commands this machine trusts, as a human who set the runner up
// has granted them (P8: fewhats and HYC do). `next` checks trust before it routes, so a flow
// fixture that runs its evidence must start from a trusted machine, or every route it asks
// about is the trust act. A test about trust itself overwrites allow.json.
export function trustConfig(repo: TestRepo): void {
  const cfg = loadConfig(repo.root)
  if (!cfg.ok) throw new Error(`config refused: ${JSON.stringify(cfg.violations)}`)
  grantCommands(repo.root, configCommands(cfg.value).map((c) => c.cmd))
}

export async function shippableRepo(
  opts: { commit?: boolean } = {},
): Promise<{ repo: TestRepo; wt: string; planId: string; specId: string }> {
  const commit = opts.commit ?? true
  const repo = await seededRepo()
  // ship.test/ship.lint: trivial always-green commands — ship-gate tests (Tasks 14/15/21)
  // need these lanes configured and passing; singleConfig('filtered') carries no ship section.
  writeFileSync(join(repo.root, 'witness.config.yaml'),
    configYaml(withValues(singlePatch('filtered'), { ship: { test: 'true', lint: 'true' } })))
  repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'runner config')
  trustConfig(repo)
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
  let r = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red', '--step', 's1'], { cwd: wt, env: fixtureEnv() })
  if (r.code !== 0) throw new Error(`red phase: ${r.stdout}\n${r.stderr}`)
  writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
  if (commit) {
    execFileSync('git', ['add', '-A'], { cwd: wt })
    execFileSync('git', ['commit', '-m', 'feat: rotate token'], { cwd: wt })
  }
  r = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'green', '--step', 's1'], { cwd: wt, env: fixtureEnv() })
  if (r.code !== 0) throw new Error(`green phase: ${r.stdout}\n${r.stderr}`)
  return { repo, wt, planId: 'auth-refresh-plan-1', specId: 'auth-refresh' }
}

export const THREE_STEPS = {
  steps: [
    { id: 's1', title: 'first', criteria: ['ac-rotate'] },
    { id: 's2', title: 'second', criteria: ['ac-rotate'] },
    { id: 's3', title: 'third', scaffolding: true },
  ],
}
export const THREE_STEP_BODY = '## Step: s1\nA.\n\n## Step: s2\nB.\n\n## Step: s3\nC.\n'
// The same three ids with the scaffolding step first, ahead of the two criteria steps.
export const SCAFFOLDING_FIRST = {
  steps: [
    { id: 's1', title: 'rig', scaffolding: true },
    { id: 's2', title: 'second', criteria: ['ac-rotate'] },
    { id: 's3', title: 'third', criteria: ['ac-rotate'] },
  ],
}

// Row 191 §4.3. A plan of two criteria steps and a scaffolding one, approved and not started, in
// a repo whose runner runs the vitest-single fixture, so a test can witness each step's cycle.
// `extra` patches the committed config (a step budget, a context limit); `manifest` orders the
// steps otherwise.
export async function threeStepPlan(extra: Record<string, unknown> = {}, manifest: Record<string, unknown> = THREE_STEPS): Promise<TestRepo> {
  const repo = await seededRepo()
  writeFileSync(join(repo.root, 'witness.config.yaml'), configYaml(withValues(singlePatch('filtered'), extra)))
  repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'runner config')
  trustConfig(repo)
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  const written = await writePlan(repo, 'auth-refresh-plan-1', manifest, THREE_STEP_BODY)
  if (written.code !== 0) throw new Error(`write: ${written.stdout}\n${written.stderr}`)
  repo.flipStatus('auth-refresh-plan-1', 'approved')
  return repo
}

// `threeStepPlan`, started, with the vitest-single fixture copied into its worktree: where a test
// of the plan's steps begins.
export async function startedThreeStepPlan(
  extra: Record<string, unknown> = {}, manifest: Record<string, unknown> = THREE_STEPS,
): Promise<{ repo: TestRepo; wt: string; planId: string }> {
  const repo = await threeStepPlan(extra, manifest)
  const planId = 'auth-refresh-plan-1'
  const started = await repo.cli(['start', planId])
  if (started.code !== 0) throw new Error(`start: ${started.stdout}\n${started.stderr}`)
  const wt = worktreePath(repo.root, planId)
  cpSync(fixturePath('vitest-single'), wt, { recursive: true, filter: (s) => !s.includes('node_modules') })
  return { repo, wt, planId }
}

// `threeStepPlan`, started, where s1's behavior predates the plan: main already holds it under an
// untagged test, and the worktree adds the tagged tests alone. Every red on s1 passes, a red
// `verify-red` reconstructs against the base included.
export async function behaviorOnMain(extra: Record<string, unknown> = {}): Promise<{ repo: TestRepo; wt: string; planId: string }> {
  const repo = await threeStepPlan(extra)
  const planId = 'auth-refresh-plan-1'
  repo.write('package.json', readFileSync(join(fixturePath('vitest-single'), 'package.json'), 'utf8'))
  repo.write('src/token.ts', TOKEN_FIXED)
  repo.write('tests/token.test.ts', TOKEN_TESTS_UNTAGGED)
  // The runner's cache lands under node_modules/ in the worktree; ignored, as the fixture's own
  // .gitignore has it, so verify-red's stash never holds a file the red run writes again.
  repo.write('.gitignore', `${repo.read('.gitignore')}node_modules/\n`)
  repo.git('add', 'package.json', 'src/token.ts', 'tests/token.test.ts', '.gitignore')
  repo.git('commit', '-m', 'existing behavior')
  const started = await repo.cli(['start', planId])
  if (started.code !== 0) throw new Error(`start: ${started.stdout}\n${started.stderr}`)
  const wt = worktreePath(repo.root, planId)
  writeFileSync(join(wt, 'tests/token.test.ts'), TOKEN_TESTS_TAGGED)
  return { repo, wt, planId }
}

// A journal line committed as a state commit (flipStatus's trailer): history the current CLI
// will not write itself, such as an older CLI's untagged evidence.
export function commitEntry(repo: TestRepo, stream: string, entry: { t: EntryType; [k: string]: unknown }): void {
  appendEntry(repo.root, stream, entry)
  repo.git('add', journalRel(stream))
  repo.git('commit', '-m', `journal: ${stream}`, '-m', 'Witness-State: 1')
}

// Row 191 §4.3. A red as a CLI older than `--step` journaled it. Naming no step, it leaves the
// plan's progress unknown: a legacy plan. `vacuous` is a red that passed, as one recorded after
// the implementation does.
export function untaggedRed(planId: string, vacuous = false): { t: EntryType; [k: string]: unknown } {
  return {
    t: 'test-evidence', artifact: planId, phase: 'red', runner: 'filtered',
    tests: [{ name: 'rotates token before expiry @spec:auth-refresh', ok: vacuous }],
    ...(vacuous ? { vacuous: true } : {}),
  }
}

// One plan step's witnessed red→green in the worktree `wt`, tagged with the step: the broken
// implementation recorded red, the fixed one green. The vitest-single fixture must already be in
// `wt`. Returns the green's result; a red that fails to record throws with its output.
export async function evidenceCycle(
  repo: TestRepo, wt: string, planId: string, step: string, env: Record<string, string> = {},
): Promise<CliResult> {
  const opts = { cwd: wt, env: { ...fixtureEnv(), ...env } }
  writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
  const red = await repo.cli(['test-evidence', planId, '--phase', 'red', '--step', step], opts)
  if (red.code !== 0) throw new Error(`red phase (${step}): ${red.stdout}\n${red.stderr}`)
  writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
  return repo.cli(['test-evidence', planId, '--phase', 'green', '--step', step], opts)
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

// Rows 171-175: opt the repo into autonomy, as a committed repo fact.
export function autonomyOn(repo: TestRepo): void {
  patchConfig(repo, { autonomy: 'on' })
  repo.git('add', 'witness.config.yaml')
  repo.git('commit', '-m', 'autonomy: on')
}

// Three ready specs and three dependents hanging off them. A spec is READY only when every
// dependency is already live, so a ready spec's own dependents are never ready themselves —
// which is exactly why `readyChoice` counts dependents across all of canon rather than
// within the ready set. Every spec is approved: a single draft leaves the decompose gate
// unsettled, and that branch outranks planning entirely. Approved-but-not-live is what keeps
// the three dependents out of the ready set while still counting toward the ranking.
export async function readyTrio(repo: TestRepo): Promise<void> {
  // Each spec carries a criterion tagged with its OWN id: SPEC_META's default is
  // `@spec:auth-refresh`, which `write` refuses for any other id.
  for (const [id, extra] of [
    ['token-store', {}],
    ['session-index', {}],
    ['audit-log', {}],
    ['auth-refresh', { depends: ['token-store'] }],
    ['device-list', { depends: ['token-store'] }],
    ['rate-limit', { depends: ['session-index'] }],
  ] as Array<[string, Record<string, unknown>]>) {
    const w = await writeSpec(repo, id, { criteria: [{ id: `ac-${id}`, test: `@spec:${id}` }], covers: ['g1'], ...extra })
    expect(w.code, `write ${id}: ${w.stderr}`).toBe(0)
  }
  for (const id of ['token-store', 'session-index', 'audit-log', 'auth-refresh', 'device-list', 'rate-limit']) {
    approve(repo, id)
  }
}

// A plan written under an approved spec, ready for its gate — opted into autonomy unless
// the caller wants the decision to wait first.
export async function plannedRepo(opts: { autonomy?: boolean } = {}): Promise<TestRepo> {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  if (opts.autonomy !== false) autonomyOn(repo)
  return repo
}

// One blocking finding anchored inside the plan: the recommender's `blocking-here`.
export const PLAN_BLOCKING = {
  coverage: [
    { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
    { anchor: 'auth-refresh > ## Behavior', note: 'read' },
  ],
  findings: [{ blocking: true, anchor: 'auth-refresh-plan-1 > ## Step: s1', claim: 'step is untestable' }],
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
  // D149. `designs/**` is guarded but was named in one of six ground rules, and nothing in
  // the payload told a session to read a file before editing it — the two halves of the
  // 103×/8× edit-friction clusters that are witness's to fix.
  'designs/**',
  'Read a file before your first edit',
  // Row 197. A grill's answers are numbered too, and a number there is no CLI selection (D143).
  'never a `witness decide` option',
]

// Row 198. A spec carrying one decision under a plan derived from it: a birth recap, not an
// amendment, so the fixture shortcut holds and the plan stands as the spec's base.
export async function decidedRepo(): Promise<TestRepo> {
  const repo = await seededRepo({ noRecap: true })
  const r = await repo.cli(['recap', '--file', repo.writeRecap({ decisions: [{ id: 'd1', text: 'Rotation is server-side' }] })])
  if (r.code !== 0) throw new Error(`recap: ${r.stderr}`)
  repo.effort = 'auth-hardening'
  const w = await writeSpec(repo, 'auth-refresh', { carries: ['d1'] })
  if (w.code !== 0) throw new Error(`write spec: ${w.stderr}`)
  approve(repo, 'auth-refresh')
  const p = await writePlan(repo, 'auth-refresh-plan-1')
  if (p.code !== 0) throw new Error(`write plan: ${p.stderr}`)
  return repo
}

// Amends the carried decision's text — the spec's content stays as it is.
export async function turnDecision(repo: TestRepo, text: string): Promise<void> {
  const r = await repo.cli(['recap', '--amend', '--file', repo.writeRecap({ decisions: [{ id: 'd1', text }] })])
  if (r.code !== 0) throw new Error(`amend: ${r.stderr}`)
}

// Row 198 (Builder's call 4). A chore plan on a live spec, the chore carrying its own decision.
export const TIDY = {
  effort: 'tidy', class: 'chore', goals: [{ id: 'g1', text: 'Tidy the token module' }],
  non_goals: [], constraints: [], decisions: [{ id: 'd1', text: 'Keep the public API' }], slices: [],
}
export async function choreOnSpec(): Promise<TestRepo> {
  const repo = await seededRepo({ preexisting: ['auth-refresh'] })
  repo.write('tidy.json', JSON.stringify(TIDY))
  const r = await repo.cli(['recap', '--file', 'tidy.json'])
  if (r.code !== 0) throw new Error(`recap tidy: ${r.stderr}`)
  const p = await writePlan(repo, 'auth-refresh-plan-1', {}, PLAN_BODY, 'tidy')
  if (p.code !== 0) throw new Error(`write chore plan: ${p.stderr}`)
  return repo
}

// A second effort, so a test can put plans or amendments under a different owner.
export async function recapEffort(repo: TestRepo, slug: string): Promise<void> {
  repo.write(`recap-${slug}.json`, JSON.stringify({
    effort: slug, class: 'feature', goals: [{ id: 'g1', text: `${slug} goal` }],
    non_goals: [], constraints: [], slices: [],
  }))
  const r = await repo.cli(['recap', '--file', `recap-${slug}.json`])
  rmSync(join(repo.root, `recap-${slug}.json`), { force: true })
  if (r.code !== 0) throw new Error(`recap ${slug}: ${r.stderr}`)
}

// D167. `rename` moves an id and its journal but not its file, so the re-slice departs
// `token-refresh` from `specs/auth-refresh.md` — the path its way back lands on.
export async function renamedAndResliced(): Promise<{ repo: TestRepo; shipped: string }> {
  const repo = await seededRepo({ preexisting: ['auth-refresh'] })
  expect((await repo.cli(['rename', 'auth-refresh', 'token-refresh'])).code).toBe(0)
  const shipped = repo.read('specs/auth-refresh.md')
  expect((await writeSpec(repo, 'setup-card', { supersedes: 'token-refresh', criteria: [{ id: 'ac-setup', test: '@spec:setup-card' }] })).code).toBe(0)
  return { repo, shipped }
}

// D167. The doc a pre-167 `write` (or a hand edit) could leave on a departed spec's path;
// `write` and `adopt` refuse to make one now.
export function plantHolder(repo: TestRepo, shipped: string, writer?: string): string {
  const rel = 'specs/auth-refresh.md'
  const planted = shipped.replace('id: token-refresh', 'id: auth-refresh').replace('@spec:token-refresh', '@spec:auth-refresh')
    .replace('status: live', 'status: approved').replace(/^summary: .*$/m, 'summary: a different spec')
  repo.write(rel, planted)
  if (writer !== undefined) {
    const doc = findById(loadCanon(repo.root), 'auth-refresh')!
    appendEntry(repo.root, writer, { t: 'write', effort: writer, artifact: 'auth-refresh', sha: canonicalSha(doc.meta, doc.body), created: true })
  }
  repo.git('add', rel, ...(writer === undefined ? [] : [journalRel(writer)]))
  repo.git('commit', '-m', 'a doc a pre-167 write left on the old path', '-m', 'Witness-State: 1')
  return planted
}
