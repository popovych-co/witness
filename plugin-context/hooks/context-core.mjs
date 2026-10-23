// witness context core — the shared half of both harness adapters' context duty (row 191).
//
// Before every shell command an adapter puts the session's live fill in that command's
// environment as WITNESS_CONTEXT (§4.1). It latches a session on its first witness command and,
// once per latched session, appends one warning to a command that finishes at or over
// `session.contextLimit` (§4.6). The hand-over decision stays the CLI's; this file only renders
// the reading, reads the limit and words the warning.
//
// Dependency-free ON PURPOSE (Decision 13), on canon-guard.mjs's precedent and stricter than it:
// no imports at all. The Claude Code hooks module (context.ts) runs in the engine's own
// environment, which has no Node (everything outside it is reached through `$`), so even
// `node:path` would keep it from loading. The Pi extension (witness-pi.ts) imports this file as
// its sibling in .pi/extensions/. Both adapters import it by relative path, byte for byte the
// same, and keep only their harness's calls. The original is plugin/hooks/context-core.mjs, which
// the Pi payload copies. Claude Code copies the witness-context plugin whole into its cache, where
// nothing outside it resolves, so plugin-context/hooks/ holds a copy beside the module that
// scripts/sync-versions.mjs makes from the original (tests/context-core.test.ts holds the two
// equal): edit the original.
//
// The CLI never imports it: a runtime import from plugin/ is the packaging trap harness.ts
// describes. So pctOf and windowLabel duplicate src/context.ts's on purpose, contextLimitOf reads,
// without the CLI's YAML parser, the forms of `session.contextLimit` the CLI writes and documents,
// and tests/context-core.test.ts holds each to its original on those forms.

export const DEFAULT_LIMIT = 20;
const CONFIG = 'witness.config.yaml';

// ── The limit (§4.2) ─────────────────────────────────────────────────────────────────────────
//
// `session.contextLimit` without a YAML dependency, in canon-guard.mjs's plain-reader style. It
// reads the plain block and flow forms the CLI writes and documents, trailing comments and quoted
// keys included, and the key only as a direct child of a top-level `session:`. On those forms the
// answers are the CLI resolver's: DEFAULT_LIMIT when the section or the key is absent, the integer
// when it is one from 1 to 100, and undefined for anything the resolver refuses. It is not a YAML
// parser: rarer spellings (anchors, tags, a whole file in flow style) may read otherwise. The
// adapters stay silent on undefined; the CLI names the refusal on its next run.

