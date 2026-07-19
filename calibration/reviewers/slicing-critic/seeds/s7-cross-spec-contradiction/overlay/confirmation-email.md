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

Within 60 seconds of the payment webhook, a confirmation email with the order
number and line items is handed to the mail provider. Delivery failures retry
three times over five minutes, then surface in the ops digest — never dropped
silently.

A declined payment clears the cart immediately and sends no email, so the
guest starts a clean checkout rather than resuming a stale one.
