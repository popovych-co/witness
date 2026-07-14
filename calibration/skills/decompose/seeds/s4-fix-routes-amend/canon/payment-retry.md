---
id: payment-retry
type: spec
status: live
summary: Failed payments retry three times with exponential backoff
depends: []
criteria:
  - id: ac-retry
    test: "@spec:payment-retry"
---

## Motivation

Transient processor failures should not lose orders.

## Behavior

A failed payment attempt is retried up to three times with exponential
backoff (1s, 4s, 16s). Retries reuse the original payment token. After the
final failure the order moves to needs-attention.
