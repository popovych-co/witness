import { shellArg } from './toon.js'

// Rows 139/203. A command the CLI offers a human to run, as data: the words after `witness`
// exactly as given, so it runs without a shell; the words a human must fill, by position; and
// the line the text prints. A surface that offers an act prints its `line`, so a reader of the
// act and a reader of the text are handed the same command.

// The CLI's own placeholders, and only those — the names `PLACEHOLDER` matches in a line.
export type ActInputName = 'why' | 'effort'
// `argv[at]` is exactly `<name>`, and `argv[at - 1]` is the flag whose slot it fills.
export interface ActInput { name: ActInputName; at: number }
// Rows 139/203. Reviewer text reaches the model as the text prints it, unescaped (R5/R17): an
// option's `why`, a block's `anchor`, a parked item's `why` and a gate run's `demoted` anchor —
// only the findings table spells it out. No act carries it: since row 239 the revise carries no
// note. A renderer must spell it out (spec §4.2), and the UI runs `argv`, never `line`.
export interface Act { argv: readonly string[]; inputs: readonly ActInput[]; line: string }

// Rows 139/203. Inputs are positional: the CLI writes `<why>` only as a note and `<effort>` only
// as an upstream, so those two words, whole and in those two slots, are the only ones a human
// fills. Any other word is literal, even one that reads `<why>`: a reviewer's anchor inside a
// note prefill (`… <why> in <SaveBar>`), or a repo-authored trust command, which stays a literal
// grant and never becomes a slot to fill.
const slotOf = (flag: string | undefined): ActInputName | undefined =>
  flag === '--note' ? 'why' : flag === '--upstream' ? 'effort' : undefined

function inputAt(argv: readonly string[], at: number): ActInputName | undefined {
  const name = slotOf(argv[at - 1])
  return name !== undefined && argv[at] === `<${name}>` ? name : undefined
}

// One word as the line prints it: today's per-word rendering, byte for byte, so a line is the
// text every screen printed before acts existed. The word after `--note` prints in double
// quotes, raw — D120's grammar, which `actOfCommand` reads back. The word after `--cmd` is the
// one word today's text shell-quoted (`grantOf`, the trust verb's `run:` lines): a repo-authored
// command the verb takes as one word, which must paste as one whatever quotes or spaces it
// holds. Every other word prints as written — flags, ids, an input bare as the slot it is — as
// the templates printed them: a malformed id stays as unpasteable as it was, and `argv` keeps
// what runs exact.
function word(argv: readonly string[], at: number): string {
  const w = argv[at]!
  if (argv[at - 1] === '--note') return `"${w}"`
  return argv[at - 1] === '--cmd' ? shellArg(w) : w
}

const words = (argv: readonly string[]): string[] => argv.map((_, at) => word(argv, at))

export function cliAct(...argv: string[]): Act {
  const inputs = argv.flatMap((_, at): ActInput[] => {
    const name = inputAt(argv, at)
    return name !== undefined ? [{ name, at }] : []
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
