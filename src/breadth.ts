import { randomInt } from 'node:crypto'
import { langOf } from './switch-offs.js'

// Row 280 (§4 T4, correction C45). A lint guard must catch the shape of the flagged code, not this
// file's path or names: the red tree also holds a copy of the anchored file beside it, its local
// names renamed to fresh ones and its indentation changed, and the rule must fire there too.
//
// Slice 2 review I1: the copy's name and its fresh names are drawn each run (`breadthSeed`), so a
// rule can never name them in advance — a fixed tag (`-witness-breadth`, `$wb<i>`) was printed by the
// first refusal and then targeted. Fresh names, never a suffix: a suffix kept the old name as a
// substring, and a rule matching a regex on the name passed that way (probe t4a-guards.log §4).
// Slice 2 review I2: a local is any binding — a declaration, a parameter, a catch binding, a
// destructured name — so a rule pinned to a local's exact name misses the copy. Imports and
// properties keep their names: a rule banning an API must hold on the copy.
//
// The JS/TS family only: a Rust copy compiles only when a parent module declares it, a line outside
// the overlay. Probed (t4a-breadth.mjs beside the impl map) over 80 fewhats files: 0 ESLint parse
// errors, 0 tsc syntax errors, 0 Biome parse errors.

// Keywords and contextual keywords: never a name the copy renames.
const KEYWORDS = new Set(('break case catch class const continue debugger default delete do else enum export extends false finally '
  + 'for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let '
  + 'static implements interface package private protected public await async as from of get set type declare namespace module '
  + 'abstract readonly keyof infer is asserts satisfies override accessor unique never unknown any constructor').split(' '))
// The words after which a `/` opens a regex literal rather than dividing.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'])
// The characters after which a `/` opens a regex literal.
const REGEX_AFTER_CHAR = new Set([...'(,=:[!&|?{};+-*%<>~^'])
// A method head's name that is a statement keyword, never a method.
const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'typeof', 'await', 'yield', 'new'])

export interface BreadthSeed { stem: string; prefix: string }

const letters = (n: number): string => Array.from({ length: n }, () => String.fromCharCode(97 + randomInt(26))).join('')

// One run's seed: the copy's stem (8 lowercase letters: kebab- and camel-safe for filename rules) and
// the fresh names' prefix (5 lowercase letters).
export function breadthSeed(): BreadthSeed {
  return { stem: letters(8), prefix: letters(5) }
}

// The copy's path: `stem` in place of the basename's part before its first dot after the first
// character, the suffix kept (`a/b.test.ts` → `a/<stem>.test.ts`, `.eslintrc.cjs` → `<stem>.cjs`).
export function breadthPath(path: string, stem: string): string {
  const slash = path.lastIndexOf('/')
  const base = path.slice(slash + 1)
  const dot = base.indexOf('.', 1)
  return `${path.slice(0, slash + 1)}${stem}${dot < 0 ? '' : base.slice(dot)}`
}

