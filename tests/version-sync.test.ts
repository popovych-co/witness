import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;
const PIN = /@whatmatters\/specflow@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('plugin version pin', () => {
  it('plugin.json exists and its version matches package.json', () => {
    const p = join(root, 'plugin', '.claude-plugin', 'plugin.json');
    expect(existsSync(p)).toBe(true);
    const manifest = JSON.parse(readFileSync(p, 'utf8'));
    expect(manifest.name).toBe('specflow');
    expect(manifest.version).toBe(pkgVersion);
  });

  it('marketplace.json lists the plugin at ./plugin', () => {
    const m = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
    expect(m.name).toBe('specflow');
    expect(m.plugins).toEqual([expect.objectContaining({ name: 'specflow', source: './plugin' })]);
  });

  it('every @whatmatters/specflow@ pin under plugin/ equals the package version', () => {
    const files = walk(join(root, 'plugin')).filter((f) => /\.(md|sh|mjs|json)$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(PIN)) {
        expect(`${f}: ${m[0]}`).toBe(`${f}: @whatmatters/specflow@${pkgVersion}`);
      }
    }
  });
});
