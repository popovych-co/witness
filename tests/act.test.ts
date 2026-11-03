import { describe, expect, it } from 'vitest'
import { cliAct, exitsLine } from '../src/act.js'

// Rows 139/203. A command the CLI offers is an act: the words after `witness` as given, the
// words a human fills, and the line the text has always printed.
describe('cliAct (rows 139/203)', () => {
  it('prints the line the CLI always printed', () => {
    expect(cliAct('decide', 'plan', 'p1', '--revise', '--note', '2 blocking findings: a "b", c').line)
      .toBe('witness decide plan p1 --revise --note "2 blocking findings: a "b", c"')
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
      .toEqual(["witness decide plan p1 --revise --upstream '<why>'", 'witness decide plan p1 --revise --note "<effort>"'])
  })
  it('keeps every word as given, so it runs without a shell', () => {
    expect(cliAct('trust', 'p1', '--cmd', "echo 'hi' | wc").argv).toEqual(['trust', 'p1', '--cmd', "echo 'hi' | wc"])
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
