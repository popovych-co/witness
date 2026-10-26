// witness Pi extension — the canon guard, the session dashboard and the context reading.
//
// The Pi half of Decision 8: one pure canonGuard, thin per-harness adapters. The tool
// names are pi's (`write`, `edit`, `bash` — there is no MultiEdit) and the path key is
// `path`; canonGuard accepts both vocabularies so this file needs no translation table.
// Row 191's context duty is the same shape: context-core.mjs holds it for both harnesses,
// and this file keeps only pi's calls (ctx.getContextUsage, ctx.sessionManager, process.env).
//
// canon-guard.mjs and context-core.mjs are imported by RELATIVE path and are siblings in
// the installed layout (.pi/extensions/) — see the pi descriptor's payload recipe. A
// package import would resolve-fail in a repo with no witness install (Decision 13).
//
// Every failure path falls open: a broken extension must never brick a session. On Pi
// that is NOT free. docs/extensions.md, "Error Handling": *extension errors are logged,
// agent continues; `tool_call` errors block the tool (fail-safe)* — the inversion is
// scoped to exactly the event the guard uses. So the try/catch below is load-bearing,
// not garnish: without it an unparseable witness.config.yaml would refuse every write
// in the repo, `src/` included. Do not remove it because canonGuard already catches.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canonGuard } from "./canon-guard.mjs";
import {
  configCandidates, contextLimitOf, invokesWitness, pinOf, readingJson, waitArgv, waitRequest, wakeAllowed, warnLine,
} from "./context-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// The Claude Code SessionStart hook injects the dashboard as session context. Pi's
// analogue is before_agent_start's `message`, which is stored in the session and sent
// to the model — a real transcript entry, not a toast. Once per session, latched.
function dashboardText(cwd: string): string {
  const script = process.env.WITNESS_DASHBOARD ?? join(here, "session-dashboard.sh");
  try {
    const r = spawnSync("sh", [script], { cwd, encoding: "utf8", timeout: 60_000 });
    return (r.stdout ?? "").trim();
  } catch {
    return "";
  }
}

