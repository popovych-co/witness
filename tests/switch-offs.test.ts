// Row 273 (§4 T3, C25, C27). The switch-off token layer: each token where its tool reads it — a
// directive where it opens a comment, a code token never on a comment line, the test API only in test
// files — and the copies of each switch-off line a plan adds beyond its base's.
import { rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isTestPath, lineSwitchOffs, planSwitchOffs, switchOffKey } from '../src/switch-offs.js'
import { tmpRepo, type TestRepo } from './helpers.js'

// The base reads planSwitchOffs makes, counted (tmpRepo runs git itself, uncounted).
const gitBlobs = vi.hoisted(() => ({ n: 0 }))
vi.mock('../src/gitio.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/gitio.js')>()
  return { ...real, gitBlob: (...a: Parameters<typeof real.gitBlob>) => { gitBlobs.n += 1; return real.gitBlob(...a) } }
})

// A repo whose base commit holds `files`; the change is made after it, uncommitted.
function based(files: Record<string, string>): { repo: TestRepo; root: string; base: string } {
  const repo = tmpRepo()
  for (const [rel, body] of Object.entries(files)) repo.write(rel, body)
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'base')
  return { repo, root: repo.root, base: repo.git('rev-parse', 'HEAD') }
}

const tokens = (file: string, line: string, extra: string[] = []) => lineSwitchOffs(file, line, extra).map((h) => h.token)

describe('the switch-off tokens (row 273, C25)', () => {
  it.each([
    ['src/a.ts', '// eslint-disable-next-line no-console', ['eslint-disable-next-line']],
    ['src/a.ts', '/* eslint-disable */', ['eslint-disable']],
    ['src/a.ts', 'x() // eslint-disable-line', ['eslint-disable-line']],
    ['src/a.ts', '/* eslint no-console: "off" */', ['eslint-config']],
    ['src/a.ts', '// @ts-expect-error a type test', ['@ts-expect-error']],
    ['src/a.ts', '/** @ts-ignore */', ['@ts-ignore']],
    ['src/a.ts', '/// @ts-nocheck', ['@ts-nocheck']],
    ['src/a.tsx', '{/* biome-ignore lint/a11y/useAltText: decorative */}', ['biome-ignore']],
    ['src/a.ts', '// biome-ignore-all lint: generated', ['biome-ignore-all']],
    ['src/a.ts', '// Stryker disable next-line all', ['Stryker disable']],
    ['tests/a.test.ts', "it.skip('x', () => {})", ['.skip(']],
    ['src/a.spec.ts', "describe.only('x', () => {})", ['.only(']],
    ['e2e/a.ts', "test.fails('x', f)", ['.fails(']],
    ['tests/a.test.ts', "it.skip.each([1])('x', f)", ['.skip(']],
    ['tests/a.test.ts', "it('x', (ctx) => { ctx.skip() })", ['.skip(']],
    ['tests/a.test.ts', "xit('x', f)", ['xit(']],
    ['tests/a.test.ts', "xtest('x', f)", ['xtest(']],
    ['pkg/__tests__/a.js', "xdescribe('x', f)", ['xdescribe(']],
    ['tests/a.test.ts', "it('x', { retry: 3 }, f)", ['retry:']],
    ['tests/a.test.ts', "test('x', { fails: true }, f)", ['fails: true']],
    ['tests/a.test.ts', "test('x', { skip: true }, f)", ['skip: true']],
    ['src/lib.rs', '#[allow(clippy::too_many_arguments)]', ['#[allow(']],
    ['src/lib.rs', '#![allow(dead_code)]', ['#![allow(']],
    ['src/lib.rs', '#[expect(unused)]', ['#[expect(']],
    ['src/lib.rs', '#[cfg_attr(test, allow(unused))]', ['cfg_attr allow']],
    ['src/lib.rs', '#[ignore = "slow"]', ['#[ignore]']],
    ['src/lib.rs', '#[mutants::skip]', ['mutants::skip']],
    ['a.py', 'x = 1  # noqa: E501', ['noqa']],
    ['a.py', 'y = f()  # type: ignore[attr-defined]', ['type: ignore']],
    ['a.py', '# pylint: disable=invalid-name', ['pylint: disable']],
    ['a.go', 'f() //nolint:errcheck', ['nolint']],
  ])('%s: %s is a switch-off', (file, line, want) => {
    expect(tokens(file, line)).toEqual(want)
  })

  it.each([
    ['src/a.ts', 'process.exit(1)'],                       // §4 T3's acceptance
    ['src/a.ts', 'retry: false,'],                         // fewhats' react-query option (probe)
    ['src/a.ts', "it.skip('x', () => {})"],                // the test API outside a test file
    ['tests/a.test.ts', '{ fails: "unreachable" }'],       // fewhats' fixture key (probe)
    ['tests/a.test.ts', "retry: cliAct('retry', t)"],      // witness's object key (probe)
    ['tests/a.test.ts', '// while this test fails: x'],    // prose
    ['src/a.ts', '// see the eslint-disable docs'],        // prose naming a directive
    ['tests/a.test.ts', "it.skipIf(win)('x', f)"],
    ['tests/a.test.ts', "// it.skip('x')"],               // a code token on a comment line
    ['src/lib.rs', '// #[allow(dead_code)]'],
    ['src/a.ts', '#[allow(x)]'],                           // another language's token
    ['README.md', '// eslint-disable'],                    // no language: no built-in applies
  ])('%s: %s is not', (file, line) => {
    expect(tokens(file, line)).toEqual([])
  })

  it('reads the rule ids a directive names (row 273)', () => {
    const rules = (file: string, line: string) => lineSwitchOffs(file, line, [])[0]!.rules
    expect(rules('src/a.ts', '// eslint-disable-next-line no-console, @typescript-eslint/no-explicit-any -- why')).toEqual(['@typescript-eslint/no-explicit-any', 'no-console'])
    expect(rules('src/a.ts', '// biome-ignore lint/suspicious/noExplicitAny: legacy')).toEqual(['lint/suspicious/noExplicitAny'])
    expect(rules('src/lib.rs', '#[allow(clippy::too_many_arguments, dead_code)]')).toEqual(['clippy::too_many_arguments', 'dead_code'])
    expect(rules('a.py', 'x = 1  # noqa: E501,W291')).toEqual(['E501', 'W291'])
    expect(rules('a.go', 'f() //nolint:errcheck,gosec // why')).toEqual(['errcheck', 'gosec'])
    expect(rules('src/a.ts', '// @ts-ignore')).toEqual([])
  })

  it("the repo's own tokens match in any text file, never glued to an identifier (C25)", () => {
    expect(tokens('src/a.ts', '/* istanbul ignore next */', ['istanbul ignore'])).toEqual(['extra:istanbul ignore'])
    expect(tokens('docs/a.md', 'c8 ignore next', ['c8 ignore'])).toEqual(['extra:c8 ignore'])
    expect(tokens('src/a.ts', 'skipTests = 1', ['skipTest'])).toEqual([])
    expect(tokens('src/a.ts', 'preskipTest()', ['skipTest'])).toEqual([])
  })

  it('a test file is named so, or lives in a test folder', () => {
    expect(['a.test.ts', 'src/a.spec.tsx', 'tests/helpers.ts', 'apps/web/e2e/support/harness.ts', 'pkg/__tests__/x.js', 'spec/x.rb'].every(isTestPath)).toBe(true)
    expect(['src/a.ts', 'src/testing.ts', 'src/latest/a.ts', 'specs/x.md'].some(isTestPath)).toBe(false)
  })
})

