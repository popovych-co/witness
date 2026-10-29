#!/usr/bin/env node
// Release gate: the deterministic checks a tag must clear before `npm publish`.
//
// One rule, a fact about the tagged tree: the tag names the version being published
// (v<version>), so a release can never ship contents that disagree with the ref that
// triggered it. Row 212 removed the second rule, the shipped model-matrix check.
//
// Exported pure so the rules are unit-tested rather than string-matched in YAML.

import { isMain } from './is-main.mjs';

const row = (field, rule, got, want) => ({ field, rule, got, want });

/** @param {{version: string, tag?: string}} input */
export function releaseGate({ version, tag }) {
  const errors = [];

  if (tag && tag !== `v${version}`) {
    // The `want` column names the act that actually works, and there are two — but they
    // are not equally likely. A tag ahead of package.json is a release someone MEANT to
    // cut and tagged before bumping; telling them to re-tag downward answers the rarer
    // half and reads as "your tag is wrong" when the tree is what is behind. Naming the
    // bump first, with the one command that performs it in the right order, is the same
    // rule the decision block follows: a refusal carries the remedy, not just the delta.
    errors.push(row('tag', 'tag-version-mismatch', tag,
      `package.json at ${tag.replace(/^v/, '')} — cut it with \`node scripts/release.mjs ${tag.replace(/^v/, '')}\`, or re-tag this tree as v${version}`));
  }

  return { ok: errors.length === 0, errors };
}

// CLI: reads the repo it runs in, exits 2 on refusal (the CLI's own convention).
if (isMain(import.meta.url)) {
  const { readFileSync } = await import('node:fs');

  let version;
  try {
    version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  } catch (e) {
    console.error(`refused: release gate\n  inputs · unreadable · got ${e.message} · want readable package.json`);
    process.exit(2);
  }
  if (typeof version !== 'string' || version.length === 0) {
    console.error('refused: release gate\n  package.json#version · missing · got none · want a semver string');
    process.exit(2);
  }
  const tag = process.env.GITHUB_REF_NAME ?? '';

  const { ok, errors } = releaseGate({ version, tag });
  const fmt = (r) => `  ${r.field} · ${r.rule} · got ${r.got} · want ${r.want}`;

  if (!ok) {
    console.error(`refused: release gate\n${errors.map(fmt).join('\n')}`);
    process.exit(2);
  }
  console.log(`release gate ok · ${version}${tag ? ` · ${tag}` : ''}`);
}
