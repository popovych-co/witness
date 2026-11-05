import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { seededRepo } from './helpers.js'

// Row 239 (the plan's B17). A command named inside prose — a refusal's want, a `help:`, a note,
// a check detail — is pasted as often as a `run:` line is, so it prints as one: a runnable
// command is an act's line, and a shape quotes each foreign word through the quoter.
describe('prose that names a command quotes its foreign words (row 239)', () => {
  it("a refusal's want quotes the target the human typed (row 239)", async () => {
    const repo = await seededRepo()
    const r = await repo.cli(['decide', 'plan', 'p1$(touch M1)', '--approve'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("run: witness gate plan 'p1$(touch M1)'")
  })

  it('trust --yes without a terminal quotes the id', async () => {
    const repo = await seededRepo()
    const r = await repo.cli(['trust', 'p$(touch M1)', '--yes'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('yes-needs-terminal')
    expect(r.stderr).toContain("witness trust 'p$(touch M1)' --cmd '<cmd>'")
  })
})

// The regression net. A template that names `witness <verb>` and then interpolates a value not
// passed through the quoter (`shellWord`, `quotedWord`) or built as an act (`cliAct`) prints that
// value bare on a command line, and so does a quoted `witness <verb> ` string with a value
// concatenated after it. Each line of src/ is read alone.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
const TEMPLATE = /`[^`]*\bwitness [a-z][^`]*\$\{(?!shellWord\(|cliAct\(|quotedWord\()/
const CONCAT = /'[^']*\bwitness [a-z][^']*'\s*\+/

// The lines that match and name no command, each as [file, a substring of the line]. Every entry
// must still match a line, so the list never outlives the code it excuses.
const NOT_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  // The trust prompt: witness is the sentence's subject, and `cmd` is the repo's command the
  // human is asked to trust, shown as written (row 237 never offers one they cannot read whole).
  ['src/allowlist.ts', 'witness wants to run: ${cmd}'],
  // The floor's remedy names this CLI's own version, which no repo, reviewer or config writes.
  ['src/cli.ts', 'witness floor --set ${version()}'],
  // Prose: "a witness setting", and `near` is a path from witness's own settings list.
  ['src/config.ts', 'a witness setting — did you mean ${near}?'],
  // Prose naming where a drive runs, when it has no log to watch; the pid is a number.
  ['src/drive-presence.ts', 'the terminal running witness drive · pid ${h.pid}'],
  // The drive report's summary, a title: the repo's name and the tally follow a dash.
  ['src/drive-report.ts', 'witness drive — ${basename(root)} · ${tally}'],
  // The header drive writes into its own log file, which nothing offers to be pasted.
  ['src/drive.ts', '--- witness drive ${new Date().toISOString()} ---'],
  // What `witness migrate` would write, in words: witness's own setting paths, not arguments.
  ['src/migration.ts', "witness migrate ${parts.join(' · ')}"],
  // adopt's usage line: `<…>` is argument syntax naming the configured dirs, not a command.
  ['src/verbs/adopt.ts', 'witness adopt <${paths.specs}/... | ${paths.plans}/...>.md'],
]

describe('no witness command in src/ prints a bare value (row 239)', () => {
  it('no template under src/ interpolates a bare value into a witness command', () => {
    const hits: string[] = []
    const excused = new Set<number>()
    for (const file of walk(join(ROOT, 'src'))) {
      const rel = relative(ROOT, file).replaceAll('\\', '/')
      for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        if (!TEMPLATE.test(line) && !CONCAT.test(line)) continue
        const at = NOT_COMMANDS.findIndex(([f, s]) => f === rel && line.includes(s))
        if (at >= 0) excused.add(at)
        else hits.push(`${rel}:${i + 1}: ${line.trim()}`)
      }
    }
    expect(hits).toEqual([])
    expect(NOT_COMMANDS.filter((_, at) => !excused.has(at))).toEqual([])
  })
})
