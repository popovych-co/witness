// The stream ids witness owns for its own records (F7's reserved ids). A leaf, imported by `ask.ts`,
// `check`, the jobs and the trust verb alike: `ask.ts` reading `jobs.ts` for one of them made the
// import cycle ask → jobs → runner → allowlist → scan → ask (T2a's deferred M4).
export const JOB_STREAM = 'jobs'     // row 257: drive's shard outcomes
export const TRUST_STREAM = 'trust'  // row 259: repo-level trust grants, a command with no target
export const LEDGER_STREAM = 'ledger' // row 269: the repo ledger, what a human booked
