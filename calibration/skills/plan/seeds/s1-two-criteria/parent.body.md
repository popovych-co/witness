## Motivation

Slugs appear in every shared URL (g1).

## Behavior

`slugify(title)` lowercases, replaces whitespace runs with single hyphens,
strips characters outside `[a-z0-9-]`, and collapses repeated hyphens. Slugs
are capped at 80 characters without cutting mid-word where possible (ac-len's
suite asserts the cap; the cap value lives here: 80).
