// Row 239. Each shell's quoting that nothing reads through, the one copy of each: inside POSIX
// single quotes no character is special, so a `'` is written `'\''` (close, an escaped quote,
// reopen); inside PowerShell's nothing expands, and a single quote is written twice. The one
// exception is the canon guard, which ships alone and imports nothing from witness:
// plugin/hooks/canon-guard.mjs carries a twin of `shellWord` and `withheldOn` and all they read,
// and tests/canon-guard.test.ts holds it equal to these. Change both or neither.
const posixQuoted = (p: string): string => `'${p.replaceAll("'", "'\\''")}'`
const psQuoted = (p: string): string => `'${p.replace(/['‘’‚‛]/g, (q) => q + q)}'`

// One character spelled out: the one spelling `shellWord`, `visible` and `logSafe` share.
const spell = (c: string): string =>
  c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t'
    : c.codePointAt(0)! < 0x100 ? `\\x${c.codePointAt(0)!.toString(16).padStart(2, '0')}` : `\\u{${c.codePointAt(0)!.toString(16)}}`

// A command a human is asked to trust, or any word offered to be pasted, is repo-authored text: a
// carriage return or an escape sequence could paint a different command over the real one, a bidi
// override reorder it (Trojan Source), an invisible filler hide a second command beside it. A
// denylist always misses one, so the rule is an allowlist: printable ASCII shows as it is, anything
// else is spelled out (rows 205/237, ruling R27), and a word carrying any of it is never offered.
const UNSHOWABLE = /[^\x20-\x7e]/u
export const hasControl = (s: string): boolean => UNSHOWABLE.test(s)
export const visible = (s: string): string => s.replace(new RegExp(UNSHOWABLE.source, 'gu'), spell)

// Row 239 (ruling R24). The subset of the unshowable that would split the line a word prints on: a
// control character (a newline, a carriage return, a tab, ESC, a C1 control) or the line and
// paragraph separators U+2028/U+2029, which editors and some terminals render as a line break. A
// physical line that starts `run:` is a line the skills run. Its message takes precedence in
// `withheldOn`, since it is the sharper reason, but every unshowable word is withheld all the same.
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/u

// A shell word is quoted only when it needs it, so the common line stays the one a human
// types — a path in drive's watch line, a command in a `--cmd` grant (row 205). Row 239: never
// bare when it starts with `=`, which zsh's EQUALS option, on by default, reads as the path of a
// command (probed: a bare `=ls` reached the program as `/bin/ls`).
export const shellArg = (p: string): string => /^(?!=)[\w@%+=:,./-]+$/.test(p) ? p : posixQuoted(p)
// Row 214. The same rule for a PowerShell word — drive's Windows watch line. Bare only when no
// character in it means anything to PowerShell: a bare `,` builds an array, a leading `@` splats
// and a leading `-` binds as a parameter, so none of them is bare here as in a POSIX word. Else
// single-quoted, where nothing expands and the one special character is a single quote — any of
// the five PowerShell reads as one (' ‘ ’ ‚ ‛) — written twice.
export const psArg = (p: string): string =>
  /^[\w%+=:./\\][\w%+=:./\\-]*$/.test(p) ? p : psQuoted(p)

// Row 239. One quoter for every word witness prints on a line offered to be pasted. Off Windows
// the line is pasted into bash, zsh or dash, and a word prints as `shellArg` prints it. On win32
// it is pasted into PowerShell, and a word prints as `psArg` prints it, but for a flag: `psArg`
// quotes a leading `-`, because a cmdlet binds such a word as a parameter, yet a native command
// (`witness`, `git`, `gh`, `claude`) receives a flag verbatim, and the watch line's cmdlet flags
// (`-LiteralPath`, `-Wait`) must stay bare to be flags at all. A flag is `-` or `--`, a letter,
// then letters, digits and `-`. It holds no `.`, `:`, `%` or `=`: PowerShell splits `-a.b` for a
// native command, and `--%` stops its parsing. A lone `--` is no flag here and prints `'--'`,
// which reads the same either way.
// Ruling R22. On Windows a line is also run through the agent's Bash tool, which is Git Bash: a
// skill runs a grant or the canon guard's adopt there. A backslash means nothing to PowerShell and
// escapes the next character in Git Bash, which reads a bare `C:\w` as `C:w`, so a word holding one
// prints single-quoted, where both read it as written.
export type Platform = NodeJS.Platform
const WINDOWS_FLAG = /^--?[A-Za-z][A-Za-z0-9-]*$/
// The quoting alone, for a word taken as given: bare in the platform's safe set, else quoted.
function quoteWord(w: string, platform: Platform): string {
  if (platform !== 'win32') return shellArg(w)
  return WINDOWS_FLAG.test(w) ? w : w.includes('\\') ? psQuoted(w) : psArg(w)
}
// Row 239. One quoter for every word witness prints on a line offered to be pasted. Off Windows the
// line is pasted into bash, zsh or dash and a word prints as `shellArg` prints it; on win32 into
// PowerShell and it prints as `psArg` prints it, but for a flag (B2) and a `\` word (R22). Ruling
// R27: every character outside printable ASCII is spelled out first (`visible`), as the trust grant
// has shown a command since rows 205/237 — a byte above 0x7f is a Meta key to an interactive shell's
// line editor (probed), and a control character splits the line (R24). Such a word is withheld
// (`withheldOn`), so this spelled form is only ever shown, never pasted, and need not be exact.
export function shellWord(w: string, platform: Platform = process.platform): string {
  return quoteWord(visible(w), platform)
}

