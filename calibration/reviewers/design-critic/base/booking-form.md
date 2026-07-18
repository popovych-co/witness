---
id: booking-form
type: spec
status: approved
summary: Owner creates a bookable service
criteria:
  - id: ac-create
    test: "@spec:booking-form"
---

## Motivation

Owners need to publish a bookable service quickly.

## Behavior

The owner enters a service name and price and saves it. Essential fields are
visible first; tuning fields (buffers, limits) are subordinate. The booking mode
(fixed vs flexible) is selectable with a visible active state. The save action is
always reachable.
