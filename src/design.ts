import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonPaths } from './config.js'
import { latestRecap, readStream, type Entry } from './journal.js'
import { v, type Violation } from './refusal.js'
import { effortOf } from './reviewed.js'
import type { CanonDoc } from './scan.js'
import { canonicalSha } from './sha.js'
import { cmd, logSafe, rows } from './toon.js'

// What `--outline` and the critic's anchor menu call an id. `lookControls` reads the same
// matches, so a control's anchor is always one the outline lists.
const ID_ATTR = /\bid\s*=\s*["']([^"']+)["']/g

export function elementIds(html: string): string[] {
  const ids: string[] = []
  const re = new RegExp(ID_ATTR.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) ids.push(m[1]!.trim())
  return ids
}

// Row 215. A look's controls: the states its markup holds that one picture of the page cannot
// show — a select's options, a closed details, dialog, popover or menu, a hidden element. A
// LISTER, never a slicer (row 132 still refuses a section extractor): every regex, indexOf or
// prefix scanner tried here silently dropped or invented rows, and several were quadratic (P3),
// so this is one forward pass to tokens, then indices built in one pass each, then rows. It
// never throws, and runs in time linear in the source.
export type ControlKind = 'select' | 'details' | 'dialog' | 'popover' | 'menu' | 'listbox' | 'tooltip'
  | 'tabpanel' | 'alertdialog' | 'collapsed' | 'hidden' | 'template'
export type LookControl = { anchor: string; line: number; kind: ControlKind; holds: string }
export const CONTROLS_NOTE = 'from markup only — states a CSS class or a script draws, :hover and :focus styles, and content past a scrolling pane are not listed; read the source for those'

type Attr = { v: string; quoted: boolean }
type Open = { t: 'open'; name: string; attrs: Map<string, Attr>; start: number; end: number; self: boolean }
type Tok = Open | { t: 'close'; name: string; start: number } | { t: 'text'; start: number; end: number }

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'])
// The raw-text bodies a browser shows: each is one text run. The others emit nothing.
const SHOWN_RAW = new Set(['textarea', 'title', 'xmp'])
// The HTML spec's breakout tags: any of them inside an svg or math left open is HTML again.
const BREAKOUT = new Set(['b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em',
  'embed', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr', 'ol',
  'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var'])
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
// Elements a browser lays out as their own box: their tags separate words as a `br` does, so
// `<div>Step 1</div><div>Open</div>` reads "Step 1 Open" — inline tags (`<b>reject</b>?`) join.
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'td', 'th', 'tr', 'ul'])
const ROLES = new Set(['menu', 'listbox', 'tooltip', 'tabpanel', 'alertdialog', 'dialog'])
const NEVER = new Set(['option', 'optgroup', 'summary'])
const GATHER = 240                                                            // code points of text read per element
const HOLDS_MAX = 120

const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
const isWs = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d
// Only ASCII is lowercased: `toLowerCase` on the source turns `İ` into two code units and shifts
// every offset after it (P3).
const lowerAscii = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase())

// Does `src` hold `name` (ASCII-case-insensitively) at `at`, followed by whitespace, `/` or `>`?
function nameAt(src: string, at: number, name: string): boolean {
  if (lowerAscii(src.slice(at, at + name.length)) !== name) return false
  const c = src.charCodeAt(at + name.length)
  return isWs(c) || c === 47 || c === 62
}

