import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// The engine file carried `no Task subagents, ever` while every skill was clean, so a
// skills-only scope would miss the single worst offender. Both trees, always.
function neutralFiles(): string[] {
  return [...walk(join(root, 'plugin', 'skills')), ...walk(join(root, 'plugin', 'commands'))]
    .filter((f) => f.endsWith('.md'));
}

// Decision 3: harness-specific strings live in the CLI, not in the prose. The RULE is
// that commands and tool names are CLI-supplied; harness *names* stay legal in prose
// (README needs them, and a regex banning "Pi" is unimplementable). The list below is a
// ratchet of what has actually leaked, not the specification — when a new harness lands,
// add its commands here. Each entry is [pattern, what to say instead]; the message is
// the whole point of the test.
const BANNED: Array<[RegExp, string]> = [
  // Anchored so `docs/new` cannot false-positive. `/new` is banned alongside `/clear`
  // so nobody "fixes" a neutrality failure by naming the other harness's command.
  [/(^|[\s("'`])\/(clear|new)\b/,
    'the relay command is CLI-printed — print the `relay:` line witness next / dispatch-report emitted, and say nothing about what it contains'],
  [/MultiEdit/, 'name no harness-specific tool — say "any file-writing tool"; the guard names the real one when it fires'],
  [/PreToolUse/, 'say "the canon guard" — the hook is a Claude Code implementation detail'],
  // Revision 2: `\bsubagents?\b`, not `Task subagents?`. The narrower pattern left the
  // implement:39 and ship:29 rewrites OPTIONAL, which is how a truncated replacement
  // block came within one copy-paste of deleting the dispatch-budget mechanism.
  [/\bsubagents?\b/i,
    'say "a fresh session is the execution model" — dispatch and subagents are Claude Code vocabulary, and row 82 retired them anyway'],
  [/invoke skill/i, 'say "use the `<name>` skill" — Pi has no skill-invocation tool, only a read-the-file instruction'],
];

describe('harness neutrality', () => {
  it('scans the skills and the engine file', () => {
    const files = neutralFiles();
    expect(files.length).toBeGreaterThanOrEqual(7);   // six skills + the engine
    expect(files.some((f) => f.endsWith(join('commands', 'witness.md')))).toBe(true);
  });

  for (const [pattern, remedy] of BANNED) {
    it(`no ${pattern.source} in skills or commands`, () => {
      const hits = neutralFiles()
        .flatMap((f) => readFileSync(f, 'utf8').split('\n')
          .map((line, i) => ({ f, n: i + 1, line }))
          .filter((r) => pattern.test(r.line)))
        .map((r) => `${r.f.slice(root.length + 1)}:${r.n}: ${r.line.trim().slice(0, 120)}`);
      expect(hits.join('\n'), remedy).toBe('');
    });
  }
});
