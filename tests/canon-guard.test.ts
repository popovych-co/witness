import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonGuard } from '../plugin/hooks/canon-guard.mjs';

function specflowRepo(config = 'schema: 1\n'): string {
  const dir = mkdtempSync(join(tmpdir(), 'canonguard-'));
  writeFileSync(join(dir, 'specflow.config.yaml'), config);
  for (const d of ['specs', 'plans', 'src']) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

describe('canonGuard — Claude Code input shape', () => {
  it('blocks Edit/Write/MultiEdit on canon paths and names the relative path', () => {
    const repo = specflowRepo();
    const r = canonGuard({ tool: 'Edit', input: { file_path: join(repo, 'specs', 'a.md') }, cwd: repo });
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain('specs/a.md');
    expect(r?.reason).toContain('specflow CLI (write / design / adopt)');
    expect(canonGuard({ tool: 'Write', input: { file_path: join(repo, 'plans', 'p.md') }, cwd: repo })?.block).toBe(true);
    expect(canonGuard({ tool: 'MultiEdit', input: { file_path: join(repo, 'specs', 'sub', 'd.md') }, cwd: repo })?.block).toBe(true);
  });

  it('allows non-canon paths, prefix look-alikes and non-specflow repos', () => {
    const repo = specflowRepo();
    mkdirSync(join(repo, 'specsy'), { recursive: true });
    expect(canonGuard({ tool: 'Edit', input: { file_path: join(repo, 'src', 'x.ts') }, cwd: repo })).toBeUndefined();
    expect(canonGuard({ tool: 'Edit', input: { file_path: join(repo, 'specsy', 'x.md') }, cwd: repo })).toBeUndefined();
    const plain = mkdtempSync(join(tmpdir(), 'plain-'));
    mkdirSync(join(plain, 'specs'), { recursive: true });
    expect(canonGuard({ tool: 'Edit', input: { file_path: join(plain, 'specs', 'a.md') }, cwd: plain })).toBeUndefined();
  });
});

describe('canonGuard — Pi input shape', () => {
  it('blocks write/edit on `path`, the key pi actually sends', () => {
    const repo = specflowRepo();
    expect(canonGuard({ tool: 'write', input: { path: join(repo, 'specs', 'a.md') }, cwd: repo })?.block).toBe(true);
    expect(canonGuard({ tool: 'edit', input: { path: 'plans/p.md' }, cwd: repo })?.block).toBe(true);
    expect(canonGuard({ tool: 'write', input: { path: join(repo, 'src', 'x.ts') }, cwd: repo })).toBeUndefined();
  });

  it('blocks lowercase bash the same way as Bash', () => {
    const repo = specflowRepo();
    expect(canonGuard({ tool: 'bash', input: { command: 'echo hi > specs/a.md' }, cwd: repo })?.block).toBe(true);
    expect(canonGuard({ tool: 'bash', input: { command: 'cat specs/a.md' }, cwd: repo })).toBeUndefined();
  });
});

describe('canonGuard — configured canon roots', () => {
  it('follows flow-style and block-style paths:, releasing the defaults', () => {
    const flow = specflowRepo('schema: 1\npaths: { specs: docs/specs, plans: docs/plans }\n');
    mkdirSync(join(flow, 'docs', 'specs'), { recursive: true });
    expect(canonGuard({ tool: 'Edit', input: { file_path: join(flow, 'docs', 'specs', 'a.md') }, cwd: flow })?.block).toBe(true);
    expect(canonGuard({ tool: 'Edit', input: { file_path: join(flow, 'specs', 'a.md') }, cwd: flow })).toBeUndefined();

    const block = specflowRepo('schema: 1\npaths:\n  specs: docs/specs\n  plans: docs/plans\n');
    mkdirSync(join(block, 'docs', 'specs'), { recursive: true });
    expect(canonGuard({ tool: 'Write', input: { file_path: join(block, 'docs', 'specs', 'a.md') }, cwd: block })?.block).toBe(true);
  });
});

describe('canonGuard — fail open', () => {
  it('returns undefined for unknown tools, missing input and garbage', () => {
    const repo = specflowRepo();
    expect(canonGuard({ tool: 'Glob', input: { pattern: 'specs/**' }, cwd: repo })).toBeUndefined();
    expect(canonGuard({ tool: 'Write', input: undefined, cwd: repo })).toBeUndefined();
    expect(canonGuard({ tool: 'Write', input: { file_path: 42 }, cwd: repo })).toBeUndefined();
    expect(canonGuard({ tool: '', input: {}, cwd: '' })).toBeUndefined();
  });
});
