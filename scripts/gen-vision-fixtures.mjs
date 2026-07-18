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
  execFileSync(chrome, ['--headless', '--disable-gpu', '--window-size=1200,1600',
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
