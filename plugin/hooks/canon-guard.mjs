// witness canon guard — the shared core behind every harness's write block.
//
// Dependency-free ON PURPOSE (Decision 13): the Claude Code hook runs from
// ${CLAUDE_PLUGIN_ROOT}, which has no node_modules, and a Pi user's repo has no reason
// to have @popovych.co/witness installed. An import from the CLI package would
// resolve-fail into the fail-open path on both — a SILENTLY ABSENT guard. Adapters
// import this file by relative path and stay thin.
//
// Friction, not the guarantee (the trailer audit is) — Decision 31. Anything
// unparseable falls open: a broken guard must never brick a session.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

// Claude Code and Pi vocabularies. Pi has no MultiEdit; Claude Code has no lowercase
// forms. Listing both keeps the adapters free of translation tables.
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'edit', 'write']);
const BASH_TOOLS = new Set(['Bash', 'bash']);

function configRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'witness.config.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Canon roots from the repo's `paths:` config key (flow or block style), extracted
// without a YAML dependency. Anything unparseable falls back to the defaults.
function canonDirs(root) {
  try {
    const text = readFileSync(join(root, 'witness.config.yaml'), 'utf8');
    const flow = text.match(/^paths:[ \t]*\{([^}]*)\}/m);
    const section = flow ? flow[1] : (text.match(/^paths:[ \t]*\n((?:[ \t]+\S.*\n?)*)/m) || [])[1] || '';
    const dir = (key) => {
      const m = section.match(new RegExp(`(?:^|[\\s{,])${key}:[ \\t]*['"]?([^'"\\s,}#]+)`, 'm'));
      return m ? m[1].replace(/\/+$/, '') : key;
    };
    return [dir('specs'), dir('plans'), dir('designs')];
  } catch {
    return ['specs', 'plans', 'designs'];
  }
}

function isStateRel(rel, dirs) {
  const posix = rel.split('\\').join('/');
  return dirs.some((d) => posix === d || posix.startsWith(`${d}/`));
}

// ── Bash: mutation targets, not mentions (Decision 133) ─────────────────────────────
//
// The old shape blocked when a state path and a writeish token co-occurred ANYWHERE in the
// command string. That fails CLOSED on ambiguity, against this file's own contract — and it
// blocked `grep "Do not touch" <plan>`, because \btouch\b matched inside the search string.
//
// The shape now: mask quoted regions and heredoc bodies OFFSET-PRESERVINGLY, read structure
// only from unmasked text, resolve every candidate target from the ORIGINAL command at the
// same offsets, and block a segment only when a resolved target is a state path. Resolving
// from the original is what the offset preservation is FOR: matching against the masked text
// instead would let `echo hi > "docs/plans/p1.md"` fall open, and a quoted path is how an
// agent usually spells one.
const CODE = 0;      // shell structure lives here, and only here
const QUOTED = 1;    // inside '…' or "…" — part of a token, never structure
const FILLER = 2;    // a heredoc body — neither structure nor token

function maskOf(cmd) {
  const mask = new Uint8Array(cmd.length);
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '<' && cmd[i + 1] === '<') {
      // <<TAG, <<-TAG, <<'TAG', <<"TAG" — the body is the reporter's own case: an issue
      // written with `cat > /tmp/x.md <<'EOF'` quoting a plan path it must not be blocked for
      const m = /^<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(cmd.slice(i));
      if (m) {
        const nl = cmd.indexOf('\n', i + m[0].length);
        if (nl === -1) { i += m[0].length; continue; }
        const term = new RegExp(`\\n[ \\t]*${m[2]}[ \\t]*(?=\\n|$)`).exec(cmd.slice(nl));
        const end = term ? nl + term.index + term[0].length : cmd.length;
        mask.fill(FILLER, nl + 1, end);
        i = end;
        continue;
      }
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== c) j += c === '"' && cmd[j] === '\\' ? 2 : 1;
      // unterminated: everything after it is unparseable, so mask it and fall open
      const end = Math.min(j, cmd.length);
      mask.fill(QUOTED, i + 1, end);
      i = end + 1;
      continue;
    }
    i++;
  }
  return mask;
}

// Separators found in UNMASKED text only, so a quoted `;` or `|` cannot split a segment.
const SEPARATORS = ';|&\n()';

