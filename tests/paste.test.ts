import { describe, expect, it } from 'vitest'
import { shellLine } from '../src/toon.js'
import { MODES, PAYLOADS, type Pasteable, pasteIn } from './shells.js'

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

  // Built once per payload (a build may need a repo, which is async), then pasted alone into every mode.
  it.each(ROWS)('%s', async (_, build, payloads = PAYLOADS) => {
    for (const p of payloads) {
      const items = await build(p)
      for (const mode of MODES) for (const x of items) {
        const pasted = pasteIn(mode, x.line, x.cwd)
        expect(pasted.markers, `${mode}: ${x.line}`).toEqual([])
        if (x.calls !== undefined) expect(pasted.calls, `${mode}: ${x.line}`).toEqual(x.calls)
      }
    }
  }, 120_000)
})
