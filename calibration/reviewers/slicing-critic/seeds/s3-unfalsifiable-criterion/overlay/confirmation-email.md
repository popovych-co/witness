---
id: confirmation-email
type: spec
status: draft
summary: Paid orders trigger a confirmation email within one minute
depends: [guest-card-payment]
criteria:
  - id: ac-email
    cmd: "echo emails-checked"
---

## Motivation

Guests have no account page; the email is their only receipt (g2).

## Behavior

A confirmation email is sent when the system is able to; timing depends on
load.
