import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const guard = join(__dirname, '..', 'plugin', 'hooks', 'guard-state.mjs');

function runGuard(input: unknown): { code: number; stderr: string } {
  const r = spawnSync('node', [guard], { input: JSON.stringify(input), encoding: 'utf8' });
  return { code: r.status ?? -1, stderr: r.stderr };
}

function witnessRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfhook-'));
  writeFileSync(join(dir, 'witness.config.yaml'), 'schema: 1\n');
  mkdirSync(join(dir, 'specs'), { recursive: true });
  mkdirSync(join(dir, 'plans'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  return dir;
}

function plainDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plain-'));
  mkdirSync(join(dir, 'specs'), { recursive: true });
  return dir;
}

describe('guard-state hook — Edit/Write/MultiEdit', () => {
  it('blocks Edit on specs/** in a witness repo, pointing at the witness CLI', () => {
    const repo = witnessRepo();
    const r = runGuard({ tool_name: 'Edit', tool_input: { file_path: join(repo, 'specs', 'auth.md') }, cwd: repo });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('witness CLI (write / design / adopt)');
  });

  it('blocks Write on plans/** and MultiEdit on nested specs paths', () => {
    const repo = witnessRepo();
    expect(runGuard({ tool_name: 'Write', tool_input: { file_path: join(repo, 'plans', 'p1.md') }, cwd: repo }).code).toBe(2);
    expect(runGuard({ tool_name: 'MultiEdit', tool_input: { file_path: join(repo, 'specs', 'sub', 'deep.md') }, cwd: repo }).code).toBe(2);
  });

  it('allows non-state paths in a witness repo and prefix look-alikes', () => {
    const repo = witnessRepo();
    mkdirSync(join(repo, 'specsy'), { recursive: true });
    expect(runGuard({ tool_name: 'Edit', tool_input: { file_path: join(repo, 'src', 'x.ts') }, cwd: repo }).code).toBe(0);
    expect(runGuard({ tool_name: 'Edit', tool_input: { file_path: join(repo, 'specsy', 'x.md') }, cwd: repo }).code).toBe(0);
  });

  it('is inert outside witness repos', () => {
    const dir = plainDir();
    expect(runGuard({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'specs', 'a.md') }, cwd: dir }).code).toBe(0);
  });
});

describe('guard-state hook — configured canon paths', () => {
  function docsRepo(config: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'sfhook-'));
    writeFileSync(join(dir, 'witness.config.yaml'), config);
    mkdirSync(join(dir, 'docs', 'specs'), { recursive: true });
    mkdirSync(join(dir, 'specs'), { recursive: true });
    return dir;
  }

  it('guards the configured roots and releases the defaults (flow style)', () => {
    const repo = docsRepo('schema: 1\npaths: { specs: docs/specs, plans: docs/plans }\n');
    expect(runGuard({ tool_name: 'Edit', tool_input: { file_path: join(repo, 'docs', 'specs', 'a.md') }, cwd: repo }).code).toBe(2);
    expect(runGuard({ tool_name: 'Edit', tool_input: { file_path: join(repo, 'specs', 'a.md') }, cwd: repo }).code).toBe(0);
    expect(runGuard({ tool_name: 'Bash', tool_input: { command: 'echo hi > docs/specs/a.md' }, cwd: repo }).code).toBe(2);
    expect(runGuard({ tool_name: 'Bash', tool_input: { command: 'echo hi > specs/a.md' }, cwd: repo }).code).toBe(0);
  });

  it('reads block-style paths too', () => {
    const repo = docsRepo('schema: 1\npaths:\n  specs: docs/specs\n  plans: docs/plans\n');
    expect(runGuard({ tool_name: 'Write', tool_input: { file_path: join(repo, 'docs', 'specs', 'a.md') }, cwd: repo }).code).toBe(2);
    expect(runGuard({ tool_name: 'Write', tool_input: { file_path: join(repo, 'plans', 'p.md') }, cwd: repo }).code).toBe(0);
  });
});

describe('guard-state hook — Bash (best-effort)', () => {
  it('blocks writes into state paths', () => {
    const repo = witnessRepo();
    expect(runGuard({ tool_name: 'Bash', tool_input: { command: 'echo hi > specs/a.md' }, cwd: repo }).code).toBe(2);
    expect(runGuard({ tool_name: 'Bash', tool_input: { command: "sed -i '' plans/p.md" }, cwd: repo }).code).toBe(2);
    expect(runGuard({ tool_name: 'Bash', tool_input: { command: 'rm specs/a.md' }, cwd: repo }).code).toBe(2);
  });

  it('allows reads and non-state commands, and everything outside witness repos', () => {
    const repo = witnessRepo();
    expect(runGuard({ tool_name: 'Bash', tool_input: { command: 'cat specs/a.md' }, cwd: repo }).code).toBe(0);
    expect(runGuard({ tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: repo }).code).toBe(0);
    expect(runGuard({ tool_name: 'Bash', tool_input: { command: 'echo hi > specs/a.md' }, cwd: plainDir() }).code).toBe(0);
  });
});

describe('guard-state hook — fail-open', () => {
  it('exits 0 on malformed JSON, empty stdin, and unknown tools', () => {
    expect(spawnSync('node', [guard], { input: 'not json', encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('node', [guard], { input: '', encoding: 'utf8' }).status).toBe(0);
    expect(runGuard({ tool_name: 'Glob', tool_input: { pattern: 'specs/**' }, cwd: witnessRepo() }).code).toBe(0);
  });
});

describe('hooks.json', () => {
  it('wires the guard for Edit|Write|MultiEdit and Bash via CLAUDE_PLUGIN_ROOT', () => {
    const cfg = JSON.parse(readFileSync(join(__dirname, '..', 'plugin', 'hooks', 'hooks.json'), 'utf8'));
    const pre = cfg.hooks.PreToolUse;
    expect(pre.map((e: { matcher: string }) => e.matcher)).toEqual(['Edit|Write|MultiEdit', 'Bash']);
    for (const entry of pre) {
      expect(entry.hooks[0].command).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/guard-state.mjs');
    }
  });
});