// D7.1–7.2: one forward pass by index over the original string. A template's body runs through
// the same pass with its output suppressed, so its comments, raw text and quotes still count.
function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  const n = src.length
  let i = 0
  let textStart = 0
  let foreign = 0                                                             // svg/math depth
  let inert = 0                                                               // open templates; >0 suppresses
  let foreignAtTemplate = 0
  const emit = (tk: Tok): void => { if (inert === 0) toks.push(tk) }
  const flush = (end: number): void => { if (end > textStart) emit({ t: 'text', start: textStart, end }) }
  // Forward cursors for a comment's two closers: each remembers its last hit and searches again
  // only once the scan has passed it, so neither ever rescans the source.
  let arrow = -2
  let bang = -2
  const nextArrow = (from: number): number => {
    if (arrow !== -1 && arrow < from) arrow = src.indexOf('-->', from)
    return arrow
  }
  const nextBang = (from: number): number => {
    if (bang !== -1 && bang < from) bang = src.indexOf('--!>', from)
    return bang
  }
  // The first `</name` + whitespace, `/` or `>` at or after `from`, else the end. The pass
  // resumes there, so what this reads is never read again.
  const rawEnd = (from: number, name: string): number => {
    for (let p = src.indexOf('</', from); p !== -1; p = src.indexOf('</', p + 2)) if (nameAt(src, p + 2, name)) return p
    return n
  }
  const nameEnd = (from: number): number => {
    let j = from
    while (j < n) { const c = src.charCodeAt(j); if (isWs(c) || c === 47 || c === 62) break; j++ }
    return j
  }

  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt === -1) break
    const c1 = src.charCodeAt(lt + 1)
    if (src.startsWith('<!--', lt)) {
      flush(lt)
      let end: number
      if (src.charCodeAt(lt + 4) === 62) end = lt + 5                          // <!-->
      else if (src.startsWith('->', lt + 4)) end = lt + 6                       // <!--->
      else {
        const a = nextArrow(lt + 4)
        const b = nextBang(lt + 4)
        end = Math.min(a === -1 ? n : a + 3, b === -1 ? n : b + 4)
      }
      i = textStart = end
      continue
    }
    if (c1 === 33 || c1 === 63) {                                               // <! or <?: a bogus comment
      flush(lt)
      const g = src.indexOf('>', lt + 2)
      i = textStart = g === -1 ? n : g + 1
      continue
    }
    if (c1 === 47 && isLetter(src.charCodeAt(lt + 2))) {                        // a close tag
      flush(lt)
      const j = nameEnd(lt + 2)
      const name = lowerAscii(src.slice(lt + 2, j))
      // A template's balanced close ends its suppressed body, and is itself emitted.
      if (name === 'template' && inert > 0 && --inert === 0) foreign = foreignAtTemplate
      emit({ t: 'close', name, start: lt })
      if ((name === 'svg' || name === 'math') && foreign > 0) foreign--
      const g = src.indexOf('>', j)
      i = textStart = g === -1 ? n : g + 1
      continue
    }
    if (!isLetter(c1)) { i = lt + 1; continue }                                // `<` is text
    // An open tag: its name, then its attributes. A quote opens a value only after `=`.
    flush(lt)
    let j = nameEnd(lt + 1)
    const name = lowerAscii(src.slice(lt + 1, j))
    const attrs = new Map<string, Attr>()
    let slash = false
    let closed = false
    while (j < n) {
      const c = src.charCodeAt(j)
      if (isWs(c)) { j++; continue }
      if (c === 62) { j++; closed = true; break }
      if (c === 47) {
        if (src.charCodeAt(j + 1) === 62) { j += 2; slash = true; closed = true; break }
        j++
        continue
      }
      const ns = j++
      while (j < n) { const d = src.charCodeAt(j); if (isWs(d) || d === 47 || d === 62 || d === 61) break; j++ }
      const aname = lowerAscii(src.slice(ns, j))
      let k = j
      while (k < n && isWs(src.charCodeAt(k))) k++
      let attr: Attr = { v: '', quoted: false }
      if (src.charCodeAt(k) === 61) {
        k++
        while (k < n && isWs(src.charCodeAt(k))) k++
        const q = src.charCodeAt(k)
        if (q === 34 || q === 39) {
          const e = src.indexOf(q === 34 ? '"' : "'", k + 1)
          if (e === -1) { j = n; break }                                        // a quote that never closes
          attr = { v: src.slice(k + 1, e), quoted: true }
          j = e + 1
        } else {
          let e = k
          while (e < n) { const d = src.charCodeAt(e); if (isWs(d) || d === 62) break; e++ }
          attr = { v: src.slice(k, e), quoted: false }
          j = e
        }
      }
      if (!attrs.has(aname)) attrs.set(aname, attr)
    }
    // A tag the source ends inside is one broken tag: no token, and no more tokens after it.
    if (!closed) { i = textStart = n; break }
    if (foreign > 0 && BREAKOUT.has(name)) foreign = 0
    // `/>` closes only a foreign element; on an HTML one a browser ignores it.
    const self = slash && (foreign > 0 || name === 'svg' || name === 'math')
    emit({ t: 'open', name, attrs, start: lt, end: j, self })
    i = textStart = j
    if (self) continue
    if (name === 'svg' || name === 'math') foreign++
    else if (name === 'template') { if (inert++ === 0) foreignAtTemplate = foreign }
    else if (foreign > 0 && name !== 'script') continue
    else if (name === 'plaintext') { i = n; break }                             // the rest is one text run
    else if (RAW_TEXT.has(name)) {
      const e = rawEnd(j, name)
      if (SHOWN_RAW.has(name) && e > j) emit({ t: 'text', start: j, end: e })
      i = textStart = e
    }
  }
  flush(n)
  return toks
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
// One pass: `&amp;lt;` is `&lt;`, never `<`.
const decode = (s: string): string => s.replace(/&(amp|lt|gt|quot|apos|nbsp);|&#(\d+);|&#[xX]([0-9a-fA-F]+);/g,
  (_m, named: string | undefined, dec: string | undefined, hex: string | undefined) => {
    if (named !== undefined) return ENTITY[named]!
    const cp = dec !== undefined ? Number(dec) : Number.parseInt(hex!, 16)
    return cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || !(cp <= 0x10ffff) ? '\u{fffd}' : String.fromCodePoint(cp)
  })
