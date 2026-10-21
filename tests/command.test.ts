import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_PIN_PREFIX } from './helpers';

const body = () => readFileSync(join(__dirname, '..', 'plugin', 'commands', 'witness.md'), 'utf8');

describe('/witness command', () => {
  it('has frontmatter with description and the --manual hint', () => {
    const fm = /^---\n([\s\S]*?)\n---/.exec(body());
    expect(fm).toBeTruthy();
    expect(fm![1]).toContain('description:');
    expect(fm![1]).toContain('--manual');
  });

  it('loops over witness next and invokes every stage skill', () => {
    const b = body();
    expect(b).toContain(SKILL_PIN_PREFIX);
    expect(b).toContain('witness next');
    for (const s of ['witness-brainstorm', 'witness-decompose', 'witness-plan', 'witness-implement', 'witness-ship']) {
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
    expect(body()).toContain('witness gate');
  });
});

describe('design stage in the motion surfaces', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  it('the /witness loop routes stage: design', () => {
    const cmd = read('plugin/commands/witness.md');
    expect(cmd).toMatch(/stage: design/);
    expect(cmd).toContain('witness-design');
  });
  it('the /witness loop hands off when home: is elsewhere', () => {
    const cmd = read('plugin/commands/witness.md');
    expect(cmd).toMatch(/`home:`/);
    expect(cmd).toMatch(/END YOUR TURN/);
    expect(cmd).toMatch(/--manual/);
  });
  it('decompose documents the ui flag both directions', () => {
    const d = read('plugin/skills/witness-decompose/SKILL.md');
    expect(d).toContain('ui: true');
    expect(d.toLowerCase()).toContain('browser');
  });
  it('plan requires the approved design for ui parents', () => {
    const p = read('plugin/skills/witness-plan/SKILL.md');
    expect(p).toContain('design-from');
  });
});

describe('the engine under autonomy (A8)', () => {
  it('defers to the CLI under autonomy and stops only where it names a human (A8)', () => {
    const b = body();
    for (const s of ['## Under `autonomy: on`', 'Never run `witness decide`', '`kept-stop:`', '`merged:`']) expect(b, s).toContain(s);
    expect(b).toContain('END YOUR TURN');
    expect(b).toContain('Never merge');
    expect(b).toContain('`--manual` on `gate` and `ship` when armed');
  });

  it('queues the words it was given as an ask (A9)', () => {
    expect(body()).toContain('$WITNESS ask "<those words>"')
    expect(/^---\n([\s\S]*?)\n---/.exec(body())![1]).toContain('[what to build]')
  })
});

describe('drive handoff rows (B1)', () => {
  it('hands an autonomous run to drive before any other row (B1)', () => {
    const b = body()
    for (const s of ['`launch:` is printed and this session is not `--manual`-armed', '`watch:` is printed and no `launch:`', '`drive: done` is printed']) {
      expect(b).toContain(s)
    }
    expect(b.indexOf('`launch:` is printed')).toBeLessThan(b.indexOf('A `choose:` block is printed'))
  })
})
