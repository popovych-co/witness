import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_GROUND_RULES, SKILL_PIN_PREFIX } from './helpers';

export const SKILLS = ['specflow-brainstorm', 'specflow-decompose', 'specflow-plan', 'specflow-implement', 'specflow-ship'];
const skillPath = (name: string) => join(__dirname, '..', 'plugin', 'skills', name, 'SKILL.md');

describe('stage skills — shared contract', () => {
  for (const name of SKILLS) {
    it(`${name} has frontmatter, the pin, and the ground rules`, () => {
      const body = readFileSync(skillPath(name), 'utf8');
      const fm = /^---\n([\s\S]*?)\n---/.exec(body);
      expect(fm, 'frontmatter').toBeTruthy();
      expect(fm![1]).toContain(`name: ${name}`);
      expect(fm![1]).toContain('description:');
      expect(body).toContain(SKILL_PIN_PREFIX);
      for (const rule of SKILL_GROUND_RULES) expect(body, rule).toContain(rule);
    });
  }
});

describe('specflow-brainstorm', () => {
  const body = () => readFileSync(skillPath('specflow-brainstorm'), 'utf8');
  it('interviews one question at a time and persists via specflow recap', () => {
    expect(body()).toContain('One question per turn');
    expect(body()).toContain('recap --file');
    expect(body()).toContain('recap --amend');
    expect(body()).toContain('writes no');
  });
  it('carries the fix short form and the goal-id scheme', () => {
    expect(body()).toContain('two questions');
    expect(body()).toContain('g1');
    expect(body()).toContain('n1');
  });
});

describe('specflow-decompose', () => {
  const body = () => readFileSync(skillPath('specflow-decompose'), 'utf8');
  it('routes by class and consults the index', () => {
    expect(body()).toContain('specflow index');
    expect(body()).toContain('THE one spec');
    expect(body()).toContain('write NO specs');
  });
  it('hands manifests to specflow write and gates the effort', () => {
    expect(body()).toContain('write ');
    expect(body()).toContain('--effort');
    expect(body()).toContain('gate decompose');
    expect(body()).toContain('decide decompose');
    expect(body()).toContain('## Motivation');
    expect(body()).toContain('## Behavior');
  });
});

describe('specflow-plan', () => {
  const body = () => readFileSync(skillPath('specflow-plan'), 'utf8');
  it('derives from the CLI delta and emits the step manifest', () => {
    expect(body()).toContain('specflow diff');
    expect(body()).toContain('"steps"');
    expect(body()).toContain('scaffolding');
    expect(body()).toContain('## Step:');
    expect(body()).toContain('-plan-');
  });
  it('never supplies the pin and gates the plan', () => {
    expect(body()).toContain('derives-from');
    expect(body()).toContain('gate plan');
    expect(body()).toContain('decide plan');
  });
});

describe('specflow-implement', () => {
  const body = () => readFileSync(skillPath('specflow-implement'), 'utf8');
  it('starts the worktree and dispatches a fresh subagent', () => {
    expect(body()).toContain('specflow start');
    expect(body()).toContain('fresh subagent');
    expect(body()).toContain('.specflow/worktrees/');
  });
  it('witnesses red and green and gates', () => {
    expect(body()).toContain('test-evidence');
    expect(body()).toContain('--phase red');
    expect(body()).toContain('--phase green');
    expect(body()).toContain('verify-red');
    expect(body()).toContain('gate implement');
    expect(body()).toContain('@spec:');
  });
});

describe('specflow-implement — capture mandate', () => {
  const body = () => readFileSync(skillPath('specflow-implement'), 'utf8');
  it('names the screens dir and per-moment captures', () => {
    expect(body()).toContain('SPECFLOW_SCREENS_DIR');
    expect(body()).toContain('design-reviewer');
    for (const moment of ['initial', 'error', 'success']) expect(body()).toContain(moment);
  });
});

describe('specflow-ship', () => {
  const body = () => readFileSync(skillPath('specflow-ship'), 'utf8');
  it('drives the ship phases and always stops for the human', () => {
    expect(body()).toContain('specflow ship');
    expect(body()).toContain('always stops');
    expect(body()).toContain('decide ship');
  });
  it('owns semantic-conflict resolution and never merges', () => {
    expect(body()).toContain('semantic-conflict');
    expect(body()).toContain('--force-with-lease');
    expect(body()).toContain('Never merge');
  });
});
