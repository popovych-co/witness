#!/usr/bin/env node
// Cut a release: the four steps that must happen in one order, performed by one
// command so the order cannot be got wrong.
//
// The order is not arbitrary. `release.yml` triggers on a `v*` tag and then checks
// two facts about the TAGGED TREE: `sync-versions` leaves no diff (the plugin pins
// match package.json), and `release-gate.mjs` finds the tag equal to `v<version>`.
// Both are properties of the commit the tag names, so the bump and the stamp have to
// be IN that commit — a tag pushed before them names a tree that can never pass.
// That is the failure this script exists to make unreachable: the tag is derived
// from package.json here, so the two cannot disagree.
//
// It never pushes. It prints the two push commands and stops, because publishing is
// the human's act and a script that pushes tags turns a typo into a release.
//
// Usage: node scripts/release.mjs <major|minor|patch|x.y.z>

const row = (field, rule, got, want) => ({ field, rule, got, want });

/**
 * The version a bump keyword resolves to. Prerelease identifiers are dropped by a
 * keyword bump (0.11.0-rc.1 + patch -> 0.11.1); an explicit version is taken as given.
 * @param {string} current @param {string} spec
 */
export function nextVersion(current, spec) {
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec)) return spec;
  const [major, minor, patch] = current.split('-')[0].split('.').map(Number);
  if (spec === 'major') return `${major + 1}.0.0`;
  if (spec === 'minor') return `${major}.${minor + 1}.0`;
  if (spec === 'patch') return `${major}.${minor}.${patch + 1}`;
  return undefined;
}

/**
 * Everything that must hold before a release commit is written. Pure so the rules are
 * unit-tested rather than discovered on a failed CI run.
 * @param {{current: string, spec: string, branch: string, dirty: boolean, tags: string[]}} input
 */
export function releasePreflight({ current, spec, branch, dirty, tags }) {
  const errors = [];
  const target = nextVersion(current, spec);

  if (target === undefined) {
    errors.push(row('version', 'unparsable', spec || '(none)', 'major | minor | patch | x.y.z'));
  }
  // Releases are cut from the default branch because the tag must name a commit that
  // is reachable from it — `gh release create --verify-tag` and every consumer walk
  // assume that, and a tag on an unmerged branch is a release nobody can `git fetch`.
  if (branch !== 'main') {
    errors.push(row('branch', 'not-main', branch, 'main — merge the release PR first, then cut from it'));
  }
  // sync-versions rewrites plugin files in place. With other edits already in the tree
  // there is no way to tell the stamp from the work, and the release commit becomes a
  // mixed commit nobody can revert cleanly.
  if (dirty) {
    errors.push(row('worktree', 'dirty', 'uncommitted changes', 'a clean tree — commit or stash first'));
  }
  if (target !== undefined && tags.includes(`v${target}`)) {
    errors.push(row('tag', 'tag-exists', `v${target}`,
      `an unused version — delete the tag (git push origin :refs/tags/v${target}) or pick the next one`));
  }
  if (target !== undefined && target === current) {
    errors.push(row('version', 'no-change', target, 'a version above the current one'));
  }

  return { ok: errors.length === 0, errors, target };
}

// CLI: performs the bump, the stamp, the commit and the tag — then stops.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const pkgPath = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  const { ok, errors, target } = releasePreflight({
    current: pkg.version,
    spec: process.argv[2] ?? '',
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    dirty: git('status', '--porcelain').length > 0,
    tags: git('tag', '--list').split('\n').filter(Boolean),
  });
  if (!ok) {
    console.error(`refused: release\n${errors.map((r) => `  ${r.field} · ${r.rule} · got ${r.got} · want ${r.want}`).join('\n')}`);
    process.exit(2);
  }

  writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, version: target }, null, 2)}\n`);
  execFileSync('node', [join(root, 'scripts', 'sync-versions.mjs')], { cwd: root, stdio: 'inherit' });
  git('add', '-A');
  git('commit', '-m', `chore(release): ${target}`);
  git('tag', `v${target}`);

  console.log(`release commit + tag v${target} created locally · nothing pushed`);
  console.log(`  git push origin main`);
  console.log(`  git push origin v${target}`);
}
