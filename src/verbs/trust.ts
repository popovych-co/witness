import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { commandsRun, grantCommands, trustListing, trustStatus, trustedCommands } from '../allowlist.js'
import { loadConfig } from '../config.js'
import { sessionMarker } from '../drive-presence.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { appendEntry, entryLine, journalRel } from '../journal.js'
import { acquireLock } from '../lock.js'
import { ok, renderRefusal, v, type Result } from '../refusal.js'
import { effortOf } from '../reviewed.js'
import { findById, loadCanon } from '../scan.js'
import { cmd as cmdLine, hasControl, kv, rows, visible } from '../toon.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'

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
  if (positionals.length > 1 || (granting && id === undefined)) {
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
    renderRefusal([v('--yes', 'yes-needs-terminal', 'no terminal', `name each command: witness trust ${id} --cmd '<cmd>'`)])
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
    ctx.out(kv('trust', `${unsafe} carry characters outside printable ASCII — never granted here · rewrite where it is written`))
    return EXIT.FINDINGS
  }

  if (id === undefined) {
    show(['cmd', 'source', 'doc', 'status'])
    if (listing.untrusted === 0) return settled(listing.unsafe)
    ctx.out(kv('trust', `${listing.untrusted} untrusted — grant each from the target that runs it: witness trust <id> --cmd '<cmd>'`))
    return EXIT.FINDINGS
  }

  // The grant flow takes the raw commands the target's flow runs, which the listing holds only
  // escaped: a grant is of the exact bytes. The listing resolved the target.
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
  // An unsafe command is listed and never pending: no flag and no prompt grants it.
  const trusted = new Set(trustedCommands(root))
  const pending = cmds.filter((c) => trustStatus(trusted, c) === 'untrusted')

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
    // opposite. Each line pastes as one argument, whatever quotes the command carries.
    ctx.out(kv('trust', `${listing.untrusted} untrusted — the human names each to trust it`))
    for (const a of listing.pending) ctx.out(cmdLine('run', a.line))
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
