import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './cli.js'
import { EXIT } from './cli.js'
import { git, stateCommit, tryGit } from './gitio.js'
import { type Result } from './refusal.js'

export interface TxnMarker {
  op: string
  files: string[]
  journal?: { stream: string; line: string }
}

const markerPath = (root: string) => join(root, '.specflow', 'txn.json')

export function pendingTxn(root: string): TxnMarker | undefined {
  if (!existsSync(markerPath(root))) return undefined
  return JSON.parse(readFileSync(markerPath(root), 'utf8')) as TxnMarker
}

export function crashPoint(env: Record<string, string | undefined>, name: string): void {
  if (env.SPECFLOW_CRASH_AFTER === name) process.exit(9)
}

export function withTxn<T>(root: string, marker: TxnMarker, fn: () => Result<T>): Result<T> {
  mkdirSync(join(root, '.specflow'), { recursive: true })
  writeFileSync(markerPath(root), JSON.stringify(marker))
  let res: Result<T>
  try {
    res = fn()
  } catch (e) {
    rollbackTxn(root, marker)
    throw e
  }
  if (res.ok) rmSync(markerPath(root), { force: true })
  else rollbackTxn(root, marker)
  return res
}

export function rollbackTxn(root: string, marker: TxnMarker): void {
  for (const f of marker.files) {
    const tracked = tryGit(root, 'ls-files', '--error-unmatch', '--', f).ok
    if (tracked) git(root, 'checkout', '--', f)
    else rmSync(join(root, f), { force: true })
  }
  rmSync(markerPath(root), { force: true })
}

export function completeTxn(root: string, marker: TxnMarker): Result<{ sha: string }> {
  if (marker.journal) {
    const p = join(root, marker.journal.stream)
    const current = existsSync(p) ? readFileSync(p, 'utf8') : ''
    const lastLine = current.split('\n').filter(Boolean).at(-1)
    if (lastLine !== marker.journal.line) appendFileSync(p, marker.journal.line + '\n')
  }
  const res = stateCommit(root, marker.files, `${marker.op} (recovered)`)
  if (res.ok) rmSync(markerPath(root), { force: true })
  return res
}

export function guardTxn(ctx: Ctx, root: string): number | undefined {
  const m = pendingTxn(root)
  if (!m) return undefined
  ctx.err(`pending transaction from a crashed invocation: ${m.op}`)
  ctx.err('help: specflow recover --complete | --rollback')
  return EXIT.BLOCKED
}
