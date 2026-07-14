import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const LICENSE_FILES = [
  'pr-review-toolkit-Apache-2.0.txt',
  'superpowers-MIT.txt',
  'mattpocock-skills-MIT.txt',
  'no-mistakes-MIT.txt',
];

describe('LICENSES/', () => {
  it('carries every vendor license text', () => {
    for (const f of LICENSE_FILES) {
      const p = join(root, 'LICENSES', f);
      expect(existsSync(p), f).toBe(true);
      const body = readFileSync(p, 'utf8');
      expect(body.length, f).toBeGreaterThan(500);
      if (f.includes('Apache')) expect(body).toContain('Apache License');
      else expect(body).toContain('Permission is hereby granted');
    }
  });
});

describe('NOTICE.md', () => {
  const notice = () => readFileSync(join(root, 'NOTICE.md'), 'utf8');

  it('maps every vendored and derived surface to its source and license file', () => {
    const n = notice();
    for (const f of LICENSE_FILES) expect(n).toContain(`LICENSES/${f}`);
    for (const p of ['prompts/code-reviewer.md', 'prompts/silent-failure-hunter.md', 'prompts/type-design.md', 'prompts/pr-test.md']) {
      expect(n).toContain(p);
    }
    for (const s of ['specflow-brainstorm', 'specflow-plan', 'specflow-implement', 'specflow-ship']) {
      expect(n).toContain(s);
    }
  });

  it('records the specops zero-text rule', () => {
    expect(notice()).toContain('specops');
    expect(notice().toLowerCase()).toContain('no text was copied');
  });
});

describe('package files', () => {
  it('ships LICENSES and NOTICE.md with the npm package', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('LICENSES');
    expect(pkg.files).toContain('NOTICE.md');
  });
});
