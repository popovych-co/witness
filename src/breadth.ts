import { langOf } from './switch-offs.js'

// Row 280 (§4 T4, correction C45). A lint guard must catch the shape of the flagged code, not this
// file's path or names: the red tree also holds a copy of the anchored file beside it, its declared
// names renamed to fresh ones and its indentation changed, and the rule must fire there too.
//
// Fresh names (`$wb0`, `$wb1`, …), not a suffix: a suffix kept the old name as a substring, and a rule
// matching a regex on the name passed breadth that way (probe t4a-guards.log §4). The JS/TS family
// only: a Rust copy compiles only when a parent module declares it, a line outside the overlay.
// Probed (t4a-breadth.mjs beside the impl map) over 80 fewhats files: 0 ESLint parse errors, 0 tsc
// syntax errors, 0 Biome parse errors.

export const BREADTH_TAG = '-witness-breadth'

// Keywords and contextual keywords: never a name the copy renames, even where a declaration's syntax
// would read one (`const from`, `let type`).
const KEYWORDS = new Set(('break case catch class const continue debugger default delete do else enum export extends false finally '
  + 'for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let '
  + 'static implements interface package private protected public await async as from of get set type declare namespace module '
  + 'abstract readonly keyof infer is asserts satisfies override accessor unique never unknown any').split(' '))

// The tag before the basename's first dot after its first character (`a/b.test.ts` →
// `a/b-witness-breadth.test.ts`, `.eslintrc.cjs` → `.eslintrc-witness-breadth.cjs`); a name with no
// such dot takes the tag at its end.
export function breadthPath(path: string): string {
  const slash = path.lastIndexOf('/')
  const dir = path.slice(0, slash + 1)
  const base = path.slice(slash + 1)
  const dot = base.indexOf('.', 1)
  return dot < 0 ? `${dir}${base}${BREADTH_TAG}` : `${dir}${base.slice(0, dot)}${BREADTH_TAG}${base.slice(dot)}`
}

// The code spans of `text`, as [start, end): everything outside `//` and `/* */` comments, '…' and
// "…" strings, and the text of `…` templates — a `${…}` hole is code, nested to any depth.
function codeSpans(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const holes: number[] = []   // per open template hole, its brace depth
  let i = 0
  let start = 0
  const push = (end: number) => { if (end > start) out.push([start, end]) }
  while (i < text.length) {
    const c = text[i]
    const d = text[i + 1]
    if (c === '/' && d === '/') {
      push(i); i = text.indexOf('\n', i); if (i < 0) i = text.length; start = i; continue
    }
    if (c === '/' && d === '*') {
      push(i); const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; start = i; continue
    }
    if (c === "'" || c === '"') {
      push(i); i++
      while (i < text.length && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1
      i++; start = i; continue
    }
    if (c === '`' || (c === '}' && holes.length > 0 && holes.at(-1) === 0)) {
      if (c === '}') holes.pop()
      push(i); i++
      for (;;) {
        if (i >= text.length) break
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === '`') { i++; break }
        if (text[i] === '$' && text[i + 1] === '{') { i += 2; holes.push(0); break }
        i++
      }
      start = i; continue
    }
    if (c === '{' && holes.length > 0) holes[holes.length - 1]!++
    if (c === '}' && holes.length > 0) holes[holes.length - 1]!--
    i++
  }
  push(text.length)
  return out
}

const DECLARED = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g
const IDENT = /(?<![\w$])[A-Za-z_$][\w$]*/g

// The copy of a JS/TS file: names declared in code by const, let, var, function or class (never a
// keyword) renamed in code only to `$wb<i>` in first-declaration order, except right after a lone
// `.` (a property; a spread `...x` is renamed); every line's leading whitespace doubled. Undefined
// outside the JS/TS family.
export function breadthCopy(path: string, text: string): { path: string; text: string } | undefined {
  if (langOf(path) !== 'ts') return undefined
  const spans = codeSpans(text)
  const fresh = new Map<string, string>()
  for (const [a, b] of spans) {
    for (const m of text.slice(a, b).matchAll(DECLARED)) {
      const name = m[1]!
      if (!KEYWORDS.has(name) && !fresh.has(name)) fresh.set(name, `$wb${fresh.size}`)
    }
  }
  let out = ''
  let at = 0
  for (const [a, b] of spans) {
    out += text.slice(at, a)
    out += text.slice(a, b).replace(IDENT, (word, off: number) => {
      const p = a + off
      const property = text[p - 1] === '.' && !(text[p - 2] === '.' && text[p - 3] === '.')
      return !property && fresh.has(word) ? fresh.get(word)! : word
    })
    at = b
  }
  out += text.slice(at)
  return { path: breadthPath(path), text: out.split('\n').map((l) => l.replace(/^([ \t]+)/, '$1$1')).join('\n') }
}
