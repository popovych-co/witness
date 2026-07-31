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
  'dispatch-report': () => import('./verbs/dispatch.js'),
  adopt: () => import('./verbs/adopt.js'),
  gate: () => import('./verbs/gate.js'),
  decide: () => import('./verbs/decide.js'),
  design: () => import('./verbs/design.js'),
  start: () => import('./verbs/start.js'),
  clean: () => import('./verbs/clean.js'),
  ship: () => import('./verbs/ship.js'),
  next: () => import('./verbs/next.js'),
  abandon: () => import('./verbs/abandon.js'),
  rename: () => import('./verbs/rename.js'),
  sync: () => import('./verbs/sync.js'),
  calibrate: () => import('./verbs/calibrate.js'),
}

// answered centrally so no verb can crash on --help (several parse argv
// strictly); each line mirrors the verb's own usage refusal where one exists
const VERB_USAGE: Record<string, string> = {
  abandon: 'witness abandon <plan-id | effort-slug>',
  adopt: 'witness adopt <specs/... | plans/...>.md',
  calibrate: 'witness calibrate <exact-model-id> [--suite all|reviewers|skills] [--only <name>] [--samples <n>] [--publish]',
  check: 'witness check',
  clean: 'witness clean',
  decide: 'witness decide <gate> <target> --approve|--revise|--stop [--override] [--note <t>] [--upstream <artifact|effort>] [--pin <policy>]… [--show]',
  design: 'witness design <spec-id> --file <html> | --reconfirm | --open',
  diff: 'witness diff <spec-id>',
  'dispatch-report': 'witness dispatch-report <plan-id> --steps-assigned <n> --steps-completed <n> [--tokens <n>] [--tool-uses <n>] [--duration-ms <n>]',
  gate: 'witness gate <decompose|plan|implement|ship|design> <target> [--fresh] [--manual]',
  index: 'witness index',
  init: 'witness init [--agent claude-code|pi|auto]',
  log: 'witness log <stream> [--all] [--lineage]',
  next: 'witness next',
  recap: 'witness recap --file <recap.json> [--amend]',
  recover: 'witness recover [--complete | --rollback]',
  rename: 'witness rename <old-id> <new-id>',
  satisfy: 'witness satisfy <doc-id> --need <text | index>',
  ship: 'witness ship <plan-id>',
  start: 'witness start <plan-id>',
  sync: 'witness sync',
  'test-evidence': 'witness test-evidence <plan-id> --phase red|green',
  'verify-red': 'witness verify-red <plan-id> [--base <ref>]',
}

export function version(): string {
  const pkg = JSON.parse(
    readFileSync(join(new URL('.', import.meta.url).pathname, '..', 'package.json'), 'utf8'),
  ) as { version: string }
  return pkg.version
}

export function usage(): string {
  return [
    'witness — spec-led pipeline: specs are state, plans are motion',
    'usage: witness <verb> [flags]',
    `verbs: ${Object.keys(VERBS).sort().join(' · ') || '(landing slice by slice)'}`,
    'help: witness <verb> --help',
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
  if (load && (rest.includes('--help') || rest.includes('-h'))) {
    ctx.out(`usage: ${VERB_USAGE[verb] ?? `witness ${verb} [flags]`}`)
    return EXIT.OK
  }
  if (!load) {
    ctx.err(`unknown verb: ${verb}`)
    ctx.err(usage())
    return EXIT.REFUSED
  }
  return (await load()).run(ctx, rest)
}