// Row 191 §4.6: the nearest witness.config.yaml up from the session's directory decides
// the limit, as canon-guard.mjs finds its root: the walk stops at the first that exists. In a
// plan's worktree it starts at the primary root, whose config the CLI reads (configCandidates).
// One that cannot be read gives no limit, and so no warning; with none, the same.
function configuredLimit(cwd: string): number | undefined {
  const path = configCandidates(cwd).find((candidate) => existsSync(candidate));
  if (path === undefined) return undefined;
  try {
    return contextLimitOf(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// Row 204: the CLI version the engine resolves `$WITNESS` to, read from the engine installed
// beside this file (.pi/prompts/witness.md), or the plugin's own copy when run from it.
function enginePin(): string | undefined {
  for (const p of [join(here, "..", "prompts", "witness.md"), join(here, "..", "commands", "witness.md")]) {
    try {
      const pin = pinOf(readFileSync(p, "utf8"));
      if (pin !== undefined) return pin;
    } catch {
      /* next candidate */
    }
  }
  return undefined;
}

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content.flatMap((c) => (c !== null && typeof c === "object" && (c as { type?: unknown }).type === "text" ? [String((c as { text?: unknown }).text)] : [])).join("\n")
    : "";

export default function (pi: ExtensionAPI) {
  // Row 204, keyed by session id: the wait the last witness command asked for, and the one
  // waiter this session runs. A newer request replaces the waiter; a replaced or shut-down
  // waiter posts nothing.
  const requests = new Map<string, { token: string } | undefined>();
  const waiters = new Map<string, ChildProcess>();
  // Row 191 §4.6, keyed by session id: after `new_session` the session id moves (P7), and
  // the new session latches and warns afresh.
  const latched = new Set<string>();
  const warned = new Set<string>();

  pi.on("tool_call", async (event, ctx) => {
    try {
      const verdict = canonGuard({ tool: event.toolName, input: event.input, cwd: ctx.cwd });
      if (verdict) {
        // Isolated: the toast is cosmetic, the verdict is not. A notify failure must
        // never downgrade a block we already decided into an allow.
        try {
          if (ctx.hasUI) ctx.ui.notify("witness: canon write blocked — use the CLI", "warning");
        } catch {
          /* cosmetic only */
        }
        return { block: true, reason: verdict.reason };
      }
    } catch {
      /* the guard falls open */
    }
    // Row 191 §4.1: the live reading, in the environment the bash tool spawns this very
    // command with (getShellEnv() spreads process.env at spawn time — P2). Its own
    // try/catch, load-bearing for the same reason as the guard's: a throw here would block
    // the command it was only meant to measure.
    try {
      if (event.toolName === "bash") {
        const session = ctx.sessionManager.getSessionId();
        const usage = ctx.getContextUsage();
        process.env.WITNESS_CONTEXT = readingJson(session, usage?.tokens, usage?.contextWindow, usage?.percent);
        if (invokesWitness(event.input.command)) latched.add(session);
      }
    } catch {
      // No reading this time, and none left over: the last one names this same session, and
      // the CLI would trust it as live. The command runs all the same, unmeasured.
      delete process.env.WITNESS_CONTEXT;
    }
    return undefined;
  });

  // Row 191 §4.6: once per session, the first bash result at or over the limit in a session
  // that has run the witness CLI carries one more text block, which the model reads with the
  // output (P2). Never in a gate reviewer's spawn, never without a witness.config.yaml.
  pi.on("tool_result", async (event, ctx) => {
    // Row 204: the last witness command decides whether this chat waits. Its own try/catch:
    // the warning below must never be lost to it.
    try {
      if (event.toolName === "bash" && invokesWitness((event.input as { command?: unknown } | undefined)?.command)) {
        requests.set(ctx.sessionManager.getSessionId(), waitRequest(textOf(event.content)));
      }
    } catch {
      /* no wait this time */
    }
    try {
      if (event.toolName !== "bash") return undefined;
      const session = ctx.sessionManager.getSessionId();
      if (!latched.has(session) || warned.has(session) || process.env.WITNESS_REVIEWER !== undefined) return undefined;
      const limit = configuredLimit(ctx.cwd);
      if (limit === undefined) return undefined;
      const usage = ctx.getContextUsage();
      const line = warnLine(usage?.tokens, usage?.contextWindow, limit);
      if (line === undefined) return undefined;
      const content = [...event.content, { type: "text" as const, text: line }];
      warned.add(session);
      return { content };
    } catch {
      return undefined;
    }
  });

  // Row 204. Once a turn has fully settled — no retry, compaction or queued continuation left —
  // a chat whose last witness command printed a `wait:` line in the add-on mode is woken by
  // the wait's own output when it exits. Every failure path falls open: no wake, never a block.
  pi.on("agent_settled", async (_event, ctx) => {
    try {
      const session = ctx.sessionManager.getSessionId();
      const request = requests.get(session);
      requests.delete(session);
      if (request === undefined || !wakeAllowed({ hasUI: ctx.hasUI, env: process.env })) return;
      const argv = waitArgv({
        bin: process.env.WITNESS_BIN, pin: enginePin(), token: request.token, platform: process.platform,
        systemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
      });
      if (argv === undefined) return;
      waiters.get(session)?.kill();
      const child = spawn(argv[0]!, argv.slice(1), { cwd: ctx.cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      waiters.set(session, child);
      let out = "";
      child.stdout?.on("data", (d) => { out += String(d); });
      child.on("error", () => { if (waiters.get(session) === child) waiters.delete(session); });
      child.on("close", (_code, signal) => {
        if (waiters.get(session) !== child) return;
        waiters.delete(session);
        if (signal !== null) return;
        try {
          pi.sendMessage({ customType: "witness-wait", content: out.trim() || "wait: ended", display: true },
            { triggerTurn: true, deliverAs: "followUp" });
        } catch {
          /* no wake */
        }
      });
    } catch {
      /* falls open */
    }
  });
  pi.on("session_shutdown", async () => {
    const all = [...waiters.values()];
    waiters.clear();
    for (const child of all) {
      try { child.kill(); } catch { /* gone */ }
    }
  });

  let injected = false;
  pi.on("session_start", async () => {
    injected = false;
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (injected) return undefined;
    injected = true;
    const text = dashboardText(ctx.cwd);
    if (text === "") return undefined;
    return { message: { customType: "witness-dashboard", content: text, display: true } };
  });
}
