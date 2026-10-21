import { describe, expect, it } from 'vitest'
import { deltaView } from '../src/delta.js'
import { snapshotFiles, snapshotTree } from '../src/snapshot.js'
import { anchorFromKey, anchorKey, sectionText, type Reviewed } from '../src/verdict.js'
import { tmpRepo } from './helpers.js'

const CANON = ['specs', 'plans', 'designs', '.witness']
function based() {
  const repo = tmpRepo()
  for (const f of ['src/a.ts', 'src/b.ts', 'tests/t.ts', 'specs/s.md']) repo.write(f, `${f}\n`)
  repo.git('add', '-A'); repo.git('commit', '-m', 'base')
  return { repo, base: repo.git('rev-parse', 'HEAD') }
}
const doc = (s1: string, s2 = 'Stable.', detail = 'Kept.', steps = 's1') =>
  `---\nid: p\ntype: plan\nsteps: [${steps}]\n---\n\n## Step: s1\n${s1}\n\n## Step: s2\n${s2}\n\n### Detail\n${detail}\n`
const docs = (cur: string): Reviewed => ({ kind: 'docs', docs: [
  { id: 'p', body: cur.slice(cur.indexOf('## Step: s1')) }, { id: 'parent', body: '## Behavior\nRotate.\n' }] })

describe('code gates: a unit is a path', () => {
  it('is unchanged unless it or something under it moved, and canon is context', () => {
    const { repo, base } = based()
    repo.write('src/a.ts', 'a1\n'); const from = snapshotTree(repo.root, base, ['src/a.ts'])!
    repo.write('src/a.ts', 'a2\n'); const to = snapshotTree(repo.root, base, ['src/a.ts'])!
    const v = deltaView(repo.root, { kind: 'tree', root: repo.root, files: ['src/a.ts'], canonRoot: repo.root, canonDirs: CANON }, from, to)
    expect(v.state('src/a.ts#rotate')).toBe('changed')
    expect(v.state('src/b.ts')).toBe('unchanged')
    expect(v.state('tests/t.ts#case')).toBe('unchanged')
    expect(v.state({ kind: 'omission', scope: 'src/' })).toBe('changed')
    expect(v.state({ kind: 'omission', scope: 'tests' })).toBe('unchanged')
    expect(v.state({ kind: 'omission', scope: '.' })).toBe('changed')
    expect(v.state('specs/s.md')).toBe('context')
    expect(v.state('plans/p.md')).toBe('context')
  })
})

describe('doc gates: a unit is a section', () => {
  const view = (repo: ReturnType<typeof tmpRepo>, a: string, b: string) => deltaView(repo.root, docs(b),
    snapshotFiles(repo.root, [{ name: 'p.md', content: a }])!, snapshotFiles(repo.root, [{ name: 'p.md', content: b }])!)

  it('a section is unchanged while its text and the frontmatter are', () => {
    const { repo } = based()
    const v = view(repo, doc('Attempt 1.'), doc('Attempt 2.'))
    expect(v.state('p > ## Step: s1')).toBe('changed')
    expect(v.state('p > ## Step: s2')).toBe('unchanged')
    expect(v.state('p > ## Step: s2 > ### Detail')).toBe('unchanged')
    expect(v.state('## Step: s2')).toBe('unchanged')                       // unscoped: resolves in the plan only
    expect(v.state({ kind: 'omission', scope: 'p > ## Step: s2' })).toBe('unchanged')
    expect(v.state('p')).toBe('changed')                                     // a bare doc anchor is the whole doc
    expect(v.state('parent > ## Behavior')).toBe('context')                  // not in the snapshot
    expect(v.state('## Behavior')).toBe('context')
  })

  it('a subsection edit moves the section above it, and a frontmatter edit moves every section', () => {
    const { repo } = based()
    expect(view(repo, doc('A.'), doc('A.', 'Stable.', 'Changed.')).state('p > ## Step: s2')).toBe('changed')
    expect(view(repo, doc('A.'), doc('A.', 'Stable.', 'Changed.')).state('p > ## Step: s1')).toBe('unchanged')
    expect(view(repo, doc('A.'), doc('A.', 'Stable.', 'Kept.', 's1, s2')).state('p > ## Step: s1')).toBe('changed')
  })
})

describe('the design gate: the look is one unit', () => {
  it('every design# anchor shares the html, and the spec is context', () => {
    const { repo } = based()
    const html = (x: string) => snapshotFiles(repo.root, [{ name: 'design.html', content: `<main id="essentials">${x}</main>\n` }])!
    const reviewed: Reviewed = { kind: 'design', artifact: { ids: ['essentials'] }, spec: { id: 'booking-form', body: '## Behavior\nBook.\n' } }
    expect(deltaView(repo.root, reviewed, html('A'), html('A')).state('design#essentials')).toBe('unchanged')
    expect(deltaView(repo.root, reviewed, html('A'), html('B')).state('design#essentials')).toBe('changed')
    expect(deltaView(repo.root, reviewed, html('A'), html('B')).state({ kind: 'omission', scope: '.' })).toBe('changed')
    expect(deltaView(repo.root, reviewed, html('A'), html('B')).state('booking-form > ## Behavior')).toBe('context')
    expect(deltaView(repo.root, { kind: 'screens', captures: [] }, html('A'), html('B')).state('home.png')).toBe('context')
  })
})

describe('the verdict helpers', () => {
  it('sectionText stops at the next heading at its level or above, matching as resolveDocPath does', () => {
    const body = '## A\na\n### A1\na1\n## B\nb\n'
    expect(sectionText(body, ['## A'])).toBe('## A\na\n### A1\na1')
    expect(sectionText(body, ['## A', '### A1'])).toBe('### A1\na1')
    expect(sectionText(body, ['## B'])).toBe('## B\nb')
    expect(sectionText(body, ['##   A'])).toBe('## A\na\n### A1\na1')
    expect(sectionText(body, ['## C'])).toBeUndefined()
  })

  it('anchorKey and anchorFromKey round-trip an omission', () => {
    expect(anchorKey({ kind: 'omission', scope: 'tests/' })).toBe('omission:tests/')
    expect(anchorFromKey('omission:tests/')).toEqual({ kind: 'omission', scope: 'tests/' })
    expect(anchorFromKey('src/a.ts#x')).toBe('src/a.ts#x')
  })
})
