// A shell word is quoted only when it needs it, so the common line stays the one a human
// types — a path in drive's watch line, a command in a `--cmd` grant (row 205).
export const shellArg = (p: string): string => /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replaceAll("'", "'\\''")}'`

// Security review. A command a human is asked to trust is repo-authored text: a carriage return
// or an escape sequence could paint a different command over the real one, a bidi override
// reorder it (Trojan Source), an invisible filler hide a second command beside it. A denylist of
// such characters always misses one, so the rule is an allowlist: printable ASCII shows as it
// is, anything else is spelled out, and a command carrying any of it is never granted.
const UNSHOWABLE = /[^\x20-\x7e]/u
export const hasControl = (s: string): boolean => UNSHOWABLE.test(s)
// One character spelled out: the one spelling `visible` and `logSafe` share.
const spell = (c: string): string =>
  c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t'
    : c.codePointAt(0)! < 0x100 ? `\\x${c.codePointAt(0)!.toString(16).padStart(2, '0')}` : `\\u{${c.codePointAt(0)!.toString(16)}}`
export const visible = (s: string): string => s.replace(new RegExp(UNSHOWABLE.source, 'gu'), spell)

// Row 214. What a session drive runs wrote, on the human's terminal and in .witness/drive.log: the
// same paint-over and reorder attacks, from text an agent controls (a command, a path, its prose).
// Nobody grants a log line, so the rule is narrower than `visible`'s — control and format
// characters (ESC, CR, TAB, bidi overrides, zero-width fillers) and the line and paragraph
// separators U+2028/U+2029, which editors and some terminals render as a line break, are spelled
// out, and printable text in any script stays as written: `visible` would mangle drive's own `·`
// and `→`, and every sentence an agent writes in another language.
const UNLOGGABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
export const logSafe = (s: string): string => s.replace(UNLOGGABLE, spell)

function esc(value: unknown): string {
  const s = String(value ?? '')
  return /[,"\n]|^\s|\s$/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function kv(key: string, value: unknown): string {
  return `${key}: ${esc(value)}`
}

// Commands are the one value class that must survive verbatim: `esc` quotes anything
// containing `,` or `"`, and `--revise --note "<why>"` contains both — so the exits line
// reached humans as `exits: "witness decide … --note ""<why>"" …"`, which pastes into a
// shell as an empty --note. The gate printed the same string clean through a template
// literal, so this is one string with two renderings (D120). Structured values keep `kv`.
export function cmd(key: string, command: string): string {
  return `${key}: ${command}`
}

export function list(key: string, values: unknown[]): string {
  return `${key}[${values.length}]: ${values.map(esc).join(',')}`
}

export function rows(key: string, fields: string[], items: Array<Record<string, unknown>>): string[] {
  return [
    `${key}[${items.length}]{${fields.join(',')}}:`,
    ...items.map((it) => '  ' + fields.map((f) => esc(it[f])).join(',')),
  ]
}
