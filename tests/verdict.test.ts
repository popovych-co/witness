import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { anchorMenu, parseVerdict, resolveAnchor, verdictViolations, type Reviewed } from '../src/verdict.js'

const SPEC_DOCS: Reviewed = {
  kind: 'docs',
  docs: [
    { id: 'auth-refresh', body: '## Motivation\nwhy\n## Behavior\ntokens rotate\n' },
    { id: 'auth-mfa', body: '## Motivation\nwhy\n## Behavior\nmfa required\n' },
  ],
}

function tree(): Reviewed {
  const root = mkdtempSync(join(tmpdir(), 'verdict-tree-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/token.ts'), 'export function rotateToken() {}\n')
  writeFileSync(join(root, 'src/quota.ts'), 'export function quota() {}\n')
  return { kind: 'tree', root, files: ['src/token.ts', 'src/quota.ts'] }
}

describe('parseVerdict', () => {
  it('refuses missing coverage and malformed findings', () => {
    expect(parseVerdict({ findings: [] }).ok).toBe(false)
    expect(parseVerdict({ coverage: [], findings: [{ anchor: '## X' }] }).ok).toBe(false)
    const good = parseVerdict({
      coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }],
      findings: [{ blocking: true, anchor: 'auth-refresh > ## Behavior', claim: 'no expiry bound' }],
    })
    expect(good.ok).toBe(true)
  })
})

describe('doc anchors', () => {
  it('resolves scoped heading paths and rejects missing ones', () => {
    expect(resolveAnchor('auth-refresh > ## Behavior', SPEC_DOCS)).toBeUndefined()
    expect(resolveAnchor('auth-refresh > ## Rollback', SPEC_DOCS)).toContain('no heading')
    expect(resolveAnchor('no-such-doc > ## Behavior', SPEC_DOCS)).toContain('no reviewed doc')
  })
})

describe('code anchors', () => {
  it('resolves files and symbols, refuses line numbers', () => {
    const t = tree()
    expect(resolveAnchor('src/token.ts', t)).toBeUndefined()
    expect(resolveAnchor('src/token.ts#rotateToken', t)).toBeUndefined()
    expect(resolveAnchor('src/token.ts#noSuchSymbol', t)).toContain('symbol')
    expect(resolveAnchor('src/token.ts:42', t)).toContain('line numbers')
    expect(resolveAnchor('../etc/passwd', t)).toContain('escapes')
  })
})

describe('verdictViolations — fail-closed', () => {
  it('one unresolvable finding anchor poisons the whole verdict', () => {
    const verdict = {
      coverage: [
        { anchor: 'auth-refresh > ## Behavior', note: 'read' },
        { anchor: 'auth-mfa > ## Behavior', note: 'read' },
      ],
      findings: [
        { blocking: false, anchor: 'auth-refresh > ## Motivation', claim: 'fine' },
        { blocking: true, anchor: 'auth-refresh > ## Nowhere', claim: 'ghost' },
      ],
    }
    const violations = verdictViolations(verdict, SPEC_DOCS)
    expect(violations.length).toBe(1)
    expect(violations[0].rule).toBe('anchor-unresolvable')
    expect(violations[0].field).toBe('findings[1].anchor')
  })

  it('a clean verdict must cover every reviewed doc, with scoped anchors', () => {
    const clean = { coverage: [{ anchor: '## Behavior', note: 'read' }], findings: [] }
    const rules = verdictViolations(clean, SPEC_DOCS).map((x) => x.rule)
    expect(rules).toContain('coverage-unscoped')
    expect(rules).toContain('coverage-minimum')

    const full = {
      coverage: [
        { anchor: 'auth-refresh > ## Behavior', note: 'read' },
        { anchor: 'auth-mfa > ## Behavior', note: 'read' },
      ],
      findings: [],
    }
    expect(verdictViolations(full, SPEC_DOCS)).toEqual([])
  })

  it('tree coverage needs min(5, changed) distinct changed files; omissions resolve scopes', () => {
    const t = tree()
    const short = {
      coverage: [{ anchor: 'src/token.ts', note: 'read' }],
      findings: [{ blocking: true, anchor: { kind: 'omission' as const, scope: '.' }, claim: 'no timeout anywhere' }],
    }
    expect(verdictViolations(short, t).map((x) => x.rule)).toContain('coverage-minimum')
    const full = {
      coverage: [
        { anchor: 'src/token.ts', note: 'read' },
        { anchor: 'src/quota.ts', note: 'read' },
      ],
      findings: [{ blocking: true, anchor: { kind: 'omission' as const, scope: 'src' }, claim: 'no timeout' }],
    }
    expect(verdictViolations(full, t)).toEqual([])
    const bogus = {
      coverage: full.coverage,
      findings: [{ blocking: true, anchor: { kind: 'omission' as const, scope: 'no/such/dir' }, claim: 'x' }],
    }
    expect(verdictViolations(bogus, t).map((x) => x.rule)).toContain('anchor-unresolvable')
  })
})

