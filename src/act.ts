import { shellWord, withheldOn, type Platform } from './toon.js'

// Rows 139/203. A command the CLI offers a human to run, as data: the words after `witness`
// exactly as given, so it runs without a shell; the words a human must fill, by position; and
// the line the text prints. A surface that offers an act prints its `line`, so a reader of the
// act and a reader of the text are handed the same command. Row 239: the line is printed for the
// shell its platform pastes into, and pasted there it runs exactly `argv`.

// The CLI's own placeholders, and only those — the names an act's inputs carry. Row 239: every
// reader finds them on the act (`inputs`), and none matches them in a printed line.
export type ActInputName = 'why' | 'effort'
// `argv[at]` is exactly `<name>`, and `argv[at - 1]` is the flag whose slot it fills.
export interface ActInput { name: ActInputName; at: number }
// Rows 139/203. Reviewer text reaches the model as the text prints it, unescaped (R5/R17): an
// option's `why`, a block's `anchor`, a parked item's `why` and a gate run's `demoted` anchor —
// only the findings table spells it out. No act carries it: since row 239 the revise carries no
// note. A renderer must spell it out (spec §4.2), and the UI runs `argv`, never `line`.
// Row 239 (the plan's B4). `withheld` is why the line is never offered to be pasted, set on
// Windows only: a word other than an input holds a character cmd.exe or Windows PowerShell can
// read as more than text (`withheldOn`). The line is still shown, and `argv`, run with no shell,
// runs as given.
export interface Act { argv: readonly string[]; inputs: readonly ActInput[]; line: string; withheld?: string }

// Rows 139/203. Inputs are positional: the CLI writes `<why>` only as a note and `<effort>` only
// as an upstream, so those two words, whole and in those two slots, are the only ones a human
// fills. Any other word is literal, even one that reads `<why>`: a repo-authored trust command
// stays a literal grant and never becomes a slot to fill.
const slotOf = (flag: string | undefined): ActInputName | undefined =>
  flag === '--note' ? 'why' : flag === '--upstream' ? 'effort' : undefined

function inputAt(argv: readonly string[], at: number): ActInputName | undefined {
  const name = slotOf(argv[at - 1])
  return name !== undefined && argv[at] === `<${name}>` ? name : undefined
}

// One word as the line prints it. An input prints as it always has, `"<why>"` or `<effort>`: a
// placeholder the human replaces, never pasted as it stands. Row 239: every other word prints
// through the quoter (`shellWord`), the `--note` and `--cmd` words included — bare where the
// platform's shell reads it as written, so a line of ids and flags prints byte for byte as it
// always did, and quoted where not. A line therefore reads back by the quoter's grammar (off
// Windows, `shellWords`), no longer by D120's raw `--note "…"`, and a word pastes as the one word
// it is, whatever quotes, spaces or `$(…)` it holds: an id, a note, or a repo-authored command the
// trust verb takes as one word.
function word(argv: readonly string[], at: number, platform: Platform): string {
  const w = argv[at]!
  const input = inputAt(argv, at)
  if (input === 'why') return `"${w}"`
  return input === 'effort' ? w : shellWord(w, platform)
}

const words = (argv: readonly string[], platform: Platform): string[] => argv.map((_, at) => word(argv, at, platform))

// Row 239. An act printed for the shell `platform` pastes into: bash, zsh or dash off Windows,
// PowerShell on it. An input is the CLI's own placeholder, so it is never withheld.
export function actOn(platform: Platform, argv: readonly string[]): Act {
  const inputs = argv.flatMap((_, at): ActInput[] => {
    const name = inputAt(argv, at)
    return name !== undefined ? [{ name, at }] : []
  })
  const withheld = withheldOn(argv.filter((_, at) => inputAt(argv, at) === undefined), platform)
  return { argv, inputs, line: ['witness', ...words(argv, platform)].join(' '), ...(withheld !== undefined ? { withheld } : {}) }
}

// An act for this machine's shell.
export function cliAct(...argv: string[]): Act {
  return actOn(process.platform, argv)
}

// Row 239 (the plan's B4, ruling R16(b)). An act as the row printed under the line it belongs to:
// `run: <line>`, or `then:` for the step after it. An act Windows withholds is shown with why on a
// `note:` row, which offers nothing to paste. Every `run:` and `then:` row printed from an act goes
// through here, so no printer can forget the check.
export function runRow(act: Act, label: 'run' | 'then' = 'run', indent = '  '): string {
  return act.withheld === undefined ? `${indent}${label}: ${act.line}` : `${indent}note: ${act.line} — ${act.withheld}`
}

// `liveExits`' grammar: the acts' lines joined by ` | `, where a decide act on the same gate and
// target as the act before it prints only the words after them — `witness decide plan p1
// --approve | --stop`. A decide act with no word past its target prints whole, never as an
// empty segment. Row 239: those words print for `platform`, the one the acts were built for.
export function exitsLine(acts: readonly Act[], platform: Platform = process.platform): string {
  return acts.map((a, i) => {
    const prev = acts[i - 1]
    const shared = prev !== undefined && a.argv[0] === 'decide' && a.argv.length > 3 &&
      [0, 1, 2].every((k) => a.argv[k] === prev.argv[k])
    return shared ? words(a.argv, platform).slice(3).join(' ') : a.line
  }).join(' | ')
}
