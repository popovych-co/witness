import { describe, expect, it } from 'vitest'
import { shippableRepo } from './helpers.js'

describe('dispatch-report — the slice boundary relay', () => {
  it('prints the relay command for the resolved harness', async () => {
    const { repo, planId } = await shippableRepo()
    const pi = await repo.cli(
      ['dispatch-report', planId, '--steps-assigned', '3', '--steps-completed', '3'],
      { env: { SPECFLOW_HARNESS: 'pi' } },
    )
    expect(pi.code).toBe(0)
    expect(pi.stdout).toContain(`dispatch: ${planId}`)
    expect(pi.stdout).toContain('relay: /new then /specflow')

    const cc = await repo.cli(
      ['dispatch-report', planId, '--steps-assigned', '3', '--steps-completed', '2'],
      { env: { SPECFLOW_HARNESS: 'claude-code' } },
    )
    expect(cc.code).toBe(0)
    expect(cc.stdout).toContain('relay: /clear then /specflow')
  })
})
