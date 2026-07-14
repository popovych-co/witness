---
id: checkout-flow
type: spec
status: live
summary: Guests complete checkout in three steps with a persistent cart
depends: []
criteria:
  - id: ac-checkout
    test: "@spec:checkout-flow"
---

## Motivation

Checkout is the revenue path.

## Behavior

Cart, address, payment — three steps; the cart persists across sessions for
seven days. Abandoning payment keeps the cart intact.
