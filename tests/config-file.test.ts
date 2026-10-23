import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { canonGuard } from '../plugin/hooks/canon-guard.mjs'
import { contextLimitOf } from '../plugin/hooks/context-core.mjs'
import { readComments, renderConfig } from '../src/config-file.js'
import { migrateValues } from '../src/migration.js'
import { defaultValues, withValues } from '../src/settings.js'

// Row 193 §4.5. The file `init` writes and `migrate` rewrites, and who owns which comment.
const fixture = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', 'configs', name), 'utf8')
const defaults = () => defaultValues({ harness: 'claude-code' })
const memoryValues = (name: string) => {
  const m = migrateValues(parse(fixture(name)) as Record<string, unknown>, 1, { mode: 'memory' })
  if (!m.ok) throw new Error(JSON.stringify(m.violations))
  return m.value.raw
}
const humanLines = (h: ReturnType<typeof readComments>['human']) => [...h.top, ...[...h.above.values()].flat(), ...h.end]

describe('renderConfig (row 193 §4.5)', () => {
  it('renders the defaults as spec §4.5', async () => {
    // The snapshot is the spec's block: review any difference against §4.5, not against the code.
    await expect(renderConfig(defaults())).toMatchFileSnapshot('../fixtures/configs/default.yaml')
  })

  it('round-trips values', () => {
    expect(parse(renderConfig(defaults()))).toEqual(defaults())
    const a = withValues(defaults(), memoryValues('consumer-a.yaml'))
    expect(parse(renderConfig(a))).toEqual(a)
    const listBattery = withValues(defaults(), { gates: { implement: { reviewers: ['code-reviewer'] } }, autonomy: 'on' })
    expect(parse(renderConfig(listBattery))).toEqual(listBattery)
  })

  it('stays readable by the hook readers', () => {
    expect(contextLimitOf(renderConfig(withValues(defaults(), { session: { contextLimit: 35 } })))).toBe(35)
    const repo = mkdtempSync(join(tmpdir(), 'rendered-'))
    writeFileSync(join(repo, 'witness.config.yaml'),
      renderConfig(withValues(defaults(), { paths: { specs: 'docs/specs', plans: 'docs/plans', designs: 'docs/designs' } })))
    mkdirSync(join(repo, 'docs', 'specs'), { recursive: true })
    mkdirSync(join(repo, 'specs'), { recursive: true })
    expect(canonGuard({ tool: 'Edit', input: { file_path: join(repo, 'docs', 'specs', 'x.md') }, cwd: repo })?.block).toBe(true)
    expect(canonGuard({ tool: 'Edit', input: { file_path: join(repo, 'specs', 'x.md') }, cwd: repo })).toBeUndefined()
  })

  it('puts no comment on a section line', () => {
    const text = renderConfig(withValues(defaults(), memoryValues('consumer-a.yaml')))
    const sections = text.split('\n').filter((l) => /^\s*[a-zA-Z]+:\s*(#|$)/.test(l))
    expect(sections.length).toBeGreaterThan(8)
    for (const l of sections) expect(l).not.toContain('#')
  })
})

describe('readComments (row 193 §4.5 ownership)', () => {
  it('drops every line the 0.20.0 template wrote', () => {
    const r = readComments(fixture('init-0.20.0.yaml'))
    expect(humanLines(r.human)).toEqual([])
    expect(r.legacy).toBeGreaterThan(0)
  })

  it('drops the old inheritance advice and keeps edited copies', () => {
    const advice = '# any gate block may pin its own model (wins over the global pin), e.g.'
    const b = readComments(fixture('consumer-b.yaml'))
    expect(humanLines(b.human).map((l) => l.trim())).not.toContain(advice)
    expect(b.legacy).toBe(2)   // the advice and its example line; the first line is replaced, not dropped
    const edited = readComments(fixture('consumer-b.yaml').replace(advice, advice.replace('global', 'shared')))
    expect(edited.human.above.get('gates.decompose')).toContain(advice.replace('global', 'shared'))
    expect(edited.legacy).toBe(1)
  })

  it('files human comments by setting', () => {
    const { human } = readComments(fixture('consumer-a.yaml'))
    expect(human.above.get('docs.design')?.[0]).toMatch(/^# example prose standing in/)
    expect(human.above.get('gates.reviewerTimeoutMs')?.[0]).toMatch(/^# example prose about the pin/)
    expect(human.above.get('autonomy')?.[0]).toMatch(/^# example prose: who decides/)
    expect(human.above.get('ship')?.[0]).toMatch(/^# example prose: lint runs/)
    expect(human.top).toEqual([])
    expect(human.above.has('gates.model')).toBe(false)
  })

  it('moves a human comment at the end of a setting line above it', () => {
    const { human } = readComments('schema: 2\nsession:\n  contextLimit: 30   # the team\'s choice\n')
    expect(human.above.get('session.contextLimit')).toEqual(["# the team's choice"])
  })

  it('keeps comments at a map end, between deeper settings and at file end', () => {
    const text = [
      '# above everything, a human note',
      'schema: 2',
      'session:',
      '  contextLimit: 20',
      '  # at the end of session\'s map',
      'drive:',
      '  caps:',
      '    rounds: 16',
      '        # deeper than its neighbours',
      '    upstream: 6',
      '# at the end of the file',
      '',
    ].join('\n')
    const { human } = readComments(text)
    expect(human.top).toEqual(['# above everything, a human note'])
    expect(human.above.get('drive')).toEqual(["# at the end of session's map"])
    expect(human.above.get('drive.caps.upstream')).toEqual(['# deeper than its neighbours'])
    expect(human.end).toEqual(['# at the end of the file'])
    const out = renderConfig(defaults(), human)
    for (const l of humanLines(human)) expect(out).toContain(l)
    expect(out).toMatch(/\n {4}# deeper than its neighbours\n {4}upstream: 6 /)
    expect(out.split('\n')[1]).toBe('# above everything, a human note')
    expect(out.trimEnd().split('\n').at(-1)).toBe('# at the end of the file')
  })
})
