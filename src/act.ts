import { shellArg } from './toon.js'

// Rows 139/203. A command the CLI offers a human to run, as data: the words after `witness`
// exactly as given, so it runs without a shell; the words a human must fill, by position; and
// the line the text prints. A surface that offers an act prints its `line`, so a reader of the
// act and a reader of the text are handed the same command.

// The CLI's own placeholders, and only those — the names `PLACEHOLDER` matches in a line.
export type ActInputName = 'why' | 'effort'
// `argv[at]` is exactly `<name>`.
export interface ActInput { name: ActInputName; at: number }
export interface Act { argv: readonly string[]; inputs: readonly ActInput[]; line: string }

// A whole word, never a fragment: a reviewer's anchor inside a note prefill may read `<why>`
// or `<SaveBar>`, and it is the reviewer's text, not a word the human must fill.
const INPUT = /^<(why|effort)>$/

// One word as the line prints it. The word after `--note` prints in double quotes, raw — D120's
// grammar, which every screen has printed and `actOfCommand` reads back; a shell word's quoting
// would change that text. An input prints bare, as the slot it is. Anything else is a shell
// word: ids match ID_RE and print bare, a trust command prints single-quoted.
function word(argv: readonly string[], at: number): string {
  const w = argv[at]!
  if (argv[at - 1] === '--note') return `"${w}"`
  return INPUT.test(w) ? w : shellArg(w)
}

const words = (argv: readonly string[]): string[] => argv.map((_, at) => word(argv, at))

export function cliAct(...argv: string[]): Act {
  const inputs = argv.flatMap((w, at): ActInput[] => {
    const m = INPUT.exec(w)
    return m ? [{ name: m[1] as ActInputName, at }] : []
  })
  return { argv, inputs, line: ['witness', ...words(argv)].join(' ') }
}

// `liveExits`' grammar: the acts' lines joined by ` | `, where a decide act on the same gate and
// target as the act before it prints only the words after them — `witness decide plan p1
// --approve | --stop`. A decide act with no word past its target prints whole, never as an
// empty segment.
export function exitsLine(acts: readonly Act[]): string {
  return acts.map((a, i) => {
    const prev = acts[i - 1]
    const shared = prev !== undefined && a.argv[0] === 'decide' && a.argv.length > 3 &&
      [0, 1, 2].every((k) => a.argv[k] === prev.argv[k])
    return shared ? words(a.argv).slice(3).join(' ') : a.line
  }).join(' | ')
}
