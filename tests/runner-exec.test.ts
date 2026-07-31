import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runFiltered } from '../src/runner.js'
import { breakSingleFixture, copyFixture, fakeCtx, fixtureEnv, tmpRepo, vitestBin } from './helpers.js'

const TEMPLATE = `node "${vitestBin()}" run -t "@spec:{id}" --passWithNoTests`

describe('runFiltered', () => {
  it('exits zero for a passing tagged spec and nonzero after the break', async () => {
    const repo = tmpRepo()
    copyFixture(repo, 'vitest-single')
    const ctx = fakeCtx(repo.root, { env: fixtureEnv() })
    const green = await runFiltered(repo.root, ctx, TEMPLATE, 'auth-refresh')
    expect(green.ok && green.value.exitZero).toBe(true)
    breakSingleFixture(repo)
    const red = await runFiltered(repo.root, ctx, TEMPLATE, 'auth-refresh')
    expect(red.ok && red.value.exitZero).toBe(false)
    expect(red.ok && red.value.output.length > 0).toBe(true)
  })

  it('passes with zero matching tests — the root-runnable contract', async () => {
    const repo = tmpRepo()
    copyFixture(repo, 'vitest-single')
    const res = await runFiltered(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), TEMPLATE, 'no-such-spec')
    expect(res.ok && res.value.exitZero).toBe(true)
  })

  it('blocks untrusted templates in non-TTY and never executes them', async () => {
    const repo = tmpRepo()
    const marker = join(repo.root, 'ran-auth-refresh.txt')
    const res = await runFiltered(repo.root, fakeCtx(repo.root, { tty: false }), 'touch ran-{id}.txt', 'auth-refresh')
    expect(!res.ok && res.violations[0]?.rule).toBe('untrusted-blocked')
    expect(existsSync(marker)).toBe(false)
  })

  it('prompts once for the raw template — one consent covers every spec id', async () => {
    const repo = tmpRepo()
    const yes = await runFiltered(repo.root, fakeCtx(repo.root, { answers: ['y'] }), 'touch ran-{id}.txt', 'spec-a')
    expect(yes.ok).toBe(true)
    expect(repo.read('.witness/allow.json')).toContain('touch ran-{id}.txt')
    const again = await runFiltered(repo.root, fakeCtx(repo.root, { tty: false }), 'touch ran-{id}.txt', 'spec-b')
    expect(again.ok && existsSync(join(repo.root, 'ran-spec-b.txt'))).toBe(true)
  })

  it('refuses declined templates', async () => {
    const repo = tmpRepo()
    const res = await runFiltered(repo.root, fakeCtx(repo.root, { answers: ['n'] }), 'touch ran-{id}.txt', 'spec-a')
    expect(!res.ok && res.violations[0]?.rule).toBe('untrusted-declined')
  })
})
