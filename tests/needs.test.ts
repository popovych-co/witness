import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateNeeds } from '../src/needs.js'
import { tmpRepo } from './helpers.js'
import type { Ctx } from '../src/cli.js'

function ctxFor(root: string, opts: { tty?: boolean; answers?: string[]; env?: Record<string, string> } = {}): Ctx {
  const answers = [...(opts.answers ?? [])]
  return {
    cwd: root,
    env: { ...opts.env },
    isTTY: opts.tty ?? answers.length > 0,
    out: () => {},
    err: () => {},
    ask: async () => answers.shift() ?? '',
  }
}

describe('evaluateNeeds', () => {
  it('checks env and manual needs without touching the shell', async () => {
    const repo = tmpRepo()
    const results = await evaluateNeeds(repo.root, ctxFor(repo.root, { env: { STRIPE_API_KEY: 'sk' } }), [
      { env: 'STRIPE_API_KEY' },
      { env: 'MISSING_VAR' },
      { manual: 'sandbox created', satisfied: true },
      { manual: 'dns cut over', satisfied: false },
    ])
    expect(results.map((r) => r.status)).toEqual(['ok', 'unmet', 'ok', 'unmet'])
  })

  it('prompts once for a cmd, persists consent, and runs it', async () => {
    const repo = tmpRepo()
    const first = await evaluateNeeds(repo.root, ctxFor(repo.root, { answers: ['y'] }), [{ cmd: 'true' }])
    expect(first[0]?.status).toBe('ok')
    expect(readFileSync(join(repo.root, '.specflow/allow.json'), 'utf8')).toContain('"true"')
    const second = await evaluateNeeds(repo.root, ctxFor(repo.root, { tty: false, env: {} }), [{ cmd: 'true' }])
    expect(second[0]?.status).toBe('ok')
  })

  it('reports unmet for a failing trusted command', async () => {
    const repo = tmpRepo()
    const res = await evaluateNeeds(repo.root, ctxFor(repo.root, { answers: ['y'] }), [{ cmd: 'false' }])
    expect(res[0]?.status).toBe('unmet')
  })

  it('blocks untrusted commands without a TTY and never executes them', async () => {
    const repo = tmpRepo()
    const marker = join(repo.root, 'executed.marker')
    const res = await evaluateNeeds(repo.root, ctxFor(repo.root, { tty: false }), [{ cmd: `touch ${marker}` }])
    expect(res[0]?.status).toBe('blocked')
    expect(existsSync(marker)).toBe(false)
  })

  it('declines when the user says no, and trusts everything under SPECFLOW_TRUST_CMDS=1', async () => {
    const repo = tmpRepo()
    const declined = await evaluateNeeds(repo.root, ctxFor(repo.root, { answers: ['n'] }), [{ cmd: 'true' }])
    expect(declined[0]?.status).toBe('declined')
    const ci = await evaluateNeeds(repo.root, ctxFor(repo.root, { tty: false, env: { SPECFLOW_TRUST_CMDS: '1' } }), [{ cmd: 'true' }])
    expect(ci[0]?.status).toBe('ok')
  })
})
