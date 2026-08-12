# Releasing witness

```bash
git checkout main && git pull
node scripts/release.mjs patch      # or minor | major | 0.12.3
git push origin main
git push origin v<version>          # the tag push is what publishes
```

That is the whole procedure. The script performs the bump, the stamp, the commit and the tag; it never pushes, because publishing is a human act and a script that pushes tags turns a typo into a release.

## Why the order is fixed

`release.yml` triggers on a `v*` tag and then checks two facts about **the tree that tag names**:

| Step | Fact it asserts |
|---|---|
| `pnpm run sync-versions` + `git diff --exit-code` | every plugin pin and `plugin.json` already match `package.json` |
| `node scripts/release-gate.mjs` | the tag equals `v${package.json.version}`, and a 1.x release ships a calibration matrix |

Both are properties of the tagged commit. So the bump and the stamp must be **inside** that commit — a tag pushed before them names a tree that can never pass, no matter how many times CI is re-run. `scripts/release.mjs` derives the tag from `package.json`, which makes the two unable to disagree.

Skills carry `npx -y @popovych.co/witness@<version>` pins, so the stamp is not cosmetic: the CLI a repo actually runs is the one its skills name. `sync-versions` is what keeps that true, and the `git diff --exit-code` step is what stops an unsynced tag from shipping.

## If the tag was pushed too early

The gate refuses with `tag-version-mismatch` before `npm publish`, so nothing shipped and the tag is a dead ref. Delete it, cut the release properly, and tag the release commit:

```bash
git push origin :refs/tags/v<version>   # delete the remote tag
git tag -d v<version>                   # and the local one
node scripts/release.mjs <version>      # bump + stamp + commit + tag, in one act
git push origin main && git push origin v<version>
```

Deleting is safe only while the version is unpublished — check with `npm view @popovych.co/witness versions` and `gh release list`. Once either shows it, burn the number and release the next one instead.

## Preflight refusals

`scripts/release.mjs` refuses before writing anything, in the CLI's own `field · rule · got · want` shape:

- `branch · not-main` — the tag must name a commit reachable from the default branch; merge the release PR first.
- `worktree · dirty` — `sync-versions` rewrites plugin files in place, and with other edits pending the release commit becomes a mixed commit nobody can revert cleanly.
- `tag · tag-exists` — that version was already cut; delete the tag or pick the next one.
- `version · no-change` / `unparsable` — the bump resolves to nothing.

## What the release job does after the gate

`npm publish --provenance` (npm trusted publishing over OIDC — no `NPM_TOKEN` anywhere), then `gh release create --generate-notes --verify-tag`. Both are unattended; the gate is the last place a bad release can be stopped.
