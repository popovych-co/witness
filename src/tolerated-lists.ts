// Rows 283 and 285 (corrections C47–C49). The two files witness writes into a consumer's tree so a
// tool stays green on spots a tolerated set holds, and reads back so its reader sees them:
// ESLint's own bulk-suppressions file at the root (ESLint reads it by default; probe §1) and a
// witness-owned Biome config the repo's `biome.json` extends, one override per file setting each
// tolerated rule to `info` — the tool stays green and its SARIF reports each spot as a `note`
// (probe §3). Writers are witness code: no setting, no command.

export const ESLINT_LIST = 'eslint-suppressions.json'
export const BIOME_LIST = 'biome.witness.json'
export const BIOME_LEVEL = 'info'

// One (file, rule) pair, a key no path or rule id can collide in.
export const pairKey = (file: string, rule: string): string => `${file}\0${rule}`

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const GLOB = /[*?[\]{}!]/

// The (file, rule) pairs the witness file sets to `info`: an override of exactly
// `{ includes: [<one path, no glob>], linter: { rules: { <group>: { <name>: 'info' } } } }`. Any other
// shape is none of witness's writing and contributes nothing; text that does not parse reads empty.
export function biomePairs(text: string): Set<string> {
  const out = new Set<string>()
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return out
  }
  if (!isObj(doc) || !Array.isArray(doc.overrides)) return out
  for (const o of doc.overrides) {
    if (!isObj(o) || Object.keys(o).some((k) => k !== 'includes' && k !== 'linter')) continue
    const inc = o.includes
    if (!Array.isArray(inc) || inc.length !== 1 || typeof inc[0] !== 'string' || inc[0] === '' || GLOB.test(inc[0])) continue
    if (!isObj(o.linter) || Object.keys(o.linter).some((k) => k !== 'rules') || !isObj(o.linter.rules)) continue
    const pairs: string[] = []
    let shaped = true
    for (const [group, names] of Object.entries(o.linter.rules)) {
      if (!isObj(names)) { shaped = false; break }
      for (const [name, level] of Object.entries(names)) {
        if (level !== BIOME_LEVEL) { shaped = false; break }
        pairs.push(pairKey(inc[0], `lint/${group}/${name}`))
      }
      if (!shaped) break
    }
    if (shaped) for (const p of pairs) out.add(p)
  }
  return out
}
