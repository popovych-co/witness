import { describe, expect, it } from 'vitest'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { changedFiles, diffBase } from '../src/evidence.js'
import { loadConfig } from '../src/config.js'
import { fakeCtx, fakeScenario, gateEnv, nextLine, putVerdict, shippableRepo } from './helpers.js'
import { worktreePath } from '../src/worktree.js'

// The same battery fake flows.test.ts and implement-identity.test.ts drive the gate with.
async function settleImplementGate(repo: { root: string }, wt: string, planId: string): Promise<void> {
  const cfg = loadConfig(repo.root)
  const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
  const files = changedFiles(wt, base.ok ? base.value : '')
  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })), findings: [] })
  const code = await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'implement', planId,
    { fresh: false, manual: false })
  if (code !== 0) throw new Error(`implement gate did not settle: exit ${code}`)
}

// Line-prefixed, never `toContain`: `run:` and `home:` both occur inside note prose, and a
// substring assertion would pass on the wrong line in exactly the case worth catching.
const row = (out: string, prefix: string): string | undefined =>
  out.split('\n').find((l) => l.startsWith(prefix))

describe('next answers whether this session is already home', () => {
  it('omits run: and relay: when home: is the cwd', async () => {
    const { repo, wt } = await shippableRepo()

    const res = await repo.cli(['next'], { cwd: wt })

    expect(res.code).toBe(0)
    expect(row(res.stdout, `home: ${wt}`)).toBeDefined()
    expect(row(res.stdout, 'run: ')).toBeUndefined()
    expect(row(res.stdout, 'relay: ')).toBeUndefined()

    await repo.cli(['clean'])
  })

  it('still prints run: and relay: when home: is another checkout', async () => {
    const { repo, planId } = await shippableRepo()
    const wt = worktreePath(repo.root, planId)

    const out = await nextLine(repo)   // asked from the primary root

    expect(row(out, `home: ${wt}`)).toBeDefined()
    expect(row(out, `run: cd '${wt}'`)).toBeDefined()
    expect(row(out, 'relay: ')).toBeDefined()

    await repo.cli(['clean'])
  })

  it('omits the handoff for a ship row asked from the primary root', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)

    const out = await nextLine(repo)

    expect(out).toContain(`witness ship ${planId}`)
    expect(row(out, `home: ${repo.root}`)).toBeDefined()
    expect(row(out, 'run: ')).toBeUndefined()

    await repo.cli(['clean'])
  })

  // The comparison is between PATHS, not between strings. `primaryRoot` answers with git's
  // physical path while `ctx.cwd` is whatever the human typed — and on macOS every `/tmp`
  // and `/var` path is a symlink, so a raw `===` reports a session sitting in its own home
  // as one that must be relocated. That is the field failure, not a hypothetical.
  it('resolves symlinks before deciding — a symlinked cwd is still home', async () => {
    const { repo, wt } = await shippableRepo()
    const link = join(mkdtempSync(join(tmpdir(), 'witness-link-')), 'wt')
    symlinkSync(wt, link)

    const res = await repo.cli(['next'], { cwd: link })

    expect(res.code).toBe(0)
    expect(row(res.stdout, `home: ${wt}`)).toBeDefined()
    expect(row(res.stdout, 'run: ')).toBeUndefined()

    await repo.cli(['clean'])
  })
})
