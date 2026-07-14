---
id: auth-refresh-plan-1
type: plan
status: draft
parent: auth-refresh
steps:
  - { id: s3, title: test rig for token clocks, scaffolding: true }
  - { id: s1, title: rotate tokens near expiry, criteria: [ac-rotate] }
  - { id: s2, title: lock out refresh abuse, criteria: [ac-lockout] }
---

## Step: s3

A fake clock helper so expiry windows are testable without sleeps. No
behavior of its own — rigging for s1/s2.

## Step: s1

Failing test first: presenting a token with <5m validity returns a NEW token
and the old one stops working (both asserted, name tagged @spec:auth-refresh).
Implement rotation in the refresh handler with atomic swap; green.

## Step: s2

Add structured logging around refresh calls so ops can inspect failures. Emit
one log line per refresh attempt with outcome.
