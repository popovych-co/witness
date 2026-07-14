## Motivation

Fixed-width columns line up in monospace output (g1).

## Behavior

`padLeft(str, width, ch)` pads `str` on the left with `ch` until it reaches
`width` characters, unchanged if already at or past `width` (ac-left).
`padRight(str, width, ch)` does the same on the right (ac-right).
