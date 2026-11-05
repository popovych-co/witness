import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonGuard } from '../plugin/hooks/canon-guard.mjs'
import { actOn } from '../src/act.js'
import { grantRows } from '../src/allowlist.js'
import { handoffLine, loadHarness } from '../src/harness.js'
import { offeredLine, quotedWord, shellArg, shellLine, shellWord, shellWords, withheldOn } from '../src/toon.js'
import { CORPUS } from './shells.js'

// PowerShell's reading of one word, after its tokenizer: a word opening with any of its five
// single quotes is a string running to the next one, where two together are one literal quote;
// any other word is bare. `undefined` when the string closes before the word ends, or never.
const PS_QUOTE = /['\u2018\u2019\u201a\u201b]/
function psRead(word: string): string | undefined {
  if (!PS_QUOTE.test(word[0] ?? '')) return word
  let read = ''
  for (let i = 1; i < word.length; i++) {
    if (!PS_QUOTE.test(word[i]!)) { read += word[i]; continue }
    if (!PS_QUOTE.test(word[i + 1] ?? '')) return i === word.length - 1 ? read : undefined
    read += word[++i]
  }
  return undefined
}

const withheld = (chars: string): string =>
  `not offered on Windows \u2014 it holds ${chars}, which cmd.exe or Windows PowerShell can read as more than text`

describe('one quoter for every pasted word (row 239)', () => {
  it("a POSIX word is bare in shellArg's set, never when it starts with = (row 239)", () => {
    expect(shellWord('auth-refresh-plan-1', 'darwin')).toBe('auth-refresh-plan-1')
    expect(shellWord('--approve', 'linux')).toBe('--approve')
    expect(shellWord('a=b', 'darwin')).toBe('a=b')
    expect(shellWord('=ls', 'darwin')).toBe("'=ls'")
    expect(shellArg('=ls')).toBe("'=ls'")
    expect(shellWord('', 'darwin')).toBe("''")
    expect(shellWord("it's", 'darwin')).toBe(`'it'\\''s'`)
  })

  it("a Windows word is psArg's, and a flag stays bare", () => {
    for (const flag of ['--revise', '-LiteralPath', '-u']) expect(shellWord(flag, 'win32')).toBe(flag)
    expect(shellWord('--', 'win32')).toBe("'--'")
    expect(shellWord('-a.b', 'win32')).toBe("'-a.b'")
    expect(shellWord('--%', 'win32')).toBe("'--%'")
    expect(shellWord('a,b', 'win32')).toBe("'a,b'")
    expect(shellWord('@x', 'win32')).toBe("'@x'")
    expect(shellWord('C:\\w\\repo', 'win32')).toBe('C:\\w\\repo')
    expect(shellWord("o'b\u2019c", 'win32')).toBe("'o''b\u2019\u2019c'")
  })

  it("a quoted Windows word reads back exact under PowerShell's single-quote rule", () => {
    for (const w of CORPUS) expect(psRead(shellWord(w, 'win32')), JSON.stringify(w)).toBe(w)
  })

  it('a quoted POSIX word reads back exact through shellWords', () => {
    for (const w of CORPUS) expect(shellWords(shellLine(['witness', w], 'darwin')), JSON.stringify(w)).toEqual(['witness', w])
  })

  it('quotedWord quotes every word, as the handoff prints its path and /witness', () => {
    expect(quotedWord('/w/repo', 'darwin')).toBe("'/w/repo'")
    expect(quotedWord("/o'b", 'darwin')).toBe(`'/o'\\''b'`)
    expect(quotedWord('C:\\w', 'win32')).toBe("'C:\\w'")
    expect(quotedWord("C:\\o'b", 'win32')).toBe("'C:\\o''b'")
  })

  it('withheldOn names what cmd.exe or Windows PowerShell read, on Windows only', () => {
    expect(withheldOn(['trust', 'p1', '--cmd', 'npm test && npm run lint'], 'win32')).toBe(withheld('&'))
    expect(withheldOn(['a"b%c'], 'win32')).toBe(withheld('" %'))
    for (const c of ['&', '|', '^', '<', '>', '"', '%', '!']) expect(withheldOn([c], 'win32'), c).toBe(withheld(c))
    // named in the set's order, not the order the words hold them
    expect(withheldOn(['100%', 'a&b'], 'win32')).toBe(withheld('& %'))
    expect(withheldOn(['x&y'], 'darwin')).toBeUndefined()
    expect(withheldOn(['plain words'], 'win32')).toBeUndefined()
  })

  it('offeredLine is shellLine unless Windows withholds it', () => {
    expect(offeredLine(['git', 'push', '-u', 'origin', 'main'], 'darwin')).toBe('git push -u origin main')
    expect(offeredLine(['git', 'push', '-u', 'origin', 'main'], 'win32')).toBe('git push -u origin main')
    expect(offeredLine(['git', 'checkout', '--', 'd&x.html'], 'win32')).toBeUndefined()
  })

  // Row 239 (the plan's B4, B5). Each kind of line a foreign word reaches, built for Windows around
  // each character cmd.exe or Windows PowerShell reads: a trust grant's command, a restore remedy's
  // path, a push remedy's branch and the canon guard's path are shown and never offered. The
  // handoff's path is a cmdlet's argument, which PowerShell alone reads: quoted, never withheld.
  it('on Windows every kind a foreign word reaches withholds a risky one (row 239)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'quote-guard-'))
    try {
      writeFileSync(join(repo, 'witness.config.yaml'), 'schema: 1\n')
      const claude = loadHarness('claude-code')
      if (!claude.ok) throw new Error('claude-code')
      for (const c of ['&', '|', '^', '<', '>', '"', '%', '!']) {
        expect(actOn('win32', ['trust', 'p1', '--cmd', `x${c}y`]).withheld, c).toBeDefined()
        expect(grantRows('p1', { cmd: `x${c}y` }, 'win32').filter((r) => r.includes('--cmd')), c).toEqual([])
        expect(offeredLine(['git', 'checkout', '--', `d${c}.html`], 'win32'), c).toBeUndefined()
        expect(offeredLine(['git', 'push', '-u', 'origin', `b${c}`], 'win32'), c).toBeUndefined()
        const guard = canonGuard({ tool: 'Write', input: { file_path: join(repo, 'specs', `a${c}b.md`) }, cwd: repo, platform: 'win32' })
        expect(guard?.block, c).toBe(true)
        expect(guard?.reason, c).not.toContain('run: witness adopt')
        expect(guard?.reason, c).toContain(`witness adopt ${shellWord(`specs/a${c}b.md`, 'win32')} \u2014 ${withheld(c)}`)
        expect(handoffLine(claude.value, `C:\\a${c}b`, undefined, 'win32'), c)
          .toBe(`Set-Location -LiteralPath 'C:\\a${c}b' -ErrorAction Stop; claude '/witness'`)
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("shellWords reads the quoter's grammar and a human's typing, and refuses an open quote", () => {
    expect(shellWords(`witness decide plan p1 --revise --note "don't ship"`))
      .toEqual(['witness', 'decide', 'plan', 'p1', '--revise', '--note', "don't ship"])
    expect(shellWords("a 'b'\\''c' d")).toEqual(['a', "b'c", 'd'])
    expect(shellWords('a "x\\"y" \\$z')).toEqual(['a', 'x"y', '$z'])
    expect(shellWords('  a   b  ')).toEqual(['a', 'b'])
    expect(shellWords('a "" b')).toEqual(['a', '', 'b'])
    expect(shellWords('$(touch M1)')).toEqual(['$(touch', 'M1)'])
    expect(shellWords("a 'open")).toBeUndefined()
    expect(shellWords('a\\')).toBeUndefined()
    // a tab ends a word; a backslash is literal in '…', and in "…" before any other character
    expect(shellWords('a\tb')).toEqual(['a', 'b'])
    expect(shellWords(`'c\\d' "a\\b"`)).toEqual(['c\\d', 'a\\b'])
    expect(shellWords('a "open')).toBeUndefined()
  })
})
