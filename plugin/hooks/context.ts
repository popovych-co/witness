// witness context — the Claude Code half of row 191's adapter: the live reading in every Bash
// command's environment, and one warning per session at the limit.
//
// A hooks module: hooks.json names it under `modules`, beside the classic hooks (P1 ran both
// kinds from one hooks.json in one session). The plugin API is early access and moves between
// releases; its declaration file and `claude plugin validate plugin` are the authority over
// anything written here. The logic is context-core.mjs's, shared byte for byte with the Pi
// extension, and this file keeps only the calls on `$`.
//
// Fail open: everything before next(e) sits in one try/catch, so a reading that cannot be taken
// costs the command nothing. It runs unmeasured, and the CLI says so (§7: a release that changes
// this API turns the reading off, never the shell).
import type { EngineInterface, Register } from 'claude-code';
import { configCandidates, contextLimitOf, invokesWitness, readingJson, warnLine } from './context-core.mjs';

// Row 191 §4.6: the nearest witness.config.yaml up from the session's directory decides the
// limit; with none, there is no limit and no warning. A read that rejects is a file not there.
async function configuredLimit($: EngineInterface): Promise<number | undefined> {
  for (const path of configCandidates(await $.session.cwd())) {
    let text: string;
    try {
      text = await $.fs.read(path);
    } catch {
      continue;
    }
    return contextLimitOf(text);
  }
  return undefined;
}

export const register: Register = (on) => {
  // Keyed by session id: /clear starts a new one (P7), which latches and warns afresh.
  const latched = new Set<string>();
  const warned = new Set<string>();

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let session: string | undefined;
    let line: string | undefined;
    try {
      // §4.1, P1: the status line's figures, free to read, set where this command inherits them.
      session = await $.session.id();
      const { context } = await $.session.usage();
      await $.env.set('WITNESS_CONTEXT', readingJson(session, context.tokens, context.window, context.percent));
      if (invokesWitness(e.command)) latched.add(session);
      // §4.6: only in a session that has run the witness CLI, and never in a gate reviewer's spawn.
      if (latched.has(session) && !warned.has(session) && (await $.env.get('WITNESS_REVIEWER')) === undefined) {
        const limit = await configuredLimit($);
        if (limit !== undefined) line = warnLine(context.tokens, context.window, limit);
      }
    } catch {
      line = undefined;
    }
    const r = await next(e);
    if (session === undefined || line === undefined || r.deny !== undefined) return r;
    warned.add(session);
    // P3: the model reads `context` only as an array; a bare string is dropped without a word.
    return { ...r, context: [...(r.context ?? []), line] };
  });
};