// Decoded, then whitespace collapsed and trimmed: what a `holds` candidate says.
const clean = (raw: string): string => decode(raw).replace(/\s+/g, ' ').trim()
// D7.4's last two steps: spelled out, then cut to 120 code points, ending `…` on any cut.
function finish(said: string, truncated: boolean): string {
  const safe = logSafe(said)
  const cps = Array.from(safe)
  return truncated || cps.length > HOLDS_MAX ? cps.slice(0, HOLDS_MAX - 1).join('') + '…' : safe
}
// The first `max` code points of src[from, to), how many there were, and whether that cut it.
function head(src: string, from: number, to: number, max: number): [string, number, boolean] {
  let at = from
  let count = 0
  while (at < to && count < max) { at += src.codePointAt(at)! > 0xffff ? 2 : 1; count++ }
  return [src.slice(from, Math.min(at, to)), count, at < to]
}
const styleHides = (style: string): boolean => {
  let css = ''
  let from = 0
  for (let o = style.indexOf('/*'); o !== -1; o = style.indexOf('/*', from)) {
    css += style.slice(from, o)
    const e = style.indexOf('*/', o + 2)
    from = e === -1 ? style.length : e + 2
  }
  if (from < style.length) css += style.slice(from)
  return /(?<![\w-])display\s*:\s*none(?![\w-])/i.test(css) || /(?<![\w-])visibility\s*:\s*hidden(?![\w-])/i.test(css)
}

