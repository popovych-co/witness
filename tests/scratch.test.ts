import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { fixtureEnv, spawnAsync, vitestBin } from './helpers.js'
import { scratchDir } from './scratch.js'

const ROOT = resolve(import.meta.dirname, '..')

// Runs fixtures/scratch-life passing or failing with its temp root pointed at an empty probe, so
// what the probe holds afterwards is exactly what scratchDir left behind: the homes, one per
// directory kept.
async function lifeRun(mode: 'pass' | 'fail'): Promise<{ code: number; out: string; probe: string; left: string[] }> {
  const probe = scratchDir('witness-life-probe-')
  const cache = scratchDir('witness-life-cache-')
  const res = await spawnAsync(process.execPath, [vitestBin(), 'run', '--config', join(ROOT, 'fixtures', 'scratch-life', 'vitest.config.ts')], {
    cwd: ROOT,
    env: fixtureEnv({ TMPDIR: probe, TMP: probe, TEMP: probe, SCRATCH_LIFE: mode, SCRATCH_LIFE_CACHE: cache }),
  })
  return { code: res.code, out: res.stdout + res.stderr, probe, left: readdirSync(probe).sort() }
}

// A home's name is its prefix plus six random characters; the directory the nested test was
// handed is the prefix, trailing dashes dropped, inside it.
const stem = (n: string) => n.replace(/[A-Za-z0-9]{6}$/, '')
const handed = (r: { probe: string }, home: string) => join(r.probe, home, stem(home).replace(/-+$/, ''))

it('a passing run leaves nothing behind, whatever scope made it (issue #99)', async () => {
  const r = await lifeRun('pass')
  expect(r.code, r.out).toBe(0)
  expect(r.left).toEqual([])
}, 60_000)

it('a failing run keeps exactly its failed owners\' directories and names each (issue #99)', async () => {
  const r = await lifeRun('fail')
  expect(r.code, r.out).toBe(1)
  expect(r.left.map(stem).sort()).toEqual([
    'life-cache-', 'life-collect-', 'life-each-', 'life-own-', 'life-setup-', 'life-shared-', 'life-slow-',
    'witness-', 'witness-fake-',
  ])
  for (const home of r.left) expect(r.out).toContain(`scratch kept: ${handed(r, home)}`)
  expect(r.out).toContain(`report for ${handed(r, r.left.find((n) => n.startsWith('life-own-'))!)}`)
  // A fixture repo's siblings live in its home, and a fake scenario's report is its fake trails.
  const home = r.left.find((n) => stem(n) === 'witness-')!
  expect(readdirSync(join(r.probe, home)).sort()).toEqual(['witness', 'witness-origin.git'])
  const fake = handed(r, r.left.find((n) => stem(n) === 'witness-fake-')!)
  expect(r.out).toContain(`fake claude trail · ${join(fake, 'claude-trace')}\nstart 1\nclaim 1 1`)
}, 60_000)
