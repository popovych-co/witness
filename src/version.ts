import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The one home for "which version of witness is which". install.ts parsed the pin to
// decide whether a payload was only a pin apart (row 102 killed that rule) and check.ts
// re-declared the same regex inline — one question answered in two places, which is the
// shape rows 93, 95, 96 and 104 all name. scripts/sync-versions.mjs keeps a third copy
// on purpose: it is dependency-free by contract and cannot import TypeScript.

// Both payload files and every SKILL.md embed the pin as
// `${WITNESS_BIN:-npx -y @popovych.co/witness@<v>}`, so the capture MUST end at the
// semver and never swallow the closing brace.
const PIN = /@popovych\.co\/witness@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/

export function pinIn(text: string): string | undefined {
  return PIN.exec(text)?.[1]
}

// Numeric triple only. Prerelease ordering is deliberately out of scope (row 102):
// witness has never published one, and equal triples compare equal — which is also the
// witness-developer case, where the running CLI and the installed payload are the same
// version and the write must still happen.
function triple(raw: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim())
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])]
}

// `undefined` means CANNOT COMPARE, never "equal". Every consumer is a guard or a
// warning, and a guard that fired on an unparseable version would refuse a legal
// upgrade over a typo — the doctrine currentSha's undefined already carries (row 94).
export function compareTriple(a: string, b: string): number | undefined {
  const [x, y] = [triple(a), triple(b)]
  if (x === undefined || y === undefined) return undefined
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return (x[i] as number) < (y[i] as number) ? -1 : 1
  }
  return 0
}

// Row 103. Every remedy that names a witness command is executed BY the CLI that
// printed it, and on a frozen repo that CLI is the frozen one: `witness init --agent pi`
// through a frozen /witness is `npx …@0.5.1 init`, which restamps 0.5.1 onto 0.5.1 — a
// no-op that reads as compliance. Remedies name the version.
export const NPX_LATEST = 'npx -y @popovych.co/witness@latest'

// Row 116. Moved here from cli.ts. `journal.ts` stamps every entry with it and cannot
// import the CLI shell without closing a cycle (cli → verbs/* → journal). This module
// already claimed to be the one home for "which version of witness is which" while the
// reader itself lived in the shell — the same split rows 93, 95 and 96 keep naming. The
// single readFileSync is the exception to this file's no-I/O rule and the only one it
// may ever have.
export function version(): string {
  const pkg = JSON.parse(
    readFileSync(join(new URL('.', import.meta.url).pathname, '..', 'package.json'), 'utf8'),
  ) as { version: string }
  return pkg.version
}