describe('the switch-offs a plan adds (row 273, C27)', () => {
  it("counts the copies beyond the base's: a line the base holds is not the plan's, a new file counts whole", () => {
    const { repo, root, base } = based({ 'src/a.ts': '// @ts-ignore\nconst a = 1\n' })
    repo.write('src/a.ts', '// @ts-ignore\nconst a = 1\n// eslint-disable-next-line no-console\nconsole.log(a)\n')
    repo.write('tests/b.test.ts', "it.only('x', () => {})\n")
    const offs = planSwitchOffs(root, base, ['src/a.ts', 'tests/b.test.ts'], [])
    expect(offs.map((o) => [o.file, o.line, o.token, o.test])).toEqual([
      ['src/a.ts', 3, 'eslint-disable-next-line', false], ['tests/b.test.ts', 1, '.only(', true]])
    expect(offs[0]).toMatchObject({ snippet: '// eslint-disable-next-line no-console', rules: ['no-console'] })
  })

  it('a moved or re-indented line is not new; a duplicated one is, the last copy (C27)', () => {
    const { repo, root, base } = based({ 'src/a.ts': 'a()\n// @ts-ignore\nb()\n' })
    repo.write('src/a.ts', '// @ts-ignore\r\na()\nb()\n')                       // moved, CRLF: the same key
    expect(planSwitchOffs(root, base, ['src/a.ts'], [])).toEqual([])
    repo.write('src/a.ts', 'a()\n  // @ts-ignore\nb()\n\t// @ts-ignore\n')     // re-indented, then a copy
    expect(planSwitchOffs(root, base, ['src/a.ts'], []).map((o) => o.line)).toEqual([4])
  })

  it("a key names its token, file and normalized line (Review Focus 2)", () => {
    const k = (token: string, file: string, snippet: string) => switchOffKey({ token, file, snippet })
    expect(k('@ts-ignore', 'src/a.ts', '// @ts-ignore')).toMatch(/^[0-9a-f]{16}$/)
    expect(k('@ts-ignore', 'src/a.ts', '// @ts-ignore')).not.toBe(k('@ts-ignore', 'src/b.ts', '// @ts-ignore'))
    expect(k('@ts-ignore', 'src/a.ts', '// @ts-ignore')).not.toBe(k('extra:@ts-ignore', 'src/a.ts', '// @ts-ignore'))
  })

  it('a deleted file, a binary file and a symlink add none; a file holding no token costs no git call', () => {
    const { repo, root, base } = based({ 'src/gone.ts': '// @ts-ignore\n', 'held.ts': '// @ts-ignore\n', 'src/a.ts': 'a()\n' })
    rmSync(join(root, 'src/gone.ts'))
    repo.write('bin.dat', '\0\n// @ts-ignore\n')
    symlinkSync(join(root, 'held.ts'), join(root, 'src/link.ts'))
    expect(planSwitchOffs(root, base, ['src/gone.ts', 'bin.dat', 'src/link.ts'], [])).toEqual([])
    repo.write('src/a.ts', 'b()\n'); repo.write('src/c.ts', 'c()\n')
    gitBlobs.n = 0
    expect(planSwitchOffs(root, base, ['src/a.ts', 'src/c.ts'], [])).toEqual([])
    expect(gitBlobs.n).toBe(0)
  })
})
