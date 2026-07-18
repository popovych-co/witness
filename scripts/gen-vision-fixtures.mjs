// scripts/gen-vision-fixtures.mjs — regenerate the design-reviewer vision fixtures.
// Run once when the HTML sources change: `node scripts/gen-vision-fixtures.mjs`.
// Renders each *.html under calibration/reviewers/design-reviewer/_src to a sibling
// *.png in the matching base/seed/inject overlay dir. Requires a headless Chrome on
// PATH (chrome-headless-shell or google-chrome); prints the exact command it runs.
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'calibration', 'reviewers', 'design-reviewer')
const chrome = process.env.CHROME_BIN ?? 'chrome-headless-shell'
function render(html, png) {
  // 650px tall: tall enough that s3-field-wall's flat 13-field list and s2-buried-action's
  // savebar (pushed off-screen by its own 1600px spacer) still render meaningfully, short
  // enough that base/s1/s4's short-content forms don't leave a fixed savebar stranded
  // ~1150px below the fold — a rendering artifact a real page at a sane viewport wouldn't
  // have, which calibration against claude-sonnet-5 showed reads as a false buried-action.
  execFileSync(chrome, ['--headless', '--disable-gpu', '--window-size=1200,650',
    `--screenshot=${png}`, `file://${html}`], { stdio: 'inherit' })
}
// walk _src/**/*.html → PNG at the path encoded in the filename (dir__name.png)
for (const f of readdirSync(join(root, '_src'))) {
  if (!f.endsWith('.html')) continue
  const [group, ...rest] = f.replace(/\.html$/, '').split('__')
  const name = rest.join('__')
  const outDir = group === 'base' ? join(root, 'base')
    : join(root, group.startsWith('inject-') ? 'inject' : 'seeds', group.replace(/^inject-/, ''), 'overlay')
  render(join(root, '_src', f), join(outDir, `${name}.png`))
  console.log(`rendered ${f} → ${outDir}/${name}.png`)
}
