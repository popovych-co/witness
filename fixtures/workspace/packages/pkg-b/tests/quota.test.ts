import { expect, it } from 'vitest'
import { remaining } from '../src/quota'

it('reports remaining quota @spec:quota', () => {
  expect(remaining(2, 10)).toBe(8)
})
