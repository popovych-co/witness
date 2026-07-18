#!/usr/bin/env node
// specflow PreToolUse guard — friction, not the guarantee (the trailer audit is).
// Blocks Edit/Write/MultiEdit on specs/** and plans/** inside specflow repos,
// plus best-effort Bash matching (Decision 31). Exit 2 = block (stderr is fed
// back to the model). Any parse/read failure exits 0: a broken hook must never
// brick a session.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

function configRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'specflow.config.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Canon roots from the repo's `paths:` config key (flow or block style),
// extracted without a YAML dependency — the hook must stay standalone.
// Anything unparseable falls back to the defaults: friction, not the guarantee.
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

function block(what) {
  process.stderr.write(
    `specflow: ${what} is CLI-written state — use the specflow CLI (write / design / adopt), ` +
      `never a direct edit. Direct edits are refused; the Specflow-State trailer audit catches end-runs.\n`,
  );
  process.exit(2);
}

let raw = '';
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  try {
    const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
    const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
    if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
      const fp = input.tool_input && input.tool_input.file_path;
      if (typeof fp !== 'string' || fp === '') process.exit(0);
      const abs = isAbsolute(fp) ? fp : resolve(cwd, fp);
      const root = configRoot(dirname(abs));
      if (!root) process.exit(0);
      const rel = relative(root, abs);
      if (rel.startsWith('..')) process.exit(0);
      if (isStateRel(rel, canonDirs(root))) block(rel.split('\\').join('/'));
      process.exit(0);
    }
    if (tool === 'Bash') {
      const cmd = input.tool_input && input.tool_input.command;
      if (typeof cmd !== 'string') process.exit(0);
      const root = configRoot(cwd);
      if (!root) process.exit(0);
      const dirs = canonDirs(root);
      if (statePathRe(dirs).test(cmd) && WRITEISH.test(cmd)) {
        block(`a ${dirs.map((d) => `${d}/`).join(' or ')} path in that command`);
      }
      process.exit(0);
    }
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
