---
id: guest-card-payment
type: spec
status: draft
summary: Guests pay by card at checkout without creating an account
depends: []
criteria:
  - id: ac-pay
    test: "@spec:guest-card-payment"
  - id: ac-pci
    cmd: "npm run audit:pci-fields"
---

## Motivation

Guest conversion drops at forced signup; g1 removes the account wall.

## Behavior

The checkout page renders a card-payment form inline: labeled card-number,
expiry, and CVC inputs inside a bordered panel, with a "Pay now" button
below. Submitting shows an inline spinner over the button; on success the
form is replaced by an order-confirmation panel showing the guest their
order number. A decline leaves the form on screen with the processor's
reason shown in a red banner above the card fields and the entered values
preserved. No card number field ever appears in a server-side request
schema (ac-pci greps the request schemas for card-field names and fails on
any hit) — the fields post directly to the processor's hosted endpoint.
