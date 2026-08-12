import { describe, expect, it } from 'vitest';
// @ts-expect-error - dependency-free .mjs script, no types
import { nextVersion, releasePreflight } from '../scripts/release.mjs';

const clean = { current: '0.11.0', branch: 'main', dirty: false, tags: ['v0.11.0'] };
const rules = (rows: { rule: string }[]) => rows.map((r) => r.rule);

describe('nextVersion', () => {
  it('resolves the three keywords', () => {
    expect(nextVersion('0.11.0', 'patch')).toBe('0.11.1');
    expect(nextVersion('0.11.0', 'minor')).toBe('0.12.0');
    expect(nextVersion('0.11.0', 'major')).toBe('1.0.0');
  });

  it('takes an explicit version as given, prerelease included', () => {
    expect(nextVersion('0.11.0', '0.12.3')).toBe('0.12.3');
    expect(nextVersion('0.11.0', '1.0.0-rc.1')).toBe('1.0.0-rc.1');
  });

  it('drops a prerelease identifier on a keyword bump', () => {
    expect(nextVersion('1.0.0-rc.1', 'patch')).toBe('1.0.1');
  });

  it('is undefined for anything else', () => {
    expect(nextVersion('0.11.0', 'v0.12.0')).toBeUndefined();
    expect(nextVersion('0.11.0', '')).toBeUndefined();
  });
});

describe('release preflight', () => {
  it('passes a clean patch bump on main', () => {
    const r = releasePreflight({ ...clean, spec: 'patch' });
    expect(r.ok).toBe(true);
    expect(r.target).toBe('0.11.1');
    expect(rules(r.errors)).toEqual([]);
  });

  // The failure this script exists to prevent, from the other end: the tag is derived
  // from package.json, so a tag that already exists means the version was already cut.
  it('refuses a version whose tag already exists, and names the deletion', () => {
    const r = releasePreflight({ ...clean, spec: '0.11.0', tags: ['v0.11.0', 'v0.11.1'] });
    expect(r.ok).toBe(false);
    expect(rules(r.errors)).toContain('tag-exists');
    expect(r.errors.find((e: { rule: string }) => e.rule === 'tag-exists').want)
      .toContain('git push origin :refs/tags/v0.11.0');
  });

  it('refuses off main, because a tag must name a commit reachable from it', () => {
    const r = releasePreflight({ ...clean, spec: 'patch', branch: 'release-0.11.1' });
    expect(r.ok).toBe(false);
    expect(rules(r.errors)).toContain('not-main');
  });

  it('refuses a dirty tree, which would mix the stamp with the work', () => {
    const r = releasePreflight({ ...clean, spec: 'patch', dirty: true });
    expect(r.ok).toBe(false);
    expect(rules(r.errors)).toContain('dirty');
  });

  it('refuses an unparsable spec', () => {
    const r = releasePreflight({ ...clean, spec: 'nope' });
    expect(r.ok).toBe(false);
    expect(rules(r.errors)).toContain('unparsable');
    expect(r.target).toBeUndefined();
  });

  it('refuses a bump that changes nothing', () => {
    const r = releasePreflight({ ...clean, spec: '0.11.0', tags: [] });
    expect(r.ok).toBe(false);
    expect(rules(r.errors)).toContain('no-change');
  });

  it('reports every broken rule at once, not the first', () => {
    const r = releasePreflight({ current: '0.11.0', spec: 'patch', branch: 'wip', dirty: true, tags: ['v0.11.1'] });
    expect(rules(r.errors).sort()).toEqual(['dirty', 'not-main', 'tag-exists']);
  });
});
