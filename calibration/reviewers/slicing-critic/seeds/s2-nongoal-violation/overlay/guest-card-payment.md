---
id: guest-card-payment
type: spec
status: draft
summary: Guests pay by card at checkout without creating an account
ui: true
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

A guest completes card payment through the hosted payment field; our servers
receive a tokenized reference only — no card number field ever appears in a
server-side request schema (ac-pci greps the request schemas for card-field
names and fails on any hit). Payment success creates the order and shows the
guest their order number. A decline shows the processor's reason and keeps
the cart intact. After a successful payment the card is stored on the guest's
device-linked profile so the next purchase can reuse it ("remember this card").
