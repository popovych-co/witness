import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CONTEXT_PLUGIN } from '../src/install.js';

const root = join(__dirname, '..');
const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;
const json = (...rel: string[]) => JSON.parse(readFileSync(join(root, ...rel), 'utf8'));
const PIN = /@popovych\.co\/witness@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g;

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
    expect(manifest.name).toBe('witness');
    expect(manifest.version).toBe(pkgVersion);
  });

  it('marketplace.json lists the plugin at ./plugin and the context plugin at ./plugin-context', () => {
    const m = json('.claude-plugin', 'marketplace.json');
    expect(m.name).toBe('witness');
    expect(m.plugins).toEqual([
      expect.objectContaining({ name: 'witness', source: './plugin' }),
      expect.objectContaining({ name: 'witness-context', source: './plugin-context' }),
    ]);
  });

  it('the context plugin.json exists and its version matches package.json', () => {
    const manifest = json('plugin-context', '.claude-plugin', 'plugin.json');
    expect(manifest.name).toBe('witness-context');
    expect(manifest.version).toBe(pkgVersion);
  });

  // Row 191 §4.11. init's settings declaration and the install line init and check print name
  // the plugin through CONTEXT_PLUGIN: renaming either manifest alone would leave them naming a
  // plugin no marketplace lists.
  it('CONTEXT_PLUGIN names the context plugin in this marketplace', () => {
    const plugin = json('plugin-context', '.claude-plugin', 'plugin.json').name;
    expect(CONTEXT_PLUGIN).toBe(`${plugin}@${json('.claude-plugin', 'marketplace.json').name}`);
  });

  it('every @popovych.co/witness@ pin under plugin/ equals the package version', () => {
    const files = walk(join(root, 'plugin')).filter((f) => /\.(md|sh|mjs|json|ts)$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(PIN)) {
        expect(`${f}: ${m[0]}`).toBe(`${f}: @popovych.co/witness@${pkgVersion}`);
      }
    }
  });
});