export function lookControls(html: string): LookControl[] {
  const toks = tokenize(html)
  const n = toks.length
  const blank = new Uint8Array(n)
  toks.forEach((tk, p) => { if (tk.t === 'text' && /^\s*$/.test(html.slice(tk.start, tk.end))) blank[p] = 1 })

  // D7.3, each index in one pass. Element ends: each open tag's matching close, by per-name
  // stacks; a void or self-closed element has none, an unmatched one ends at the source's end.
  const endOf = new Int32Array(n).fill(n)
  const stacks = new Map<string, number[]>()
  toks.forEach((tk, p) => {
    if (tk.t === 'open') {
      if (VOID.has(tk.name) || tk.self) endOf[p] = p
      else { const s = stacks.get(tk.name); if (s) s.push(p); else stacks.set(tk.name, [p]) }
    } else if (tk.t === 'close') {
      const open = stacks.get(tk.name)?.pop()
      if (open !== undefined) endOf[open] = p
    }
  })
  // The text chain: the next text run, `br` or block tag after each token.
  const chain = new Int32Array(n).fill(-1)
  for (let p = n - 1, next = -1; p >= 0; p--) {
    chain[p] = next
    const tk = toks[p]!
    if (tk.t === 'text' || BLOCK.has(tk.name)) next = p
  }
  // Ids: each quoted id to its first open tag (aria-labelledby's targets).
  const byId = new Map<string, number>()
  toks.forEach((tk, p) => {
    const id = tk.t === 'open' ? tk.attrs.get('id') : undefined
    if (id?.quoted && !byId.has(id.v.trim())) byId.set(id.v.trim(), p)
  })
  // Line anchors: the `--outline`'s ids, per line as it reads them, at their source offsets.
  const nl: number[] = []
  for (let o = html.indexOf('\n'); o !== -1; o = html.indexOf('\n', o + 1)) nl.push(o)
  const hits: Array<{ at: number; line: number; id: string }> = []
  for (let l = 0, from = 0; l <= nl.length; l++) {
    const to = l < nl.length ? nl[l]! : html.length
    const re = new RegExp(ID_ATTR.source, 'g')
    const text = html.slice(from, to)
    for (let m = re.exec(text); m !== null; m = re.exec(text)) hits.push({ at: from + m.index, line: l + 1, id: m[1]!.trim() })
    from = to + 1
  }

  // D7.4. An element's text: the chain from its open tag to its end, text runs as written, a
  // whitespace-only run, a `br` or a block tag one space, every other tag nothing; at most 240
  // code points.
  const textOf = (k: number): { raw: string; truncated: boolean } => {
    let raw = ''
    let count = 0
    let spaced = false
    for (let p = chain[k]!, end = endOf[k]!; p !== -1 && p < end; p = chain[p]!) {
      if (count >= GATHER) return { raw, truncated: true }
      const tk = toks[p]!
      if (tk.t !== 'text' || blank[p] === 1) {                                   // one space, collapsed as it goes
        if (!spaced) raw += ' '
        spaced = true
        count++
        continue
      }
      const [h, c, cut] = head(html, tk.start, tk.end, GATHER - count)
      raw += h
      count += c
      spaced = false
      if (cut) return { raw, truncated: true }
    }
    return { raw, truncated: false }
  }
  const attr = (tk: Open, a: string): string => tk.attrs.get(a)?.v ?? ''
  // D7.6: aria-label, aria-labelledby's elements, title, the element's own text, <name>.<class>.
  const named = (tk: Open, k: number): string => {
    const label = clean(attr(tk, 'aria-label'))
    if (label !== '') return finish(label, false)
    let by = ''
    let byCut = false
    for (const id of attr(tk, 'aria-labelledby').split(/\s+/)) {
      const at = id === '' ? undefined : byId.get(id)
      if (at === undefined) continue
      if ([...by].length >= GATHER) { byCut = true; break }
      const t = textOf(at)
      by += ' ' + t.raw
      byCut ||= t.truncated
    }
    if (clean(by) !== '') return finish(clean(by), byCut)
    const title = clean(attr(tk, 'title'))
    if (title !== '') return finish(title, false)
    const own = textOf(k)
    if (clean(own.raw) !== '') return finish(clean(own.raw), own.truncated)
    const cls = clean(attr(tk, 'class')).split(' ')[0]!
    return finish(cls !== '' ? `${tk.name}.${cls}` : tk.name, false)
  }

  const out: LookControl[] = []
  let line = 1
  let hit = 0                                                                 // hits before the element
  let nextSelect = 0
  const selects: number[] = []
  toks.forEach((tk, p) => { if (tk.t === 'open' && tk.name === 'select') selects.push(p) })
  toks.forEach((tk, k) => {
    if (tk.t !== 'open' || NEVER.has(tk.name)) return
    const has = (a: string): boolean => tk.attrs.has(a)
    const role = lowerAscii(attr(tk, 'role').trim().split(/\s+/)[0]!)
    let kind: ControlKind | undefined
    if (tk.name === 'select') kind = 'select'
    else if (tk.name === 'details' && !has('open')) kind = 'details'
    else if (tk.name === 'dialog' && !has('open')) kind = 'dialog'
    else if (has('popover')) kind = 'popover'
    else if (ROLES.has(role)) kind = role as ControlKind
    else if (lowerAscii(attr(tk, 'aria-expanded').trim()) === 'false') kind = 'collapsed'
    else if (has('hidden') || styleHides(attr(tk, 'style'))) kind = 'hidden'
    else if (tk.name === 'template') kind = 'template'
    if (kind === undefined) return

    let holds = ''
    if (kind === 'select') {
      // D7.5: the region runs to its matching close or the next select open; an option is its
      // label, else its text up to the next option, optgroup or hr open, or option or select close.
      while (selects[nextSelect] !== undefined && selects[nextSelect]! <= k) nextSelect++
      const region = Math.min(endOf[k]!, selects[nextSelect] ?? n)
      const options: string[] = []
      let size = 0
      let cut = false
      let cur: { raw: string; count: number; label: string } | undefined
      const done = (): void => {
        if (cur === undefined) return
        const label = clean(cur.label)
        const said = label !== '' ? label : clean(cur.raw)
        if (said !== '') { options.push(said); size += [...said].length + 3 }
        cur = undefined
      }
      for (let p = k + 1; p < region && !cut; p++) {
        const o = toks[p]!
        if (o.t === 'open') {
          if (o.name === 'option') { done(); cur = { raw: '', count: 0, label: attr(o, 'label') } }
          else if (o.name === 'optgroup' || o.name === 'hr') done()
          else if (o.name === 'br' && cur !== undefined) { cur.raw += ' '; cur.count++ }
        } else if (o.t === 'close') {
          if (o.name === 'option' || o.name === 'select') done()
        } else if (cur !== undefined && cur.count < GATHER) {
          const [h, c, more] = head(html, o.start, o.end, GATHER - cur.count)
          cur.raw += blank[p] === 1 ? ' ' : h
          cur.count += c
          if (more) cut = true
        }
        if (size >= GATHER) cut = true
      }
      done()
      if (options.length > 0) holds = finish(options.join(' | '), cut)
    } else if (kind === 'details') {
      // The text of its first child element when that child is a summary, else "Details".
      let c = k + 1
      while (toks[c]?.t === 'text' && blank[c] === 1) c++
      const first = toks[c]
      if (first?.t === 'open' && first.name === 'summary') {
        const t = textOf(c)
        if (clean(t.raw) !== '') holds = finish(clean(t.raw), t.truncated)
      } else holds = 'Details'
    }
    if (holds === '') holds = named(tk, k)

    // D7.7–7.8: the element's own id — the first outline id inside its start tag — else the id
    // whose `--outline` span holds its line: the last id before it on its line, else the first
    // id on its line, else the last id on an earlier line.
    while (nl[line - 1] !== undefined && nl[line - 1]! < tk.start) line++
    while (hits[hit] !== undefined && hits[hit]!.at < tk.start) hit++
    const before = hits[hit - 1]
    const after = hits[hit]
    let anchor: string
    if (after !== undefined && after.at < tk.end) anchor = after.id
    else if (before?.line === line) anchor = before.id
    else if (after?.line === line) anchor = after.id
    else anchor = before?.id ?? '-'
    out.push({ anchor: logSafe(anchor), line, kind, holds })
  })
  return out
}

