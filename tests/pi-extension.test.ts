import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import register from '../plugin/hooks/specflow-pi.ts';

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

// A stub ExtensionAPI. Pi cannot be loaded in CI (Tier 1 never loads a harness), so the
// adapter is exercised against the surface pi documents: pi.on(name, handler), handlers
// receiving (event, ctx), a blocking return of { block, reason }.
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
  const ctx = { cwd: '', hasUI: true, ui: { notify: (m: string) => notes.push(m) } };
  return { pi, fire, ctx, notes };
}

function specflowRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'piext-'));
  writeFileSync(join(dir, 'specflow.config.yaml'), 'schema: 1\n');
  for (const d of ['specs', 'plans', 'src']) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

describe('pi extension — canon guard', () => {
  it('blocks a write to canon and returns the guard reason to the model', async () => {
    const s = stubPi();
    register(s.pi as never);
    s.ctx.cwd = specflowRepo();
    const r = await s.fire('tool_call', { toolName: 'write', input: { path: 'specs/a.md' } }, s.ctx);
    expect(r).toMatchObject({ block: true });
    expect((r as { reason: string }).reason).toContain('specflow CLI (write / design / adopt)');
    expect(s.notes.join()).toContain('specflow');
  });

  it('allows non-canon writes, reads and bash reads', async () => {
    const s = stubPi();
    register(s.pi as never);
    s.ctx.cwd = specflowRepo();
    expect(await s.fire('tool_call', { toolName: 'write', input: { path: 'src/x.ts' } }, s.ctx)).toBeUndefined();
    expect(await s.fire('tool_call', { toolName: 'read', input: { path: 'specs/a.md' } }, s.ctx)).toBeUndefined();
    expect(await s.fire('tool_call', { toolName: 'bash', input: { command: 'cat specs/a.md' } }, s.ctx)).toBeUndefined();
  });

  it('blocks a bash redirection into canon', async () => {
    const s = stubPi();
    register(s.pi as never);
    s.ctx.cwd = specflowRepo();
    const r = await s.fire('tool_call', { toolName: 'bash', input: { command: 'echo x > plans/p.md' } }, s.ctx);
    expect(r).toMatchObject({ block: true });
  });

  it('does not notify when there is no UI (print mode)', async () => {
    const s = stubPi();
    register(s.pi as never);
    s.ctx.cwd = specflowRepo();
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
    s.ctx.cwd = specflowRepo();
    for (const bad of [{}, { toolName: 'write' }, { toolName: 'write', input: null }, { toolName: 42, input: { path: 1 } }]) {
      expect(await s.fire('tool_call', bad, s.ctx)).toBeUndefined();
    }
  });

  it('still blocks with the guard reason when the UI notification throws', async () => {
    const s = stubPi();
    register(s.pi as never);
    s.ctx.cwd = specflowRepo();
    s.ctx.ui = { notify: () => { throw new Error('no tty'); } };
    const r = await s.fire('tool_call', { toolName: 'write', input: { path: 'specs/a.md' } }, s.ctx);
    expect(r).toMatchObject({ block: true });
    expect((r as { reason: string }).reason).toContain('specflow CLI (write / design / adopt)');
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
    process.env.SPECFLOW_DASHBOARD = fakeDashboard('specflow: 9.9.9 · schema: 1');
    try {
      register(s.pi as never);
      s.ctx.cwd = specflowRepo();
      const first = await s.fire('before_agent_start', { prompt: 'hi' }, s.ctx);
      expect(first).toMatchObject({ message: { customType: 'specflow-dashboard', display: true } });
      expect((first as { message: { content: string } }).message.content).toContain('specflow: 9.9.9');

      expect(await s.fire('before_agent_start', { prompt: 'again' }, s.ctx)).toBeUndefined();

      await s.fire('session_start', { reason: 'new' }, s.ctx);
      expect(await s.fire('before_agent_start', { prompt: 'fresh' }, s.ctx)).toBeTruthy();
    } finally {
      delete process.env.SPECFLOW_DASHBOARD;
    }
  });

  it('injects nothing when the dashboard script is missing or silent', async () => {
    const s = stubPi();
    process.env.SPECFLOW_DASHBOARD = join(tmpdir(), 'nope-does-not-exist.sh');
    try {
      register(s.pi as never);
      s.ctx.cwd = specflowRepo();
      expect(await s.fire('before_agent_start', { prompt: 'hi' }, s.ctx)).toBeUndefined();
    } finally {
      delete process.env.SPECFLOW_DASHBOARD;
    }
  });
});