const SESSION = /^(["']?)session\1[ \t]*:(?=\s|$)/;
// A plain key needs whitespace after its colon; a quoted one may take its value straight after,
// the JSON-like flow form (`{"contextLimit":15}`).
const LIMIT = /^(?:(["'])contextLimit\1\s*:|contextLimit\s*:(?=\s|$))\s*([\s\S]*)$/;

// A comment opens at a `#` that starts the line or follows whitespace; inside a word it is text.
const uncomment = (line) => line.replace(/(^|\s)#.*$/, '');

// YAML 1.2's core-schema numbers, which is what the CLI's parser reads: decimal, 0o octal, 0x hex
// and floats (`15.0` is 15). Anything else is a string, a bool or null, and none is a limit.
function numberOf(raw) {
  if (/^0o[0-7]+$/.test(raw)) return parseInt(raw.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(raw)) return parseInt(raw.slice(2), 16);
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(raw)) return Number(raw);
  return undefined;
}

// The entries of the flow map the text opens with, split at its own commas; undefined while the
// map is unclosed.
function flowEntries(text) {
  const out = [];
  let depth = 0;
  let start = 1;
  let quote;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '{' || c === '[') {
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return [...out, text.slice(start, i)];
    } else if (c === ',' && depth === 1) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return undefined;
}

// The `session:` map's own entries, one `key: value` text each. Undefined when `session:` holds
// no map — nothing under it is null, and a scalar or a sequence is not a map — all of which the
// CLI refuses. A block map's entries are its lines at the first child's indentation, so a
// `contextLimit` nested deeper is some other key's.
function sessionEntries(lines, at) {
  const inline = uncomment(lines[at].replace(SESSION, '')).trim();
  if (inline.startsWith('{')) return flowEntries([inline, ...lines.slice(at + 1).map(uncomment)].join('\n'));
  if (inline !== '') return undefined;
  const entries = [];
  let indent;
  for (const line of lines.slice(at + 1)) {
    const text = uncomment(line).trim();
    if (text === '') continue;
    const lead = line.length - line.trimStart().length;
    if (lead === 0) break;
    indent ??= lead;
    if (lead === indent) entries.push(text);
  }
  if (indent === undefined || /^-(\s|$)/.test(entries[0])) return undefined;
  return entries;
}

/**
 * @param {string} text the whole witness.config.yaml
 * @returns {number | undefined} the limit, DEFAULT_LIMIT when unset, undefined when invalid
 */
export function contextLimitOf(text) {
  if (typeof text !== 'string') return undefined;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const at = lines.findIndex((line) => SESSION.test(line));
  if (at === -1) return DEFAULT_LIMIT;
  const entries = sessionEntries(lines, at);
  if (entries === undefined) return undefined;
  for (const entry of entries) {
    const m = LIMIT.exec(entry.trim());
    if (!m) continue;
    const n = numberOf((m[2] ?? '').trim());
    return Number.isInteger(n) && n >= 1 && n <= 100 ? n : undefined;
  }
  return DEFAULT_LIMIT;
}

// A directory inside `.witness/worktrees/<id>`: a plan's worktree, or a folder within it.
const WORKTREE = /[\\/]\.witness[\\/]worktrees[\\/][^\\/]+/;

/**
 * The config the limit comes from is the nearest one up from the session's directory, as
 * canon-guard.mjs finds its root. A path, not a walk: each adapter reads with its own harness's
 * calls, the first file found decides, and none at all means silence.
 *
 * Inside a plan's worktree the walk starts at the primary root, the directory holding `.witness`
 * (final review I2). The CLI reads the primary root's config, and the worktree's is a checkout of
 * it from when the worktree was cut: read first, a limit changed on main since would warn at one
 * share while the CLI hands over at another.
 *
 * @param {string} cwd an absolute directory, `/` or `\` separated
 * @returns {string[]} witness.config.yaml in cwd and in every directory above it, nearest first
 */
export function configCandidates(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return [];
  const sep = /[\\/]/.exec(cwd)?.[0] ?? '/';
  const out = [];
  const worktree = WORKTREE.exec(cwd);
  let dir = (worktree === null ? cwd : cwd.slice(0, worktree.index)).replace(/[\\/]+$/, '');
  for (;;) {
    out.push(`${dir}${sep}${CONFIG}`);
    const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
    if (cut === -1) return out;
    dir = dir.slice(0, cut);
  }
}

// ── The latch (§4.6) ─────────────────────────────────────────────────────────────────────────
//
// The warning is for sessions that have run the witness CLI with a verb: through the $WITNESS
// variable the skills define, as `witness <verb>` where a command starts, or as the pinned
// package itself (`npx -y @popovych.co/witness@<version> <verb>`). A mention is not a run: a
// path through a `witness` folder, or the word inside a quoted search string.
const RUNS = [
  /(?:\$WITNESS|\$\{WITNESS\})"?[ \t]+[a-z][a-z-]*/,
  /(?:^|[;&|(`\n])\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*witness[ \t]+[a-z][a-z-]*/,
  /\/witness@[^\s'"}]+[ \t]+[a-z][a-z-]*/,
];

/**
 * @param {unknown} command the shell command about to run
 * @returns {boolean} whether it runs the witness CLI
 */
export function invokesWitness(command) {
  return typeof command === 'string' && RUNS.some((run) => run.test(command));
}

// ── The reading and the warning (§4.1, §4.6) ─────────────────────────────────────────────────

/**
 * The contract, as the adapter writes it. `percent` is the harness's own and display only: the
 * CLI computes the share itself. An absent field drops out and a null stays (Pi's tokens right
 * after a compaction); the CLI reads either as no reading yet.
 *
 * @param {string} session the harness's session id
 * @param {number | null | undefined} tokens
 * @param {number | undefined} window
 * @param {number | null | undefined} percent
 * @returns {string} the WITNESS_CONTEXT value
 */
export function readingJson(session, tokens, window, percent) {
  return JSON.stringify({ session, tokens, window, percent });
}

/**
 * src/context.ts's pctOf: floored, so a printed 20% always means the limit test passed.
 *
 * @param {number} tokens
 * @param {number} window
 * @returns {number}
 */
export function pctOf(tokens, window) {
  return Math.floor(tokens * 100 / window);
}

/**
 * src/context.ts's windowLabel: 1M, 200k, thousands rounded first so 999,999 reads 1M.
 *
 * @param {number} window
 * @returns {string}
 */
export function windowLabel(window) {
  if (window < 1_000) return String(window);
  const thousands = Math.round(window / 1_000);
  if (thousands < 1_000) return `${thousands}k`;
  return `${Math.round(window / 100_000) / 10}M`;
}

const isCount = (x) => Number.isInteger(x) && x > 0;

/**
 * The one line an adapter appends to a command's result once the fill has reached the limit.
 * Decided in integer tokens as the CLI's `reached` decides (plan call 2), so the floored share it
 * prints is never under the limit it names. A session with no reading yet has reached nothing.
 *
 * @param {number | null | undefined} tokens
 * @param {number | undefined} window
 * @param {number} limit the configured `session.contextLimit`
 * @returns {string | undefined} the warning, or undefined under the limit
 */
export function warnLine(tokens, window, limit) {
  if (!isCount(tokens) || !isCount(window) || !isCount(limit)) return undefined;
  if (tokens * 100 < limit * window) return undefined;
  return `witness: context ${pctOf(tokens, window)}% of ${windowLabel(window)} has reached the ${limit}% limit — finish what you are in (implement: the red→green), then hand over`;
}
