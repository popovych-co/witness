---
id: confirmation-email
type: spec
status: draft
summary: Paid orders trigger a confirmation email within one minute
ui: true
depends: [guest-card-payment]
criteria:
  - id: ac-email
    test: "@spec:confirmation-email"
---

## Motivation

Guests have no account page; the email is their only receipt (g2).

## Behavior

Within 60 seconds of the payment webhook, a confirmation email with the order
number and line items is handed to the mail provider. Delivery failures retry
three times over five minutes, then surface in the ops digest — never dropped
silently.
