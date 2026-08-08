import { describe, expect, it } from 'vitest'
import { NPX_LATEST, compareTriple, pinIn } from '../src/version.js'

describe('pinIn', () => {
  // Both payload files and every SKILL.md embed the pin inside a shell default:
  // `${WITNESS_BIN:-npx -y @popovych.co/witness@0.6.0}`. A capture class that ends at
  // whitespace swallows the closing brace and never equals a version — that exact bug
  // made payload-stale fire on every fresh install once already.
  it('stops at the semver inside a shell default expansion', () => {
    expect(pinIn('WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.6.0}"')).toBe('0.6.0')
  })

  it('reads a prerelease pin whole', () => {
    expect(pinIn('npx -y @popovych.co/witness@1.0.0-rc.1 check')).toBe('1.0.0-rc.1')
  })

  it('answers undefined for the three payload files that carry no pin', () => {
    expect(pinIn('export function canonGuard() {}\n')).toBeUndefined()
  })
})

describe('compareTriple', () => {
  it('orders by numeric field, not lexically', () => {
    expect(compareTriple('0.9.0', '0.10.0')).toBe(-1)
    expect(compareTriple('0.10.0', '0.9.0')).toBe(1)
    expect(compareTriple('1.0.0', '0.99.99')).toBe(1)
  })

  it('treats equal triples as equal — the witness-developer case, where the write still happens', () => {
    expect(compareTriple('0.7.0', '0.7.0')).toBe(0)
  })

  // Prerelease ordering is out of scope by decision (row 102): witness has never
  // published one, and a guard that guessed at it would refuse a legal upgrade.
  it('ignores the prerelease suffix rather than guessing at its order', () => {
    expect(compareTriple('1.0.0-rc.1', '1.0.0')).toBe(0)
  })

  // undefined means "cannot compare", never "equal". Every consumer is a guard or a
  // warning, and a guard that fired on an unparseable version would refuse an upgrade
  // over a typo — the same doctrine currentSha's undefined carries (row 94).
  it('answers undefined when either side has no triple', () => {
    expect(compareTriple('latest', '0.7.0')).toBeUndefined()
    expect(compareTriple('0.7.0', '')).toBeUndefined()
  })
})

describe('NPX_LATEST', () => {
  // Row 103: a remedy naming a bare witness command is executed BY the frozen CLI that
  // printed it — `witness init --agent pi` through a frozen /witness is
  // `npx …@0.5.1 init`, which restamps 0.5.1 onto 0.5.1 and reads as compliance.
  it('names the version explicitly so the remedy escapes a frozen CLI', () => {
    expect(NPX_LATEST).toBe('npx -y @popovych.co/witness@latest')
  })
})