// `text` with everything that is not code — `//` and `/* */` comments, '…' and "…" strings, a
// template's text (its `${…}` holes are code), regex literals — blanked to spaces (line breaks
// kept), so every offset still points into `text`.
// `jsx`: a file that may hold JSX (any JS-family file but .ts, .mts, .cts), where a quote right after a
// word character is JSX text (`Don't`).
function maskCode(text: string, jsx: boolean): string {
  const out = text.split('')
  const blank = (a: number, b: number) => { for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ' }
  const holes: number[] = []   // per open template hole, its brace depth
  let lastSig = ''             // the last significant code character
  let lastWord = ''            // the identifier ending at lastSig, when it is one
  let i = 0
  const value = () => { lastSig = 'a'; lastWord = '' }
  while (i < text.length) {
    const c = text[i]!
    const d = text[i + 1]
    if (c === '/' && d === '/') {
      const end = text.indexOf('\n', i)
      const stop = end < 0 ? text.length : end
      blank(i, stop); i = stop; continue
    }
    if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? text.length : end + 2
      blank(i, stop); i = stop; continue
    }
    if (c === '/' && (lastSig === '' || REGEX_AFTER_CHAR.has(lastSig) || REGEX_AFTER_WORD.has(lastWord))) {
      let j = i + 1
      let cls = false
      let closed = false
      while (j < text.length && text[j] !== '\n') {
        const ch = text[j]!
        if (ch === '\\') { j += 2; continue }
        if (ch === '[') cls = true
        else if (ch === ']') cls = false
        else if (ch === '/' && !cls) { closed = true; j++; break }
        j++
      }
      if (closed) {
        while (j < text.length && /[a-z]/i.test(text[j]!)) j++
        blank(i, j); i = j; value(); continue
      }
    }
    // Final review I2: in a file that may hold JSX a quote right after a word character is JSX text
    // (`Don't`), never a string's opener; in a .ts file (`return'x'`) it opens one (security review).
    if ((c === "'" || c === '"') && !(jsx && /[\w$]/.test(text[i - 1] ?? ''))) {
      let j = i + 1
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      j = Math.min(j + 1, text.length)
      blank(i, j); i = j; value(); continue
    }
    if (c === '`' || (c === '}' && holes.length > 0 && holes.at(-1) === 0)) {
      if (c === '}') holes.pop()
      let j = i + 1
      let hole = false
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '`') { j++; break }
        if (text[j] === '$' && text[j + 1] === '{') { j += 2; holes.push(0); hole = true; break }
        j++
      }
      blank(i, j); i = j   // a hole's `${` is the template's, never code: a binding named `$` must not match it
      if (hole) { lastSig = '{'; lastWord = '' } else value()
      continue
    }
    if (c === '{' && holes.length > 0) holes[holes.length - 1]!++
    if (c === '}' && holes.length > 0) holes[holes.length - 1]!--
    if (!/\s/.test(c)) {
      if (/[\w$]/.test(c)) {
        let j = i
        while (j < text.length && /[\w$]/.test(text[j]!)) j++
        lastWord = text.slice(i, j); lastSig = text[j - 1]!; i = j; continue
      }
      lastSig = c; lastWord = ''
    }
    i++
  }
  return out.join('')
}

const IDENT = /(?<![\w$])[A-Za-z_$][\w$]*/y
const identAt = (s: string, at: number): string | undefined => { IDENT.lastIndex = at; return IDENT.exec(s)?.[0] }
const skipSpace = (s: string, at: number): number => { while (at < s.length && /\s/.test(s[at]!)) at++; return at }

// The index of the bracket closing the one at `at` in the masked text, or -1.
function closing(m: string, at: number): number {
  const open = m[at]!
  const close = open === '(' ? ')' : open === '[' ? ']' : '}'
  let depth = 0
  for (let k = at; k < m.length; k++) {
    if (m[k] === open) depth++
    else if (m[k] === close && --depth === 0) return k
  }
  return -1
}

// Final review I2. How the character at `k` moves the nesting depth: brackets always; `<` only as a
// type argument's opener (right after a word character) and `>` only as its closer while one is open
// (never `=>`, `>=` or a comparison), so `Map<string, Date>` and `(x: number) => void` hold no comma or
// close at depth 0 that is not one.
function depthStep(m: string, k: number, angles: { n: number }): number {
  const c = m[k]!
  if ('([{'.includes(c)) return 1
  if (')]}'.includes(c)) return -1
  if (c === '<' && /[\w$]/.test(m[k - 1] ?? '')) { angles.n++; return 1 }
  if (c === '>' && angles.n > 0 && m[k - 1] !== '=' && m[k + 1] !== '=') { angles.n--; return -1 }
  return 0
}

// The comma-separated elements of a bracket's inside at depth 0, as [start, end) offsets.
function elements(m: string, open: number, close: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const angles = { n: 0 }
  let depth = 0
  let start = open + 1
  for (let k = open + 1; k < close; k++) {
    const step = depthStep(m, k, angles)
    depth += step
    if (step === 0 && m[k] === ',' && depth === 0) { out.push([start, k]); start = k + 1 }
  }
  out.push([start, close])
  return out
}

