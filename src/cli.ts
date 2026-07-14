import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configPath } from './config.js'
import { primaryRoot } from './gitio.js'

export interface Ctx {
  cwd: string
  env: Record<string, string | undefined>
  isTTY: boolean
  out: (line: string) => void
  err: (line: string) => void
  ask: (question: string) => Promise<string>
}

export const EXIT = { OK: 0, FINDINGS: 1, REFUSED: 2, BLOCKED: 3 } as const

type Verb = (ctx: Ctx, argv: string[]) => Promise<number>

const VERBS: Record<string, () => Promise<{ run: Verb }>> = {
  recover: () => import('./verbs/recover.js'),
  init: () => import('./verbs/init.js'),
  recap: () => import('./verbs/recap.js'),
  write: () => import('./verbs/write.js'),
  diff: () => import('./verbs/diff.js'),
  check: () => import('./verbs/check.js'),
  index: () => import('./verbs/index-verb.js'),
  satisfy: () => import('./verbs/satisfy.js'),
  log: () => import('./verbs/log.js'),
  'test-evidence': () => import('./verbs/evidence.js'),
  'verify-red': () => import('./verbs/evidence.js').then((m) => ({ run: m.runVerifyRed })),
  adopt: () => import('./verbs/adopt.js'),
  gate: () => import('./verbs/gate.js'),
  decide: () => import('./verbs/decide.js'),
  start: () => import('./verbs/start.js'),
  clean: () => import('./verbs/clean.js'),
  ship: () => import('./verbs/ship.js'),
  next: () => import('./verbs/next.js'),
  abandon: () => import('./verbs/abandon.js'),
  rename: () => import('./verbs/rename.js'),
  sync: () => import('./verbs/sync.js'),
  calibrate: () => import('./verbs/calibrate.js'),
}

export function version(): string {
  const pkg = JSON.parse(
    readFileSync(join(new URL('.', import.meta.url).pathname, '..', 'package.json'), 'utf8'),
  ) as { version: string }
  return pkg.version
}

export function usage(): string {
  return [
    'specflow — spec-led pipeline: specs are state, plans are motion',
    'usage: specflow <verb> [flags]',
    `verbs: ${Object.keys(VERBS).sort().join(' · ') || '(landing slice by slice)'}`,
    'help: specflow <verb> --help',
  ].join('\n')
}

export async function main(ctx: Ctx, argv: string[]): Promise<number> {
  const [verb, ...rest] = argv
  if (verb === '--version' || verb === '-v') {
    ctx.out(version())
    return EXIT.OK
  }
  if (!verb || verb === 'help' || verb === '--help') {
    if (!verb) {
      const rootRes = primaryRoot(ctx.cwd)
      if (rootRes.ok && existsSync(configPath(rootRes.value))) {
        return (await import('./verbs/dashboard.js')).run(ctx, [])
      }
    }
    ctx.out(usage())
    return EXIT.OK
  }
  const load = VERBS[verb]
  if (!load) {
    ctx.err(`unknown verb: ${verb}`)
    ctx.err(usage())
    return EXIT.REFUSED
  }
  return (await load()).run(ctx, rest)
}
