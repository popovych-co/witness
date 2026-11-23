import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { commandsRun, grantCommands, pendingCmds, pendingRows, trustedCommands, trustListing, unsafeLeft } from '../allowlist.js'
import type { Config } from '../config.js'
import { loadConfig } from '../config.js'
import { sessionMarker } from '../drive-presence.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { appendEntry, entryLine, journalRel, readStream } from '../journal.js'
import { acquireLock } from '../lock.js'
import { ok, refuse, renderRefusal, v, type Result, type Violation } from '../refusal.js'
import { effortOf } from '../reviewed.js'
import { findById, loadCanon } from '../scan.js'
import { hasControl, kv, rows, shellWord, visible } from '../toon.js'
import { headlessCommands } from '../jobs.js'
import { TRUST_STREAM } from '../streams.js'
import { crashPoint, guardTxn, pendingTxn, withTxn } from '../txn.js'

const USAGE = "witness trust [<artifact-id>] [--cmd '<exact command>']… [--yes]"

// D154. The green-path half. Trust rides the decision surface wherever a stop exists
// (`decide --approve --trust-cmds`), but a green-path class never stops — and a headless
// gate that blocks every untrusted command with no verb to unblock it is the Aug 1
// false negative with a nicer message. This is that verb.
//
// Row 205 (issue #56). It lists every command the target's flow runs — the config commands,
// the spec's `cmd:` criteria for a plan, the target's `cmd:` needs — and grants only what the
// human names: `--cmd '<exact>'` per command, `--yes` for all of them only at a terminal, and
// nothing from inside a session drive spawned or a reviewer runs in (row 173's rule, extended
// from `decide` to the verb). A bare nod is never a grant (D143).
//
// The trust list resolves at the PRIMARY ROOT, like the runner config it governs: a branch
// checkout cannot re-point what the repository trusts or runs (D132's doctrine).
//
// Row 259. A repo command — one a repo setting declares (the runner, ship.test, ship.lint,
// scratch.prepare) — is also granted with no target: `witness trust --cmd '<exact>'`, journaled on
// witness's reserved `trust` stream. A drive job or a scratch prepare serves no artifact, so the
// grant its wait names has none. `--yes` still needs a target: a blanket yes is a target's act.
export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  let parsed: { values: { cmd?: string[]; yes?: boolean }; positionals: string[] }
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true,
      options: { cmd: { type: 'string', multiple: true }, yes: { type: 'boolean' } },
    })
  } catch (e) {
    renderRefusal([v('usage', 'bad-flag', (e as Error).message, USAGE)]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const { values, positionals } = parsed
  const id = positionals[0]
  const named = values.cmd ?? []
  const granting = named.length > 0 || values.yes === true
  if (positionals.length > 1 || (values.yes === true && id === undefined)) {
    renderRefusal([v('usage', 'required', positionals.length > 1 ? positionals.join(' ') : 'no target',
      'a grant names its target, which the act is journaled against: ' + USAGE)]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const marker = sessionMarker(ctx.env)
  if (granting && marker !== undefined) {
    renderRefusal([v('trust', 'trust-in-session', marker, 'the human grants trust in their own chat or terminal')])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  if (values.yes === true && !ctx.isTTY) {
    // Row 239. A shape: the target the human typed is quoted (a grant without one was refused
    // above), and the command is theirs to name.
    renderRefusal([v('--yes', 'yes-needs-terminal', 'no terminal', `name each command: witness trust ${shellWord(id!)} --cmd '<cmd>'`)])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  if (id === undefined && named.length > 0) return grantRepo(ctx, root, cfgR.value, named)
  const canon = loadCanon(root)
  // Rows 139/203. The listing is a model the verb prints: its rows, its counts and the grants it
  // offers. An unknown target is its refusal.
  // Every repo-authored field is shown escaped: a criterion's or a need's id rides in `source`.
  const listingR = trustListing(root, cfgR.value, canon, id)
  if (!listingR.ok) { renderRefusal(listingR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const listing = listingR.value
  const show = (fields: string[]) => rows('commands', fields, listing.rows.map((r) => ({ ...r }))).forEach((l) => ctx.out(l))
  // Nothing left to grant is not "all trusted" while an unsafe command stays blocked.
  const settled = (unsafe: number): number => {
    if (unsafe === 0) { ctx.out(kv('trust', 'every command is already trusted')); return EXIT.OK }
    ctx.out(kv('trust', unsafeLeft(unsafe)))
    return EXIT.FINDINGS
  }

  if (id === undefined) {
    show(['cmd', 'source', 'doc', 'status'])
    if (listing.untrusted === 0) return settled(listing.unsafe)
    ctx.out(kv('trust', `${listing.untrusted} untrusted — a repo command (doc -): witness trust --cmd '<cmd>' · a doc's: witness trust <id> --cmd '<cmd>'`))
    return EXIT.FINDINGS
  }

  // A named command is checked against the raw commands the target's flow runs, which the listing's
  // rows hold only escaped: a grant is of the exact bytes. The listing resolved the target.
  const listed = commandsRun(cfgR.value, canon, findById(canon, id)!)
  const cmds = [...new Set(listed.map((c) => c.cmd))]
  const unsafe = named.find(hasControl)
  if (unsafe !== undefined) {
    renderRefusal([v('--cmd', 'control-characters', visible(unsafe),
      'a command of printable ASCII — any other character can hide what it runs')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const unknown = named.filter((c) => !cmds.includes(c))
  if (unknown.length > 0) {
    renderRefusal([v('--cmd', 'unknown-command', unknown[0]!, `one of: ${cmds.map(visible).join(' · ') || '(nothing to trust)'}`)])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  if (cmds.length === 0) {
    ctx.out(kv('trust', `${id} runs no command — nothing to trust`))
    return EXIT.OK
  }
  show(['cmd', 'source', 'status'])
  if (listing.untrusted === 0) return settled(listing.unsafe)
  // Row 205. What is pending is the listing's, read from allow.json once with its rows: a grant
  // landing since cannot make the grant disagree with the rows just printed. An unsafe command is
  // listed and never pending: no flag and no prompt grants it.
  const pending = pendingCmds(listing)

  // One command at a time, because a blanket yes is a different act from four considered ones:
  // the named ones, all at a terminal's --yes, or the terminal's own per-command prompt.
  const grant: string[] = []
  if (named.length > 0) grant.push(...pending.filter((c) => named.includes(c)))
  else if (values.yes === true) grant.push(...pending)
  else if (ctx.isTTY && marker === undefined) {
    for (const cmd of pending) {
      const answer = await ctx.ask(`trust: ${cmd}\ngrant? saves to .witness/allow.json (gitignored) [y/N]`)
      if (answer.trim().toLowerCase().startsWith('y')) grant.push(cmd)
    }
  }
  if (grant.length === 0) {
    if (named.length > 0) { ctx.out(kv('trust', `already trusted: ${named.join(' · ')}`)); return EXIT.OK }
    // Listing is the honest answer for a caller that granted nothing: exiting 0 would say the
    // opposite. Each line pastes as one argument, whatever quotes the command carries. Row 239: a
    // grant Windows withholds is a note naming why, never a line to paste; it stays pending, so
    // this listing run at a terminal asks for it.
    ctx.out(kv('trust', `${listing.untrusted} untrusted — the human names each to trust it`))
    pendingRows(listing).forEach((l) => ctx.out(l))
    return EXIT.FINDINGS
  }

  const granted = grantTrust(ctx, root, id, grant, 'verb')
  if (!granted.ok) {
    renderRefusal(granted.violations).forEach((l) => ctx.err(l))
    return granted.violations.some((x) => x.rule === 'locked') ? EXIT.BLOCKED : EXIT.REFUSED
  }
  ctx.out(kv('trusted', grant.join(' · ')))
  return EXIT.OK
}

// Row 222 (#67). A grant is a state write like every other: under the repo lock, one
// transaction appends the `trust` entry and lands its trailer commit, and only then does
// allow.json take the commands — D154's order, a grant follows the durable record, so a
// refused commit or a crash before it leaves no grant nobody journaled. allow.json is
// machine-local and gitignored, so it rides the lock, never the commit; the lock is what
// keeps two grants' read-modify-write of it from losing one.
export function grantTrust(ctx: Ctx, root: string, artifact: string, cmds: string[], via: 'verb' | 'decide'): Result<void> {
  const lock = acquireLock(root)
  if (!lock.ok) return lock
  try {
    const stream = effortOf(root, artifact) ?? artifact
    const entry = { t: 'trust' as const, artifact, cmds, via }
    const rel = journalRel(stream)
    const res = withTxn(root, { op: `trust(${artifact})`, files: [rel], journal: { stream, line: entryLine(entry) } }, () => {
      appendEntry(root, stream, entry)
      crashPoint(ctx.env, 'trust-journal')
      const committed = stateCommit(root, [rel], `trust(${artifact}): ${cmds.length} command(s)`)
      if (committed.ok) grantCommands(root, cmds)
      return committed
    })
    return res.ok ? ok(undefined) : res
  } finally {
    lock.value()
  }
}

// ── Repo commands (row 259) ──────────────────────────────────────────────────────────────────

const refused = (ctx: Ctx, rows: Violation[]): number => {
  renderRefusal(rows).forEach((l) => ctx.err(l))
  return rows.some((x) => x.rule === 'locked') ? EXIT.BLOCKED : EXIT.REFUSED
}

// The targetless grant: each named command must be one a repo setting declares, and printable
// ASCII; those not yet trusted are journaled and granted in one act.
function grantRepo(ctx: Ctx, root: string, cfg: Config, named: string[]): number {
  const unsafe = named.find(hasControl)
  if (unsafe !== undefined) {
    return refused(ctx, [v('--cmd', 'control-characters', visible(unsafe),
      'a command of printable ASCII — any other character can hide what it runs')])
  }
  // Final review: every command witness runs headless — a drive job's own included, so the grant
  // its wait offers is one this verb takes.
  const cmds = [...new Set(headlessCommands(cfg, ctx.env).map((c) => c.cmd))]
  const unknown = named.filter((c) => !cmds.includes(c))
  if (unknown.length > 0) {
    return refused(ctx, [v('--cmd', 'unknown-command', visible(unknown[0]!),
      `a repo command: ${cmds.map(visible).join(' · ') || '(none declared)'} · a doc's command takes its target: witness trust <id> --cmd '<cmd>'`)])
  }
  const trusted = new Set(trustedCommands(root))
  const grant = [...new Set(named)].filter((c) => !trusted.has(c))
  if (grant.length === 0) {
    ctx.out(kv('trust', `already trusted: ${named.join(' · ')}`))
    return EXIT.OK
  }
  const granted = grantRepoTrust(ctx, root, grant, 'verb')
  if (!granted.ok) return refused(ctx, granted.violations)
  ctx.out(kv('trusted', grant.join(' · ')))
  return EXIT.OK
}

// A repo grant as journaled: a `trust` entry (an act, as a target's) whose artifact is '-'.
export function repoTrustEntry(cmds: string[], via: 'verb' | 'migrate') {
  return { t: 'trust' as const, artifact: '-', cmds, via }
}

// F7's rule for reserved streams: one an older witness, or another artifact, wrote under the name
// is that history, and a grant appended to it would be read as part of it.
export function trustStreamTaken(root: string): Violation | undefined {
  const first = readStream(root, TRUST_STREAM)[0]
  return first !== undefined && first.t !== 'trust'
    ? v(TRUST_STREAM, 'stream-taken', `the stream starts with ${visible(String(first.t))}`,
      'a stream for repo trust grants alone — witness check names the artifact that holds it')
    : undefined
}

// grantTrust's shape (row 222) on witness's own `trust` stream: under the repo lock, one
// transaction appends the entry and lands its trailer commit, and only then does allow.json take
// the commands (D154's order).
export function grantRepoTrust(ctx: Ctx, root: string, cmds: string[], via: 'verb' | 'migrate'): Result<void> {
  const lock = acquireLock(root)
  if (!lock.ok) return lock
  try {
    const pending = pendingTxn(root)
    if (pending !== undefined) return refuse([v('.witness/txn.json', 'pending-txn', pending.op, 'witness recover --complete | --rollback')])
    const taken = trustStreamTaken(root)
    if (taken !== undefined) return refuse([taken])
    const entry = repoTrustEntry(cmds, via)
    const rel = journalRel(TRUST_STREAM)
    const res = withTxn(root, { op: 'trust(repo)', files: [rel], journal: { stream: TRUST_STREAM, line: entryLine(entry) } }, () => {
      appendEntry(root, TRUST_STREAM, entry)
      crashPoint(ctx.env, 'trust-journal')
      const committed = stateCommit(root, [rel], `trust: ${cmds.length} repo command(s)`)
      if (committed.ok) grantCommands(root, cmds)
      return committed
    })
    return res.ok ? ok(undefined) : res
  } finally {
    lock.value()
  }
}
