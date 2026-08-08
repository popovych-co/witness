import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { version } from './cli.js'
import { tryGit } from './gitio.js'
import { type Harness } from './harness.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { NPX_LATEST, compareTriple, pinIn } from './version.js'

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

export interface SyncResult { written: string[]; overwritten: string[] }

// The engine file is the one payload entry every harness carries, and its pin is what
// decides which CLI the whole pipeline runs — so it is also the only file whose pin can
// answer "which version installed what is here".
const ENGINE_SOURCE = 'plugin/commands/witness.md'

// Revision 6, extended by row 102. Committing the payload is load-bearing: the implement
// stage runs with cwd inside .witness/worktrees/<plan-id>, which is a checkout of the
// branch, so only committed files reach it. A gitignored target therefore has exactly one
// honest answer — refuse. `git add -f` would override a rule the human wrote down; writing
// without committing would leave the payload in the primary root and the worktree with no
// guard, while every `check` reads clean.
//
// Row 102 adds two more preconditions, because the rule that spared an edited file is
// gone and the write now clobbers:
//
//   payload-dirty      — a clobbered edit is recoverable only from git, so an uncommitted
//                        payload change must refuse rather than be overwritten into
//                        nothing. --untracked-files=all, so a present-but-untracked
//                        payload counts.
//   cli-behind-payload — an older CLI running in a repo a newer one installed would
//                        REVERT the payload, re-freezing the repo one version further
//                        back. Equal triples write (the witness-developer case);
//                        prerelease ordering is out of scope.
//
// All three refuse the WHOLE run, called BEFORE the lock and before any scaffold write,
// so a refusal leaves nothing half-installed — and a half-upgraded payload set (guard at
// one version, engine at another) is precisely the skew row 102 exists to close.
//
// harness.settings is deliberately outside the dirty guard: mergeSettings appends and
// never clobbers, so a dirty settings file is not at risk.
export function preflightPayload(root: string, harness: Harness): Result<void> {
  const targets = harness.payload.map((p) => p.to)
  const ignored = [...targets, ...(harness.settings ? [harness.settings] : [])]
    .filter((rel) => tryGit(root, 'check-ignore', '-q', '--', rel).ok)
  if (ignored.length > 0) {
    return refuse(ignored.map((rel) => v(rel, 'payload-ignored', 'matched by .gitignore',
      'a committable path — worktrees are branch checkouts, so only committed payloads reach ' +
      '.witness/worktrees/<plan-id>; un-ignore it, or install a different agent here')))
  }

  // A failed status call is not evidence of dirt: primaryRoot already proved this is a
  // repo, and inventing a refusal out of a git error would block the upgrade this row
  // exists to deliver.
  const status = tryGit(root, 'status', '--porcelain', '--untracked-files=all', '--', ...targets)
  const dirty = status.ok
    ? status.out.split('\n').filter((l) => l !== '').map((l) => l.slice(3).trim())
    : []
  // The remedy has to cover both authors of the dirt. `init` writes the payload and
  // commits it under a lock but NOT a transaction (verbs/init.ts), so a crash between
  // the two leaves a dirty payload the human never wrote — and telling them to commit it
  // would be telling them to commit bytes they did not author. Name both cases.
  if (dirty.length > 0) {
    return refuse(dirty.map((rel) => v(rel, 'payload-dirty', 'uncommitted change on a payload path',
      'a committed payload tree — init overwrites payload files now, and a clobbered edit is ' +
      'recoverable only from git; commit it if the change is yours, or revert it — a payload ' +
      'left dirty by a crashed init should be reverted, never committed')))
  }

  const engine = harness.payload.find((p) => p.from === ENGINE_SOURCE)
  const installedPin = engine !== undefined && existsSync(join(root, engine.to))
    ? pinIn(readFileSync(join(root, engine.to), 'utf8'))
    : undefined
  // `?? 0` is the "cannot compare, so do not refuse" rule: an unparseable pin must never
  // block an upgrade, exactly as compareTriple's undefined contract states.
  if (engine !== undefined && installedPin !== undefined && (compareTriple(version(), installedPin) ?? 0) < 0) {
    return refuse([v(engine.to, 'cli-behind-payload', `payload pins ${installedPin}, this CLI is ${version()}`,
      `a CLI at or ahead of the installed payload — run ${NPX_LATEST} init --agent ${harness.name}`)])
  }
  return ok(undefined)
}

// Revision 1: SYNC, not install-once. Row 102: three-way, not four. The payload files
// are witness's artifacts that happen to live in the user's repo — the engine file's pin
// is the single point deciding which CLI the entire pipeline runs, and there is no
// sanctioned way to customise any of them (the human's config home is
// witness.config.yaml, repo prose reaches reviewers through row 68's docs: registry).
// The rule that spared an edited file was defending an unsupported hack while the file
// it defended froze the repo forever, so it is gone: differing content is overwritten
// and NAMED, one `git revert` away because row 87 already commits the payload.
export function installPayload(root: string, harness: Harness): Result<SyncResult> {
  const pre = preflightPayload(root, harness)
  if (!pre.ok) return refuse(pre.violations)
  const out: SyncResult = { written: [], overwritten: [] }
  for (const { from, to } of harness.payload) {
    const src = join(packageRoot(), from)
    if (!existsSync(src)) {
      return refuse([v('payload', 'source-missing', from,
        'a file shipped in the witness tarball — reinstall @popovych.co/witness')])
    }
    const shipped = readFileSync(src, 'utf8')
    const dst = join(root, to)
    if (!existsSync(dst)) {
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, shipped)
      out.written.push(to)
      continue
    }
    if (readFileSync(dst, 'utf8') === shipped) continue
    writeFileSync(dst, shipped)
    out.overwritten.push(to)
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
