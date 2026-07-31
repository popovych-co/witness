import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSkillSeeds, runSkillSuites, type AgentRunner } from '../src/calibrate';
import { main } from '../src/cli';
import { renderRefusal } from '../src/refusal';
import { fakeCtx, fakeScenario, gateEnv, putVerdict, tmpRepo } from './helpers';
import { loadHarness } from '../src/harness';

async function runCalibrate(root: string, scenario: string, args: string[]) {
  const outs: string[] = [];
  const ctx = fakeCtx(root, { env: gateEnv(scenario), out: (l) => outs.push(l) });
  const code = await main(ctx, ['calibrate', ...args]);
  return { code, out: outs.join('\n') };
}

async function runCalibrateWithAgent(root: string, scenario: string, agent: AgentRunner) {
  const ctx = fakeCtx(root, { env: gateEnv(scenario) });
  const hx = loadHarness('claude-code');
  if (!hx.ok) throw new Error('registry');
  const r = await runSkillSuites(ctx, hx.value, 'claude-fable-5', 1, { only: 'implement', agent });
  if (!r.ok) return { code: 2, out: renderRefusal(r.violations).join('\n') };
  const pass = r.value.every((s) => s.pass);
  return { code: pass ? 0 : 1, out: r.value.map((s) => `${s.skill} ${s.ok}/${s.total}`).join('\n') };
}

const spec = (id: string, meta: Record<string, unknown>, body: string) => ({ id, meta, body });
const specMeta = (summary: string, covers: string[], tag: string) => ({
  type: 'spec',
  summary,
  depends: [],
  needs: [],
  criteria: [{ id: 'ac-1', test: `@spec:${tag}` }],
  covers,
});
const body = '## Motivation\n\nSeeded.\n\n## Behavior\n\nObservable behavior with a stated threshold: 5.\n';

describe('skill seeds are well-formed', () => {
  it('loads 5 decompose, 4 plan, 3 implement seeds', () => {
    expect(loadSkillSeeds('decompose').length).toBe(5);
    expect(loadSkillSeeds('plan').length).toBe(4);
    expect(loadSkillSeeds('implement').length).toBe(3);
  });
});

describe('decompose contract (fake claude)', () => {
  it('PASS on a valid two-spec envelope', async () => {
    const scenario = fakeScenario();
    putVerdict(scenario, {
      artifacts: [
        spec('unread-badge', specMeta('In-app unread badge within 5 seconds', ['g1'], 'unread-badge'), body),
        spec('digest-opt-out', specMeta('Users can opt out of the email digest', ['g2'], 'digest-opt-out'), body),
      ],
    });
    const r = await runCalibrate(tmpRepo().root, scenario, ['claude-fable-5', '--only', 'decompose', '--samples', '1']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/decompose.*1\/1/s);
  });

  it('FAIL when the non-goal bait is taken (forbid trap)', async () => {
    const scenario = fakeScenario();
    // sample 1 → seed s1 (valid); sample 2 → seed s2 whose envelope mentions redis
    putVerdict(scenario, {
      artifacts: [
        spec('unread-badge', specMeta('In-app unread badge within 5 seconds', ['g1'], 'unread-badge'), body),
        spec('digest-opt-out', specMeta('Users can opt out of the email digest', ['g2'], 'digest-opt-out'), body),
      ],
    }, 1);
    putVerdict(scenario, {
      artifacts: [spec('page-cache', specMeta('Cache product pages in Redis', ['g1'], 'page-cache'), body)],
    }, 2);
    const r = await runCalibrate(tmpRepo().root, scenario, ['claude-fable-5', '--only', 'decompose', '--samples', '2']);
    expect(r.code).toBe(1);
  });
});

describe('plan contract (fake claude)', () => {
  it('PASS on a valid one-plan envelope mapping both criteria', async () => {
    const scenario = fakeScenario();
    putVerdict(scenario, {
      artifacts: [{
        id: 'slug-format-plan-1',
        meta: {
          type: 'plan',
          parent: 'slug-format',
          depends: [],
          needs: [],
          steps: [{ id: 's1', title: 'implement slugify', criteria: ['ac-fmt', 'ac-len'] }],
        },
        body: '## Step: s1\n\nFailing test first, then implement; green.\n',
      }],
    });
    const r = await runCalibrate(tmpRepo().root, scenario, ['claude-fable-5', '--only', 'plan', '--samples', '1']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/plan.*1\/1/s);
  });
});

