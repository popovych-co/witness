import { describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planChangeSet, witnessExcludes, witnessPaths } from '../src/change-set.js'
import { changedTestSpecs, diffTags } from '../src/evidence.js'
import { diffReviewedSha } from '../src/reviewed.js'
import { git, payloadPlan, TOKEN_TESTS_TAGGED } from './helpers.js'

describe('the plan change set (row 246, #93)', () => {
  it('names every harness payload target as witness-owned', () => {
    expect(witnessPaths()).toEqual([
      '.claude/commands/witness.md', '.claude/hooks/canon-guard.mjs', '.claude/hooks/guard-state.mjs',
      '.claude/hooks/session-dashboard.sh', '.pi/extensions/canon-guard.mjs', '.pi/extensions/context-core.mjs',
      '.pi/extensions/session-dashboard.sh', '.pi/extensions/witness.ts', '.pi/prompts/witness.md',
      '.witness/hooks/canon-guard.mjs', '.witness/hooks/guard-state.mjs', '.witness/hooks/session-dashboard.sh',
    ])
    expect(witnessExcludes()).toContain(':(top,literal,exclude).witness/hooks/guard-state.mjs')
    // row 250: the retired home stays witness-owned while plan branches still carry it
    expect(witnessExcludes()).toContain(':(top,literal,exclude).claude/hooks/guard-state.mjs')
  })

  it('drops payload paths however they changed and keeps every other path, settings.json included', async () => {
    const { wt, base } = await payloadPlan()
    const fixture = planChangeSet(wt, base)                                       // the copied fixture, untracked
    writeFileSync(join(wt, '.witness/hooks/guard-state.mjs'), '// edited\n')      // tracked, edited
    rmSync(join(wt, '.pi/prompts/witness.md'))                                    // tracked, deleted
    git(wt, 'add', '.witness/hooks/guard-state.mjs')                              // staged
    mkdirSync(join(wt, '.claude/hooks'), { recursive: true })                    // row 250: witness writes none there now
    writeFileSync(join(wt, '.claude/hooks/new-hook.sh'), 'echo\n')                // untracked, not a payload path
    writeFileSync(join(wt, '.claude/settings.json'), '{}\n')                      // shared, not owned
    writeFileSync(join(wt, 'a b [x].md'), 'odd name\n')
    expect(planChangeSet(wt, base)).toEqual([...fixture, '.claude/hooks/new-hook.sh', '.claude/settings.json', 'a b [x].md'].sort())
  })

  it('a committed payload-only change moves neither the reviewed identity nor the tags evidence reads', async () => {
    const { wt, base } = await payloadPlan()
    writeFileSync(join(wt, 'tests/token.test.ts'), TOKEN_TESTS_TAGGED)
    const sha = diffReviewedSha(wt, base)
    const tags = diffTags(wt, base)
    writeFileSync(join(wt, '.witness/hooks/guard-state.mjs'), '// a newer payload\n')
    git(wt, 'add', '.witness/hooks/guard-state.mjs')
    git(wt, 'commit', '-m', 'init(claude-code): agent payloads')
    expect(diffReviewedSha(wt, base)).toBe(sha)
    expect(diffTags(wt, base)).toEqual(tags)
    expect(changedTestSpecs(wt, base, 'auth-refresh')).toEqual([])
  })
})
