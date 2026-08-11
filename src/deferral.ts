import { randomBytes } from 'node:crypto'
import type { Entry } from './journal.js'

export type DeferralKind = 'artifact-debt' | 'lens-suspicion'
export type DismissCause = 'superseded' | 'lens-retired' | 'judged-wrong'
export const DISMISS_CAUSES: readonly DismissCause[] = ['superseded', 'lens-retired', 'judged-wrong']

export interface DeferralEntry {
  v: 1
  t: 'deferral'
  id: string
  artifact: string
  gate: string
  round: number
  anchor: string
  kind: DeferralKind
  caused_by_run: string
  moved_from?: string
}

// D122. A minted id, never a derived ordinal: the debt is re-booked onto the parent spec
// when its flow completes, and a per-stream ordinal renumbers when it changes homes — so
// "how long has this been open" becomes unanswerable across the move, and age is the only
// thing separating a fresh deferral from a chronic one. Same shape as `newRunId`.
export const newDeferralId = (): string => `d-${randomBytes(4).toString('hex')}`

// State is an append-only FOLD, never a mutation: `deferral` opens, `deferral-moved`
// closes it on THIS stream (it continues on another), `deferral-retyped` changes only its
// kind, and discharge/dismiss close it for good.
export function openDeferrals(entries: Entry[]): DeferralEntry[] {
  const open = new Map<string, DeferralEntry>()
  for (const e of entries) {
    const id = typeof e.id === 'string' ? e.id : undefined
    if (id === undefined) continue
    if (e.t === 'deferral') open.set(id, e as unknown as DeferralEntry)
    else if (e.t === 'deferral-moved' || e.t === 'deferral-discharged' || e.t === 'deferral-dismissed') open.delete(id)
    else if (e.t === 'deferral-retyped') {
      const cur = open.get(id)
      if (cur) open.set(id, { ...cur, kind: e.kind as DeferralKind })
    }
  }
  return [...open.values()]
}

// Injected into every lens, exactly as `pinsBlock` is, and joined to `prompts_sha` so a new
// obligation invalidates the verdict cache and the next round cannot judge without it.
// Deliberately the INVERSE of a pin: a pin tells reviewers not to re-litigate, this tells
// them to report the thing if it is still there. Pins suppress findings; obligations
// solicit them — which is what makes the discharge automatic and evidence-shaped.
export function deferralsBlock(open: DeferralEntry[]): string {
  if (open.length === 0) return ''
  return '## Open deferrals (human overrides — report these if they still hold)\n\n' +
    'A human approved this artifact over the findings below rather than fixing them. They are ' +
    'NOT settled policy and they are NOT pins. If the defect is still present, report it as a ' +
    'finding and anchor it exactly as listed. If it is gone, say so in your coverage. Silence ' +
    'is read as "still present".\n\n' +
    open.map((d, i) => `${i + 1}. ${d.anchor} — ${d.gate} round ${d.round} (${d.id})`).join('\n') + '\n\n'
}
