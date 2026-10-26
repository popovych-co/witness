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
  // Row 197. The grill walks the whole tree for every class: no short forms.
  it('walks every class whole and carries the id scheme', () => {
    expect(body()).toContain('No short forms');
    expect(body()).not.toContain('two questions');
    expect(body()).toContain('g1');
    expect(body()).toContain('n1');
    expect(body()).toContain('d1');
  });
  // Rows 197 and 199. It opens on an ask, saves as it goes, and ends in a critique pass and a playback.
  it('is the grill: an ask first, a draft per answer, a critique pass and a playback', () => {
    expect(body()).toContain('witness draft');
    expect(body()).toContain('what do you want to build?');
    expect(body()).toContain('critique pass');
    expect(body()).toContain('playback');
    expect(body()).not.toContain('Stateless by design');
    expect(body()).not.toMatch(/recap --amend <effort>/);
  });
  // Final review (B-I4). An amendment has no ask: a literal agent must not queue one for it.
  it('an amendment queues no ask', () => {
    expect(body()).toContain('An amendment queues no ask');
  });
});

// D142 prose half. The CLI rebases on origin/<branch> (`ship.ts`), so a recipe that rebases
// the LOCAL ref recreates the stale base the CLI just refused.
describe('witness-ship', () => {
  it('rebases the remote tip in the manual-conflict recipe', () => {
    const body = readFileSync(skillPath('witness-ship'), 'utf8');
    expect(body).toContain('git fetch origin <ship-branch>');
    expect(body).toContain('git rebase origin/<ship-branch>');
    expect(body).not.toMatch(/^git rebase <ship-branch>/m);
  });
});

