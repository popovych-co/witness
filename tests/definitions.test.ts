import { createHash } from 'node:crypto'
import { rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import {
  DEFAULT_DEFINITIONS, definitionEntry, definitionFor, defsHeld, effectTree, isIgnoreFile, restorable, restoredName,
  spliceMember, type Restored,
} from '../src/definitions.js'
import { planChangeSet } from '../src/change-set.js'
import { diffBase } from '../src/evidence.js'
import { snapshotTree } from '../src/snapshot.js'
import { shippableRepo, tmpRepo, unwrap, type TestRepo } from './helpers.js'

describe('checks.definitions entries (row 277)', () => {
  it('an entry without a slash matches the basename at any depth; with one, from the root (row 277)', () => {
    const e = (xs: string[]) => xs.map((x) => definitionEntry(x)!)
    expect(definitionFor(e(['tsconfig*.json']), 'packages/ui/tsconfig.base.json')?.glob).toBe('tsconfig*.json')
    expect(definitionFor(e(['.gitignore']), 'infra/.gitignore')?.glob).toBe('.gitignore')
    expect(definitionFor(e(['apps/web/biome.json']), 'biome.json')).toBeUndefined()
    expect(definitionFor(e(['apps/web/biome.json']), 'apps/web/biome.json')?.glob).toBe('apps/web/biome.json')
    expect(definitionFor(e(['tsconfig*.json']), 'src/tsconfig.ts')).toBeUndefined()
    expect(definitionFor(e(['package.json#scripts']), 'packages/a/package.json')).toEqual({ glob: 'package.json', member: 'scripts' })
    expect(definitionFor(e(['**/x.json']), 'a/b/x.json')?.glob).toBe('**/x.json')
    expect(isIgnoreFile('infra/.gitignore')).toBe(true)
    expect(isIgnoreFile('.prettierignore')).toBe(true)
    expect(isIgnoreFile('.editorconfig')).toBe(false)
  })

  it('the first matching entry wins (row 277)', () => {
    const e = ['package.json#scripts', 'package.json'].map((x) => definitionEntry(x)!)
    expect(definitionFor(e, 'package.json')).toEqual({ glob: 'package.json', member: 'scripts' })
  })

  it('the default list parses whole, 26 entries (row 277)', () => {
    expect(DEFAULT_DEFINITIONS).toHaveLength(26)
    expect(DEFAULT_DEFINITIONS.every((x) => definitionEntry(x) !== undefined)).toBe(true)
  })
})

const DEFAULTS = DEFAULT_DEFINITIONS.map((x) => definitionEntry(x)!)
const commitAll = (repo: TestRepo, m: string) => { repo.git('add', '-A'); repo.git('commit', '-q', '-m', m); return repo.git('rev-parse', 'HEAD') }
const blobAt = (repo: TestRepo, rev: string, path: string) => repo.git('rev-parse', `${rev}:${path}`)
const jsonId = (v: unknown) => `json:${createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)}`
// The plan's side is the working tree against `base`, as the gates read it.
const restoredOf = (repo: TestRepo, base: string, entries = DEFAULTS) => restorable(repo.root, repo.root, base, planChangeSet(repo.root, base), entries)
const PKG_BASE = '{\n  "name": "a",\n  "scripts": {\n    "lint": "biome check ."\n  },\n  "dependencies": { "x": "1" }\n}\n'

describe('the member splice (row 277)', () => {
  it("the base's member replaces the plan's; every other byte stays the plan's (row 277)", () => {
    const plan = '{\n  "name": "a",\n  "scripts": {\n    "lint": "true",\n    "x": "y"\n  },\n  "dependencies": { "x": "2" }\n}\n'
    expect(spliceMember(plan, PKG_BASE, 'scripts')).toBe(plan.replace('{\n    "lint": "true",\n    "x": "y"\n  }', '{\n    "lint": "biome check ."\n  }'))
    expect(spliceMember('{"a": "}{\\"", "scripts": {"b": "1"}}', '{"scripts": {"b": "2"}}', 'scripts')).toBe('{"a": "}{\\"", "scripts": {"b": "2"}}')
    expect(spliceMember('{"scripts": "x", "z": 1}', '{"scripts": ["a", {"b": "]"}]}', 'scripts')).toBe('{"scripts": ["a", {"b": "]"}], "z": 1}')
    expect(spliceMember('[1]', PKG_BASE, 'scripts')).toBeUndefined()
    expect(spliceMember('{"scripts": {', PKG_BASE, 'scripts')).toBeUndefined()
    expect(spliceMember('{"scripts": {}}', '{"name": "a"}', 'scripts')).toBeUndefined()
  })

  it("a member the plan's file lacks is inserted first, in the plan's own spacing (slice 1 review I3)", () => {
    const body = '{\n    "lint": "biome check ."\n  }'
    expect(spliceMember('{\n  "name": "a",\n  "dependencies": { "x": "2" }\n}\n', PKG_BASE, 'scripts'))
      .toBe(`{\n  "scripts": ${body},\n  "name": "a",\n  "dependencies": { "x": "2" }\n}\n`)
    expect(spliceMember('{"name": "a"}', PKG_BASE, 'scripts')).toBe(`{"scripts": ${body}, "name": "a"}`)
    expect(spliceMember('{ }', PKG_BASE, 'scripts')).toBe(`{"scripts": ${body} }`)
    for (const t of [spliceMember('{"name": "a"}', PKG_BASE, 'scripts')!, spliceMember('{ }', PKG_BASE, 'scripts')!]) {
      expect(JSON.parse(t).scripts).toEqual({ lint: 'biome check .' })
    }
  })
})

describe('what a plan restores (row 277)', () => {
  it("a modified .gitignore restores the base's copy (row 277)", () => {
    const repo = tmpRepo()
    repo.write('.gitignore', 'dist/\n'); repo.write('src/a.ts', 'a\n')
    const base = commitAll(repo, 'base')
    repo.write('.gitignore', 'dist/\nsrc/a.ts\n')
    expect(unwrap(restoredOf(repo, base))).toEqual([{ path: '.gitignore', how: 'base', held: blobAt(repo, base, '.gitignore') }])
  })

  it('an added tsconfig.json stays as the plan wrote it (Review Focus 1)', () => {
    const repo = tmpRepo()
    repo.write('src/a.ts', 'a\n')
    const base = commitAll(repo, 'base')
    repo.write('packages/x/tsconfig.json', '{}\n'); repo.write('packages/x/package.json', PKG_BASE)
    expect(unwrap(restoredOf(repo, base))).toEqual([])
  })

  it('a package.json whose scripts did not change is not restored (Review Focus 2)', () => {
    const repo = tmpRepo()
    repo.write('package.json', PKG_BASE)
    const base = commitAll(repo, 'base')
    repo.write('package.json', PKG_BASE.replace('"x": "1"', '"x": "2"'))
    expect(unwrap(restoredOf(repo, base))).toEqual([])
    repo.write('package.json', PKG_BASE.replace('biome check .', 'true'))
    expect(unwrap(restoredOf(repo, base))).toEqual([
      { path: 'package.json', how: 'member', member: 'scripts', held: jsonId({ lint: 'biome check .' }) },
    ])
    expect(restoredName(unwrap(restoredOf(repo, base))[0]!)).toBe('package.json#scripts')
    rmSync(join(repo.root, 'package.json'))
    expect(unwrap(restoredOf(repo, base))).toEqual([])
  })

  it('a deleted biome.json is restored; a deleted tsconfig.json whose folder the plan emptied is not (Review Focus 3)', () => {
    const repo = tmpRepo()
    repo.write('biome.json', '{}\n'); repo.write('packages/x/tsconfig.json', '{}\n'); repo.write('packages/x/src/a.ts', 'a\n')
    repo.write('packages/y/tsconfig.json', '{}\n'); repo.write('packages/y/src/b.ts', 'b\n'); repo.write('README.md', 'r\n')
    const base = commitAll(repo, 'base')
    rmSync(join(repo.root, 'biome.json')); rmSync(join(repo.root, 'packages/x'), { recursive: true })
    rmSync(join(repo.root, 'packages/y/tsconfig.json'))
    expect(unwrap(restoredOf(repo, base))).toEqual([
      { path: 'biome.json', how: 'base', held: blobAt(repo, base, 'biome.json') },
      { path: 'packages/y/tsconfig.json', how: 'base', held: blobAt(repo, base, 'packages/y/tsconfig.json') },
    ])
  })

  it('an added nested .gitignore is removed; a symlink or submodule at a definition path never is (row 277)', () => {
    const repo = tmpRepo()
    repo.write('src/a.ts', 'a\n'); repo.write('real.json', '{}\n')
    symlinkSync('real.json', join(repo.root, 'biome.json'))
    const base = commitAll(repo, 'base')
    repo.write('infra/.gitignore', 'secret.tf\n'); repo.write('infra/main.tf', 'x\n')
    rmSync(join(repo.root, 'biome.json')); repo.write('biome.json', '{"linter": {"enabled": false}}\n')
    symlinkSync('real.json', join(repo.root, 'tsconfig.json'))
    expect(unwrap(restoredOf(repo, base))).toEqual([{ path: 'infra/.gitignore', how: 'removed', held: null }])
  })

  it("a member file either side cannot read as a JSON object is restored whole, and never voids the others (slice 1 review I1)", () => {
    const repo = tmpRepo()
    repo.write('.gitignore', 'dist/\n'); repo.write('tests/fixtures/bad/package.json', PKG_BASE)
    repo.write('package.json', `\uFEFF${PKG_BASE}`); repo.write('tsconfig.json', '{\n  // strict\n  "compilerOptions": { "strict": true }\n}\n')
    const base = commitAll(repo, 'base')
    repo.write('.gitignore', 'dist/\nsrc/a.ts\n'); repo.write('tests/fixtures/bad/package.json', '{ "scripts": ')
    repo.write('package.json', `\uFEFF${PKG_BASE.replace('biome check .', 'true')}`)
    repo.write('tsconfig.json', '{\n  // loose\n  "compilerOptions": { "strict": false }\n}\n')
    const entries = ['.gitignore', 'package.json#scripts', 'tsconfig.json#compilerOptions'].map((x) => definitionEntry(x)!)
    expect(unwrap(restoredOf(repo, base, entries))).toEqual([
      { path: '.gitignore', how: 'base', held: blobAt(repo, base, '.gitignore') },
      { path: 'package.json', how: 'base', held: blobAt(repo, base, 'package.json') },
      { path: 'tests/fixtures/bad/package.json', how: 'base', held: blobAt(repo, base, 'tests/fixtures/bad/package.json') },
      { path: 'tsconfig.json', how: 'base', held: blobAt(repo, base, 'tsconfig.json') },
    ])
  })

  it("a symlink the plan puts over a base definition restores the base's file (slice 1 review I2)", () => {
    const repo = tmpRepo()
    repo.write('.gitignore', 'dist/\n'); repo.write('package.json', PKG_BASE); repo.write('loose/ignore', '*\n'); repo.write('loose/package.json', '{}\n')
    const base = commitAll(repo, 'base')
    rmSync(join(repo.root, '.gitignore')); symlinkSync('loose/ignore', join(repo.root, '.gitignore'))
    rmSync(join(repo.root, 'package.json')); symlinkSync('loose/package.json', join(repo.root, 'package.json'))
    expect(unwrap(restoredOf(repo, base))).toEqual([
      { path: '.gitignore', how: 'base', held: blobAt(repo, base, '.gitignore') },
      { path: 'package.json', how: 'base', held: blobAt(repo, base, 'package.json') },
    ])
  })

  it("a member the plan deleted is restored, and a deleted member file whose folder stays tracked comes back whole (slice 1 review I3)", () => {
    const repo = tmpRepo()
    repo.write('package.json', PKG_BASE); repo.write('packages/x/package.json', PKG_BASE); repo.write('packages/x/src/a.ts', 'a\n')
    repo.write('packages/y/package.json', PKG_BASE); repo.write('packages/y/src/b.ts', 'b\n')
    const base = commitAll(repo, 'base')
    repo.write('package.json', '{\n  "name": "a",\n  "dependencies": { "x": "1" }\n}\n')
    rmSync(join(repo.root, 'packages/x/package.json')); rmSync(join(repo.root, 'packages/y'), { recursive: true })
    const restored = unwrap(restoredOf(repo, base))
    expect(restored).toEqual([
      { path: 'package.json', how: 'member', member: 'scripts', held: jsonId({ lint: 'biome check .' }) },
      { path: 'packages/x/package.json', how: 'base', held: blobAt(repo, base, 'packages/x/package.json') },
    ])
    const files = planChangeSet(repo.root, base)
    const tree = unwrap(effectTree(repo.root, base, snapshotTree(repo.root, base, files)!, restored))
    expect(JSON.parse(repo.git('cat-file', 'blob', `${tree}:package.json`))).toEqual({ scripts: { lint: 'biome check .' }, name: 'a', dependencies: { x: '1' } })
  })

  it('a path no entry names is never restored, and [] restores nothing (row 277)', () => {
    const repo = tmpRepo()
    repo.write('.gitignore', 'dist/\n'); repo.write('vitest.setup.ts', 'a\n')
    const base = commitAll(repo, 'base')
    repo.write('.gitignore', 'x\n'); repo.write('vitest.setup.ts', 'b\n')
    expect(unwrap(restoredOf(repo, base, []))).toEqual([])
    expect(unwrap(restoredOf(repo, base)).map(restoredName)).toEqual(['.gitignore'])
  })
})

describe('the effect tree (row 277)', () => {
  const effectRepo = () => {
    const repo = tmpRepo()
    repo.write('.gitignore', 'dist/\n'); repo.write('package.json', PKG_BASE); repo.write('src/a.ts', 'a\n')
    const base = commitAll(repo, 'base')
    repo.write('.gitignore', 'dist/\nsrc/a.ts\n')
    repo.write('package.json', PKG_BASE.replace('biome check .', 'true').replace('"x": "1"', '"x": "2"'))
    repo.write('infra/.gitignore', 'secret.tf\n'); repo.write('infra/main.tf', 'x\n'); repo.write('src/b.ts', 'b\n')
    const files = planChangeSet(repo.root, base)
    const planTree = snapshotTree(repo.root, base, files)!
    const restored = unwrap(restorable(repo.root, repo.root, base, files, DEFAULTS))
    return { repo, base, planTree, restored }
  }

  it("the effect tree is the plan's tree with each restored path folded in, nothing else moved (row 277)", () => {
    const { repo, base, planTree, restored } = effectRepo()
    expect(restored.map(restoredName)).toEqual(['.gitignore', 'infra/.gitignore', 'package.json#scripts'])
    const tree = unwrap(effectTree(repo.root, base, planTree, restored))
    const ls = (t: string) => repo.git('ls-tree', '-r', t)
    const planLines = ls(planTree).split('\n').filter((l) => !/\t(\.gitignore|package\.json|infra\/\.gitignore)$/.test(l))
    const effectLines = ls(tree).split('\n').filter((l) => !/\t(\.gitignore|package\.json)$/.test(l))
    expect(effectLines).toEqual(planLines)
    expect(repo.git('rev-parse', `${tree}:.gitignore`)).toBe(blobAt(repo, base, '.gitignore'))
    expect(ls(tree)).not.toContain('infra/.gitignore')
    expect(repo.git('cat-file', 'blob', `${tree}:package.json`) + '\n').toBe(PKG_BASE.replace('"x": "1"', '"x": "2"'))
  })

  it('defsHeld reads every base side back, and false once one differs (row 277)', () => {
    const { repo, base, planTree, restored } = effectRepo()
    const defs = Object.fromEntries(restored.map((r: Restored) => [restoredName(r), r.held]))
    const tree = unwrap(effectTree(repo.root, base, planTree, restored))
    expect(defsHeld(repo.root, tree, defs)).toBe(true)
    expect(defsHeld(repo.root, planTree, defs)).toBe(false)
    for (const name of Object.keys(defs)) expect(defsHeld(repo.root, planTree, { [name]: defs[name]! }), name).toBe(false)
    expect(defsHeld(repo.root, tree, { ...defs, 'infra/main.tf': null })).toBe(false)
    expect(defsHeld(repo.root, 'f'.repeat(40), defs)).toBeUndefined()
  })

  it('a fixture plan changes no definition its base holds (settled point 9)', async () => {
    const { repo, wt } = await shippableRepo()
    const base = unwrap(diffBase(wt, unwrap(loadConfig(repo.root))))
    expect(unwrap(restorable(repo.root, wt, base, planChangeSet(wt, base), DEFAULTS))).toEqual([])
  })
})
