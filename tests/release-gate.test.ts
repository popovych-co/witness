import { describe, expect, it } from 'vitest';
// @ts-expect-error - dependency-free .mjs script, no types
import { releaseGate } from '../scripts/release-gate.mjs';

const rules = (rows: { rule: string }[]) => rows.map((r) => r.rule);

describe('release gate', () => {
  it('passes a tag that names the version, 0.x and 1.x alike — no matrix rule (row 212)', () => {
    for (const version of ['0.26.0', '1.0.0', '1.0.0-rc.1']) {
      expect(releaseGate({ version, tag: `v${version}` })).toEqual({ ok: true, errors: [] });
    }
  });

  it('refuses a tag that does not match the package version', () => {
    const r = releaseGate({ version: '0.4.0', tag: 'v0.5.0' });
    expect(r.ok).toBe(false);
    expect(rules(r.errors)).toContain('tag-version-mismatch');
    expect(r.errors[0]).toMatchObject({ field: 'tag', got: 'v0.5.0' });
  });

  // The remedy, not just the delta: a tag ahead of the version is a release cut in the
  // wrong order, and `want v0.4.0` sent the reader to re-tag downward — the rarer half.
  it('names the bump first and the downgrade second', () => {
    const { want } = releaseGate({ version: '0.4.0', tag: 'v0.5.0' }).errors[0];
    expect(want).toContain('package.json at 0.5.0');
    expect(want).toContain('scripts/release.mjs 0.5.0');
    expect(want.indexOf('package.json at 0.5.0')).toBeLessThan(want.indexOf('re-tag this tree as v0.4.0'));
  });

  it('skips the tag check when invoked without a tag (manual dispatch)', () => {
    const r = releaseGate({ version: '0.4.0', tag: '' });
    expect(r.ok).toBe(true);
    expect(rules(r.errors)).toEqual([]);
  });
});
