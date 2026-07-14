## Step: s1

Failing test first in `tests/clamp.test.mjs` — name carries `@spec:clamp-range`;
assert bounds, NaN → lo, and the lo > hi RangeError. Then implement `clamp` in
`src/clamp.mjs`; green.
