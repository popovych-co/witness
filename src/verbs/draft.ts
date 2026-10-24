import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { journalStamp } from '../context.js'
import {
  draftSummary, dropDraft, keyName, markRead, parseKey, readDraft, saveDraft, settledItems, validateDraft, type DraftKey,
} from '../drafts.js'
import { primaryRoot } from '../gitio.js'
import { latestRecap } from '../journal.js'
import { renderRefusal, v, type Violation } from '../refusal.js'
import { findById, loadCanon } from '../scan.js'
import { kv } from '../toon.js'
import { askRefusal, effortRefusal } from './recap.js'

// Row 199. A grill's or design session's local draft, saved after every settled answer and read
// back to resume. Drafts are not state: no lock, no txn guard, no commit, no journal line. The
// saver's session rides in the file, which is what lets row 191 count a save as an act.
export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { file: { type: 'string' } } })
  const raw = positionals[0]
  if (!raw) { ctx.err('usage: witness draft <ask-<id>|amend-<effort>|design-<spec-id>> [--file <json>]'); return EXIT.REFUSED }
  const refused = (violations: Violation[]): number => { renderRefusal(violations).forEach(ctx.err); return EXIT.REFUSED }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) return refused(rootR.violations)
  const root = rootR.value

  const k = parseKey(raw)
  if (k === undefined) return refused([v('key', 'bad-key', raw, 'ask-<id> | amend-<effort> | design-<spec-id>')])
  const referent = referentRefusal(root, k)
  if (referent !== undefined) return refused([referent])

  const stored = readDraft(root, k)
  const session = journalStamp(ctx.env)?.session
  if (values.file === undefined) {
    if (!stored.ok) return refused(stored.violations)
    if (stored.value === undefined) {
      if (k.kind !== 'amend') return refused([v('key', 'no-draft', keyName(k), `a saved draft — witness draft ${keyName(k)} --file <json>`)])
      // Builder's call 8: an amendment starts from the latest recap, every text exact, because a
      // decision's text is part of the pin of every plan that carries it.
      const r = latestRecap(root, k.effort)!
      ctx.out(kv('draft', `${keyName(k)} · seeded from the latest recap`))
      const seed = {
        effort: r.effort, class: r.class, goals: r.goals, non_goals: r.non_goals, constraints: r.constraints,
        ...(r.decisions !== undefined ? { decisions: r.decisions } : {}), slices: r.slices,
      }
      JSON.stringify(seed, null, 2).split('\n').forEach((l) => ctx.out(l))
      return EXIT.OK
    }
    ctx.out(kv('draft', `${keyName(k)} · ${draftSummary(k, stored.value.draft)}`))
    JSON.stringify(stored.value.draft, null, 2).split('\n').forEach((l) => ctx.out(l))
    if (session !== undefined) markRead(root, k, stored.value, session)
    return EXIT.OK
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(resolve(ctx.cwd, values.file), 'utf8'))
  } catch (e) {
    return refused([v('--file', 'input-json', String((e as Error).message).slice(0, 120), 'readable JSON file')])
  }
  const violations = validateDraft(k, parsed)
  if (violations.length) return refused(violations)
  const draft = parsed as Record<string, unknown>
  // Builder's call 11. Two chats routed into one conversation would otherwise overwrite each
  // other's answers unseen. A session that saved this draft, or read it back since, has seen every
  // answer in it, so it may drop or reword one — that is the human's call in its chat.
  const seen = stored.ok && (stored.value?.session === session || stored.value?.read?.includes(session ?? '') === true)
  if (stored.ok && stored.value?.session !== undefined && session !== undefined && !seen) {
    const kept = new Set(settledItems(k, draft))
    const lost = settledItems(k, stored.value.draft).filter((i) => !kept.has(i))
    if (lost.length) {
      return refused([v('key', 'draft-moved', `${keyName(k)} would drop ${lost.join(' · ')}`,
        `this draft holds answers another session saved — read it back (witness draft ${keyName(k)}) and continue from it`)])
    }
  }
  saveDraft(root, k, draft, session)
  ctx.out(kv('draft', `${keyName(k)} — saved · ${draftSummary(k, draft)}`))
  return EXIT.OK
}

// Builder's call 13. A draft's key refuses what its recap would, by the recap's own rules: a draft
// for an ask no recap may answer, or an effort no amendment may land on, is a conversation with no
// way to end. An answered or withdrawn ask's stale draft is removed on the way.
function referentRefusal(root: string, k: DraftKey): Violation | undefined {
  const asKey = (x: Violation): Violation => ({ ...x, field: 'key' })
  if (k.kind === 'ask') {
    const refusal = askRefusal(root, k.id)
    if (refusal !== undefined && refusal.rule !== 'unknown-ask') dropDraft(root, k)
    return refusal === undefined ? undefined : asKey(refusal)
  }
  if (k.kind === 'amend') {
    const refusal = effortRefusal(root, k.effort, true)
    if (refusal !== undefined) return asKey(refusal)
    return latestRecap(root, k.effort) === undefined
      ? v('key', 'unknown-effort', k.effort, 'an effort with a recap to amend')
      : undefined
  }
  return findById(loadCanon(root), k.spec)?.meta.type === 'spec'
    ? undefined
    : v('key', 'unknown-spec', k.spec, 'a specs/ doc id')
}
