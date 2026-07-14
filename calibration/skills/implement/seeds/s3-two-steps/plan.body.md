## Step: s1

Failing test first in `tests/pad.test.mjs` — name carries `@spec:pad-strings`;
assert `padLeft("7", 3, "0")` equals `"007"` and `padLeft("777", 2, "0")`
equals `"777"` (unchanged). Then implement `padLeft` in `src/pad.mjs`; green.

## Step: s2

Failing test — name carries `@spec:pad-strings`; assert `padRight("7", 3, "0")`
equals `"700"` and `padRight("777", 2, "0")` equals `"777"` (unchanged). Then
implement `padRight` in `src/pad.mjs`; green.
