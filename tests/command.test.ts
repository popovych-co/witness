import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_PIN_PREFIX } from './helpers';

const body = () => readFileSync(join(__dirname, '..', 'plugin', 'commands', 'specflow.md'), 'utf8');

describe('/specflow command', () => {
  it('has frontmatter with description and the --manual hint', () => {
    const fm = /^---\n([\s\S]*?)\n---/.exec(body());
    expect(fm).toBeTruthy();
    expect(fm![1]).toContain('description:');
    expect(fm![1]).toContain('--manual');
  });

  it('loops over specflow next and invokes every stage skill', () => {
    const b = body();
    expect(b).toContain(SKILL_PIN_PREFIX);
    expect(b).toContain('specflow next');
    for (const s of ['specflow-brainstorm', 'specflow-decompose', 'specflow-plan', 'specflow-implement', 'specflow-ship']) {
      expect(b).toContain(s);
    }
  });

  it('stops on pending decisions and no-progress, and never decides', () => {
    const b = body();
    expect(b).toContain('decide');
    expect(b).toContain('END YOUR TURN');
    expect(b).toContain('no progress');
    expect(b).toContain('Never merge');
  });

  it('propagates --manual to every gate invocation', () => {
    expect(body()).toContain('--manual');
    expect(body()).toContain('specflow gate');
  });
});

describe('design stage in the motion surfaces', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  it('the /specflow loop routes stage: design', () => {
    const cmd = read('plugin/commands/specflow.md');
    expect(cmd).toMatch(/stage: design/);
    expect(cmd).toContain('specflow-design');
  });
  it('the /specflow loop hands off when home: is elsewhere', () => {
    const cmd = read('plugin/commands/specflow.md');
    expect(cmd).toMatch(/`home:`/);
    expect(cmd).toMatch(/END YOUR TURN/);
    expect(cmd).toMatch(/--manual/);
  });
  it('decompose documents the ui flag both directions', () => {
    const d = read('plugin/skills/specflow-decompose/SKILL.md');
    expect(d).toContain('ui: true');
    expect(d.toLowerCase()).toContain('browser');
  });
  it('plan requires the approved design for ui parents', () => {
    const p = read('plugin/skills/specflow-plan/SKILL.md');
    expect(p).toContain('design-from');
  });
});
