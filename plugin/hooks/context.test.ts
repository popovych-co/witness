// Row 191 §4.1, §4.6: the Claude Code adapter (context.ts) under `claude plugin test plugin`.
// Nothing runs beneath the plugin here: the test's own hooks stand for the engine, answering each
// call on `$` with `{ value }` and the Bash call itself with `{ result }`. Each test names its own
// session, so no latch or warning can carry from one test to the next.
import type { On } from 'claude-code';
import { expect, test } from 'claude-code/testing';

const WARNING = /^witness: context 21% of 1M has reached the 20% limit/;
const OVER = { tokens: 210000, percent: 21 };

// What the engine answers, changeable mid-test: a reviewer spawn's mark, a usage call that fails,
// the config (unreadable where it is nearest, or none anywhere) and a deny for the Bash call.
type World = { reviewer?: string; usage?: 'fails'; config?: 'unreadable' | 'none'; deny?: string };
type Fill = { tokens: number; percent: number };

// One session at a fill, run in /repo/sub under /repo's witness.config.yaml, so the config is
// found one level up. `ran` records the WITNESS_CONTEXT each Bash call ran with.
function engine(on: On, session: string, fill: Fill, world: World = {}) {
  let env: string | undefined;
  const ran: Array<string | undefined> = [];
  const PARENT = '/repo/witness.config.yaml';
  const exists = (path: string) => (world.config === 'none' ? false
    : path === PARENT || (world.config === 'unreadable' && path === '/repo/sub/witness.config.yaml'));
  on('session.id', () => ({ value: session }));
  on('session.usage', () => (world.usage === 'fails'
    ? { deny: 'no reading' }
    : { value: { startedAt: 0, context: { ...fill, window: 1000000 }, rateLimits: [] } }));
  on('session.cwd', () => ({ value: '/repo/sub' }));
  on('fs.exists', (_, e) => ({ value: exists(e.path) }));
  on('fs.read', (_, e) => (e.path === PARENT && exists(e.path)
    ? { value: 'schema: 1\nsession:\n  contextLimit: 20\n' }
    : { deny: `cannot read ${e.path}` }));
  on('env.get', (_, e) => ({ value: e.name === 'WITNESS_REVIEWER' ? world.reviewer : undefined }));
  on('env.set', (_, e) => {
    if (e.name === 'WITNESS_CONTEXT') env = e.value;
    return { value: {} };
  });
  on('tool.call', () => {
    ran.push(env);
    return world.deny === undefined ? { result: {} } : { deny: world.deny };
  });
  return ran;
}

test('sets WITNESS_CONTEXT before the command', async ($, on) => {
  const ran = engine(on, 'S1', { tokens: 31627, percent: 3 });
  await $.tool.call({ tool: 'Bash', command: 'ls' });
  expect(ran).toEqual(['{"session":"S1","tokens":31627,"window":1000000,"percent":3}']);
});

test('appends the warning once after a witness command', async ($, on) => {
  engine(on, 'S2', OVER);
  const first = await $.tool.call({ tool: 'Bash', command: '$WITNESS next' });
  expect(first.context?.at(-1)).toMatch(WARNING);
  const second = await $.tool.call({ tool: 'Bash', command: '$WITNESS next' });
  expect(second.context).toBeUndefined();
});

test('stays silent in a reviewer spawn', async ($, on) => {
  engine(on, 'S3', OVER, { reviewer: '1' });
  const r = await $.tool.call({ tool: 'Bash', command: '$WITNESS next' });
  expect(r.context).toBeUndefined();
});

test('stays silent before a witness command', async ($, on) => {
  engine(on, 'S4', OVER);
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context).toBeUndefined();
  // the same fill warns once the session has run witness: the latch is what kept it quiet
  expect((await $.tool.call({ tool: 'Bash', command: '$WITNESS next' })).context?.at(-1)).toMatch(WARNING);
});

test('runs the command all the same when the reading cannot be taken', async ($, on) => {
  const ran = engine(on, 'S5', OVER, { usage: 'fails' });
  const r = await $.tool.call({ tool: 'Bash', command: '$WITNESS next' });
  expect(ran).toEqual([undefined]);
  expect(r).toEqual({ result: {} });
});

// The last reading names this same session, so left standing it would pass the CLI's check as
// live for a command it was never taken for.
test('clears the last reading when a new one cannot be taken', async ($, on) => {
  const world: World = {};
  const ran = engine(on, 'S6', { tokens: 31627, percent: 3 }, world);
  await $.tool.call({ tool: 'Bash', command: 'ls' });
  world.usage = 'fails';
  await $.tool.call({ tool: 'Bash', command: 'ls' });
  expect(ran).toEqual(['{"session":"S6","tokens":31627,"window":1000000,"percent":3}', undefined]);
});

// A subagent's Bash carries the main loop's reading, but the warning is the main loop's to read.
test('a subagent neither latches the session nor takes its warning', async ($, on) => {
  const ran = engine(on, 'S7', OVER);
  expect((await $.tool.call({ tool: 'Bash', command: '$WITNESS next', agentId: 'a1' })).context).toBeUndefined();
  expect(ran[0]).toContain('"session":"S7"');
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context).toBeUndefined();
  expect((await $.tool.call({ tool: 'Bash', command: '$WITNESS next' })).context?.at(-1)).toMatch(WARNING);
});

// Parallel tool calls of one response run at once and share one reading.
test('parallel Bash calls carry the warning once between them', async ($, on) => {
  engine(on, 'S8', OVER);
  const results = await Promise.all([1, 2, 3].map(() => $.tool.call({ tool: 'Bash', command: '$WITNESS next' })));
  expect(results.filter((r) => r.context !== undefined)).toHaveLength(1);
});

test('a denied call passes through unchanged and the next call still warns', async ($, on) => {
  const world: World = { deny: 'blocked' };
  engine(on, 'S9', OVER, world);
  expect(await $.tool.call({ tool: 'Bash', command: '$WITNESS next' })).toEqual({ deny: 'blocked' });
  delete world.deny;
  expect((await $.tool.call({ tool: 'Bash', command: '$WITNESS next' })).context?.at(-1)).toMatch(WARNING);
});

test('stays silent without a witness.config.yaml', async ($, on) => {
  engine(on, 'S10', OVER, { config: 'none' });
  expect((await $.tool.call({ tool: 'Bash', command: '$WITNESS next' })).context).toBeUndefined();
});

// The walk stops at the nearest config that exists, as canon-guard.mjs's does.
test('stays silent when the nearest config cannot be read, whatever lies above it', async ($, on) => {
  engine(on, 'S11', OVER, { config: 'unreadable' });
  expect((await $.tool.call({ tool: 'Bash', command: '$WITNESS next' })).context).toBeUndefined();
});
