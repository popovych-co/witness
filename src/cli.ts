import { existsSync } from 'node:fs'
import { configPath } from './config.js'
import { stateFloor } from './floor.js'
import { primaryRoot } from './gitio.js'
import { renderRefusal, v } from './refusal.js'
import { NPX_LATEST, compareTriple, version } from './version.js'

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
  // Row 132's read route. Canon lives at the primary root and nowhere else, so reading it
  // is a verb rather than a path — which is also what lets a worktree carry no copy.
  read: () => import('./verbs/read.js'),
  diff: () => import('./verbs/diff.js'),
  check: () => import('./verbs/check.js'),
  index: () => import('./verbs/index-verb.js'),
  satisfy: () => import('./verbs/satisfy.js'),
  dismiss: () => import('./verbs/dismiss.js'),
  log: () => import('./verbs/log.js'),
  'test-evidence': () => import('./verbs/evidence.js'),
  'verify-red': () => import('./verbs/evidence.js').then((m) => ({ run: m.runVerifyRed })),
  'dispatch-report': () => import('./verbs/dispatch.js'),
  adopt: () => import('./verbs/adopt.js'),
  gate: () => import('./verbs/gate.js'),
  decide: () => import('./verbs/decide.js'),
  design: () => import('./verbs/design.js'),
  start: () => import('./verbs/start.js'),
  // The orientation screen has a name (D101). Bare `witness` stays as its alias, but
  // an unnamed command cannot be referenced — commands/witness.md instructs the
  // operator to read "the dashboard" and nothing said which command prints it.
  status: () => import('./verbs/dashboard.js'),
  clean: () => import('./verbs/clean.js'),
  ship: () => import('./verbs/ship.js'),
  next: () => import('./verbs/next.js'),
  abandon: () => import('./verbs/abandon.js'),
  rename: () => import('./verbs/rename.js'),
  sync: () => import('./verbs/sync.js'),
  calibrate: () => import('./verbs/calibrate.js'),
  // Row 116's valve. Exempt from the floor gate in `main`, because a repository that
  // refuses every verb must still be able to run the one that unrefuses it.
  floor: () => import('./verbs/floor.js'),
}

// answered centrally so no verb can crash on --help (several parse argv
// strictly); each line mirrors the verb's own usage refusal where one exists
const VERB_USAGE: Record<string, string> = {
  abandon: 'witness abandon <plan-id | effort-slug>',
  adopt: 'witness adopt <specs/... | plans/...>.md',
  calibrate: 'witness calibrate <exact-model-id> [--suite all|reviewers|skills] [--only <name>] [--samples <n>] [--publish]',
  check: 'witness check',
  clean: 'witness clean',
  decide: 'witness decide <gate> <target> --approve|--revise|--stop [--override] [--repair] [--note <t>] [--upstream <artifact|effort>] [--pin <policy>]… [--show]',
  floor: 'witness floor --show | --set <triple> --note <why>',
  design: 'witness design <spec-id> --file <html> | --reconfirm | --open',
  diff: 'witness diff <spec-id>',
  'dispatch-report': 'witness dispatch-report <plan-id> --steps-assigned <n> --steps-completed <n> [--tokens <n>] [--tool-uses <n>] [--duration-ms <n>]',
  gate: 'witness gate <decompose|plan|implement|ship|design> <target> [--fresh] [--manual]',
  index: 'witness index',
  init: 'witness init [--agent claude-code|pi|auto]',
  log: 'witness log <stream> [--all] [--lineage]',
  next: 'witness next',
  read: 'witness read <id> [--design] [--outline] [--lines <a>-<b>]',
  recap: 'witness recap --file <recap.json> [--amend]',
  recover: 'witness recover [--complete | --rollback]',
  rename: 'witness rename <old-id> <new-id>',
  satisfy: 'witness satisfy <doc-id> --need <text | index>',
  dismiss: 'witness dismiss <artifact> --deferral <id|index> --cause <superseded|lens-retired|judged-wrong> --note "<why>"',
  ship: 'witness ship <plan-id>',
  start: 'witness start <plan-id>',
  status: 'witness status — flows · blocked docs · reconcile rows · pending gates (bare `witness` is the same screen)',
  sync: 'witness sync',
  'test-evidence': 'witness test-evidence <plan-id> --phase red|green',
  'verify-red': 'witness verify-red <plan-id> [--base <ref>]',
}

// Row 116 moved the body to version.ts, which journal.ts can import without closing a
// cycle. Re-exported here because eleven call sites already ask the CLI shell for it and
// the question they are asking has not changed.
export { version }

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
  // Row 116. Above the verb table on purpose — including above the bare-`witness`
  // dashboard route, which reads the same state every verb does. The invariant is "one
  // repository, one witness version", and a per-verb opt-in is a list some future verb
  // forgets to join.
  //
  // This is the guard row 102's `cli-behind-payload` structurally could not be. That one
  // fires inside the home it protects, so a home frozen at an old pin runs an old CLI that
  // never learned to check — which is how two sessions a lifecycle apart each computed a
  // different next stage, each redirected to the other's home, and each honestly ended its
  // turn. The state is the one thing every home shares, so the state is where the bound
  // belongs.
  //
  // Forward-only, and the text must never imply otherwise: a CLI published before this row
  // cannot run this code. Homes already frozen are found by `check` and repaired by `init`.
  //
  // Two exemptions, both load-bearing. `floor` is how a bad publish is recovered from — a
  // repository that refuses every verb must still be able to run the one that unrefuses it.
  // An explicit help request is information, and refusing to print a usage line teaches
  // the human nothing they can act on.
  const helpRequested = verb === 'help' || verb === '--help'
    || rest.includes('--help') || rest.includes('-h')
  if (!helpRequested && verb !== 'floor') {
    const gateRoot = primaryRoot(ctx.cwd)
    if (gateRoot.ok) {
      const floor = stateFloor(gateRoot.value)
      if (floor !== undefined && (compareTriple(version(), floor.pin) ?? 0) < 0) {
        renderRefusal([v('witness', 'cli-behind-state',
          `this CLI is ${version()}, this repository's state was written by ${floor.pin}`,
          `a CLI at or ahead of ${floor.pin} — run ${NPX_LATEST} init --agent <name>; if you are `
          + `deliberately rolling back, lower the bound first with witness floor --set ${version()} --note <why>`,
        )]).forEach((l) => ctx.err(l))
        return EXIT.REFUSED
      }
    }
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
  try {
    return await (await load()).run(ctx, rest)
  } catch (e) {
    // Row 113. Eight verbs parse argv with node's strict `parseArgs`, which THROWS on a
    // stray positional or a mistyped flag. bin.ts's crash net then rendered a typo as
    // `unexpected-error … a bug — re-run with the same arguments and report this line`:
    // the tool asked to be reported for a mistake it could answer with its own usage. This
    // is the one throw class that is a user statement rather than a witness fault, and the
    // usage line lives right here. Anything else still reaches bin.ts unchanged.
    const code = (e as { code?: string }).code
    if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) {
      renderRefusal([v(verb, 'bad-arguments', String((e as Error).message).split('.')[0]!.slice(0, 160),
        VERB_USAGE[verb] ?? `witness ${verb} --help`)]).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
    throw e
  }
}
