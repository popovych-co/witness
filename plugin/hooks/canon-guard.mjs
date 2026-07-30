// specflow canon guard — the shared core behind every harness's write block.
//
// Dependency-free ON PURPOSE (Decision 13): the Claude Code hook runs from
// ${CLAUDE_PLUGIN_ROOT}, which has no node_modules, and a Pi user's repo has no reason
// to have @whatmatters/specflow installed. An import from the CLI package would
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
    if (existsSync(join(dir, 'specflow.config.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Canon roots from the repo's `paths:` config key (flow or block style), extracted
// without a YAML dependency. Anything unparseable falls back to the defaults.
function canonDirs(root) {
  try {
    const text = readFileSync(join(root, 'specflow.config.yaml'), 'utf8');
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

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function statePathRe(dirs) {
  return new RegExp(`(^|[\\s"'=;|&(])(\\./)?(${dirs.map(escapeRe).join('|')})/`);
}

const WRITEISH = /(>>?|\btee\b|\bsed\b[^\n]*\s-i\b|\bmv\b|\bcp\b|\brm\b|\btouch\b|\btruncate\b|\bdd\b)/;

function reasonFor(what) {
  return (
    `specflow: ${what} is CLI-written state — use the specflow CLI (write / design / adopt), ` +
    'never a direct edit. Direct edits are refused; the Specflow-State trailer audit catches end-runs.'
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
      return { block: true, reason: reasonFor(rel.split('\\').join('/')) };
    }

    if (BASH_TOOLS.has(tool)) {
      const cmd = args.command;
      if (typeof cmd !== 'string') return undefined;
      const root = configRoot(cwd);
      if (!root) return undefined;
      const dirs = canonDirs(root);
      if (statePathRe(dirs).test(cmd) && WRITEISH.test(cmd)) {
        return { block: true, reason: reasonFor(`a ${dirs.map((d) => `${d}/`).join(' or ')} path in that command`) };
      }
      return undefined;
    }

    return undefined;
  } catch {
    return undefined;
  }
}
