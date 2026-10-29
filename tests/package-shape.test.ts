import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { expect, it } from 'vitest'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  bin: Record<string, string>; files: string[]
}

// npm publish normalizes package.json before packing, and said so on 0.25.0 and 0.26.0:
// `"bin[witness]" script name dist/bin.js was invalid and removed`. The bin survived because the
// rewrite was only './dist/bin.js' → 'dist/bin.js', but a release log that says the CLI's entry
// was removed is a warning nobody can tell from a real one. Ship the form npm would write.
it('every bin target is already in the form npm publishes, inside a shipped path', () => {
  for (const [name, target] of Object.entries(pkg.bin)) {
    expect(target, name).toBe(posix.normalize(target).replace(/^\.\//, ''))
    expect(pkg.files.some((f) => target === f || target.startsWith(`${f}/`)), name).toBe(true)
  }
})
