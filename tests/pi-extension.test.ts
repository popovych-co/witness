import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import register from '../plugin/hooks/witness-pi.ts';

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

// A stub ExtensionAPI. Pi cannot be loaded in CI (Tier 1 never loads a harness), so the
// adapter is exercised against the surface pi documents: pi.on(name, handler), handlers
// receiving (event, ctx), a blocking return of { block, reason }. The context reading comes
// from ctx.getContextUsage() and the session from ctx.sessionManager (types.d.ts:193-244);
// `state` is what they answer.
function stubPi() {
  const handlers = new Map<string, Handler[]>();
  const notes: string[] = [];
  const pi = {
    on: (name: string, fn: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
  };
  const fire = async (name: string, event: unknown, ctx: unknown): Promise<unknown> => {
    let last: unknown;
    for (const h of handlers.get(name) ?? []) last = await h(event, ctx);
    return last;
  };
  const state = { usage: { tokens: 16523, contextWindow: 1000000, percent: 1.65 } as unknown, session: 'p1' };
  const ctx = {
    cwd: '', hasUI: true, ui: { notify: (m: string) => notes.push(m) },
    getContextUsage: (): unknown => state.usage,
    sessionManager: { getSessionId: () => state.session },
  };
  return { pi, fire, ctx, notes, state };
}

function witnessRepo(config = 'schema: 1\n'): string {
  const dir = mkdtempSync(join(tmpdir(), 'piext-'));
  writeFileSync(join(dir, 'witness.config.yaml'), config);
  for (const d of ['specs', 'plans', 'src']) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

describe('pi extension — canon guard', () => {
  it('blocks a write to canon and returns the guard reason to the model', async () => {
    const s = stubPi();
    register(s.pi as never);
    s.ctx.cwd = witnessRepo();
    const r = await s.fire('tool_call', { toolName: 'write', input: { path: 'specs/a.md' } }, s.ctx);
    expect(r).toMatchObject({ block: true });
    expect((r as { reason: string }).reason).toContain('witness CLI (write / design / adopt)');
    expect(s.notes.join()).toContain('witness');
  });

  it('allows non-canon writes, reads and bash reads', async () => {
    const s = stubPi();
    register(s.pi as never);
    s.ctx.cwd = witnessRepo();
    expect(await s.fire('tool_call', { toolName: 'write', input: { path: 'src/x.ts' } }, s.ctx)).toBeUndefined();
    expect(await s.fire('tool_call', { toolName: 'read', input: { path: 'specs/a.md' } }, s.ctx)).toBeUndefined();
    expect(await s.fire('tool_call', { toolName: 'bash', input: { command: 'cat specs/a.md' } }, s.ctx)).toBeUndefined();
  });

  it('blocks a bash redirection into canon', async () => {
    const s = stubPi();
    register(s.pi as never);
    s.ctx.cwd = witnessRepo();
    const r = await s.fire('tool_call', { toolName: 'bash', input: { command: 'echo x > plans/p.md' } }, s.ctx);
    expect(r).toMatchObject({ block: true });
  });

  it('does not notify when there is no UI (print mode)', async () => {
    const s = stubPi();
    register(s.pi as never);
    s.ctx.cwd = witnessRepo();
    s.ctx.hasUI = false;
    const r = await s.fire('tool_call', { toolName: 'write', input: { path: 'specs/a.md' } }, s.ctx);
    expect(r).toMatchObject({ block: true });
    expect(s.notes).toEqual([]);
  });

  // Revision 5. pi BLOCKS the tool when a tool_call handler throws (docs/extensions.md,
  // "Error Handling") — the inverse of Claude Code's hook, which allows on any failure.
  // So fail-open here is NOT the platform default: the handler's own catch is the only
  // thing preserving row 31, and these two tests are what stop it being "simplified" away.
  it('never throws on a malformed event — pi would block the tool if it did', async () => {
    const s = stubPi();
    register(s.pi as never);
    s.ctx.cwd = witnessRepo();
    for (const bad of [{}, { toolName: 'write' }, { toolName: 'write', input: null }, { toolName: 42, input: { path: 1 } }]) {
      expect(await s.fire('tool_call', bad, s.ctx)).toBeUndefined();
    }
  });

  it('still blocks with the guard reason when the UI notification throws', async () => {
    const s = stubPi();
    register(s.pi as never);
    s.ctx.cwd = witnessRepo();
    s.ctx.ui = { notify: () => { throw new Error('no tty'); } };
    const r = await s.fire('tool_call', { toolName: 'write', input: { path: 'specs/a.md' } }, s.ctx);
    expect(r).toMatchObject({ block: true });
    expect((r as { reason: string }).reason).toContain('witness CLI (write / design / adopt)');
  });
});

describe('pi extension — dashboard injection', () => {
  function fakeDashboard(text: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'piedash-'));
    const p = join(dir, 'session-dashboard.sh');
    writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' '${text}'\n`);
    chmodSync(p, 0o755);
    return p;
  }

  it('injects the dashboard once per session and re-arms on session_start', async () => {
    const s = stubPi();
    process.env.WITNESS_DASHBOARD = fakeDashboard('witness: 9.9.9 · schema: 1');
    try {
      register(s.pi as never);
      s.ctx.cwd = witnessRepo();
      const first = await s.fire('before_agent_start', { prompt: 'hi' }, s.ctx);
      expect(first).toMatchObject({ message: { customType: 'witness-dashboard', display: true } });
      expect((first as { message: { content: string } }).message.content).toContain('witness: 9.9.9');

      expect(await s.fire('before_agent_start', { prompt: 'again' }, s.ctx)).toBeUndefined();

      await s.fire('session_start', { reason: 'new' }, s.ctx);
      expect(await s.fire('before_agent_start', { prompt: 'fresh' }, s.ctx)).toBeTruthy();
    } finally {
      delete process.env.WITNESS_DASHBOARD;
    }
  });

  it('injects nothing when the dashboard script is missing or silent', async () => {
    const s = stubPi();
    process.env.WITNESS_DASHBOARD = join(tmpdir(), 'nope-does-not-exist.sh');
    try {
      register(s.pi as never);
      s.ctx.cwd = witnessRepo();
      expect(await s.fire('before_agent_start', { prompt: 'hi' }, s.ctx)).toBeUndefined();
    } finally {
      delete process.env.WITNESS_DASHBOARD;
    }
  });
});

