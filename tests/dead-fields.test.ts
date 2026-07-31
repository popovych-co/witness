import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', 'src')
const DECLARING = ['rounds.ts', 'journal.ts']   // where entry shapes are declared

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })

// Fields the CLI writes on purpose and nothing reads. Every entry needs a reason.
const WRITE_ONLY = new Set<string>([
  'v',   // schema version — read by future migrations only; D26 requires it on every entry
  't',   // discriminant — matched as a string literal everywhere, never as `.t` on a typed field
  // The revision of the DOC behind a run (plan/spec/html), where `reviewed_sha` is what
  // the reviewer judged — at the code gates a worktree tree-sha, which moves separately.
  // Journaled for post-hoc forensics and deliberately unread: doc staleness is already
  // covered upstream of settledness. `witness write` on an in-progress plan re-drafts
  // it, so plans-first routing re-gates before the flow can advance; a re-authored spec
  // re-arms designPending via the design stamp. A reader here would duplicate both.
  'artifact_sha',
])

function declaredFields(): Map<string, string> {
  const out = new Map<string, string>()
  for (const file of DECLARING) {
    const text = readFileSync(join(SRC, file), 'utf8')
    for (const m of text.matchAll(/export interface (\w*Entry) \{([\s\S]*?)\n\}/g)) {
      for (const line of m[2]!.split('\n')) {
        const f = /^\s{2}(\w+)\??:/.exec(line)
        if (f) out.set(f[1]!, m[1]!)
      }
    }
  }
  return out
}

describe('journal fields have readers', () => {
  it('every field declared on a *Entry interface is read outside its declaring module', () => {
    const fields = declaredFields()
    expect(fields.size).toBeGreaterThan(15)   // guards the regex silently matching nothing
    const consumers = walk(SRC)
      .filter((p) => !DECLARING.some((d) => p.endsWith(join('src', d))))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n')
    const dead = [...fields.keys()]
      .filter((f) => !WRITE_ONLY.has(f))
      .filter((f) => !new RegExp(`[.\\['"\`]${f}\\b`).test(consumers))
      .map((f) => `${fields.get(f)}.${f}`)
    expect(dead, 'journaled fields with no production reader — wire one or justify it in WRITE_ONLY').toEqual([])
  })
})
