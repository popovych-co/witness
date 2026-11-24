import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withScratch } from '../src/scratch.js'

it('withScratch hands use a directory, returns its value and removes the directory', () => {
  let seen = ''
  const v = withScratch('witness-t-', (d) => { seen = d; writeFileSync(join(d, 'f'), 'x'); return 7 })
  expect(v).toBe(7)
  expect(seen).not.toBe('')
  expect(existsSync(seen)).toBe(false)
})

it('withScratch removes its directory when use throws, and the error reaches the caller', () => {
  let seen = ''
  expect(() => withScratch('witness-t-', (d) => { seen = d; throw new Error('boom') })).toThrow('boom')
  expect(seen).not.toBe('')
  expect(existsSync(seen)).toBe(false)
})