describe('anchorMenu', () => {
  it('lists doc ids and doc-scoped headings; every listed line resolves verbatim', () => {
    const reviewed: Reviewed = {
      kind: 'docs',
      docs: [
        { id: 'alpha', body: '## One\ntext\n### Two deep\n' },
        { id: 'beta', body: 'no headings at all' },
      ],
    }
    const menu = anchorMenu(reviewed)
    expect(menu).toContain('## Valid anchors')
    expect(menu).toContain('- alpha')
    expect(menu).toContain('- alpha > ## One')
    expect(menu).toContain('- alpha > ### Two deep')
    expect(menu).toContain('- beta')
    for (const line of menu.split('\n').filter((l) => l.startsWith('- '))) {
      expect(resolveAnchor(line.slice(2), reviewed)).toBeUndefined()
    }
  })

  it('is empty for tree reviews', () => {
    expect(anchorMenu({ kind: 'tree', root: '/', files: [] })).toBe('')
  })
})

const SCREENS: Reviewed = {
  kind: 'screens',
  captures: [{ name: 'initial.png', path: '/w/initial.png' }, { name: 'error.png', path: '/w/error.png' }],
}

describe('screens reviewed-kind', () => {
  it('anchorMenu lists capture names', () => {
    const menu = anchorMenu(SCREENS)
    expect(menu).toContain('## Valid anchors')
    expect(menu).toContain('- initial.png')
    expect(menu).toContain('- error.png')
  })

  it('resolveAnchor accepts a capture name and an omission over one; rejects strangers', () => {
    expect(resolveAnchor('initial.png', SCREENS)).toBeUndefined()
    expect(resolveAnchor({ kind: 'omission', scope: 'error.png' }, SCREENS)).toBeUndefined()
    expect(resolveAnchor('nope.png', SCREENS)).toContain('no reviewed capture')
    expect(resolveAnchor({ kind: 'omission', scope: 'ghost.png' }, SCREENS)).toContain('no reviewed capture')
  })

  it('verdictViolations demands one coverage anchor per capture', () => {
    const under = parseVerdict({ coverage: [{ anchor: 'initial.png', note: 'seen' }], findings: [] })
    expect(under.ok).toBe(true)
    const vs = verdictViolations(under.ok ? under.value : (undefined as never), SCREENS)
    expect(vs.some((x) => x.rule === 'coverage-minimum' && x.want.includes('error.png'))).toBe(true)

    const full = parseVerdict({
      coverage: [{ anchor: 'initial.png', note: 'seen' }, { anchor: 'error.png', note: 'seen' }],
      findings: [{ blocking: true, anchor: 'initial.png', claim: 'primary action below the fold' }],
    })
    expect(full.ok).toBe(true)
    expect(verdictViolations(full.ok ? full.value : (undefined as never), SCREENS)).toEqual([])
  })
})
