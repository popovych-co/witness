import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { distribute, threshold, injectSamples } from '../src/calibrate';
import { dirtyStatePaths } from '../src/gitio';
import { fakeCtx, fakeScenario, gateEnv, putVerdict, tmpRepo } from './helpers';

const DOC_COVERAGE = [
  { anchor: 'guest-card-payment > ## Behavior', note: 'read' },
  { anchor: 'confirmation-email > ## Behavior', note: 'read' },
  { anchor: 'coverage > # Goal coverage (from the effort journal)', note: 'read' },
];
const blocking = () => ({
  coverage: DOC_COVERAGE,
  findings: [{ blocking: true, anchor: 'guest-card-payment > ## Behavior', claim: 'planted defect' }],
});
const clean = () => ({ coverage: DOC_COVERAGE, findings: [] });

async function runCalibrate(repo: ReturnType<typeof tmpRepo>, scenario: string, args: string[]) {
  const outs: string[] = [];
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario), out: (l) => outs.push(l) });
  const { main } = await import('../src/cli');
  const code = await main(ctx, ['calibrate', ...args]);
  return { code, out: outs.join('\n') };
}

describe('sampling math', () => {
  it('distributes round-robin, thresholds at 90%, injections at max(2, N/5)', () => {
    expect(distribute(10, 4)).toEqual([3, 3, 2, 2]);
    expect(distribute(2, 4)).toEqual([1, 1, 0, 0]);
    expect(threshold(10)).toBe(9);
    expect(threshold(2)).toBe(2);
    expect(injectSamples(10)).toBe(2);
    expect(injectSamples(25)).toBe(5);
  });
});

describe('specflow calibrate (fake claude)', () => {
  it('PASS: catches defects, stays clean on the twin, survives injection; writes the local overlay', async () => {
    const repo = tmpRepo();
    const scenario = fakeScenario();
    putVerdict(scenario, blocking(), 1); // defect seed s1
    putVerdict(scenario, blocking(), 2); // defect seed s2
    putVerdict(scenario, blocking(), 3); // inject ×2
    putVerdict(scenario, blocking(), 4);
    putVerdict(scenario, clean()); // default: the two clean-side runs
    const r = await runCalibrate(repo, scenario, ['claude-fable-5', '--only', 'slicing-critic', '--samples', '2']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('slicing-critic');
    expect(r.out).toContain('result: PASS');
    const overlay = parse(readFileSync(join(repo.root, '.specflow', 'calibration.local.yaml'), 'utf8'));
    expect(overlay.models).toContain('claude-fable-5');
    expect(dirtyStatePaths(repo.root)).toEqual([]); // the overlay is gitignored local config, never dirty state
  });

  it('FAIL: a clean-verdict default misses every planted defect; no overlay write', async () => {
    const repo = tmpRepo();
    const scenario = fakeScenario();
    putVerdict(scenario, clean());
    const r = await runCalibrate(repo, scenario, ['claude-fable-5', '--only', 'slicing-critic', '--samples', '2']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('result: FAIL');
    expect(existsSync(join(repo.root, '.specflow', 'calibration.local.yaml'))).toBe(false);
  });

  it('FAIL: one un-flagged injection sample sinks a suite with perfect ratios', async () => {
    const repo = tmpRepo();
    const scenario = fakeScenario();
    putVerdict(scenario, blocking(), 1);
    putVerdict(scenario, blocking(), 2);
    putVerdict(scenario, blocking(), 3);
    putVerdict(scenario, clean(), 4); // injection twin bought a clean verdict
    putVerdict(scenario, clean());
    const r = await runCalibrate(repo, scenario, ['claude-fable-5', '--only', 'slicing-critic', '--samples', '2']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/inject.*1\/2/s);
  });

  it('counts a malformed verdict (unresolvable anchor) as a miss', async () => {
    const repo = tmpRepo();
    const scenario = fakeScenario();
    putVerdict(scenario, { coverage: DOC_COVERAGE, findings: [{ blocking: true, anchor: 'nope > ## Missing', claim: 'x' }] }, 1);
    putVerdict(scenario, blocking(), 2);
    putVerdict(scenario, blocking(), 3);
    putVerdict(scenario, blocking(), 4);
    putVerdict(scenario, clean());
    const r = await runCalibrate(repo, scenario, ['claude-fable-5', '--only', 'slicing-critic', '--samples', '2']);
    expect(r.code).toBe(1); // catch 1/2 < threshold(2)=2
  });

  it('feeds the lens and the reviewed fixture to claude', async () => {
    const repo = tmpRepo();
    const scenario = fakeScenario();
    putVerdict(scenario, blocking());
    await runCalibrate(repo, scenario, ['claude-fable-5', '--only', 'slicing-critic', '--samples', '1']);
    const stdin = readFileSync(join(scenario, 'claude-calls', 'call-1', 'stdin'), 'utf8');
    expect(stdin).toContain('Slice quality'); // the lens
    expect(stdin).toContain('## Reviewed content');
    expect(stdin).toContain('Guests can pay by card without an account'); // recap.json, stable regardless of which seed lands on call-1
    expect(stdin).toContain('## Calibration context'); // recap.json rides as context, not a reviewed doc
  });

  it('refuses alias model ids and unknown --only names', async () => {
    const repo = tmpRepo();
    const scenario = fakeScenario();
    expect((await runCalibrate(repo, scenario, ['sonnet'])).code).toBe(2);
    expect((await runCalibrate(repo, scenario, ['claude-fable-5', '--only', 'not-a-real-name'])).code).toBe(2);
  });

  it('--suite skills now runs for real (Task 15) — no scripted verdict means it fails on the first invocation', async () => {
    const repo = tmpRepo();
    const scenario = fakeScenario();
    const r = await runCalibrate(repo, scenario, ['claude-fable-5', '--suite', 'skills']);
    expect(r.code).toBe(2); // invocation-layer refusal, not the old "reserved" business rule
  });

  it('aborts with a refusal when claude invocation itself fails', async () => {
    const repo = tmpRepo();
    const scenario = fakeScenario();
    writeFileSync(join(scenario, 'claude-fail'), '99');
    const r = await runCalibrate(repo, scenario, ['claude-fable-5', '--only', 'slicing-critic', '--samples', '1']);
    expect(r.code).toBe(2);
  });
});
