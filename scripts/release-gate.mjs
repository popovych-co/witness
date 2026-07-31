#!/usr/bin/env node
// Release gate: the deterministic checks a tag must clear before `npm publish`.
//
// Two rules, both facts about the tagged tree:
//   1. the tag names the version being published (v<version>), so a release can
//      never ship contents that disagree with the ref that triggered it;
//   2. a 1.x release carries a shipped calibration matrix. Below 1.0 an empty
//      matrix warns instead of failing — calibration is an explicit pre-1.0
//      graduation item (docs/graduation.md §2), and a gate that can never be
//      satisfied is a wall, not a gate.
//
// Exported pure so the rules are unit-tested rather than string-matched in YAML.

const row = (field, rule, got, want) => ({ field, rule, got, want });

/** @param {{version: string, tag?: string, models?: unknown[] | null}} input */
export function releaseGate({ version, tag, models }) {
  const errors = [];
  const warnings = [];

  if (tag && tag !== `v${version}`) {
    errors.push(row('tag', 'tag-version-mismatch', tag, `v${version}`));
  }

  const major = Number.parseInt(version.split('.')[0], 10);
  const calibrated = Array.isArray(models) && models.length > 0;
  if (!calibrated) {
    const detail = row('calibration.yaml', '', 'models: []', '>= 1 calibrated model');
    if (Number.isFinite(major) && major >= 1) {
      errors.push({ ...detail, rule: 'uncalibrated-release' });
    } else {
      warnings.push({ ...detail, rule: 'uncalibrated-prerelease' });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// CLI: reads the repo it runs in, exits 2 on refusal (the CLI's own convention).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs');
  const { parse } = await import('yaml');

  let version, models;
  try {
    version = JSON.parse(readFileSync('package.json', 'utf8')).version;
    models = parse(readFileSync('calibration.yaml', 'utf8'))?.models ?? [];
  } catch (e) {
    console.error(`refused: release gate\n  inputs · unreadable · got ${e.message} · want readable package.json + calibration.yaml`);
    process.exit(2);
  }
  if (typeof version !== 'string' || version.length === 0) {
    console.error('refused: release gate\n  package.json#version · missing · got none · want a semver string');
    process.exit(2);
  }
  const tag = process.env.GITHUB_REF_NAME ?? '';

  const { ok, errors, warnings } = releaseGate({ version, tag, models });
  const fmt = (r) => `  ${r.field} · ${r.rule} · got ${r.got} · want ${r.want}`;

  for (const w of warnings) console.log(`warn:\n${fmt(w)}`);
  if (!ok) {
    console.error(`refused: release gate\n${errors.map(fmt).join('\n')}`);
    process.exit(2);
  }
  console.log(`release gate ok · ${version}${tag ? ` · ${tag}` : ''}`);
}