// Row 239. Every word quoted, safe or not, as the handoff prints its path and `/witness`.
export function quotedWord(w: string, platform: Platform = process.platform): string {
  return platform === 'win32' ? psQuoted(w) : posixQuoted(w)
}

// Row 239 (ruling R27). The quoting with the bytes kept, for the one line a foreign word never
// reaches and that is never withheld: the watch line's local log path (the plan's B5). It holds no
// `$(…)`, so an interactive shell's line editor can rearrange it but run nothing, and a human needs
// the real path to read. The handoff's path is kept the same way, through `quotedWord`.
export function shellWordExact(w: string, platform: Platform = process.platform): string {
  return quoteWord(w, platform)
}

// Row 239. Another tool's command as a line to paste.
export function shellLine(argv: readonly string[], platform: Platform = process.platform): string {
  return argv.map((w) => shellWord(w, platform)).join(' ')
}

// Row 239. Why a command is not offered to be pasted, or `undefined` when it is. Ruling R24: on every
// platform, a word holding a character that would split the line (`LINE_BREAKING`) withholds it,
// whatever else the word holds. On Windows a pasted line can reach cmd.exe after PowerShell, because
// npm's `witness.cmd` and `npx.cmd` shims pass their arguments through it. PowerShell passes a word
// holding no space unquoted, and cmd.exe then reads `&`, `|`, `<` and `>` in it as new commands or
// redirections, `^` as its escape, and `%NAME%` (`!NAME!` under delayed expansion) as a variable.
// Windows PowerShell 5.1 also passes an embedded `"` unescaped, which moves cmd.exe's argument
// boundaries. No quoting reads as text to both, so a command holding any of these is shown and never
// offered (the user's call, 2026-11-04: "Refuse risky words now"). Ruling R22: nor one holding a
// quote-like, which PowerShell's quoting writes twice and Git Bash, where the skills run a line, reads
// as strings side by side (probed: a grant of `echo 'x; …'` named `echo x; …` there). Elsewhere the
// quoter alone makes every word text.
const WINDOWS_RISKY = ['&', '|', '^', '<', '>', '"', '%', '!']
const QUOTE_LIKES = ["'"]
export function withheldOn(words: readonly string[], platform: Platform = process.platform): string | undefined {
  if (words.some((w) => LINE_BREAKING.test(w))) return 'not offered — it holds a control or line-break character, which would split the line'
  if (words.some((w) => hasControl(w))) return "not offered — it holds a character outside printable ASCII, which a terminal's line editor can read as a command"
  if (platform !== 'win32') return undefined
  const held = (set: readonly string[]): string[] => set.filter((c) => words.some((w) => w.includes(c)))
  const risky = held(WINDOWS_RISKY)
  const quotes = held(QUOTE_LIKES)
  const why = [
    ...(risky.length > 0 ? [`${risky.join(' ')}, which cmd.exe or Windows PowerShell can read as more than text`] : []),
    ...(quotes.length > 0 ? [`${quotes.join(' ')}, which PowerShell and Git Bash read differently`] : []),
  ]
  return why.length === 0 ? undefined : `not offered on Windows — it holds ${why.join(', and ')}`
}

// Row 239. Another tool's command as a line offered to be pasted, unless it is withheld.
export function offeredLine(argv: readonly string[], platform: Platform = process.platform): string | undefined {
  return withheldOn(argv, platform) === undefined ? shellLine(argv, platform) : undefined
}

// Row 239. A line read back into its words, as a human types an answer at drive's `decide>`: a
// POSIX shell's quoting with nothing expanded, so a line `shellLine` printed reads back as the
// words it was made of. An unquoted space or tab ends a word; `'…'` is literal; inside `"…"` a
// backslash escapes only `"`, `\`, `$` and `` ` ``; outside quotes `\x` is `x`. A line an open
// quote or a trailing backslash leaves unfinished reads as `undefined`, never as a guess.
export function shellWords(line: string): string[] | undefined {
  const words: string[] = []
  let cur = ''
  let started = false
  let quote: "'" | '"' | undefined
  let escaped = false
  for (const ch of line) {
    if (escaped) {
      cur += quote === '"' && !'"\\$`'.includes(ch) ? `\\${ch}` : ch
      escaped = false
    } else if (quote === "'") {
      if (ch === "'") quote = undefined
      else cur += ch
    } else if (ch === '\\') {
      escaped = true
      started = true
    } else if (quote === '"') {
      if (ch === '"') quote = undefined
      else cur += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      started = true
    } else if (ch === ' ' || ch === '\t') {
      if (started) { words.push(cur); cur = ''; started = false }
    } else {
      cur += ch
      started = true
    }
  }
  if (quote !== undefined || escaped) return undefined
  if (started) words.push(cur)
  return words
}

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
