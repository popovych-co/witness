import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  return repo.cli(['write', id, '--effort', effort, '--meta', `m-${id}.json`, '--body', `b-${id}.md`])
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
  return repo.cli(['write', id, '--effort', effort, '--meta', `m-${id}.json`, '--body', `b-${id}.md`])
}