describe('pi extension — the context reading and the warning (row 191 §4.1, §4.6)', () => {
  // The adapter writes process.env, which every later bash child inherits; the suite may itself
  // run inside a measured session. Each test starts without either variable and gives back
  // whatever the process had.
  const KEYS = ['WITNESS_CONTEXT', 'WITNESS_REVIEWER'] as const;
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const OVER = { tokens: 210000, contextWindow: 1000000, percent: 21 };
  const LIMIT_20 = 'schema: 1\nsession:\n  contextLimit: 20\n';
  const bashResult = (text: string) => ({
    type: 'tool_result', toolName: 'bash', toolCallId: 't1', input: {}, content: [{ type: 'text', text }],
    isError: false, details: undefined,
  });
  // One bash command through both events: what the adapter returned for its result.
  async function run(s: ReturnType<typeof stubPi>, command: string): Promise<unknown> {
    await s.fire('tool_call', { toolName: 'bash', input: { command } }, s.ctx);
    return s.fire('tool_result', bashResult('ok'), s.ctx);
  }
  function overTheLimit(config = LIMIT_20) {
    const s = stubPi();
    register(s.pi as never);
    s.ctx.cwd = witnessRepo(config);
    s.state.usage = OVER;
    return s;
  }

  it('sets WITNESS_CONTEXT for a bash call', async () => {
    const s = stubPi();
    register(s.pi as never);
    s.ctx.cwd = witnessRepo();
    expect(await s.fire('tool_call', { toolName: 'read', input: { path: 'src/x.ts' } }, s.ctx)).toBeUndefined();
    expect(process.env.WITNESS_CONTEXT).toBeUndefined();
    expect(await s.fire('tool_call', { toolName: 'bash', input: { command: 'ls' } }, s.ctx)).toBeUndefined();
    expect(JSON.parse(process.env.WITNESS_CONTEXT!)).toMatchObject({ session: 'p1', tokens: 16523, window: 1000000 });
  });

  it('a canon block still wins', async () => {
    const s = stubPi();
    register(s.pi as never);
    s.ctx.cwd = witnessRepo();
    const r = await s.fire('tool_call', { toolName: 'bash', input: { command: 'echo x > plans/p.md' } }, s.ctx);
    expect(r).toMatchObject({ block: true });
    expect(process.env.WITNESS_CONTEXT).toBeUndefined();
  });

  it('warns once after the session ran the witness CLI, at or over the limit', async () => {
    const s = overTheLimit();
    const r = (await run(s, '$WITNESS next')) as { content: Array<{ type: string; text: string }> };
    expect(r.content[0]).toEqual({ type: 'text', text: 'ok' });
    expect(r.content.at(-1)!.text).toMatch(/^witness: context 21% of 1M has reached the 20% limit/);
    expect(await run(s, 'ls')).toBeUndefined();
    expect(await run(s, '$WITNESS next')).toBeUndefined();
  });

  it('stays silent before any witness command', async () => {
    const s = overTheLimit();
    expect(await run(s, 'ls')).toBeUndefined();
    expect(await run(s, 'grep -rn "witness next" src')).toBeUndefined();
  });

  it('stays silent in a reviewer spawn', async () => {
    const s = overTheLimit();
    process.env.WITNESS_REVIEWER = '1';
    expect(await run(s, '$WITNESS next')).toBeUndefined();
  });

  it('stays silent without a witness.config.yaml', async () => {
    const s = overTheLimit();
    s.ctx.cwd = mkdtempSync(join(tmpdir(), 'piext-plain-'));
    expect(await run(s, '$WITNESS next')).toBeUndefined();
  });

  it('stays silent under the limit', async () => {
    const s = overTheLimit();
    s.state.usage = { tokens: 190000, contextWindow: 1000000, percent: 19 };
    expect(await run(s, '$WITNESS next')).toBeUndefined();
  });

  it('a new session id can warn again', async () => {
    const s = overTheLimit();
    expect(await run(s, '$WITNESS next')).toBeTruthy();
    s.state.session = 'p2';
    expect(await run(s, 'ls')).toBeUndefined();             // p2 has not run witness yet
    expect(await run(s, '$WITNESS next')).toBeTruthy();
  });

  // tool_call is the event pi blocks the tool on when a handler throws (the guard tests above
  // say why), so a broken context API must cost nothing but the reading.
  it('never throws when the context API throws', async () => {
    const s = overTheLimit();
    s.ctx.getContextUsage = () => { throw new Error('no model'); };
    expect(await run(s, '$WITNESS next')).toBeUndefined();
    expect(process.env.WITNESS_CONTEXT).toBeUndefined();
    const blocked = await s.fire('tool_call', { toolName: 'write', input: { path: 'specs/a.md' } }, s.ctx);
    expect(blocked).toMatchObject({ block: true });
    expect(await s.fire('tool_call', { toolName: 'write', input: { path: 'src/x.ts' } }, s.ctx)).toBeUndefined();
  });
});
