import { expect, it } from 'vitest'
import { allow } from '../src/rate'

it('allows under the limit @spec:rate-limit', () => {
  expect(allow(3, 5)).toBe(true)
})

it('blocks at the limit @spec:rate-limit', () => {
  expect(allow(5, 5)).toBe(false)
})
