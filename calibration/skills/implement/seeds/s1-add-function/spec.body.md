## Motivation

Shared input guard (g1).

## Behavior

`clamp(value, lo, hi)` returns value bounded inclusively: below lo → lo,
above hi → hi, NaN → lo. lo > hi throws a RangeError.
