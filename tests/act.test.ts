import { describe, expect, it } from 'vitest'
import { actOn, cliAct, exitsLine, runRow } from '../src/act.js'

// Rows 139/203. A command the CLI offers is an act: the words after `witness` as given, the
// words a human fills, and the line the text has always printed.
describe('cliAct (rows 139/203)', () => {
  it('prints the line the CLI always printed', () => {
    expect(cliAct('decide', 'plan', 'p1', '--revise', '--note', '2 blocking findings: a "b", c').line)
      .toBe(`witness decide plan p1 --revise --note '2 blocking findings: a "b", c'`)
    expect(cliAct('decide', 'plan', 'p1', '--revise', '--upstream', '<effort>').line)
      .toBe('witness decide plan p1 --revise --upstream <effort>')
    expect(cliAct('trust', 'p1', '--cmd', "echo 'hi'").line).toBe(`witness trust p1 --cmd 'echo '\\''hi'\\'''`)
    expect(cliAct('gate', 'plan', 'p1', '--fresh').line).toBe('witness gate plan p1 --fresh')
  })
  it("names the words a human fills, by position, and only the CLI's own placeholders", () => {
    expect(cliAct('decide', 'plan', 'p1', '--revise', '--note', '<why>').inputs).toEqual([{ name: 'why', at: 5 }])
    expect(cliAct('decide', 'plan', 'p1', '--revise', '--upstream', '<effort>').inputs).toEqual([{ name: 'effort', at: 5 }])
    expect(cliAct('decide', 'plan', 'p1', '--revise', '--note', '1 blocking finding: <why> in <SaveBar>').inputs).toEqual([])
  })
  it('a placeholder is an input only in its own slot, so a command that reads like one stays literal', () => {
    const grant = cliAct('trust', 'p1', '--cmd', '<why>')
    expect(grant.inputs).toEqual([])
    expect(grant.line).toBe("witness trust p1 --cmd '<why>'")
    expect(cliAct('trust', 'p1', '--cmd', '<effort>').inputs).toEqual([])
    const crossed = [cliAct('decide', 'plan', 'p1', '--revise', '--upstream', '<why>'), cliAct('decide', 'plan', 'p1', '--revise', '--note', '<effort>')]
    expect(crossed.map((a) => a.inputs)).toEqual([[], []])
    expect(crossed.map((a) => a.line))
      .toEqual(["witness decide plan p1 --revise --upstream '<why>'", "witness decide plan p1 --revise --note '<effort>'"])
  })
  it("every word but the CLI's own slots prints through the quoter", () => {
    expect(cliAct('decide', 'plan', 'über plan', '--show').line).toBe("witness decide plan 'über plan' --show")
    expect(cliAct('satisfy', 'Auth Refresh', '--need', 'prod access').line).toBe("witness satisfy 'Auth Refresh' --need 'prod access'")
    expect(cliAct('satisfy', 'auth-refresh', '--need', '').line).toBe("witness satisfy auth-refresh --need ''")
    expect(cliAct('trust', 'Auth Refresh', '--cmd', 'npm test').line).toBe("witness trust 'Auth Refresh' --cmd 'npm test'")
  })
  it('keeps every word as given, so it runs without a shell', () => {
    expect(cliAct('trust', 'p1', '--cmd', "echo 'hi' | wc").argv).toEqual(['trust', 'p1', '--cmd', "echo 'hi' | wc"])
  })
})

// Row 239. An act prints for the shell its platform pastes into: PowerShell on Windows.
describe('actOn (row 239)', () => {
  it("a Windows act prints psArg words and keeps witness's own bare (row 239)", () => {
    expect(actOn('win32', ['trust', 'p1', '--cmd', "echo 'hi'"]).line).toBe("witness trust p1 --cmd 'echo ''hi'''")
    expect(actOn('win32', ['decide', 'plan', 'p1', '--revise', '--note', '<why>']).line)
      .toBe('witness decide plan p1 --revise --note "<why>"')
  })
  it('on Windows an act whose word holds a risky character is withheld, and only there (row 239)', () => {
    for (const c of ['&', '|', '^', '<', '>', '"', '%', '!']) {
      expect(actOn('win32', ['trust', 'p1', '--cmd', `a${c}b`]).withheld, c).toBeDefined()
      expect(Object.keys(actOn('darwin', ['trust', 'p1', '--cmd', `a${c}b`])), c).not.toContain('withheld')
    }
    expect(actOn('win32', ['decide', 'plan', 'p1', '--revise', '--note', '<why>']).withheld).toBeUndefined()
  })
  // Ruling R22: a quote-like reads differently in PowerShell and Git Bash, so Windows withholds it.
  // Ruling R24: a line break would split the line, so every platform withholds it, and the line
  // shows it spelled. Either way the argv runs as given.
  it('on Windows a quote-like is withheld, and everywhere a line break is (row 239, rulings R22, R24)', () => {
    const quoted = actOn('win32', ['trust', 'p1', '--cmd', "echo 'hi'"])
    expect(quoted.withheld).toBe("not offered on Windows — it holds ', which PowerShell and Git Bash read differently")
    expect(Object.keys(actOn('darwin', ['trust', 'p1', '--cmd', "echo 'hi'"]))).not.toContain('withheld')
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const a = actOn(platform, ['satisfy', 'p1', '--need', 'a\nb'])
      expect(a.line, platform).toBe("witness satisfy p1 --need 'a\\nb'")
      expect(a.withheld, platform).toBe('not offered — it holds a control or line-break character, which would split the line')
      expect(a.argv, platform).toEqual(['satisfy', 'p1', '--need', 'a\nb'])
      expect(runRow(a), platform).toBe(`  note: witness satisfy p1 --need 'a\\nb' — ${a.withheld}`)
    }
  })
})

describe('exitsLine', () => {
  it("lets consecutive decide acts share the first one's prefix", () => {
    const d = (...rest: string[]) => cliAct('decide', 'plan', 'p1', ...rest)
    expect(exitsLine([cliAct('gate', 'plan', 'p1'), d('--revise', '--note', '<why>'), d('--stop')]))
      .toBe('witness gate plan p1 | witness decide plan p1 --revise --note "<why>" | --stop')
    expect(exitsLine([d('--approve', '--override'), d('--stop'), cliAct('abandon', 'p1')]))
      .toBe('witness decide plan p1 --approve --override | --stop | witness abandon p1')
  })
  it('never prints an empty segment for a decide act with nothing past its target', () => {
    expect(exitsLine([cliAct('decide', 'plan', 'p1', '--stop'), cliAct('decide', 'plan', 'p1')]))
      .toBe('witness decide plan p1 --stop | witness decide plan p1')
  })
})