// The first depth-0 `ch` in [a, b), or -1.
function depthZero(m: string, a: number, b: number, ch: string): number {
  const angles = { n: 0 }
  let depth = 0
  for (let k = a; k < b; k++) {
    const step = depthStep(m, k, angles)
    depth += step
    if (step === 0 && m[k] === ch && depth === 0 && !(ch === '=' && (m[k + 1] === '>' || m[k + 1] === '='))) return k
  }
  return -1
}

// `member`: a method name the file declares (final review I3), renamed with its `this.` uses only.
interface Binding { name: string; at: number; shorthand: boolean; member?: true }

// The bindings one target declares: an identifier, or a `{…}` / `[…]` pattern, read up to `end`.
function target(m: string, at: number, end: number, out: Binding[]): void {
  at = skipSpace(m, at)
  if (m.startsWith('...', at)) at = skipSpace(m, at + 3)
  if (m[at] === '{' || m[at] === '[') { pattern(m, at, out); return }
  const name = identAt(m, at)
  if (name !== undefined && at < end && !KEYWORDS.has(name)) out.push({ name, at, shorthand: false })
}

// A destructuring pattern's bindings: an object's `key: target` (the key kept) and shorthand `name`
// (kept as the key, `name: fresh`), an array's elements; defaults (`= …`) are expressions, never read.
function pattern(m: string, open: number, out: Binding[]): void {
  const close = closing(m, open)
  if (close < 0) return
  const obj = m[open] === '{'
  for (const [a, b0] of elements(m, open, close)) {
    const eq = depthZero(m, a, b0, '=')
    const b = eq < 0 ? b0 : eq
    let at = skipSpace(m, a)
    if (at >= b) continue
    if (m.startsWith('...', at)) { target(m, at, b, out); continue }
    if (!obj) { target(m, at, b, out); continue }
    const colon = depthZero(m, at, b, ':')
    if (colon >= 0) { target(m, colon + 1, b, out); continue }
    const name = identAt(m, at)
    if (name !== undefined && !KEYWORDS.has(name)) out.push({ name, at, shorthand: true })
  }
}

// Every parameter list's bindings: a parameter, a TS modifier before it skipped.
function params(m: string, open: number, out: Binding[]): void {
  const close = closing(m, open)
  if (close < 0) return
  for (const [a, b0] of elements(m, open, close)) {
    let at = skipSpace(m, a)
    for (;;) {
      const w = identAt(m, at)
      if (w === undefined || !['public', 'private', 'protected', 'readonly', 'override'].includes(w)) break
      at = skipSpace(m, at + w.length)
    }
    const colon = depthZero(m, at, b0, ':')
    const eq = depthZero(m, at, b0, '=')
    const b = [colon, eq].filter((x) => x >= 0).reduce((x, y) => Math.min(x, y), b0)
    target(m, at, b, out)
  }
}

