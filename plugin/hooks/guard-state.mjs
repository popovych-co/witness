#!/usr/bin/env node
// witness PreToolUse guard — the Claude Code adapter over canonGuard.
// stdin JSON in, exit 2 + stderr out (stderr is fed back to the model). The logic
// lives in canon-guard.mjs so the Pi extension shares it byte for byte. Any
// parse/read failure exits 0: a broken hook must never brick a session.
import { canonGuard } from './canon-guard.mjs';

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
  let verdict;
  try {
    verdict = canonGuard({
      tool: input.tool_name,
      input: input.tool_input,
      cwd: typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd(),
    });
  } catch {
    process.exit(0);
  }
  if (verdict && verdict.block) {
    process.stderr.write(`${verdict.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
});
