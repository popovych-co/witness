---
id: guest-card-payment
type: spec
status: draft
summary: Payment persistence layer for checkout flows
ui: true
depends: []
criteria:
  - id: ac-pay
    test: "@spec:guest-card-payment"
  - id: ac-pci
    cmd: "npm run audit:pci-fields"
---

## Motivation

Shared plumbing for future payment slices.

## Behavior

Provides the payments table, repository interfaces, and retry queue used by
checkout services. No user-visible behavior of its own; consumers integrate
via PaymentsRepo.
