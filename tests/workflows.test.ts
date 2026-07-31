import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const wf = (name: string) => parse(readFileSync(join(__dirname, '..', '.github', 'workflows', name), 'utf8'));
const raw = (name: string) => readFileSync(join(__dirname, '..', '.github', 'workflows', name), 'utf8');

describe('workflow tiers', () => {
  it('ci runs per commit, model-free — no API key, no calibrate', () => {
    const y = wf('ci.yml');
    expect(Object.keys(y.on)).toEqual(expect.arrayContaining(['push', 'pull_request']));
    expect(raw('ci.yml')).not.toContain('ANTHROPIC_API_KEY');
    expect(raw('ci.yml')).not.toContain('calibrate');
  });

  it('calibration runs nightly, on dispatch with a model input, and on prompt/fixture changes', () => {
    const y = wf('calibration.yml');
    expect(y.on.schedule[0].cron).toBeDefined();
    expect(y.on.workflow_dispatch.inputs.model).toBeDefined();
    expect(y.on.pull_request.paths).toEqual(expect.arrayContaining(['prompts/**', 'calibration/**']));
    expect(raw('calibration.yml')).toContain('ANTHROPIC_API_KEY');
    expect(raw('calibration.yml')).not.toContain('--publish');
  });

  it('release requires tests, version sync, and the release gate', () => {
    const r = raw('release.yml');
    expect(wf('release.yml').on.push.tags).toBeDefined();
    expect(r).toContain('sync-versions');
    expect(r).toContain('scripts/release-gate.mjs');
    expect(r).toContain('npm publish');
  });

  it('release publishes with provenance and holds the OIDC permission', () => {
    const y = wf('release.yml');
    expect(y.permissions['id-token']).toBe('write');
    expect(raw('release.yml')).toContain('--provenance');
  });

  it('release is model-free — no API key on the publish path', () => {
    expect(raw('release.yml')).not.toContain('ANTHROPIC_API_KEY');
  });
});