// D156. The five fields are a minimum to exceed, not a checklist to complete.
describe('witness-brainstorm interview floor', () => {
  it('names the floor as a floor', () => {
    const body = readFileSync(skillPath('witness-brainstorm'), 'utf8');
    expect(body).toContain('the floor, not the count');
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
  // Row 199. The re-interview a scope stop sends back starts from the latest recap.
  it('starts a scope amendment from its draft seed', () => {
    expect(body()).toContain('draft amend-<effort>');
  });
  // Final review (B-I4). Re-entered after the re-interview option, the skill hands the effort to the
  // grill instead of re-slicing against the recap the human just rejected.
  it('re-entered after the re-interview option, never re-slices against the old recap', () => {
    expect(body()).toContain('never re-slice against the recap the human rejected');
  });

  it('hands a dangling-parent re-slice to the human (D166)', () => {
    expect(body()).toContain('dangling-parent');
    expect(body()).toContain('never abandon it yourself');
  });

  it('names the ids and paths a new spec cannot take (D166)', () => {
    expect(body()).toContain('id-taken');
    expect(body()).toContain('path-taken');
  });

  it('reads the decisions and carries every one (row 198)', () => {
    expect(body()).toContain('"carries"');
    expect(body()).toContain('decision-coverage');
    expect(body()).toContain('read <effort> --decisions');
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

  it('reads the decisions it must not contradict and never supplies their pin (row 198)', () => {
    expect(body()).toContain('--decisions');
    expect(body()).toContain('decisions-from');
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
  // Row 205: no session grants trust — a refusal for an untrusted command is the human's.
  it('stops on an untrusted- refusal and never grants trust', () => {
    expect(body()).toContain("**An `untrusted-` refusal is the human's.**");
    expect(body()).toContain('Never run `witness trust` — no session grants trust.');
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

// D132. Canon has one home, so a skill that reads it by path is reading a file that is not
// there. The positive half rides SKILL_GROUND_RULES; this is the negative half, in the style
// of row 128's. The pattern is deliberately just the `cat` shape: `designs/` also appears
// legitimately as a WRITE destination (the design skill's output contract), so a broader
// path-mention ban would false-positive — prose references are closed by editing them.
describe('canon is read through the CLI', () => {
  it('no skill body reads a canon path with cat', () => {
    const offenders: string[] = []
    for (const name of SKILLS) {
      const body = readFileSync(skillPath(name), 'utf8')
      for (const [i, line] of body.split('\n').entries()) {
        if (/\bcat\s+["']?(\.\/)?(specs|plans|designs)\//.test(line)) offenders.push(`${name}:${i + 1}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every skill names the read verb it must use instead', () => {
    for (const name of SKILLS) {
      expect(readFileSync(skillPath(name), 'utf8'), name).toContain('witness read <id>')
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
  // Row 197 amends this: up to three ranked answers in the block's own field words, pick first.
  it('brainstorm states the ranked-answers form', () => {
    const body = readFileSync(skillPath('witness-brainstorm'), 'utf8')
    for (const f of ['why', 'when', 'tradeoff', 'up to three', 'never padded']) {
      expect(body, f).toContain(f)
    }
    expect(body).toContain('One question per turn')
  })

  // Row 200: the design session converges the same way, after showing rendered, checked directions.
  it('design convergence asks the same way', () => {
    const body = readFileSync(skillPath('witness-design'), 'utf8')
    expect(body).toContain('up to three ranked')
    expect(body).toContain('--preview')
    expect(body).toContain('not checked')
    expect(body).not.toContain('the strongest alternative with when it wins and what it costs')
  })

  // Final review (A-I2, B-I1). A behavior note at the approval stop settles the stop first, so no
  // stale look can be approved and the design draft survives the amendment.
  it('a behavior note at the approval stop settles the stop with a revise upstream first', () => {
    const body = readFileSync(skillPath('witness-design'), 'utf8')
    expect(body).toContain('witness decide design <spec-id> --revise --upstream <effort> --note')
    const cmd = readFileSync(join(__dirname, '..', 'plugin', 'commands', 'witness.md'), 'utf8')
    expect(cmd).toContain('**A behavior answer**')
  })
})

// D127. The block makes option 1 easy to run, and a bare "ok" is the state where that
// convenience becomes the agent deciding. Reserved stops exist because a human must LOOK.
describe('the execution protocol', () => {
  it('every skill states that a named option may be run byte-for-byte', () => {
    for (const name of SKILLS) {
      const body = readFileSync(skillPath(name), 'utf8')
      expect(body, name).toContain('names an option')
      expect(body, name).toContain('byte-for-byte')
      // D143 amends D127 for exactly one case: a CLI-rendered block with a recommendation.
      expect(body, name).toContain('selects the recommended option')
      expect(body, name).toContain('--via affirmation')
    }
  })

  it('the loop states it once for the driven turn', () => {
    const cmd = readFileSync(join(__dirname, '..', 'plugin', 'commands', 'witness.md'), 'utf8')
    expect(cmd).toContain('byte-for-byte')
    expect(cmd).toContain('naming the option is their judgment')
    // D143. The engine carries the same affirmation rule the skills do — one definition,
    // surface-independent, applied by prose in chat today and by drive's prompt when D145 lands.
    expect(cmd).toContain('--via affirmation')
  })
})

describe('one autonomy conditional per skill (A8)', () => {
  const read = (name: string) => readFileSync(skillPath(name), 'utf8');
  it('every skill keys it on the CLI line, exactly once · brainstorm has none (row 194)', () => {
    for (const name of SKILLS.filter((n) => n !== 'witness-brainstorm')) expect(read(name).match(/Under `autonomy: on`/g), name).toHaveLength(1);
    expect(read('witness-brainstorm')).not.toContain('Under `autonomy: on`');
  });
  it('names what changes per stage', () => {
    expect(read('witness-implement')).toContain('the plan says X; doing Y because Z');
    expect(read('witness-ship')).toContain('`merged:`');
    expect(read('witness-ship')).toContain('Never merge');
    expect(read('witness-design')).toContain('the kept stop `design look`');
    expect(read('witness-ship')).toContain('Any other `merge: held`');
    expect(read('witness-ship')).toContain('ship <plan-id>    # append --manual when the run asked for it');
  });
});

describe('witness-design under autonomy (A6, row 194)', () => {
  it('stays a conversation; only the critic rounds are settled for it', () => {
    const body = readFileSync(skillPath('witness-design'), 'utf8')
    expect(body).toContain('the kept stop `design look`')
    expect(body).not.toContain('Skip the directions-and-converge conversation')
    expect(body).not.toContain('Never run `$WITNESS design <spec-id> --open`')
    expect(body.match(/Under `autonomy: on`/g)).toHaveLength(1)
  })
})

describe('witness-brainstorm in every mode (A6, row 194)', () => {
  it('is an interview with a human under autonomy too', () => {
    const body = readFileSync(skillPath('witness-brainstorm'), 'utf8')
    expect(body).not.toContain('there is no interview and no confirmation')
    expect(body).not.toContain('Never pass `--manual` yourself')
    expect(body).not.toContain('the ask is parked')
  })
})
describe('witness-decompose needs (A10)', () => {
  it('documents a need that holds criteria and a need that blocks start', () => {
    const body = readFileSync(skillPath('witness-decompose'), 'utf8')
    expect(body).toContain('"holds": ["ac-baseline"]')
    expect(body).toContain('blocks `witness start`')
  })
})
