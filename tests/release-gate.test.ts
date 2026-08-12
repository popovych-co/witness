import { describe, expect, it } from 'vitest';
// @ts-expect-error - dependency-free .mjs script, no types
import { releaseGate } from '../scripts/release-gate.mjs';

const rules = (rows: { rule: string }[]) => rows.map((r) => r.rule);

describe('release gate', () => {
  it('passes a 0.x tag whose version matches, with the matrix empty', () => {
    const r = releaseGate({ version: '0.4.0', tag: 'v0.4.0', models: [] });
    expect(r.ok).toBe(true);
    expect(rules(r.errors)).toEqual([]);
    expect(rules(r.warnings)).toEqual(['uncalibrated-prerelease']);
  });

  it('refuses a tag that does not match the package version', () => {
    const r = releaseGate({ version: '0.4.0', tag: 'v0.5.0', models: [] });
    expect(r.ok).toBe(false);
    expect(rules(r.errors)).toContain('tag-version-mismatch');
    expect(r.errors[0]).toMatchObject({ field: 'tag', got: 'v0.5.0' });
  });

  // The remedy, not just the delta: a tag ahead of the version is a release cut in the
  // wrong order, and `want v0.4.0` sent the reader to re-tag downward — the rarer half.
  it('names the bump first and the downgrade second', () => {
    const { want } = releaseGate({ version: '0.4.0', tag: 'v0.5.0', models: [] }).errors[0];
    expect(want).toContain('package.json at 0.5.0');
    expect(want).toContain('scripts/release.mjs 0.5.0');
    expect(want.indexOf('package.json at 0.5.0')).toBeLessThan(want.indexOf('re-tag this tree as v0.4.0'));
  });

  it('refuses a 1.x release with an empty calibration matrix', () => {
    const r = releaseGate({ version: '1.0.0', tag: 'v1.0.0', models: [] });
    expect(r.ok).toBe(false);
    expect(rules(r.errors)).toContain('uncalibrated-release');
    expect(rules(r.warnings)).toEqual([]);
  });

  it('passes a 1.x release once the matrix ships a model', () => {
    const r = releaseGate({ version: '1.0.0', tag: 'v1.0.0', models: [{ model: 'claude-fable-5' }] });
    expect(r.ok).toBe(true);
    expect(rules(r.errors)).toEqual([]);
    expect(rules(r.warnings)).toEqual([]);
  });

  it('does not warn on a calibrated 0.x release', () => {
    const r = releaseGate({ version: '0.9.0', tag: 'v0.9.0', models: [{ model: 'claude-fable-5' }] });
    expect(r.ok).toBe(true);
    expect(rules(r.warnings)).toEqual([]);
  });

  it('matches a prerelease tag against a prerelease version', () => {
    const r = releaseGate({ version: '1.0.0-rc.1', tag: 'v1.0.0-rc.1', models: [{ model: 'm' }] });
    expect(r.ok).toBe(true);
  });

  it('treats a 1.x prerelease as 1.x for the calibration rule', () => {
    const r = releaseGate({ version: '1.0.0-rc.1', tag: 'v1.0.0-rc.1', models: [] });
    expect(r.ok).toBe(false);
    expect(rules(r.errors)).toContain('uncalibrated-release');
  });

  it('skips the tag check when invoked without a tag (manual dispatch)', () => {
    const r = releaseGate({ version: '0.4.0', tag: '', models: [] });
    expect(r.ok).toBe(true);
    expect(rules(r.errors)).toEqual([]);
  });

  it('treats a null matrix the same as an empty one', () => {
    const r = releaseGate({ version: '1.0.0', tag: 'v1.0.0', models: null });
    expect(r.ok).toBe(false);
    expect(rules(r.errors)).toContain('uncalibrated-release');
  });
});
