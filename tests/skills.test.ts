import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_GROUND_RULES, SKILL_PIN_PREFIX } from './helpers';

// witness-design joins this list: it is a stage skill like the rest, and leaving it out
// meant the shared-contract loop never checked it — the five-of-six skew rows 102 and 117
// exist to close, invisible because the loop could not see the sixth file.
export const SKILLS = ['witness-brainstorm', 'witness-decompose', 'witness-plan', 'witness-implement', 'witness-ship', 'witness-design'];
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

describe('witness-brainstorm', () => {
  const body = () => readFileSync(skillPath('witness-brainstorm'), 'utf8');
  it('interviews one question at a time and persists via witness recap', () => {
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

describe('witness-decompose', () => {
  const body = () => readFileSync(skillPath('witness-decompose'), 'utf8');
  it('routes by class and consults the index', () => {
    expect(body()).toContain('witness index');
    expect(body()).toContain('THE one spec');
    expect(body()).toContain('write NO specs');
  });
  it('hands manifests to witness write and gates the effort', () => {
    expect(body()).toContain('write ');
    expect(body()).toContain('--effort');
    expect(body()).toContain('gate decompose');
    expect(body()).toContain('decide decompose');
    expect(body()).toContain('## Motivation');
    expect(body()).toContain('## Behavior');
  });
  // `next` skips the whole decompose stage for a chore: the gate refuses nothing-to-gate
  // without specs and `write` refuses spec content from a chore, so the stage is
  // unsatisfiable in both directions and the skill must not claim it always runs.
  it('does not claim the chore path always runs', () => {
    expect(body()).not.toContain('it never skips');
  });
});

describe('witness-plan', () => {
  const body = () => readFileSync(skillPath('witness-plan'), 'utf8');
  it('derives from the CLI delta and emits the step manifest', () => {
    expect(body()).toContain('witness diff');
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
  // A chore never reaches the decompose stage, so choosing its plan's parent lands here:
  // the spec whose implementation area the chore touches, else `principles`.
  it('owns the chore parent choice decompose no longer routes', () => {
    expect(body()).toContain('implementation area');
    expect(body()).toContain('principles');
  });
});

describe('witness-implement', () => {
  const body = () => readFileSync(skillPath('witness-implement'), 'utf8');
  it('starts the worktree; the session is the implementer', () => {
    expect(body()).toContain('witness start');
    expect(body()).toContain('this session is the implementer');
    expect(body()).toContain('.witness/worktrees/');
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

describe('witness-implement — capture mandate', () => {
  const body = () => readFileSync(skillPath('witness-implement'), 'utf8');
  it('names the screens dir and per-moment captures', () => {
    expect(body()).toContain('WITNESS_SCREENS_DIR');
    expect(body()).toContain('design-reviewer');
    for (const moment of ['initial', 'error', 'success']) expect(body()).toContain(moment);
  });
});

describe('witness-ship', () => {
  const body = () => readFileSync(skillPath('witness-ship'), 'utf8');
  it('drives the ship phases and always stops for the human', () => {
    expect(body()).toContain('witness ship');
    expect(body()).toContain('always stops');
    expect(body()).toContain('decide ship');
  });
  it('owns semantic-conflict resolution and never merges', () => {
    expect(body()).toContain('semantic-conflict');
    expect(body()).toContain('--force-with-lease');
    expect(body()).toContain('Never merge');
  });
});

describe('design-critic prompt', () => {
  const critic = () => readFileSync(join(__dirname, '..', 'prompts', 'design-critic.md'), 'utf8');
  it('actively checks for sections the spec does not promise', () => {
    expect(critic()).toContain('Name every section that renders nothing');
  });
});

// D128. Nine copies of the exits set existed in this system; 0.10.1 removed the four in CLI
// code, and these assertions are what stop the five in skill prose from coming back. Skill
// prose is the most expensive surface to change — a payload release plus a version-floor bump
// per tweak, for every downstream repo — so the block's SHAPE is CLI-owned and skills carry
// one key-agnostic rule about rendering it.
describe('the block is CLI-owned', () => {
  it('no skill body carries an exit set', () => {
    const offenders: string[] = []
    for (const name of SKILLS) {
      const body = readFileSync(skillPath(name), 'utf8')
      for (const [i, line] of body.split('\n').entries()) {
        const flags = (line.match(/--(approve|revise|stop|override|repair)/g) ?? []).length
        if (flags >= 2 && line.includes(' | ')) offenders.push(`${name}:${i + 1}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every skill states the render rule without naming a key', () => {
    for (const name of SKILLS) {
      const body = readFileSync(skillPath(name), 'utf8')
      expect(body, name).toContain('verbatim and in full')
      // sentence-initial in the prose, so the assertion carries the same capital
      expect(body, name).toContain('Never print a command set you remember')
    }
  })
})

// D125. The interview is the one decision surface with no CLI screen, and it was asking with
// three fields while the block asks with five. A human should meet ONE shape everywhere in
// this pipeline. This pins the INSTRUCTION, not compliance: compliance is unverifiable here
// by construction — the skill calibration suites measure the artifact a skill produces via a
// headless runner, brainstorm has no seed directory, and a multi-turn interview with a human
// answering has no headless form.
describe('the interview asks the same way the CLI does', () => {
  it('brainstorm states the five-field form', () => {
    const body = readFileSync(skillPath('witness-brainstorm'), 'utf8')
    for (const f of ['recommendation', 'why', 'alternative', 'when', 'tradeoff']) {
      expect(body, f).toContain(f)
    }
    expect(body).toContain('One question per turn')
  })

  it('design convergence asks the same way', () => {
    const body = readFileSync(skillPath('witness-design'), 'utf8')
    expect(body).toContain('the strongest alternative with when it wins and what it costs')
  })
})
