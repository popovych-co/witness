import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hook = join(__dirname, '..', 'plugin', 'hooks', 'session-dashboard.sh');

function runHook(cwd: string, env: Record<string, string> = {}): { code: number; stdout: string } {
  const r = spawnSync('sh', [hook], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
  });
  return { code: r.status ?? -1, stdout: r.stdout };
}

function stubBin(dir: string): string {
  const bin = join(dir, 'stub-specflow.sh');
  writeFileSync(bin, '#!/bin/sh\necho "specflow: stub-dashboard"\n');
  chmodSync(bin, 0o755);
  return bin;
}

describe('session-dashboard hook', () => {
  it('prints the dashboard in a specflow repo (via SPECFLOW_BIN)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfdash-'));
    writeFileSync(join(dir, 'specflow.config.yaml'), 'schema: 1\n');
    const r = runHook(dir, { SPECFLOW_BIN: stubBin(dir) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('specflow: stub-dashboard');
  });

  it('is silent outside specflow repos, even with SPECFLOW_BIN set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-'));
    const r = runHook(dir, { SPECFLOW_BIN: stubBin(dir) });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('swallows CLI failures (exit 0, session start must survive)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sffail-'));
    writeFileSync(join(dir, 'specflow.config.yaml'), 'schema: 1\n');
    const bad = join(dir, 'bad.sh');
    writeFileSync(bad, '#!/bin/sh\nexit 7\n');
    chmodSync(bad, 0o755);
    expect(runHook(dir, { SPECFLOW_BIN: bad }).code).toBe(0);
  });

  it('defaults to the npx pin and is wired in hooks.json', () => {
    expect(readFileSync(hook, 'utf8')).toContain('${SPECFLOW_BIN:-npx -y @specflow/cli@');
    const cfg = JSON.parse(readFileSync(join(__dirname, '..', 'plugin', 'hooks', 'hooks.json'), 'utf8'));
    expect(cfg.hooks.SessionStart[0].hooks[0].command).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/session-dashboard.sh');
  });
});
