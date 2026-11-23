import { describe, expect, it } from 'vitest'
import { detectPrepare } from '../src/prepare.js'
import { tmpRepo } from './helpers.js'

describe('the setup command a repo declares (row 259)', () => {
  it.each([
    [['pnpm-lock.yaml'], 'pnpm install --frozen-lockfile'],
    [['package-lock.json'], 'npm ci'],
    [['npm-shrinkwrap.json'], 'npm ci'],
    [['yarn.lock'], 'yarn install --frozen-lockfile'],
    [['yarn.lock', '.yarnrc.yml'], 'yarn install --immutable'],
    [['bun.lock'], 'bun install --frozen-lockfile'],
    [['bun.lockb'], 'bun install --frozen-lockfile'],
    [['Cargo.lock'], 'none'],
    [[], 'none'],
  ])('detectPrepare with %j at the root is %s', (files, want) => {
    const repo = tmpRepo()
    for (const f of files) repo.write(f, '')
    expect(detectPrepare(repo.root)).toBe(want)
  })
})