function segmentsOf(cmd, mask) {
  const out = [];
  let start = 0;
  for (let i = 0; i < cmd.length; i++) {
    if (mask[i] === CODE && SEPARATORS.includes(cmd[i])) { out.push([start, i]); start = i + 1; }
  }
  out.push([start, cmd.length]);
  return out.filter(([a, b]) => b > a);
}

// A masked FILLER char separates like whitespace; a QUOTED one joins, which is what keeps a
// quoted path one token. Token text comes from the original command, quotes and all.
const isBreak = (cmd, mask, i) => mask[i] === FILLER || (mask[i] === CODE && /\s/.test(cmd[i]));

function tokensOf(cmd, mask, from, to) {
  const out = [];
  let i = from;
  while (i < to) {
    if (isBreak(cmd, mask, i)) { i++; continue; }
    const start = i;
    while (i < to && !isBreak(cmd, mask, i)) i++;
    out.push(cmd.slice(start, i));
  }
  return out;
}

const unquote = (t) => t.replace(/['"]/g, '');

// Redirect targets, located by the operator in unmasked text: `>`, `>>`, `2>`, `&>`. `>&2`
// and `2>&1` duplicate a descriptor and have no path target at all.
function redirectTargets(cmd, mask, from, to) {
  const out = [];
  for (let i = from; i < to; i++) {
    if (mask[i] !== CODE || cmd[i] !== '>') continue;
    let j = i + 1;
    while (j < to && cmd[j] === '>') j++;
    while (j < to && mask[j] === CODE && /[ \t]/.test(cmd[j])) j++;
    if (j >= to || (mask[j] === CODE && cmd[j] === '&')) continue;
    const start = j;
    while (j < to && !isBreak(cmd, mask, j) && !(mask[j] === CODE && cmd[j] === '>')) j++;
    if (j > start) out.push(cmd.slice(start, j));
    i = j - 1;
  }
  return out;
}

// Command words that write their arguments. Same set the co-occurrence guard used — this row
// narrows the JUDGMENT, not the vocabulary.
const MUTATORS = new Set(['mv', 'cp', 'rm', 'tee', 'touch', 'truncate', 'dd']);
// Words that stand in front of the real command word rather than being one.
const PREFIXES = new Set(['sudo', 'command', 'env', 'time', 'nice', 'nohup', 'xargs']);

function mutatorTargets(tokens) {
  const none = { word: undefined, targets: [] };
  let i = 0;
  let word;
  for (; i < tokens.length; i++) {
    const w = unquote(tokens[i]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w.startsWith('-')) continue;   // env assignment / a prefix's flag
    const base = w.split('/').pop();
    if (PREFIXES.has(base)) continue;
    word = base;
    break;
  }
  if (word === undefined) return none;
  let args = tokens.slice(i + 1);
  // `git rm` / `git mv` mutate canon under a command word that is not itself a mutator.
  // `git checkout`/`restore` deliberately stay open: restoring canon is how a hand edit in a
  // worktree is REVERTED, which is the remedy `check` names.
  if (word === 'git') {
    const sub = args.find((a) => !unquote(a).startsWith('-'));
    if (sub === undefined || (unquote(sub) !== 'rm' && unquote(sub) !== 'mv')) return none;
    word = `git ${unquote(sub)}`;
    args = args.slice(args.indexOf(sub) + 1);
  }
  const files = args.filter((a) => !unquote(a).startsWith('-'));
  if (word === 'sed') {
    return { word, targets: args.some((a) => /^--?i/.test(unquote(a))) ? files : [] };
  }
  // cp writes only its destination — `cp <plan> /tmp/x` copies canon OUT, which is a read.
  // mv has no such half: its source is destroyed, so every argument is a target.
  if (word === 'mv' || word === 'git rm' || word === 'git mv') return { word, targets: files };
  if (word === 'cp') return { word, targets: files.slice(-1) };
  return MUTATORS.has(word) ? { word, targets: files } : none;
}

// A token is a state path when the FILESYSTEM says so, not when its spelling does — the same
// resolve-then-relativise predicate the Write/Edit branch above uses, so one fact has one
// home and an absolute or `../`-relative target lands where a regex over the raw string
// never could. `key=value` forms (`dd of=…`, `--file=…`) are tested on both halves.
function stateTargetRel(root, cwd, token, dirs) {
  const raw = unquote(token);
  const eq = /^[A-Za-z0-9_-]+=(.+)$/.exec(raw);
  for (const cand of eq ? [raw, eq[1]] : [raw]) {
    if (cand === '') continue;
    const rel = relative(root, isAbsolute(cand) ? cand : resolve(cwd, cand)).split('\\').join('/');
    if (rel !== '' && !rel.startsWith('..') && isStateRel(rel, dirs)) return rel;
  }
  return undefined;
}

// Decision 146. D133 made the reason name the path and what writes it; this completes it to
// the remedy contract gate stops already honor (D121): a shape for authoring, and a fully
// runnable `adopt` for an edit already made. No effort slug is knowable inside a hook that
// reads only the tool call, so the write line stays a LABELLED SHAPE and never a `run:` —
// a rendered command that needs editing before it runs is D129's defect in a new dress.
function remedyFor(rel, root) {
  const [specs, plans, designs] = canonDirs(root);
  const base = rel.split('/').pop() ?? rel;
  if (isStateRel(rel, [designs])) {
    const id = base.replace(/\.html$/, '');
    return `remedy: witness design ${id} --file <your.html> (author in $(mktemp -d); --open shows the current one)`;
  }
  const id = base.replace(/\.md$/, '');
  const kind = isStateRel(rel, [plans]) ? plans : specs;
  return (
    `remedy: witness write ${id} --effort <effort> --meta <m.json> --body <b.md> ` +
    `(author in $(mktemp -d), never in ${kind}/) · already hand-edited? run: witness adopt ${rel}`
  );
}

function reasonFor(what, rel, root) {
  return (
    `witness: ${what} is CLI-written state — use the witness CLI (write / design / adopt), ` +
    'never a direct edit. Direct edits are refused; the Witness-State trailer audit catches end-runs. ' +
    remedyFor(rel, root)
  );
}

/**
 * @param {{ tool?: unknown, input?: unknown, cwd?: unknown }} call
 * @returns {{ block: true, reason: string } | undefined}
 */
export function canonGuard(call) {
  try {
    const tool = typeof call?.tool === 'string' ? call.tool : '';
    const args = call?.input && typeof call.input === 'object' ? call.input : {};
    const cwd = typeof call?.cwd === 'string' && call.cwd !== '' ? call.cwd : process.cwd();

    if (WRITE_TOOLS.has(tool)) {
      // Claude Code sends file_path; pi sends path (core/tools/write.js:12).
      const fp = typeof args.file_path === 'string' ? args.file_path : args.path;
      if (typeof fp !== 'string' || fp === '') return undefined;
      const abs = isAbsolute(fp) ? fp : resolve(cwd, fp);
      const root = configRoot(dirname(abs));
      if (!root) return undefined;
      const rel = relative(root, abs);
      if (rel.startsWith('..')) return undefined;
      if (!isStateRel(rel, canonDirs(root))) return undefined;
      const posix = rel.split('\\').join('/');
      return { block: true, reason: reasonFor(posix, posix, root) };
    }

    if (BASH_TOOLS.has(tool)) {
      const cmd = args.command;
      if (typeof cmd !== 'string' || cmd === '') return undefined;
      const root = configRoot(cwd);
      if (!root) return undefined;
      const dirs = canonDirs(root);
      const mask = maskOf(cmd);
      for (const [from, to] of segmentsOf(cmd, mask)) {
        const mut = mutatorTargets(tokensOf(cmd, mask, from, to));
        const candidates = [
          ...redirectTargets(cmd, mask, from, to).map((t) => [t, 'a redirect target']),
          ...mut.targets.map((t) => [t, `a ${mut.word} target`]),
        ];
        for (const [token, how] of candidates) {
          // Name the RESOLVED target and what writes it. The old message named a directory
          // set and never the token that tripped it — which is why a block on a search string
          // read as a bug in the guard rather than a fact about the command.
          const rel = stateTargetRel(root, cwd, token, dirs);
          if (rel) return { block: true, reason: reasonFor(`${rel} (${how})`, rel, root) };
        }
      }
      return undefined;
    }

    return undefined;
  } catch {
    return undefined;
  }
}
