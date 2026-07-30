import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tryGit } from './gitio.js'
import { type Harness } from './harness.js'
import { ok, refuse, v, type Result } from './refusal.js'

// dist/install.js and src/install.ts both sit one level under the package root, so the
// same '..' works built and under vitest — the pattern model.ts:14 already uses. This is
// the only place that still needs it: locating the shipped `plugin/` tree, which is a
// genuine data dir already listed in package.json `files`.
export function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

// Project-scope hook commands. ${CLAUDE_PLUGIN_ROOT} exists only for plugin installs;
// a project install anchors on $CLAUDE_PROJECT_DIR, which Claude Code substitutes in
// hook commands (verified against 2.1.220).
const GUARD_CMD = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-state.mjs"'
const DASHBOARD_CMD = 'sh "$CLAUDE_PROJECT_DIR/.claude/hooks/session-dashboard.sh"'

interface HookEntry { matcher?: string; hooks: Array<{ type: string; command: string }> }

export interface SyncResult { written: string[]; restamped: string[]; modified: string[] }

const PIN = /@whatmatters\/specflow@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g

// Revision 6. Committing the payload is load-bearing: the implement stage runs with cwd
// inside .specflow/worktrees/<plan-id>, which is a checkout of the branch, so only
// committed files reach it. A gitignored target therefore has exactly one honest answer
// — refuse. `git add -f` would override a rule the human wrote down; writing without
// committing would leave the payload in the primary root and the worktree with no guard,
// while every `check` reads clean. Called BEFORE the lock and before any scaffold write,
// so a refusal leaves nothing half-installed.
export function preflightPayload(root: string, harness: Harness): Result<void> {
  const ignored = [...harness.payload.map((p) => p.to), ...(harness.settings ? [harness.settings] : [])]
    .filter((rel) => tryGit(root, 'check-ignore', '-q', '--', rel).ok)
  if (ignored.length === 0) return ok(undefined)
  return refuse(ignored.map((rel) => v(rel, 'payload-ignored', 'matched by .gitignore',
    'a committable path — worktrees are branch checkouts, so only committed payloads reach ' +
    '.specflow/worktrees/<plan-id>; un-ignore it, or install a different agent here')))
}

// A shipped file and an installed file that differ ONLY by version pin are the same
// file, one upgrade apart. Substituting the installed pin into the shipped text and
// comparing is exact — no heuristics, no diffing.
function pinOnlyDifference(shipped: string, installed: string): boolean {
  const installedPin = installed.match(PIN)?.[0]
  if (installedPin === undefined) return false
  return shipped.replace(PIN, installedPin) === installed
}

// Revision 1: SYNC, not install-once. These files are specflow's artifacts that happen
// to live in the user's repo, and the engine file's pin is the single point deciding
// which CLI version the entire pipeline runs — so an install-once rule pinned every repo
// to whatever version first touched it, forever, with `payload: already installed`
// printed on every attempt to fix it. A file the human actually edited is still theirs:
// report it, never clobber it.
export function installPayload(root: string, harness: Harness): Result<SyncResult> {
  const pre = preflightPayload(root, harness)
  if (!pre.ok) return refuse(pre.violations)
  const out: SyncResult = { written: [], restamped: [], modified: [] }
  for (const { from, to } of harness.payload) {
    const src = join(packageRoot(), from)
    if (!existsSync(src)) {
      return refuse([v('payload', 'source-missing', from,
        'a file shipped in the specflow tarball — reinstall @whatmatters/specflow')])
    }
    const shipped = readFileSync(src, 'utf8')
    const dst = join(root, to)
    if (!existsSync(dst)) {
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, shipped)
      out.written.push(to)
      continue
    }
    const installed = readFileSync(dst, 'utf8')
    if (installed === shipped) continue
    if (pinOnlyDifference(shipped, installed)) {
      writeFileSync(dst, shipped)
      out.restamped.push(to)
      continue
    }
    out.modified.push(to)
  }
  return ok(out)
}

function hasCommand(entries: HookEntry[] | undefined, command: string): boolean {
  return (entries ?? []).some((e) => (e.hooks ?? []).some((h) => h.command === command))
}

// Merge, never replace: .claude/settings.json is the human's file and may already carry
// their own hooks, model pin and permissions. We append only what is missing, matched
// by command string, and preserve every other key byte for byte.
export function mergeSettings(existing: string | undefined): { text: string; changed: boolean } {
  let doc: Record<string, unknown> = {}
  if (existing !== undefined && existing.trim() !== '') {
    try {
      doc = JSON.parse(existing) as Record<string, unknown>
    } catch {
      // Unparseable settings are the human's problem to fix; refusing to touch them is
      // safer than rewriting them. Signal "no change" and let init report it.
      return { text: existing, changed: false }
    }
  }
  const hooks = (doc.hooks ?? {}) as Record<string, HookEntry[] | undefined>
  let changed = false
  const pre = [...(hooks.PreToolUse ?? [])]
  for (const matcher of ['Edit|Write|MultiEdit', 'Bash']) {
    if (!pre.some((e) => e.matcher === matcher && hasCommand([e], GUARD_CMD))) {
      pre.push({ matcher, hooks: [{ type: 'command', command: GUARD_CMD }] })
      changed = true
    }
  }
  const start = [...(hooks.SessionStart ?? [])]
  if (!hasCommand(start, DASHBOARD_CMD)) {
    start.push({ hooks: [{ type: 'command', command: DASHBOARD_CMD }] })
    changed = true
  }
  if (!changed) return { text: existing ?? '', changed: false }
  doc.hooks = { ...hooks, PreToolUse: pre, SessionStart: start }
  return { text: `${JSON.stringify(doc, null, 2)}\n`, changed: true }
}

// The config rung of Decision 5's ladder. Recorded once, on the run that installs the
// first payload set; a later `--agent` for a second harness leaves it alone, because
// detection outranks it anyway and rewriting config is not what that run was asked for.
export function recordHarness(configText: string, name: string): { text: string; changed: boolean } {
  if (/^harness:/m.test(configText)) return { text: configText, changed: false }
  const suffix = configText.endsWith('\n') ? '' : '\n'
  return { text: `${configText}${suffix}harness: ${name}   # detection wins; this is the fallback\n`, changed: true }
}

export function writeSettings(root: string, rel: string, text: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}

export function readIfExists(root: string, rel: string): string | undefined {
  const p = join(root, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined
}
