import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import * as core from '../plugin/hooks/context-core.mjs'
import { configCandidates, contextLimitOf, invokesWitness, readingJson, warnLine } from '../plugin/hooks/context-core.mjs'
import { resolveSession } from '../src/config.js'
import * as cli from '../src/context.js'

// Row 191 §4.6. The adapters read the limit with a plain reader (the core imports nothing, so
// both harnesses can load it), and the CLI with its YAML resolver. One config must mean one
// limit in both, so every shape is checked against the resolver itself: a value the CLI refuses
// is no limit at all to the adapter, which then stays silent.
const SHAPES = [
  'schema: 1\n',
  'schema: 1\nsession:\n  contextLimit: 15\n',
  'schema: 1\nsession: { contextLimit: 15 }\n',
  'schema: 1\nsession:\n  contextLimit: 15   # percent\n',
  'schema: 1\nsession:\n  contextLimit: 0\n',
  'schema: 1\nsession:\n  contextLimit: 150\n',
  'schema: 1\nsession:\n  contextLimit: abc\n',
  'schema: 1\nimplement:\n  contextLimit: 9\n',
  'schema: 1\nsession:\n',
  'schema: 1\nsession: 20\n',
  'schema: 1\nsession: [1]\n',
  'schema: 1\nsession:\n  contextLimit: 15\n  bogus: 1\n',
  'schema: 1\nsession: {}\n',
  'schema: 1\nsession: { contextLimit: 15, bogus: 1 }\n',
  'schema: 1\nsession:\n  nested:\n    contextLimit: 5\n',
  'schema: 1\nsession:\n  contextLimit: 15.0\n',
  'schema: 1\nsession:\n  contextLimit: "15"\n',
]

describe('the adapter core (row 191 §4.1, §4.6)', () => {
  it.each(SHAPES)('agrees with the CLI resolver on every config shape: %j', (text) => {
    const cli = resolveSession(parseYaml(text) as Record<string, unknown>)
    expect(contextLimitOf(text)).toBe(cli.ok ? cli.value.contextLimit : undefined)
  })

  it('lists config candidates nearest first', () => {
    expect(configCandidates('/a/b/c')).toEqual(['/a/b/c/witness.config.yaml', '/a/b/witness.config.yaml', '/a/witness.config.yaml', '/witness.config.yaml'])
    expect(configCandidates('C:\\a\\b')).toEqual(['C:\\a\\b\\witness.config.yaml', 'C:\\a\\witness.config.yaml', 'C:\\witness.config.yaml'])
    expect(configCandidates('/')).toEqual(['/witness.config.yaml'])
  })

  it.each([
    ['$WITNESS next', true], ['${WITNESS} next', true], ['witness next', true],
    ['npx -y @popovych.co/witness@0.19.4 test-evidence p --phase red --step s1', true],
    ['WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.19.4}"; $WITNESS next', true],
    ['"$WITNESS" gate implement p1', true], ['cd .witness/worktrees/p1 && witness next', true],
    ['cd ~/x/personal/witness && git status', false], ['grep -rn "witness test" src', false], ['ls', false],
    ['$WITNESS_BIN next', false],
  ])('invokesWitness(%j) is %s', (cmd, want) => expect(invokesWitness(cmd)).toBe(want))

  it('renders the reading and the warning', () => {
    expect(JSON.parse(readingJson('S', 31627, 1000000, 3))).toEqual({ session: 'S', tokens: 31627, window: 1000000, percent: 3 })
    expect(JSON.parse(readingJson('S', undefined, 1000000, undefined))).toEqual({ session: 'S', window: 1000000 })
    expect(JSON.parse(readingJson('S', null, 1000000, null))).toEqual({ session: 'S', tokens: null, window: 1000000, percent: null })
    expect(warnLine(210000, 1000000, 20)).toBe('witness: context 21% of 1M has reached the 20% limit — finish what you are in (implement: the red→green), then hand over')
    expect(warnLine(200000, 1000000, 20)).toBe('witness: context 20% of 1M has reached the 20% limit — finish what you are in (implement: the red→green), then hand over')
    expect(warnLine(190000, 1000000, 20)).toBeUndefined()
    expect(warnLine(undefined, 1000000, 20)).toBeUndefined()
    expect(warnLine(0, 1000000, 1)).toBeUndefined()
  })

  // The CLI keeps its own two-line arithmetic (it must not import plugin/ at runtime), so the
  // duplicate is pinned to it here, the windows that round across a unit included.
  it.each([
    [196000, 1000000], [31627, 200000], [6020, 100000],
    [50000, 1048576], [50000, 131072], [50000, 1500000], [50000, 999_999], [500, 999],
  ])('matches the CLI arithmetic for %i/%i', (t, w) => {
    expect(core.pctOf(t, w)).toBe(cli.pctOf(t, w))
    expect(core.windowLabel(w)).toBe(cli.windowLabel(w))
  })
})
