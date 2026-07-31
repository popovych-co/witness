import { describe, expect, it } from 'vitest'
import type { TestRepo } from './helpers.js'
import {
  breakSingleFixture, copyFixture, fixSingleFixture, fixtureEnv, seededRepo, singleConfig, stampLive, writeSpec,
} from './helpers.js'

async function liveRepo(): Promise<TestRepo> {
  const repo = await seededRepo()
  copyFixture(repo, 'vitest-single')
  repo.write('witness.config.yaml', singleConfig('filtered'))
  await writeSpec(repo, 'auth-refresh')
  stampLive(repo, 'auth-refresh')
  return repo
}

describe('dashboard reconcile section', () => {
  it('shows unconfirmed after one red, drift after two, and routes next: at the sweep', async () => {
    const repo = await liveRepo()
    breakSingleFixture(repo)
    await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    const one = await repo.cli([], { env: fixtureEnv() })
    expect(one.stdout).toContain('unconfirmed')
    // computeNext's shared ladder (Task 17) has no reconcile-specific rung — it falls
    // through to the generic catch-all here, replacing the old dashboard-only ladder.
    expect(one.stdout).toContain('next: witness check')
    await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    const two = await repo.cli([], { env: fixtureEnv() })
    expect(two.stdout).toContain('reconcile[')
    expect(two.stdout).toContain('drift')
  })

  it('trends flapping from drift-check history', async () => {
    const repo = await liveRepo()
    for (const step of ['break', 'fix', 'break', 'fix'] as const) {
      if (step === 'break') breakSingleFixture(repo)
      else fixSingleFixture(repo)
      await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    }
    const res = await repo.cli([], { env: fixtureEnv() })
    expect(res.stdout).toContain('flapping')
  })

  it('surfaces an unreviewed amendment until a later entry supersedes it', async () => {
    const repo = await liveRepo()
    repo.write('specs/auth-refresh.md', repo.read('specs/auth-refresh.md').replace('Tokens leak.', 'Tokens leak badly.'))
    await repo.cli(['adopt', 'specs/auth-refresh.md'], { env: fixtureEnv() })
    const flagged = await repo.cli([], { env: fixtureEnv() })
    expect(flagged.stdout).toContain('unreviewed-amendment')
    await repo.cli(['check', '--drift'], { env: fixtureEnv() })
    const superseded = await repo.cli([], { env: fixtureEnv() })
    expect(superseded.stdout).not.toContain('unreviewed-amendment')
  })
})

describe('check orphan tags', () => {
  it('warns when a source tag names no spec', async () => {
    const repo = await liveRepo()
    repo.write('tests/stray.test.ts', 'it("edge @spec:deleted-spec", () => {})\n')
    const res = await repo.cli(['check'], { env: fixtureEnv() })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('orphan-tag')
  })
})