// Every binding the file's code declares, in source order.
function bindings(m: string): Binding[] {
  const out: Binding[] = []
  for (const x of m.matchAll(/\b(?:const|let|var)\b/g)) {
    // `as const` and `<const>` assert, never declare (final review I2)
    if (/\bas\s*$|<\s*$/.test(m.slice(Math.max(0, x.index - 10), x.index))) continue
    // each declarator of the statement: `a = …, { b } = …` up to its end at depth 0
    let at = x.index + x[0].length
    for (;;) {
      at = skipSpace(m, at)
      const start = at
      if (m[at] === '{' || m[at] === '[') { pattern(m, at, out); at = closing(m, at) + 1 }
      else target(m, at, m.length, out)
      // find the next depth-0 comma before the statement ends (`;`, a line break at depth 0, or a closer)
      let depth = 0
      let k = Math.max(at, start)
      let next = -1
      const angles = { n: 0 }
      for (; k < m.length; k++) {
        const c = m[k]!
        if (')]}'.includes(c) && depth === 0) break
        const step = depthStep(m, k, angles)
        if (step !== 0) { depth += step; continue }
        if (c === ';' && depth === 0) break
        else if (c === '\n' && depth === 0 && !/^[\s]*[,=.?:+\-*/&|]/.test(m.slice(k + 1, k + 40)) && !/[,=(+\-*/&|?:]\s*$/.test(m.slice(Math.max(0, k - 40), k))) break
        else if (c === ',' && depth === 0) { next = k + 1; break }
      }
      if (next < 0) break
      at = next
    }
  }
  for (const x of m.matchAll(/\b(?:function\b\s*\*?\s*|class\s+)([A-Za-z_$][\w$]*)?/g)) {
    if (x[1] !== undefined && !KEYWORDS.has(x[1])) out.push({ name: x[1], at: x.index + x[0].length - x[1].length, shorthand: false })
    if (!x[0].startsWith('function')) continue
    let at = skipSpace(m, x.index + x[0].length)
    if (m[at] === '<') { const gt = m.indexOf('>', at); at = gt < 0 ? at : skipSpace(m, gt + 1) }
    if (m[at] === '(') params(m, at, out)
  }
  for (const x of m.matchAll(/\bcatch\s*\(/g)) params(m, x.index + x[0].length - 1, out)
  for (let k = 0; k < m.length; k++) {
    if (m[k] !== '(') continue
    const close = closing(m, k)
    if (close < 0) continue
    const after = m.slice(close + 1, close + 200)
    const before = m.slice(0, k).trimEnd()
    const head = /([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?$/.exec(before)
    const arrow = /^\s*(?::[^=;{}()]*)?=>/.test(after)
    const method = head !== null && !NOT_METHOD.has(head[1]!) && /^\s*(?::[^;{}()]*)?\{/.test(after) && !/\bfunction\s*\*?\s*[\w$]*\s*(?:<[^<>()]*>)?$/.test(before)
    if (arrow || method) params(m, k, out)
    // Final review I3: a method's name the file declares (a class's or an object literal's).
    if (method && !KEYWORDS.has(head[1]!)) out.push({ name: head[1]!, at: head.index, shorthand: false, member: true })
  }
  for (const x of m.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) {
    // a return type or a type's member before `=>` is no parameter (final review I2)
    const before = m.slice(Math.max(0, x.index - 200), x.index)
    if (/\)\s*:\s*$|[|&]\s*$/.test(before)) continue
    if (!KEYWORDS.has(x[1]!)) out.push({ name: x[1]!, at: x.index, shorthand: false })
  }
  return out.sort((a, b) => a.at - b.at)
}

// The copy of a JS/TS file under `seed`: every local binding renamed in code only to `<prefix><i>` in
// source order (a prefix any name in the file starts with is lengthened), never right after a lone
// `.` (a property; a spread `...x` is renamed); a destructured shorthand keeps its key (`a: fresh`);
// every line's leading spaces and tabs doubled. Undefined outside the JS/TS family.
export function breadthCopy(path: string, text: string, seed: BreadthSeed): { path: string; text: string } | undefined {
  if (langOf(path) !== 'ts') return undefined
  // JSX may sit in any JS-family file but a .ts, .mts or .cts one (security review).
  const masked = maskCode(text, !/\.[mc]?ts$/.test(path))
  const found = bindings(masked)
  const words = [...masked.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*/g)].map((x) => x[0])
  let prefix = seed.prefix
  while (words.some((w) => w.startsWith(prefix))) prefix += 'q'
  const fresh = new Map<string, string>()
  for (const b of found) if (!fresh.has(b.name)) fresh.set(b.name, `${prefix}${fresh.size}`)
  const shorthand = new Set(found.filter((b) => b.shorthand).map((b) => b.at))
  const members = new Set(found.filter((b) => b.member === true).map((b) => b.name))
  let out = ''
  let at = 0
  for (const x of masked.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*/g)) {
    const p = x.index
    const name = fresh.get(x[0])
    if (name === undefined) continue
    const property = text[p - 1] === '.' && !(text[p - 2] === '.' && text[p - 3] === '.')
    // a member's `this.` use is renamed with it; any other property keeps its name
    if (property && !(members.has(x[0]) && /\bthis\s*\.$/.test(text.slice(Math.max(0, p - 8), p)))) continue
    out += text.slice(at, p) + (shorthand.has(p) ? `${x[0]}: ${name}` : name)
    at = p + x[0].length
  }
  out += text.slice(at)
  return { path: breadthPath(path, seed.stem), text: out.split('\n').map((l) => l.replace(/^([ \t]+)/, '$1$1')).join('\n') }
}
