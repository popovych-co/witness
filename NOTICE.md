# NOTICE — third-party material in witness

witness synthesizes ideas and, where licenses permit, text from five sources
(audit 2026-07-08). Full license texts live in `LICENSES/`. Two intake modes:

- **Vendored** — upstream text copied in and adapted; the file carries an
  attribution header stating source, license, and changes.
- **Derived** — rewritten from upstream material as raw inspiration; no
  contiguous text copied; the file carries a derivation header.

## Vendored (Apache-2.0 — changes stated per file, §4b)

From **pr-review-toolkit** (Anthropic, claude-plugins-official, pinned cache
commit `317b8988055b`) — `LICENSES/pr-review-toolkit-Apache-2.0.txt`:

- `prompts/code-reviewer.md` ← `agents/code-reviewer.md`
- `prompts/silent-failure-hunter.md` ← `agents/silent-failure-hunter.md`
- `prompts/type-design.md` ← `agents/type-design-analyzer.md`
- `prompts/pr-test.md` ← `agents/pr-test-analyzer.md`

## Derived (MIT)

From **superpowers** (obra) — `LICENSES/superpowers-MIT.txt`:

- `plugin/skills/witness-brainstorm/SKILL.md` (← skills/brainstorming)
- `plugin/skills/witness-plan/SKILL.md` (← skills/writing-plans)
- `plugin/skills/witness-implement/SKILL.md` (← skills/test-driven-development)

From **mattpocock/skills** — `LICENSES/mattpocock-skills-MIT.txt`:

- `plugin/skills/witness-brainstorm/SKILL.md` (← grill-me: one-question-with-recommendation interview style)
- `plugin/skills/witness-implement/SKILL.md` (← tdd: red/green loop discipline)

From **no-mistakes / axi family** (kunchenguid) — `LICENSES/no-mistakes-MIT.txt`:

- `plugin/skills/witness-ship/SKILL.md` (← no-mistakes: validate-then-ship step sequence, re-owned)
- CLI output style (TOON, `help:` hints) across `src/` — style influence, no copied text.

## Adapted (Apache-2.0)

From **frontend-design** (Anthropic, claude-plugins-official) — `LICENSES/frontend-design-Apache-2.0.txt`:

- `plugin/skills/witness-design/SKILL.md` — greenfield design direction. **Changes:** rewritten for witness's stage contract (spec-scoped artifact, CLI write path, design gate); merged with a benoticed-derived process and a witness-native interactive loop. No text copied verbatim.

## Concept-adapted — zero text

From **benoticed.co** `docs/ui/redesign-method.md` (private, same owner) — the redesign *process* (context phase → 2–3 distinct directions → converge → change-ladder) informed `plugin/skills/witness-design/SKILL.md` conceptually; **no text was copied**, and the method was generalized to two modes (new-screen / amend-living-look) and data-shape anchoring.

## Concept-only — zero text

**JarvusInnovations/specops** has no license (all rights reserved). Its
`specs/` model inspired the decompose stage conceptually; **no text was copied**
from specops into this repository, and none may ever be.

New material written for witness (no upstream text): `prompts/slicing-critic.md`,
`prompts/plan-critic.md`, `prompts/drift-reviewer.md`, `prompts/design-critic.md`,
`plugin/skills/witness-decompose/SKILL.md`, `plugin/commands/witness.md`, both hook
scripts, and everything under `src/` and `calibration/`.
