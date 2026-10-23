// Row 191 §4.1, §4.6: the Claude Code adapter (context.ts) under `claude plugin test plugin`.
// Nothing runs beneath the plugin here: the test's own hooks stand for the engine, answering each
// call on `$` with `{ value }` and the Bash call itself with `{ result }`. Each test names its own
// session, so no latch or warning can carry from one test to the next.
import type { On } from 'claude-code';
import { expect, test } from 'claude-code/testing';

const WARNING = /^witness: context 21% of 1M has reached the 20% limit/;

type World = { reviewer?: string; read?: 'fails' };
type Fill = { tokens: number; percent: number };

// One session at a fill, run in /repo/sub under /repo's witness.config.yaml, so the config is
// found one level up. `ran` records the WITNESS_CONTEXT each Bash call ran with.
function engine(on: On, session: string, fill: Fill, world: World = {}) {
  let env: string | undefined;
  const ran: Array<string | undefined> = [];
  on('session.id', () => ({ value: session }));
  on('session.usage', () => (world.read === 'fails'
    ? { deny: 'no reading' }
    : { value: { startedAt: 0, context: { ...fill, window: 1000000 }, rateLimits: [] } }));
  on('session.cwd', () => ({ value: '/repo/sub' }));
  on('fs.read', (_, e) => (e.path === '/repo/witness.config.yaml'
    ? { value: 'schema: 1\nsession:\n  contextLimit: 20\n' }
    : { deny: `ENOENT: ${e.path}` }));
  on('env.get', (_, e) => ({ value: e.name === 'WITNESS_REVIEWER' ? world.reviewer : undefined }));
  on('env.set', (_, e) => {
    if (e.name === 'WITNESS_CONTEXT') env = e.value;
    return { value: {} };
  });
  on('tool.call', () => {
    ran.push(env);
    return { result: {} };
  });
  return ran;
}

test('sets WITNESS_CONTEXT before the command', async ($, on) => {
  const ran = engine(on, 'S1', { tokens: 31627, percent: 3 });
  await $.tool.call({ tool: 'Bash', command: 'ls' });
  expect(ran).toEqual(['{"session":"S1","tokens":31627,"window":1000000,"percent":3}']);
});

test('appends the warning once after a witness command', async ($, on) => {
  engine(on, 'S2', { tokens: 210000, percent: 21 });
  const first = await $.tool.call({ tool: 'Bash', command: '$WITNESS next' });
  expect(first.context?.at(-1)).toMatch(WARNING);
  const second = await $.tool.call({ tool: 'Bash', command: '$WITNESS next' });
  expect(second.context).toBeUndefined();
});

test('stays silent in a reviewer spawn', async ($, on) => {
  engine(on, 'S3', { tokens: 210000, percent: 21 }, { reviewer: '1' });
  const r = await $.tool.call({ tool: 'Bash', command: '$WITNESS next' });
  expect(r.context).toBeUndefined();
});

test('stays silent before a witness command', async ($, on) => {
  engine(on, 'S4', { tokens: 210000, percent: 21 });
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context).toBeUndefined();
  // the same fill warns once the session has run witness: the latch is what kept it quiet
  expect((await $.tool.call({ tool: 'Bash', command: '$WITNESS next' })).context?.at(-1)).toMatch(WARNING);
});

test('runs the command all the same when the reading cannot be taken', async ($, on) => {
  const ran = engine(on, 'S5', { tokens: 210000, percent: 21 }, { read: 'fails' });
  const r = await $.tool.call({ tool: 'Bash', command: '$WITNESS next' });
  expect(ran).toEqual([undefined]);
  expect(r).toEqual({ result: {} });
});
