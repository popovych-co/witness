import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROMPT_NAMES } from '../src/reviewer';

const calRoot = join(__dirname, '..', 'calibration', 'reviewers');
const dirs = (p: string) => (existsSync(p) ? readdirSync(p).filter((n) => statSync(join(p, n)).isDirectory()) : []);
const filesUnder = (p: string): string[] =>
  dirs(p)
    .flatMap((d) => filesUnder(join(p, d)).map((f) => join(d, f)))
    .concat(existsSync(p) ? readdirSync(p).filter((n) => statSync(join(p, n)).isFile()) : []);

describe('reviewer calibration suites', () => {
  for (const reviewer of PROMPT_NAMES) {
    describe(reviewer, () => {
      const dir = join(calRoot, reviewer);
      it('has suite.json with a valid kind and a non-empty base', () => {
        const suite = JSON.parse(readFileSync(join(dir, 'suite.json'), 'utf8'));
        expect(['docs', 'tree', 'screens']).toContain(suite.kind);
        expect(filesUnder(join(dir, 'base')).length).toBeGreaterThan(0);
      });
      it('has ≥ 4 defect seeds and ≥ 1 injection twin, each well-formed', () => {
        const seeds = dirs(join(dir, 'seeds'));
        const injects = dirs(join(dir, 'inject'));
        expect(seeds.length).toBeGreaterThanOrEqual(4);
        expect(injects.length).toBeGreaterThanOrEqual(1);
        for (const [group, ids] of [['seeds', seeds], ['inject', injects]] as const) {
          for (const id of ids) {
            const seedDir = join(dir, group, id);
            expect(filesUnder(join(seedDir, 'overlay')).length, `${group}/${id} overlay`).toBeGreaterThan(0);
            const expectJson = JSON.parse(readFileSync(join(seedDir, 'expect.json'), 'utf8'));
            expect(typeof expectJson.defect, `${group}/${id} expect.defect`).toBe('string');
          }
        }
      });
      it('injection twins embed a report-clean instruction', () => {
        for (const id of dirs(join(dir, 'inject'))) {
          const texts = filesUnder(join(dir, 'inject', id, 'overlay')).map((f) => readFileSync(join(dir, 'inject', id, 'overlay', f), 'utf8'));
          expect(texts.some((t) => t.toLowerCase().includes('report clean')), id).toBe(true);
        }
      });
    });
  }
});

describe('design-critic calibration suite', () => {
  const dir = join(calRoot, 'design-critic');
  it('declares kind and carries base + seeds + inject', () => {
    expect(JSON.parse(readFileSync(join(dir, 'suite.json'), 'utf8')).kind).toBe('docs');
    expect(existsSync(join(dir, 'base'))).toBe(true);
    for (const s of ['s1-canon-violation', 's2-missing-behavior', 's3-unrealizable'])
      expect(existsSync(join(dir, 'seeds', s, 'expect.json'))).toBe(true);
    expect(existsSync(join(dir, 'inject', 'i1-report-clean-injected', 'expect.json'))).toBe(true);
  });
});

describe('slicing-critic ui-flag seeds', () => {
  const dir = join(calRoot, 'slicing-critic', 'seeds');
  it('carries both ui-flag honesty seeds', () => {
    for (const s of ['s5-ui-flag-missing', 's6-ui-flag-spurious'])
      expect(existsSync(join(dir, s, 'expect.json'))).toBe(true);
  });
});

describe('delta-mode fixtures (C3)', () => {
  for (const reviewer of PROMPT_NAMES) {
    const dir = join(calRoot, reviewer, 'delta')
    if (!existsSync(dir)) continue
    it(`${reviewer}: delta seeds live in tree suites and say where their defect sits`, () => {
      expect(JSON.parse(readFileSync(join(calRoot, reviewer, 'suite.json'), 'utf8')).kind).toBe('tree')
      for (const id of dirs(dir)) {
        const seed = join(dir, id)
        const want = JSON.parse(readFileSync(join(seed, 'expect.json'), 'utf8'))
        expect(typeof want.defect, id).toBe('string')
        expect(['block', 'demote'], id).toContain(want.expect)
        expect(Array.isArray(want.findings), id).toBe(true)
        const changed = filesUnder(join(seed, 'overlay'))
        expect(changed.length, id).toBeGreaterThan(0)
        if (want.expect === 'block') expect(changed, id).toContain(want.site)
        else {
          expect(changed, id).not.toContain(want.site)
          expect(existsSync(join(seed, 'round1', want.site)) || existsSync(join(calRoot, reviewer, 'base', want.site)), id).toBe(true)
        }
      }
    })
  }
  it('code-reviewer carries a changed-code catch, an unchanged-code demotion and an injected change', () => {
    for (const id of ['d1-defect-in-change', 'd2-defect-unchanged', 'd3-injected-change']) {
      expect(existsSync(join(calRoot, 'code-reviewer', 'delta', id, 'expect.json')), id).toBe(true)
    }
    const injected = filesUnder(join(calRoot, 'code-reviewer', 'delta', 'd3-injected-change', 'overlay'))
      .map((f) => readFileSync(join(calRoot, 'code-reviewer', 'delta', 'd3-injected-change', 'overlay', f), 'utf8'))
    expect(injected.some((t) => t.toLowerCase().includes('report clean'))).toBe(true)
  })
})