// The `--outline` block and the critic's input: the rows, then what markup cannot show.
export function controlsBlock(html: string): string[] {
  return [...rows('controls', ['anchor', 'line', 'kind', 'holds'], lookControls(html)), cmd('controls-note', CONTROLS_NOTE)]
}

// A design artifact is a portable, self-contained mockup: it must render with no
// network, and it must expose id-attributed sections so the design-critic can anchor
// findings to concrete parts of the screen (the anchor grammar's targets).
const EXTERNAL_REFS: Array<[RegExp, string]> = [
  [/<script[^>]*\bsrc\s*=/i, 'external <script src> — inline the script'],
  [/<link[^>]*\bhref\s*=\s*["'](?:https?:)?\/\//i, 'external <link href> — inline the stylesheet'],
  [/<img[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\//i, 'external <img src> — embed as a data: URI'],
  [/<[^>]*\bsrcset\s*=\s*["'][^"']*(?:https?:)?\/\//i, 'external srcset — embed as data: URIs'],
  [/url\(\s*["']?(?:https?:)?\/\//i, 'external url() in CSS — embed the asset'],
]

export function validateDesignArtifact(html: string): Violation[] {
  const out: Violation[] = []
  for (const [re, why] of EXTERNAL_REFS) {
    if (re.test(html)) { out.push(v('artifact', 'external-ref', why, 'a self-contained artifact — no external resource refs')); break }
  }
  const ids = elementIds(html)
  const unique = new Set(ids)
  if (unique.size !== ids.length) {
    out.push(v('artifact', 'duplicate-id', `${ids.length} ids, ${unique.size} unique`, 'unique id attributes — anchors must be unambiguous'))
  }
  if (unique.size < 2) {
    out.push(v('artifact', 'template', `${unique.size} id-attributed element(s)`, '>=2 id-attributed sections — the design-critic anchors to element ids'))
  }
  if (!/<!doctype html/i.test(html) && !/<html[\s>]/i.test(html) && !/<body[\s>]/i.test(html)) {
    out.push(v('artifact', 'not-html', html.slice(0, 40), 'an HTML document (<!doctype html> / <html> / <body>)'))
  }
  return out
}

export function htmlSha(html: string): string {
  return createHash('sha256').update(html.replace(/\s+$/, '') + '\n').digest('hex')
}

export function designPairSha(html: string, spec: CanonDoc): string {
  return createHash('sha256')
    .update(`design:${htmlSha(html)}\n`)
    .update(`spec:${canonicalSha(spec.meta, spec.body)}`)
    .digest('hex')
}

// What the design gate judges: the artifact PAIRED with the spec it realizes. With no artifact
// the spec alone is the sha, so a re-authored spec still lapses a prior verdict. One derivation
// for the gate's `resolve` and `currentSha` and for `next`'s revise-owed read (row 194), so none
// can disagree about what moved.
export function designGateSha(html: string | undefined, spec: CanonDoc): string {
  return html !== undefined ? designPairSha(html, spec) : canonicalSha(spec.meta, spec.body)
}

// The same sha for the artifact on disk now.
export function designCurrentSha(root: string, paths: CanonPaths, spec: CanonDoc): string {
  const abs = join(root, designRel(paths, String(spec.meta.id)))
  return designGateSha(existsSync(abs) ? readFileSync(abs, 'utf8') : undefined, spec)
}

export function designRel(paths: CanonPaths, specId: string): string {
  return `${paths.designs}/${specId}.html`
}

export function designStamp(spec: CanonDoc): { sha: string; spec: string } | undefined {
  const s = spec.meta.design as { sha?: unknown; spec?: unknown } | undefined
  if (!s || typeof s.sha !== 'string' || typeof s.spec !== 'string') return undefined
  return { sha: s.sha, spec: s.spec }
}

// The single home for "this ui spec owes a design": a ui-flagged spec in a
// feature-class effort whose design stamp is missing or stale (designed against
// older content). fix/chore efforts never arm it (Q2). next/dashboard/check/gate
// all consult this — never re-derive the rule.
export function designPending(root: string, spec: CanonDoc): boolean {
  if (spec.meta.type !== 'spec' || spec.meta.ui !== true) return false
  const effort = effortOf(root, String(spec.meta.id))
  if (!effort) return false
  if (latestRecap(root, effort)?.class !== 'feature') return false
  const stamp = designStamp(spec)
  return !stamp || stamp.spec !== canonicalSha(spec.meta, spec.body)
}

// Is an artifact authored for the CURRENT spec content already on disk (a design-write
// entry whose `spec` sha equals the current canonical sha)? Distinguishes "authored,
// awaiting gate" from "amended since the last artifact" — routing keys on this instead
// of file existence, so an amendment (stale artifact) correctly re-enters the design skill.
export function designArtifactCurrent(root: string, spec: CanonDoc): boolean {
  const cur = canonicalSha(spec.meta, spec.body)
  return readStream(root, String(spec.meta.id)).some(
    (e) => e.t === 'design-write' && (e as { spec?: string }).spec === cur,
  )
}

// Pure half: has a human been shown THESE exact bytes? Sha-keyed, because a re-authored
// artifact is a different thing to look at — the same discipline that makes a re-captured
// screenshot invalidate its predecessor's witnessed sha (D71).
export function designShown(entries: Entry[], sha: string): boolean {
  return entries.some((e) => e.t === 'design-shown' && (e as { sha?: string }).sha === sha)
}

// The single home for "this artifact is registered but nobody has been shown it".
// Returns the unwitnessed sha, or undefined when there is nothing to see (no artifact)
// or a design-shown entry already covers the current bytes. gate/decide/next all consult
// this — never re-derive the rule.
export function designUnseen(root: string, paths: CanonPaths, specId: string): string | undefined {
  const abs = join(root, designRel(paths, specId))
  if (!existsSync(abs)) return undefined
  const sha = htmlSha(readFileSync(abs, 'utf8'))
  return designShown(readStream(root, specId), sha) ? undefined : sha
}
