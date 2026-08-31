import { EXIT, type Ctx } from '../cli.js'
import { grantCommands, trustedCommands } from '../allowlist.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { appendEntry, entryLine, journalRel } from '../journal.js'
import { renderRefusal, v } from '../refusal.js'
import { effortOf } from '../reviewed.js'
import { findById, loadCanon } from '../scan.js'
import { kv, rows } from '../toon.js'
import { guardTxn, withTxn } from '../txn.js'

// D154. The green-path half. Trust rides the decision surface wherever a stop exists
// (`decide --approve --trust-cmds`), but a green-path class never stops — and a headless
// gate that blocks every untrusted command with no verb to unblock it is the Aug 1
// false negative with a nicer message. This is that verb.
//
// The trust list resolves at the PRIMARY ROOT, like the runner config it governs: a branch
// checkout cannot re-point what the repository trusts or runs (D132's doctrine).
export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const id = argv.find((a) => !a.startsWith('--'))
  if (!id) { ctx.err('usage: witness trust <artifact-id> [--yes]'); return EXIT.REFUSED }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked

  const canon = loadCanon(root)
  const doc = findById(canon, id)
  if (!doc) {
    renderRefusal([v('artifact', 'unknown-artifact', id, 'an existing canon doc id', 'witness index')])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  const criteria = (Array.isArray(doc.meta.criteria) ? doc.meta.criteria : []) as Array<Record<string, unknown>>
  const cmds = [...new Set(criteria.map((c) => c.cmd).filter((c): c is string => typeof c === 'string'))]
  if (cmds.length === 0) {
    ctx.out(kv('trust', `${id} carries no cmd: criteria — nothing to trust`))
    return EXIT.OK
  }

  const trusted = new Set(trustedCommands(root))
  const table = cmds.map((cmd) => ({ cmd, status: trusted.has(cmd) ? 'trusted' : 'untrusted' }))
  rows('criteria', ['cmd', 'status'], table as unknown as Array<Record<string, unknown>>).forEach((l) => ctx.out(l))
  const pending = cmds.filter((c) => !trusted.has(c))
  if (pending.length === 0) {
    ctx.out(kv('trust', 'every cmd: criterion is already trusted'))
    return EXIT.OK
  }

  // The same shape `ensureTrusted` uses, one command at a time, because trust is granted
  // per command and a blanket yes is a different act from four considered ones.
  const granting: string[] = []
  if (argv.includes('--yes')) {
    granting.push(...pending)
  } else if (ctx.isTTY) {
    for (const cmd of pending) {
      const answer = await ctx.ask(`trust: ${cmd}\ngrant? saves to .witness/allow.json (gitignored) [y/N]`)
      if (answer.trim().toLowerCase().startsWith('y')) granting.push(cmd)
    }
  }
  if (granting.length === 0) {
    // Listing is the honest answer for a non-TTY caller with no --yes: nothing was granted,
    // and exiting 0 would say the opposite.
    ctx.out(kv('trust', `${pending.length} untrusted — re-run with --yes to grant, or answer the prompts in a terminal`))
    return EXIT.FINDINGS
  }

  grantCommands(root, granting)
  journalTrust(ctx, root, id, granting)
  ctx.out(kv('trusted', granting.join(' · ')))
  return EXIT.OK
}

// Journaled like every other human act. Best-effort on the txn, `journalRefusal`'s
// precedent: a blocked transaction costs the record, never the grant that already landed —
// allow.json is machine-local and gitignored, so it is not part of the state commit.
export function journalTrust(ctx: Ctx, root: string, artifact: string, cmds: string[], via: 'verb' | 'decide' = 'verb'): void {
  const stream = effortOf(root, artifact) ?? artifact
  const entry = { t: 'trust' as const, artifact, cmds, via }
  const rel = journalRel(stream)
  const res = withTxn(root, { op: `trust(${artifact})`, files: [rel], journal: { stream, line: entryLine(entry) } }, () => {
    appendEntry(root, stream, entry)
    return stateCommit(root, [rel], `trust(${artifact}): ${cmds.length} command(s)`)
  })
  if (!res.ok) ctx.err('warn: trust grant could not be journaled (state paths dirty)')
}
