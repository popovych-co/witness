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
  it('the /witness loop tells the human about an older drive and ends the turn (row 240)', () => {
    const cmd = read('plugin/commands/witness.md');
    expect(cmd).toContain('| `wait: older drive` is printed | A `witness drive` from before 0.29 runs this repo');
    expect(cmd).toContain('Never run that line yourself, and never wait again until they say go.');
  });
  it('the /witness loop keeps matching past a stop being decided, and ends on nothing owed (row 240)', () => {
    const cmd = read('plugin/commands/witness.md');
    expect(cmd).toContain('| `note: being decided — <gate> <target>` lines are printed above `next:` | Drive, or another witness run, is deciding that stop now.');
    expect(cmd).toContain('| `next: witness check` with `note: nothing is owed`, in a chat | Nothing is owed that this chat can do.');
  });
  it('the /witness loop runs a parked gate\'s revise or fresh row only when the human asks (row 241)', () => {
    const cmd = read('plugin/commands/witness.md');
    expect(cmd).toContain('| a `parked:` item with `revise:` or `fresh:` rows | `revise:` sends the work back to the parked gate — run it only when the human asks');
  });
  it('the /witness loop leaves merge and fix stops to the human (row 242)', () => {
    const cmd = read('plugin/commands/witness.md');
    expect(cmd).toContain('| a `waiting: merge` or `waiting: fix` item | `waiting: merge`: the human merges');
    expect(cmd).toContain('Never run that line yourself, even when asked; run its `recheck:` line only when they ask.');
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

// Row 239 (design §3.4, §3.4b). A kept stop's and a waiting line's commands print on indented `run:`
// rows of their own, a menu as `exits:`, so the rows that read them name those lines, and the
// handoff `run:` is the unindented one.
describe('a command is a line of its own (row 239)', () => {
  const row = (start: string) => body().split('\n').find((l) => l.startsWith(start))!
  it('a kept stop\'s and a waiting line\'s commands are their run: lines (row 239)', () => {
    const trust = row('| `kept-stop: trust grant`')
    expect(trust).toContain('the `run:` line printed under')
    expect(trust).toContain('not offered on Windows')
    expect(row('| `kept-stop: unmet need`')).toContain('the `run:` line printed under it')
    expect(row('| `waiting:` lines')).toContain('`exits:`')
    const handoff = row('| an unindented `run:` line is printed')
    expect(handoff).toContain('The handoff `run:` is the **unindented** one in the routing unit.')
    expect(handoff).toContain('An indented `  run:` belongs to the line above it, whose row says when to run it.')
    expect(row('2. Read its TOON lines')).toContain('unindented')
  })
  // Ruling R17. With indented `run:` rows above `next:`, every rule that reads a `run:` names which.
  it('a relay alone, a withheld grant and a menu segment are named for the new rows (row 239)', () => {
    expect(row('| a `relay:` line is printed')).toContain('with no unindented `run:`')
    expect(row('- A `relay:` line printed')).toContain('with no unindented `run:`')
    const listing = row('| `next:` names `witness trust`')
    expect(listing).toContain('`note:` row')
    expect(listing).toContain('in their own terminal')
    expect(row('| `waiting:` lines')).toContain('a segment that names its own verb (`witness abandon …`) runs as printed')
  })
  // Ruling R13: `--via` is decide's selection record, and another verb refuses it.
  it('a nod appends --via affirmation to a witness decide option only (row 239)', () => {
    const nod = row('- After a `decide` line surfaced')
    expect(nod).toContain('`--via affirmation` appended when it is a `witness decide` option')
    expect(nod).toContain('`witness recover --complete`) runs as printed')
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
  // Final review: what no `next:` routes is said, and a wake is told to the human first.
  it('waiting: lines are told to the human, and a wake says what woke it', () => {
    const rows = body().split('\n')
    expect(rows.find((l) => l.startsWith('| `waiting:` lines are printed'))).toContain('only when they ask')
    expect(rows.find((l) => l.startsWith('| `wait: needs you`'))).toContain('Tell the human the rows it printed')
  })
})

// Row 243 (design §4.1.3, §4.5). Each refusal a moved base can leave has a row of its own, matched
// before the generic exit-2 row, with its way on: what a session may do itself, and where the work
// is the human's — never a reset, and never a deleted carry ref.
describe('the router reads the carry\'s refusals (row 243)', () => {
  const rowFor = (rule: string): string => {
    const rows = body().split('\n').filter((l) => l.startsWith('| ') && l.includes(`\`${rule}\` refusal`))
    expect(rows, rule).toHaveLength(1)
    return rows[0]!
  }
  const generic = () => body().split('\n').findIndex((l) => l.startsWith('| any other `next:` line'))
  it.each([
    ['clash-unresolved', ['A row that leads with `witness ship <plan>` means a move was interrupted: run that line', 'resolve no file by hand before it has run',
      'the `witness-ship` skill\'s **A clash** steps', '`$WITNESS turn`']],
    ['carry-pending', ['never reset the worktree, and never delete or move that ref', '`git switch witness/<plan>`', '**END YOUR TURN**', 'the human\'s call']],
    ['verify-red-pending', ['`refs/witness/verify-red/<plan>`', 'neither put it back nor overwrote it', 'Never delete or move that ref',
      '**END YOUR TURN**', 'the human\'s call']],
    ['carry-refused', ['nothing moved', 'intent-to-add', '`git add -- <file>`', '**END YOUR TURN**']],
    ['operation-in-progress', ['never ends one it did not start', 'If this session started it', '`--continue`', '`--abort`', '**END YOUR TURN**']],
    ['rebase-refused', ['not a conflict', 'an untracked file this session made', '`git add -- <file>`', 'in git\'s own words', '**END YOUR TURN**']],
    ['index-locked', ['nothing was lost', 'the next `witness ship` carries on once the lock is released', 'removing the lock file is the human\'s call', '**END YOUR TURN**']],
    ['pr-branch-gone', ['the PR branch is gone from the remote — recreate or reopen it, or abandon the plan', 'never push the branch yourself',
      'running `witness ship` again returns the same stop', '**END YOUR TURN**']],
  ])('a %s refusal has a row of its own, before the generic row', (rule, parts) => {
    const row = rowFor(rule)
    for (const p of parts) expect(row, p).toContain(p)
    expect(body().split('\n').indexOf(row)).toBeLessThan(generic())
    expect(row).not.toMatch(/git reset|update-ref -d|git stash (drop|pop|clear)/)
  })
})

// Row 244 (design §4.2.7). Revising a gate again, or retracting a settled one, takes the human's words
// and the human: a session asks for the note and never writes it, and a refused actor stops.
describe('the router reads decide\'s revise-again refusals (row 244)', () => {
  const generic = () => body().split('\n').findIndex((l) => l.startsWith('| any other `next:` line'))
  it.each([
    ['note-required', ['retracting a settled one', 'the human\'s own words', 'what to change', 'Ask the human for them and **END YOUR TURN**',
      'run the same revise with `--note "<their words>"`', 'Never write the note yourself']],
    ['revise-human', ['retracting a settled one', 'the human\'s act in their own chat or terminal', 'a session\'s a drive started', '**END YOUR TURN**']],
  ])('a %s refusal has a row of its own, before the generic row', (rule, parts) => {
    const rows = body().split('\n').filter((l) => l.startsWith('| ') && l.includes(`\`${rule}\` refusal`))
    expect(rows, rule).toHaveLength(1)
    for (const p of parts) expect(rows[0], p).toContain(p)
    expect(body().split('\n').indexOf(rows[0]!)).toBeLessThan(generic())
  })
})

// Row 244 (design §4.2.4, §4.5). The hand-back is the author's act: the router offers it where the
// changed-nothing screen's session line does — the revised state, no upstream work owed — appends
// `--manual` when armed, and never decides. Its refusals spend nothing, and `next` routes what is owed.
describe('the router hands a revise back, and reads the hand-back\'s refusals (row 244)', () => {
  const generic = () => body().split('\n').findIndex((l) => l.startsWith('| any other `next:` line'))
  const HAND_BACK = 'when you judge there is nothing to change, hand the revise back with `$WITNESS gate <gate> <target> --unchanged`, and never `decide`'
  it('a session: line offering --unchanged has a row of its own, before the generic row', () => {
    const rows = body().split('\n').filter((l) => l.startsWith('| a `session:` line offers `--unchanged`'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain(HAND_BACK)
    expect(rows[0]).toContain('`outcome: revise changed nothing`')
    expect(rows[0]).toContain('Append `--manual` when this session is `--manual`-armed')
    expect(rows[0]).toContain('A plain re-run hands nothing back')
    expect(body().split('\n').indexOf(rows[0]!)).toBeLessThan(generic())
  })
  it('the hand-back\'s refusals have one row, before the generic row', () => {
    const rows = body().split('\n').filter((l) => l.startsWith('| a refusal of `--unchanged`'))
    expect(rows).toHaveLength(1)
    for (const rule of ['nothing-to-hand-back', 'upstream-owed', 'retraction-owed', 'hand-back-standing', 'hand-back-at-bound', 'fresh-unchanged', 'settled-since']) {
      expect(rows[0], rule).toContain(`\`${rule}\``)
    }
    expect(rows[0]).toContain('Nothing was handed back and nothing was spent')
    expect(rows[0]).toContain('never `decide`')
    expect(body().split('\n').indexOf(rows[0]!)).toBeLessThan(generic())
  })
})

// Row 243 (design §4.1.3: replay step 1, "a session's fix commits are normal"). The ship session is
// spawned through /witness, so the router's never-commit rule must leave room for exactly the ship
// skill's own commits in the plan's worktree — a CI-red fix, and a replay conflict's step 1, without
// which `git rebase` refuses a dirty tree or autostashes it onto the shared stash list (#86) — and
// for nothing broader. Ship's own commit is the first code commit, no longer the sole one.
describe('the router allows the ship skill\'s own fix commits and nothing broader (row 243)', () => {
  const NARROW = 'with two exceptions, both the `witness-ship` skill\'s own and both in the plan\'s worktree: a CI-red fix, and step 1 of a replay conflict (the uncommitted work committed before the rebase).'
  it('names the two cases, keeps never-commit for everything else, and calls ship\'s commit the first', () => {
    const lines = body().split('\n').filter((l) => l.includes('git commit'))
    expect(lines).toHaveLength(1)
    const rule = lines[0]!
    expect(rule).toContain('**never `git commit` yourself, anywhere, at any stage**')
    expect(rule).toContain(NARROW)
    expect(rule.match(/exception/g)).toHaveLength(1)
    expect(rule).toContain('the ship phase makes the first code commit')
    expect(rule).not.toContain('sole code commit')
  })
  it('the ship skill calls its own commit the first code commit, never the sole one', () => {
    const ship = readFileSync(join(__dirname, '..', 'plugin', 'skills', 'witness-ship', 'SKILL.md'), 'utf8')
    expect(ship).toContain('it commits the worktree (the first code commit')
    expect(ship).not.toContain('sole code commit')
  })
})