describe('implement contract (scripted agent)', () => {
  const scriptedAgent: AgentRunner = async (ctx, worktree) => {
    const pkg = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')) as { name: string };
    const wctx = fakeCtx(worktree, { env: ctx.env });
    mkdirSync(join(worktree, 'tests'), { recursive: true });

    async function redGreen(tag: string, testFile: string, testCode: string, implPath: string, implCode: string) {
      writeFileSync(join(worktree, 'tests', testFile), testCode);
      await main(wctx, ['test-evidence', `${tag}-plan-1`, '--phase', 'red']);
      writeFileSync(join(worktree, implPath), implCode);
      await main(wctx, ['test-evidence', `${tag}-plan-1`, '--phase', 'green']);
    }

    if (pkg.name === 'cal-implement-s1') {
      await redGreen(
        'clamp-range',
        'cal.test.mjs',
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp } from '../src/clamp.mjs';\ntest('clamps into range @spec:clamp-range', () => {\n  assert.equal(clamp(5, 0, 3), 3);\n  assert.equal(clamp(-1, 0, 3), 0);\n  assert.equal(clamp(Number.NaN, 0, 3), 0);\n  assert.throws(() => clamp(1, 3, 0), RangeError);\n});\n",
        'src/clamp.mjs',
        "export function clamp(value, lo, hi) {\n  if (lo > hi) throw new RangeError('lo > hi');\n  if (Number.isNaN(value)) return lo;\n  return Math.min(hi, Math.max(lo, value));\n}\n",
      );
    } else if (pkg.name === 'cal-implement-s2') {
      await redGreen(
        'slug-trim',
        'cal.test.mjs',
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slug.mjs';\ntest('trims leading/trailing hyphens @spec:slug-trim', () => {\n  assert.equal(slugify(' hello '), 'hello');\n});\n",
        'src/slug.mjs',
        "export function slugify(title) {\n  return title\n    .toLowerCase()\n    .trim()\n    .replace(/\\s+/g, '-')\n    .replace(/[^a-z0-9-]/g, '')\n    .replace(/-+/g, '-');\n}\n",
      );
    } else if (pkg.name === 'cal-implement-s3') {
      await redGreen(
        'pad-strings',
        'cal-left.test.mjs',
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { padLeft } from '../src/pad.mjs';\ntest('pads left @spec:pad-strings', () => {\n  assert.equal(padLeft('7', 3, '0'), '007');\n  assert.equal(padLeft('777', 2, '0'), '777');\n});\n",
        'src/pad.mjs',
        "export function padLeft(str, width, ch) {\n  return str.length >= width ? str : ch.repeat(width - str.length) + str;\n}\n",
      );
      await redGreen(
        'pad-strings',
        'cal-right.test.mjs',
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { padRight } from '../src/pad.mjs';\ntest('pads right @spec:pad-strings', () => {\n  assert.equal(padRight('7', 3, '0'), '700');\n  assert.equal(padRight('777', 2, '0'), '777');\n});\n",
        'src/pad.mjs',
        "export function padLeft(str, width, ch) {\n  return str.length >= width ? str : ch.repeat(width - str.length) + str;\n}\n\nexport function padRight(str, width, ch) {\n  return str.length >= width ? str : str + ch.repeat(width - str.length);\n}\n",
      );
    }
  };

  // spawns real vitest runs repeatedly — comfortably under 10s alone, but the
  // default 20s bound flakes under full-suite parallel load
  it('3/3 with a red→green agent; 0/3 with a no-op agent', async () => {
    const pass = await runCalibrateWithAgent(tmpRepo().root, fakeScenario(), scriptedAgent);
    expect(pass.out).toMatch(/implement.*3\/3/s);
    const idle = await runCalibrateWithAgent(tmpRepo().root, fakeScenario(), async () => {});
    expect(idle.code).toBe(1);
  }, 60_000);
});
