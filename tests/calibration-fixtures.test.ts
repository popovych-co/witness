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
        expect(['docs', 'tree']).toContain(suite.kind);
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
