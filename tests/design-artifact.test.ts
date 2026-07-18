import { describe, expect, it } from 'vitest'
import {
  designPairSha, designRel, elementIds, htmlSha, validateDesignArtifact,
} from '../src/design.js'
import type { CanonDoc } from '../src/scan.js'

const doc = (meta: Record<string, unknown>, body = '## Motivation\nm\n\n## Behavior\nb\n'): CanonDoc =>
  ({ rel: `specs/${meta.id}.md`, meta, body, violations: [] })

const OK_HTML =
  '<!doctype html><html><body><section id="hero"><h1>Book</h1></section>' +
  '<section id="save-bar"><button>Save</button></section></body></html>'

describe('elementIds', () => {
  it('extracts id attributes in order, single and double quoted', () => {
    expect(elementIds('<a id="one"></a><b id=\'two\'></b>')).toEqual(['one', 'two'])
  })
})

describe('validateDesignArtifact', () => {
  it('passes a self-contained doc with >=2 unique ids', () => {
    expect(validateDesignArtifact(OK_HTML)).toEqual([])
  })

  it('flags fewer than two id-attributed sections', () => {
    const v = validateDesignArtifact('<!doctype html><body><section id="only"></section></body>')
    expect(v.some((x) => x.rule === 'template')).toBe(true)
  })

  it('flags duplicate ids', () => {
    const v = validateDesignArtifact('<!doctype html><body><i id="x"></i><i id="x"></i></body>')
    expect(v.some((x) => x.rule === 'duplicate-id')).toBe(true)
  })

  it('flags external resource references', () => {
    const script = '<!doctype html><body><section id="a"></section><section id="b"></section>' +
      '<script src="https://cdn.example/x.js"></script></body>'
    expect(validateDesignArtifact(script).some((x) => x.rule === 'external-ref')).toBe(true)
    const css = '<!doctype html><body><section id="a"></section><section id="b"></section>' +
      '<link rel="stylesheet" href="https://cdn.example/x.css"></body>'
    expect(validateDesignArtifact(css).some((x) => x.rule === 'external-ref')).toBe(true)
    const font = '<!doctype html><body><style>@font-face{src:url(//cdn/x.woff)}</style>' +
      '<section id="a"></section><section id="b"></section></body>'
    expect(validateDesignArtifact(font).some((x) => x.rule === 'external-ref')).toBe(true)
  })

  it('allows data: URIs and local/# references', () => {
    const html = '<!doctype html><body><img id="logo" src="data:image/png;base64,AAAA">' +
      '<a id="cta" href="#book">Book</a></body>'
    expect(validateDesignArtifact(html)).toEqual([])
  })

  it('flags a non-HTML blob', () => {
    expect(validateDesignArtifact('id="a" id="b" just text').some((x) => x.rule === 'not-html')).toBe(true)
  })
})

describe('htmlSha / designPairSha / designRel', () => {
  it('htmlSha ignores trailing whitespace only', () => {
    expect(htmlSha(OK_HTML)).toBe(htmlSha(OK_HTML + '\n\n'))
    expect(htmlSha(OK_HTML)).not.toBe(htmlSha(OK_HTML.replace('Book', 'Reserve')))
  })

  it('designPairSha changes when either side changes', () => {
    const s = doc({ id: 'auth-refresh', type: 'spec', status: 'approved' })
    const s2 = doc({ id: 'auth-refresh', type: 'spec', status: 'approved' }, '## Motivation\nm2\n\n## Behavior\nb\n')
    expect(designPairSha(OK_HTML, s)).not.toBe(designPairSha(OK_HTML.replace('Book', 'Go'), s))
    expect(designPairSha(OK_HTML, s)).not.toBe(designPairSha(OK_HTML, s2))
  })

  it('designRel honors the configured designs dir', () => {
    expect(designRel({ specs: 'specs', plans: 'plans', designs: 'designs' }, 'auth-refresh'))
      .toBe('designs/auth-refresh.html')
  })
})
