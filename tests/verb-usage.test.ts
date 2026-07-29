import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { seededRepo } from './helpers.js'

const VERBS_DIR = join(__dirname, '..', 'src', 'verbs')

// The usage line a verb prints when its own arguments are missing. Verbs that never
// print one (no required positional) are absent from the map and are not compared.
function ownUsage(): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of readdirSync(VERBS_DIR).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(VERBS_DIR, f), 'utf8')
    const m = /'usage: (specflow [^']+)'/.exec(src)
    if (m) out.set(m[1]!.split(' ')[1]!, m[1]!)
  }
  return out
}

// `specflow <verb> --help` answers from cli.ts's VERB_USAGE map, while a verb missing
// its required argument answers from its own hand-written string. Nothing kept the two
// in sync, which is how `decide` came to advertise every flag except `--pin` after that
// flag shipped: the map is edited in a different file from the verb that grew the flag.
describe('verb usage strings', () => {
  it('--help agrees with the usage each verb prints for itself', async () => {
    const repo = await seededRepo({ noRecap: true })
    const drift: string[] = []
    for (const [verb, own] of ownUsage()) {
      const r = await repo.cli([verb, '--help'])
      expect(r.code).toBe(0)
      const help = r.stdout.replace(/^usage: /, '')
      if (help !== own) drift.push(`${verb}\n  --help: ${help}\n  verb:   ${own}`)
    }
    expect(drift.join('\n')).toBe('')
  })
})
