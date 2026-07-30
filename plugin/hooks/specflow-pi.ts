// specflow Pi extension — the canon guard plus the session dashboard.
//
// The Pi half of Decision 8: one pure canonGuard, thin per-harness adapters. The tool
// names are pi's (`write`, `edit`, `bash` — there is no MultiEdit) and the path key is
// `path`; canonGuard accepts both vocabularies so this file needs no translation table.
//
// canon-guard.mjs is imported by RELATIVE path and is a sibling in the installed
// layout (.pi/extensions/) — see the pi descriptor's payload recipe. A package import
// would resolve-fail in a repo with no specflow install (Decision 13).
//
// Every failure path falls open: a broken extension must never brick a session. On Pi
// that is NOT free. docs/extensions.md, "Error Handling": *extension errors are logged,
// agent continues; `tool_call` errors block the tool (fail-safe)* — the inversion is
// scoped to exactly the event the guard uses. So the try/catch below is load-bearing,
// not garnish: without it an unparseable specflow.config.yaml would refuse every write
// in the repo, `src/` included. Do not remove it because canonGuard already catches.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canonGuard } from "./canon-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// The Claude Code SessionStart hook injects the dashboard as session context. Pi's
// analogue is before_agent_start's `message`, which is stored in the session and sent
// to the model — a real transcript entry, not a toast. Once per session, latched.
function dashboardText(cwd: string): string {
  const script = process.env.SPECFLOW_DASHBOARD ?? join(here, "session-dashboard.sh");
  try {
    const r = spawnSync("sh", [script], { cwd, encoding: "utf8", timeout: 60_000 });
    return (r.stdout ?? "").trim();
  } catch {
    return "";
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    try {
      const verdict = canonGuard({ tool: event.toolName, input: event.input, cwd: ctx.cwd });
      if (!verdict) return undefined;
      // Isolated: the toast is cosmetic, the verdict is not. A notify failure must
      // never downgrade a block we already decided into an allow.
      try {
        if (ctx.hasUI) ctx.ui.notify("specflow: canon write blocked — use the CLI", "warning");
      } catch {
        /* cosmetic only */
      }
      return { block: true, reason: verdict.reason };
    } catch {
      return undefined;
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
    return { message: { customType: "specflow-dashboard", content: text, display: true } };
  });
}
