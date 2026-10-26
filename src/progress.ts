import type { Entry, EntryType } from './journal.js'
import { vacuousEvidence } from './steps.js'

// Row 206. Every journal kind is either an act, which moves a flow, or bookkeeping, which
// does not. Drive's no-progress check and its take-back key both read this table: counted,
// the sync every implement session's `start` journals when the repo has a remote, and row
// 81's dispatch telemetry, read as progress, and a session that only failed was respawned to
// the cap (issue #56). A Record, so a new kind without a row fails the build rather than
// looping drive by default.
export const ENTRY_PROGRESS: Record<EntryType, 'act' | 'bookkeeping'> = {
  recap: 'act', write: 'act', 'gate-run': 'act', 'human-decision': 'act', 'test-evidence': 'act',
  adopt: 'act', status: 'act',
  'design-write': 'act', 'design-reconfirm': 'act', 'design-stamp': 'act', 'design-shown': 'act',
  trust: 'act',
  deferral: 'act', 'deferral-moved': 'act', 'deferral-retyped': 'act', 'deferral-discharged': 'act', 'deferral-dismissed': 'act',
  ask: 'act', 'ask-withdrawn': 'act', 'need-satisfied': 'act', 'step-close': 'act', retry: 'act',
  // A refused write is the CLI saying no (F5). A sync is the merge stamp's or `start`'s
  // automatic act on the human's behalf (D138). A dispatch report is telemetry (row 81). A
  // drift check reads; a policy pin records the rule a decision ran under.
  'write-refused': 'bookkeeping', sync: 'bookkeeping', dispatch: 'bookkeeping',
  'drift-check': 'bookkeeping', 'policy-pin': 'bookkeeping',
}

// A vacuous red moves nothing either (row 191, final review I3). A kind this CLI does not
// know — a hand-edited journal — is no motion.
export const movesFlow = (e: Entry): boolean =>
  Object.hasOwn(ENTRY_PROGRESS, e.t) && ENTRY_PROGRESS[e.t] === 'act' && !vacuousEvidence(e)
