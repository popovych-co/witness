import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS, settingsTable } from '../src/settings.js'

// Row 193 §4.10. The README's settings table is the list's, so it cannot drift from what the
// CLI reads again (it had left out eleven settings before row 193).
describe('the settings table (row 193 §4.10)', () => {
  it('README lists every setting, generated from the list', () => {
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8')
    const block = /<!-- settings:start -->\n([\s\S]*?)<!-- settings:end -->/.exec(readme)?.[1]
    expect(block, `README.md needs this between <!-- settings:start --> and <!-- settings:end -->:\n${settingsTable()}`)
      .toBe(settingsTable())
  })

  it('has one row per setting, each naming its default', () => {
    const rows = settingsTable().trimEnd().split('\n').slice(2)
    expect(rows).toHaveLength(SETTINGS.length)
    for (const [i, s] of SETTINGS.entries()) expect(rows[i]).toMatch(new RegExp(`^\\| \`${s.path.replaceAll('.', '\\.')}\` \\| .+ \\| \`.+\` \\|$`))
  })
})
