import { describe, expect, it } from 'vitest'
import { shellLine } from '../src/toon.js'
import { MODES, type Mode, PAYLOADS, type Pasteable, pasteIn, REF_PAYLOADS } from './shells.js'

// Back-to-back `spawnSync` calls hold the worker's event loop, and vitest's worker RPC fails a
// run whose loop is held 60 s (tests/loop-watch.ts), so a loop of pastes yields after each one.
const turn = (): Promise<unknown> => new Promise((r) => setImmediate(r))

// Row 239. A pasted line runs only what witness wrote. Each row builds lines with witness's own
// code around a hostile payload, and each line is pasted alone into every shell here: it must
// make no marker file and, where the row says, hand its stubs exactly the argv witness composed.
// A row's own payload list replaces PAYLOADS.
type Row = [name: string, build: (payload: string) => Pasteable[] | Promise<Pasteable[]>, payloads?: readonly string[]]

const ROWS: Row[] = [
  ['quoter: a POSIX word', (p) => [{ line: shellLine(['witness', 'x', p], 'darwin'), calls: [['witness', 'x', p]] }]],
  // zsh reads a bare `=ls` as the path of `ls`
  ['quoter: a word starting with =', (p) => [{ line: shellLine(['witness', p], 'darwin'), calls: [['witness', p]] }], ['=ls']],
  // PowerShell's quoting, pasted into a POSIX shell (Git Bash), is lossy for `'`: inert only
  ['quoter: the Windows form in a POSIX shell', (p) => [{ line: shellLine(['witness', 'x', p], 'win32') }]],
]

// Row 239. Where each payload was built to bite (the inventory's "Which payload bites where"), as
// the line that puts it there. Pasted there, a payload must run its code in some shell here, or
// every row above would pass it vacuously. P6 breaks out of double quotes only where history
// expands, as in a human's paste. The table holds every payload, in order.
const bare = (p: string): string => `witness x ${p}`
const doubled = (p: string): string => `witness x "${p}"`
const single = (p: string): string => `witness x '${p}'`
const INTERACTIVE = MODES.filter((m) => m.endsWith('-i'))
const BITES: ReadonlyArray<readonly [payload: string, line: (p: string) => string, modes: readonly Mode[]]> = [
  ['$(touch M1)', bare, MODES],
  ['`touch M2`', bare, MODES],
  ['"; touch M3; "', doubled, MODES],
  ["'; touch M4; '", single, MODES],
  [';touch M5;', bare, MODES],
  ['!#;touch M6;#', doubled, INTERACTIVE],
  ['main$(touch${IFS}M7)', bare, MODES],
  ['main$(touch${=IFS}M8)', bare, MODES],
  ...REF_PAYLOADS.map((p) => [p, bare, MODES] as const),
]

describe.skipIf(MODES.length === 0)('a pasted line runs only what witness wrote (row 239)', () => {
  // Without it, a broken harness would pass every row. Each mode must see a line that does run
  // code, and an interactive one must expand history, as a human's paste meets it: there `!#`
  // inserts the line typed so far, opening quote included, so `;touch M6;` runs outside quotes.
  it('the harness sees a line that does run code', () => {
    for (const mode of MODES) {
      expect(pasteIn(mode, 'witness x $(touch M1)'), mode).toEqual({ markers: ['M1'], calls: [['witness', 'x']] })
    }
    for (const mode of MODES.filter((m) => m.endsWith('-i'))) {
      expect(pasteIn(mode, 'witness x "!#;touch M6;\\"').markers, mode).toEqual(['M6'])
    }
  })

  it('each payload runs its code where it is meant to bite (row 239)', async () => {
    expect(BITES.map(([p]) => p)).toEqual([...PAYLOADS, ...REF_PAYLOADS])
    const zsh = MODES.some((m) => m.startsWith('zsh'))
    for (const [p, line, modes] of BITES) {
      // `${=IFS}` is zsh's form, which bash and dash refuse as a bad substitution: with no zsh
      // here it bites nowhere, and CI's Ubuntu has none.
      if (p.includes('${=IFS}') && !zsh) continue
      const marker = /M\d/.exec(p)![0]
      const fired: Mode[] = []
      for (const mode of modes) {
        if (pasteIn(mode, line(p)).markers.includes(marker)) fired.push(mode)
        await turn()
      }
      expect(fired, line(p)).not.toEqual([])
    }
  }, 120_000)

  // Built once per payload (a build may need a repo, which is async), then pasted alone into every mode.
  it.each(ROWS)('%s', async (_, build, payloads = PAYLOADS) => {
    for (const p of payloads) {
      const items = await build(p)
      for (const mode of MODES) for (const x of items) {
        const pasted = pasteIn(mode, x.line, x.cwd)
        await turn()
        expect(pasted.markers, `${mode}: ${x.line}`).toEqual([])
        if (x.calls !== undefined) expect(pasted.calls, `${mode}: ${x.line}`).toEqual(x.calls)
      }
    }
  }, 120_000)
})
