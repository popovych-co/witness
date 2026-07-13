# specflow

A Claude Code framework that takes a change from brainstorm to PR through a
five-stage pipeline with evidence-gated transitions. Specs are **state**
(what must be true), plans are **motion** (what we're changing); the CLI is
the sole writer of both, and every transition leaves evidence in an
append-only journal.

Status: slice 1 of 4 — the deterministic state core. Gates, criteria
execution, and the Claude Code plugin land in later slices.

## Quickstart

```bash
npx specflow init                     # scaffold specs/, plans/, .specflow/, config
npx specflow recap --file recap.json  # birth an effort from a confirmed scope recap
npx specflow write auth-refresh --effort auth-hardening --meta m.json --body b.md
npx specflow                          # dashboard: where you are, the one next action
```

## Verbs

| verb | does |
|---|---|
| `init` | scaffold config, principles, journal — one trailer commit |
| `recap [--amend] --file <json>` | validate + persist a scope recap; births the effort journal |
| `write <id> --effort <e> --meta <json> --body <md>` | validated manifest → spec/plan on disk + journal entry |
| `diff <spec-id>` | delta since the last realized state (plan pin → empty) |
| `check` | schema, graph, invariants, needs, trailer audit, probes |
| `index` | id · summary · status · depends across the canon |
| `satisfy <id> --need <text\|n>` | flip a manual need via the write path |
| `log <id>` | render a journal stream |
| `recover [--complete\|--rollback]` | resolve a crashed write transaction |
| *(no verb)* | dashboard |

## Exit codes

`0` ok · `1` findings · `2` refused (structured `{field, rule, got, want}` rows) · `3` blocked (lock/txn/untrusted cmd in non-TTY) · `9` test-only injected crash

## State model

- **Frontmatter is position** — the CLI derives "where are we" by scanning it; nothing else stores pipeline state.
- **The journal is history** — `.specflow/journal/<id>.jsonl`, append-only, committed, never compacted.
- **Every state commit carries `Specflow-State: 1`** — `specflow check` audits that spec/plan diffs appear only in trailer-bearing commits.
- Local, never committed: `.specflow/{lock,txn.json,allow.json,calibration.local.yaml}`.

## Development

```bash
npm install
npm test            # vitest, in-process CLI against throwaway git repos
npm run typecheck
npm run build
```
