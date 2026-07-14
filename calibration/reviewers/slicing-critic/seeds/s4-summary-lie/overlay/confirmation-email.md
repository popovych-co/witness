---
id: confirmation-email
type: spec
status: draft
summary: Paid orders trigger a confirmation email within one minute
depends: [guest-card-payment]
criteria:
  - id: ac-email
    test: "@spec:confirmation-email"
---

## Motivation

Guests have no account page; the email is their only receipt (g2).

## Behavior

Paid orders are batched and a daily digest email is sent at 06:00 with all
orders from the previous day.
