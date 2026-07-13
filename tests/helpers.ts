import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { main, type Ctx } from '../src/cli.js'

export interface CliResult { code: number; stdout: string; stderr: string }

export interface CliOpts {
  answers?: string[]
  tty?: boolean
  env?: Record<string, string>
}

export interface TestRepo {
  root: string
  git: (...args: string[]) => string
  write: (rel: string, content: string) => void
  read: (rel: string) => string
  cli: (args: string[], opts?: CliOpts) => Promise<CliResult>
}

export function tmpRepo(): TestRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'specflow-')))
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
      cwd: root,
      env: { ...process.env, ...opts.env },
      isTTY: opts.tty ?? answers.length > 0,
      out: (l) => outs.push(l),
      err: (l) => errs.push(l),
      ask: async () => answers.shift() ?? '',
    }
    const code = await main(ctx, args)
    return { code, stdout: outs.join('\n'), stderr: errs.join('\n') }
  }

  return { root, git, write, read, cli }
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

export async function seededRepo(recap: unknown = RECAP): Promise<TestRepo> {
  const repo = tmpRepo()
  await repo.cli(['init'])
  repo.write('recap.json', JSON.stringify(recap))
  const res = await repo.cli(['recap', '--file', 'recap.json'])
  if (res.code !== 0) throw new Error(`recap failed: ${res.stderr}`)
  return repo
}

export async function writeSpec(repo: TestRepo, id: string, meta: unknown = SPEC_META, body = SPEC_BODY, effort = 'auth-hardening'): Promise<CliResult> {
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

export async function writePlan(repo: TestRepo, id: string, meta: unknown = PLAN_META, body = PLAN_BODY, effort = 'auth-hardening'): Promise<CliResult> {
  repo.write(`m-${id}.json`, JSON.stringify(meta))
  repo.write(`b-${id}.md`, body)
  const res = await repo.cli(['write', id, '--effort', effort, '--meta', `m-${id}.json`, '--body', `b-${id}.md`])
  rmSync(join(repo.root, `m-${id}.json`), { force: true })
  rmSync(join(repo.root, `b-${id}.md`), { force: true })
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
    SPECFLOW_TRUST_CMDS: '1',
    VITEST_BIN: vitestBin(),
    CI: '',
    ...extra,
  }
}

export function fakeCtx(root: string, opts: { tty?: boolean; answers?: string[]; env?: Record<string, string> } = {}): Ctx {
  const answers = [...(opts.answers ?? [])]
  return {
    cwd: root,
    env: { ...opts.env },
    isTTY: opts.tty ?? answers.length > 0,
    out: () => {},
    err: () => {},
    ask: async () => answers.shift() ?? '',
  }
}

export function copyFixture(repo: TestRepo, name: 'vitest-single' | 'workspace'): void {
  const src = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))
  cpSync(src, repo.root, { recursive: true })
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
  const rel = `specs/${id}.md`
  repo.write(rel, repo.read(rel).replace('status: draft', 'status: live'))
  repo.git('add', rel)
  repo.git('commit', '-m', `stamp live: ${id}`, '-m', 'Specflow-State: 1')
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
