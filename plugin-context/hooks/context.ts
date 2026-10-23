// witness context — the Claude Code half of row 191's adapter: the live reading in every Bash
// command's environment, and one warning per session at the limit.
//
// A hooks module, and the whole of the witness-context plugin (row 191 §4.11): only a plugin
// carries a module, and a project's settings declaring one do not load it headless (P9), so
// this plugin, installed once per machine, serves both Claude Code routes. The full witness
// plugin does not carry it, so a machine with both never runs it twice. The plugin API is early
// access and moves between releases; its declaration file and `claude plugin validate
// plugin-context` are the authority over anything written here. The logic is context-core.mjs's,
// shared byte for byte with the Pi extension (the sibling here is a copy of plugin/hooks/'s,
// since nothing outside this folder resolves once Claude Code has copied it into its cache), and
// this file keeps only the calls on `$`.
//
// Fail open: nothing before next(e) can keep the command from running. A reading this call
// cannot take clears the variable, so the command runs unmeasured and the CLI says so (§7: a
// release that changes this API turns the reading off, never the shell).
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code';
import { configCandidates, contextLimitOf, invokesWitness, readingJson, warnLine } from './context-core.mjs';

// Row 191 §4.6: the nearest witness.config.yaml up from the session's directory decides the
// limit, as canon-guard.mjs finds its root: the walk goes up only past a directory that has none.
// In a plan's worktree it starts at the primary root, whose config the CLI reads
// (configCandidates). One that is there but cannot be read gives no limit, and so no warning.
async function configuredLimit($: EngineInterface): Promise<number | undefined> {
  for (const path of configCandidates(await $.session.cwd())) {
    if (!(await $.fs.exists(path))) continue;
    try {
      return contextLimitOf(await $.fs.read(path));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// The warning this session is owed at this fill: none in a gate reviewer's spawn, none without a
// configured limit, none under it.
async function warningAt($: EngineInterface, context: SessionContextUsage): Promise<string | undefined> {
  if ((await $.env.get('WITNESS_REVIEWER')) !== undefined) return undefined;
  const limit = await configuredLimit($);
  return limit === undefined ? undefined : warnLine(context.tokens, context.window, limit);
}

export const register: Register = (on) => {
  // Keyed by session id: /clear starts a new one (P7), which latches and warns afresh.
  const latched = new Set<string>();
  const warned = new Set<string>();

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // §4.1, P1: the status line's figures, free to read, set where this command inherits them.
    // A reading this call cannot take clears the last one: that names this same session, and the
    // CLI would trust it as live.
    let session: string | undefined;
    let context: SessionContextUsage | undefined;
    try {
      session = await $.session.id();
      context = (await $.session.usage()).context;
      await $.env.set('WITNESS_CONTEXT', readingJson(session, context.tokens, context.window, context.percent));
    } catch {
      session = undefined;
      try {
        await $.env.set('WITNESS_CONTEXT', undefined);
      } catch {
        /* the command runs all the same */
      }
    }
    // §4.6: the warning is the main loop's, once per session that has run the witness CLI. A
    // subagent's call carries the main loop's reading, but it neither latches the session nor
    // takes the warning the main loop is owed. Parallel calls run at once on one reading, so the
    // one warning is claimed at the check itself, with no await between, and handed back when
    // this call turns out to owe none.
    let warning: { session: string; line: string } | undefined;
    if (session !== undefined && context !== undefined && e.agentId === undefined) {
      if (invokesWitness(e.command)) latched.add(session);
      if (latched.has(session) && !warned.has(session)) {
        warned.add(session);
        const line = await warningAt($, context).catch(() => undefined);
        if (line === undefined) warned.delete(session);
        else warning = { session, line };
      }
    }
    // A call that rejects, or a next(e) that throws, carries no context either (D192): the claim goes
    // back before the error does, as at a deny, or the session would never be warned.
    let r: Awaited<ReturnType<typeof next>>;
    try {
      r = await next(e);
    } catch (err) {
      if (warning !== undefined) warned.delete(warning.session);
      throw err;
    }
    if (warning === undefined) return r;
    if (r.deny !== undefined) {
      warned.delete(warning.session);       // a deny carries no context: the warning waits for the next call
      return r;
    }
    // P3: the model reads `context` only as an array; a bare string is dropped without a word.
    return { ...r, context: [...(r.context ?? []), warning.line] };
  });
};
