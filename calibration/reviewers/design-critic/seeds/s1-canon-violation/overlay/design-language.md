---
id: design-language
type: spec
status: approved
summary: House design canon — framing and input rules
---

## Motivation

A consistent look across every screen.

## Behavior

Every screen opens with an eyebrow/framing header naming its section. Every
money field renders as a formatted currency input (never a raw `type="number"`
spinner) — currency needs a symbol and thousands separators a bare number input
cannot show.
