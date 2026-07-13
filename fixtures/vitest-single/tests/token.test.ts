import { expect, it } from 'vitest'
import { nextToken, rotateDue } from '../src/token'

it('rotates token before expiry @spec:auth-refresh', () => {
  expect(rotateDue(90, 100)).toBe(true)
})

it('issues a fresh token on rotation @spec:auth-refresh', () => {
  expect(nextToken('a1')).not.toBe('a1')
})

it('plain untagged unit test', () => {
  expect(1 + 1).toBe(2)
})
