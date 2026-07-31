#!/usr/bin/env node
// Stamp package.json's version across every plugin surface: plugin.json's
// `version` field and every `@popovych.co/witness@<semver>` pin in plugin text files.
// Idempotent; run before tagging a release (release.yml verifies via the test).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
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
const manifestPath = join(root, 'plugin', '.claude-plugin', 'plugin.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.version !== version) {
  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  stamped += 1;
}
for (const f of walk(join(root, 'plugin')).filter((p) => /\.(md|sh|mjs|json|ts)$/.test(p))) {
  const before = readFileSync(f, 'utf8');
  const after = before.replace(PIN, `@popovych.co/witness@${version}`);
  if (after !== before) {
    writeFileSync(f, after);
    stamped += 1;
  }
}
console.log(`@popovych.co/witness@${version}: ${stamped} file(s) restamped`);
