import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ok, refuse, v, type Result } from './refusal.js'

const lockPath = (root: string) => join(root, '.witness', 'lock')

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function acquireLock(root: string, pid = process.pid): Result<() => void> {
  mkdirSync(join(root, '.witness'), { recursive: true })
  const p = lockPath(root)
  const release = () => rmSync(p, { force: true })
  try {
    writeFileSync(p, JSON.stringify({ pid }), { flag: 'wx' })
    return ok(release)
  } catch {
    let holder: number | undefined
    try {
      holder = (JSON.parse(readFileSync(p, 'utf8')) as { pid: number }).pid
    } catch {
      holder = undefined
    }
    if (holder !== undefined && holder !== pid && isAlive(holder)) {
      return refuse([v('.witness/lock', 'locked', `held by pid ${holder}`, 'one clone, one writer — wait for the other witness invocation')])
    }
    rmSync(p, { force: true })
    writeFileSync(p, JSON.stringify({ pid }), { flag: 'wx' })
    return ok(release)
  }
}
