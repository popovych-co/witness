import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeSettings, namesRetired } from '../src/install.js'
import { formatJson } from '../src/json-format.js'
import { jsonStyle } from '../src/lint-config.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = (f: string) => readFileSync(join(REPO, 'fixtures/settings', f), 'utf8')

describe('mergeSettings rewires witness hooks in place and writes the formatter style (row 250, #95)', () => {
  it("turns fewhats' settings into exactly what fewhats' Biome prints", () => {
    const merged = mergeSettings(fixture('fewhats-before.json'))
    expect(merged.changed).toBe(true)
    expect(merged.text).toBe(fixture('fewhats-after.json'))
    expect(namesRetired(merged.text)).toBe(false)
    expect(mergeSettings(merged.text)).toEqual({ text: merged.text, changed: false })
  })
  it('leaves one set of witness entries when both homes were wired', () => {
    const doubled = JSON.parse(fixture('fewhats-before.json'))
    doubled.hooks.PreToolUse.push(
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.witness/hooks/guard-state.mjs"' }] })
    const merged = JSON.parse(mergeSettings(JSON.stringify(doubled)).text)
    const guards = merged.hooks.PreToolUse.filter((e: { hooks: Array<{ command: string }> }) =>
      e.hooks.length === 1 && e.hooks[0]!.command.includes('guard-state.mjs'))
    expect(guards.map((e: { matcher: string }) => e.matcher)).toEqual(['Edit|Write|MultiEdit', 'Bash'])
  })
  it("never touches a human's command that merely names the old path", () => {
    const own = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-state.mjs" --verbose'
    const doc = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: own }] }] } }
    expect(mergeSettings(JSON.stringify(doc)).text).toContain(JSON.stringify(own))
  })
  it('keeps a tab-indented file in tabs', () => {
    const tabbed = formatJson(JSON.parse(fixture('fewhats-before.json')), { indent: '\t', lineWidth: 80, tabWidth: 2 })
    const merged = mergeSettings(tabbed, jsonStyle(mkdtempSync(join(tmpdir(), 'witness-style-')), tabbed))
    expect(merged.text.split('\n')[1]).toBe('\t"hooks": {')
  })
})
