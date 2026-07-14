# specflow — graduation checklist

Graduated = every box below checked, evidence in the named journal streams.

## 0. Prerequisite — this repo's own config

This repository has no `specflow.config.yaml` yet (the CLI's own source repo
was never dogfooded on itself while Plans 1-4 built it). Before section 1:

- [ ] Run `specflow init` on this repo (creates `specflow.config.yaml`,
      `plans/`, `.specflow/journal/`, `specs/principles.md` in one trailer
      commit — do this deliberately, not mid-unrelated-work).
- [ ] Add to the generated `specflow.config.yaml` (calibration fixtures,
      plugin text, and prompts are full of `@spec:` strings that are **not**
      tags on real tests — without excludes, `sourceTags` would report
      orphan tags on every `check`):
      ```yaml
      criteria:
        runner: 'npx vitest run -t "@spec:{id}" --passWithNoTests'
        exclude: ['fixtures/**', 'calibration/**', 'plugin/**', 'prompts/**', 'docs/**']
      ```
- [ ] `specflow check` reports no `orphan-tag` findings.

## 1. Dogfood — specflow runs its own remaining work

From this task onward, every change to this repository goes through the
pipeline (no bare commits to src/):

- [ ] Plugin installed against this repo: `/plugin marketplace add <this repo path>` → `/plugin install specflow@specflow`; new session shows the dashboard (SessionStart hook).
- [ ] One real `fix`-class effort end-to-end: `/specflow` → two-question brainstorm → decompose routes to an amended spec → plan → implement (worktree + red→green evidence) → ship gate stop → human approve → PR → merge → lazy stamp flips `done`/`live`. Evidence: the effort's journal stream.
- [ ] One `feature`-class effort covering a real backlog item (e.g. "dashboard shows calibration staleness"), exercising the decompose scope stop.
- [ ] A deliberate hand-edit to a spec caught by `specflow check` (trailer audit) and cured by `specflow adopt` — the fire exit works when a human actually uses it.

## 2. Calibration — the matrix is real

- [ ] `specflow calibrate <current pinned model> --publish` green: every reviewer ≥ 9/10 catch and ≥ 9/10 clean, injections 100%, decompose/plan ≥ 9/10, implement 3/3.
- [ ] `calibration.yaml` ships ≥ 1 model; `gates.model`'s default resolves to `models[0]`; a gate-run journal entry shows `calibration: "shipped"`.
- [ ] The calibration workflow has a green scheduled run on main.

## 3. benoticed.co — both runner modes (Decision 63)

In the benoticed.co checkout (20-package pnpm monorepo, vitest per package):

- [ ] `specflow init`, then filtered mode:
      `runner: 'pnpm -r exec vitest run -t "@spec:{id}" --passWithNoTests'`
      Tag one existing test in one package with a seeded spec's id;
      `specflow check --drift` goes green, and goes red when the test is
      broken on purpose (then restore).
- [ ] Full-suite mode: per-package junit reporters writing `reports/junit.xml`,
      config `runner: full-suite` + `report: junit:**/reports/junit.xml`,
      suite command `pnpm -r test`; `specflow check --drift` merges the
      per-package reports and reaches the same green/red verdicts.
- [ ] One `fix`-class effort brainstorm → PR on benoticed.co with no manual
      CLI calls (the /specflow loop drives everything; humans only decide).

## 4. Bare-install proof

- [ ] On a machine/checkout with no specflow dev setup: plugin install + a
      fresh `claude` session runs `/specflow` on an empty repo through
      `specflow init` → brainstorm → first spec, with the pinned
      `npx -y specflow@<version>` doing all CLI work (no SPECFLOW_BIN).
