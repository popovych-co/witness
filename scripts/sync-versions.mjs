#!/usr/bin/env node
// Stamp package.json's version across every plugin surface: each plugin.json's
// `version` field and every `@popovych.co/witness@<semver>` pin in plugin text files,
// then refresh the witness-context plugin's copy of the context core.
// Idempotent; run before tagging a release (release.yml verifies via the test).
import { copyFileSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const PIN = /@popovych\.co\/witness@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

let stamped = 0;
for (const plugin of ['plugin', 'plugin-context']) {
  const manifestPath = join(root, plugin, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== version) {
    manifest.version = version;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    stamped += 1;
  }
}
for (const f of walk(join(root, 'plugin')).filter((p) => /\.(md|sh|mjs|json|ts)$/.test(p))) {
  const before = readFileSync(f, 'utf8');
  const after = before.replace(PIN, `@popovych.co/witness@${version}`);
  if (after !== before) {
    writeFileSync(f, after);
    stamped += 1;
  }
}
// Row 191 §4.11. Claude Code copies a marketplace plugin whole into its cache, so the
// witness-context module can import the core only from its own folder, while the Pi payload
// copies the original from plugin/hooks/. The copy is made here, after the pins, so it is
// the stamped original; a release whose copy is stale fails release.yml's diff check.
const core = join(root, 'plugin', 'hooks', 'context-core.mjs');
const copy = join(root, 'plugin-context', 'hooks', 'context-core.mjs');
if (!existsSync(copy) || !readFileSync(copy).equals(readFileSync(core))) {
  copyFileSync(core, copy);
  stamped += 1;
}
console.log(`@popovych.co/witness@${version}: ${stamped} file(s) restamped`);
