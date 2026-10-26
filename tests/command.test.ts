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

// Row 195. A chat under autonomy keeps only the human's own items; drive's machine stages are drive's.
describe('the chat keeps only the human\'s items (row 195)', () => {
  it('launch: and watch: act on a decision, a trust act, a brainstorm or a design — otherwise the chat waits', () => {
    const rows = body().split('\n').filter((l) => l.startsWith('| `launch:` is printed') || l.startsWith('| `watch:` is printed'))
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      // row 204: the human's items stay in the chat (a trust act too, row 205); otherwise it waits
      expect(r).toContain('if `next:` names `witness decide` or `witness trust`, or `stage:` is `brainstorm` or `design`')
      expect(r).not.toContain('or a `stage:` is printed')
      expect(r).toContain('Otherwise wait, by the `wait-mode:` line')
    }
  })
  // Row 205 (Q4): trust grants and unmet needs are answered in this chat, never in a terminal;
  // a grant is per named command, and a bare "y" grants nothing.
  it('the kept-stop rows answer trust grants and needs in the chat', () => {
    const rows = body().split('\n').filter((l) => l.startsWith('| `kept-stop:') || l.startsWith('| `next:` names `witness trust`'))
    const trust = rows.find((r) => r.includes('`kept-stop: trust grant`'))!
    expect(trust).toContain('`--cmd`')
    expect(trust).toContain('a bare "y" grants nothing')
    // final review I2: the kept stop renders and keeps matching, so a `launch:` below it still
    // starts drive's other work; the `next: witness trust` row asks and ends the turn
    expect(trust).not.toContain('END YOUR TURN')
    expect(trust).toContain('keep matching the rows below')
    expect(rows.find((r) => r.startsWith('| `next:` names `witness trust`'))).toContain('**END YOUR TURN**')
    const need = rows.find((r) => r.includes('`kept-stop: unmet need`'))!
    expect(need).toContain('"done"')
    expect(need).toContain('one need at a time')
    expect(rows.some((r) => r.startsWith('| `next:` names `witness trust`'))).toBe(true)
    expect(body()).toContain('A `kept-stop: design look` line is the chat\'s own stop')
    expect(body()).not.toContain('a trust grant in a terminal')
  })
})

// Row 204. The chat sleeps until something needs the human and is woken, in one session.
describe('the chat waits (row 204)', () => {
  it('launch: and watch: wait by wait-mode instead of ending the chat for good', () => {
    const b = body()
    for (const s of ['wait-mode:', 'run_in_background', '`background`', '`add-on`', '`foreground`']) expect(b, s).toContain(s)
  })
  it('each wait: outcome has its row', () => {
    const b = body()
    for (const s of ['`wait: needs you`', '`wait: drive stopped', '`wait: taken over by another chat`', 'never wait again in this chat',
      "`wait: replaced by this chat's newer wait`",
      '`wait: merged on GitHub`', '`wait: nothing owed`']) expect(b, s).toContain(s)
    expect(b).toContain('never restart drive yourself')
  })
})
