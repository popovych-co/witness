#!/usr/bin/env node
// specflow PreToolUse guard — friction, not the guarantee (the trailer audit is).
// Blocks Edit/Write/MultiEdit on specs/** and plans/** inside specflow repos,
// plus best-effort Bash matching (Decision 31). Exit 2 = block (stderr is fed
// back to the model). Any parse/read failure exits 0: a broken hook must never
// brick a session.
import { existsSync } from 'node:fs';
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

function isStateRel(rel) {
  const posix = rel.split('\\').join('/');
  return posix === 'specs' || posix === 'plans' || posix.startsWith('specs/') || posix.startsWith('plans/');
}

const STATE_PATH = /(^|[\s"'=;|&(])(\.\/)?(specs|plans)\//;
const WRITEISH = /(>>?|\btee\b|\bsed\b[^\n]*\s-i\b|\bmv\b|\bcp\b|\brm\b|\btouch\b|\btruncate\b|\bdd\b)/;

function block(what) {
  process.stderr.write(
    `specflow: ${what} is CLI-written state — hand a manifest to \`specflow write\` ` +
      `(or \`specflow adopt <path>\` for a finished hand-edit). Direct edits are refused; ` +
      `the Specflow-State trailer audit catches end-runs.\n`,
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
      if (isStateRel(rel)) block(rel.split('\\').join('/'));
      process.exit(0);
    }
    if (tool === 'Bash') {
      const cmd = input.tool_input && input.tool_input.command;
      if (typeof cmd !== 'string') process.exit(0);
      if (!configRoot(cwd)) process.exit(0);
      if (STATE_PATH.test(cmd) && WRITEISH.test(cmd)) block('a specs/ or plans/ path in that command');
      process.exit(0);
    }
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
