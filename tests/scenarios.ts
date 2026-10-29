import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Every fake scenario this worker made, in order, and the fake calls' trails of the ones made
// from an index on. Its own module, importing nothing of src: tests/fake-trails.ts is a setup file,
// and a setup file that loaded src (through helpers.ts) would bind node:child_process before a
// test file's vi.mock of it could (tests/console.test.ts).
export const scenariosMade: string[] = []

export function trailsSince(from: number): string {
  return scenariosMade.slice(from).flatMap((dir) => (['claude', 'pi'] as const).flatMap((bin) => {
    const trace = join(dir, `${bin}-trace`)
    return existsSync(trace) ? [`fake ${bin} trail · ${trace}\n${readFileSync(trace, 'utf8').trimEnd()}`] : []
  })).join('\n')
}
