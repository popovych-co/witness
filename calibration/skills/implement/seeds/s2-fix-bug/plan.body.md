## Step: s1

Failing test first in `tests/slug.test.mjs` — name carries `@spec:slug-trim`;
assert `slugify(" hello ")` equals `hello` (no leading/trailing hyphen). Then
fix `slugify` in `src/slug.mjs` to strip leading/trailing hyphens after the
existing replacements; green.
