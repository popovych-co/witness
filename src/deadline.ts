import { basename } from 'node:path'

// Row 256. Drive names each session's deadline file in this variable, an absolute path to
// `.witness/live/deadline/<drive pid>-<spawn n>.json`, and moves the deadline there while the
// session waits behind a job. `WITNESS_DRIVE_DEADLINE` keeps its meaning (row 210).
export const DRIVE_DEADLINE_FILE_ENV = 'WITNESS_DRIVE_DEADLINE_FILE'

const TOKEN = /^[1-9][0-9]*-[1-9][0-9]*$/

// Row 255. The session a test run belongs to, as its turn ticket names it, so drive can see the
// session waiting behind a job. Read from the file's name alone, never its contents: a name that is
// not `<drive pid>-<spawn n>.json` names no session.
export function sessionToken(env: Record<string, string | undefined>): string | undefined {
  const file = env[DRIVE_DEADLINE_FILE_ENV]
  if (file === undefined) return undefined
  const name = basename(file)
  if (!name.endsWith('.json')) return undefined
  const token = name.slice(0, -'.json'.length)
  return TOKEN.test(token) ? token : undefined
}
