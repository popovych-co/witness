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
Implement rotation in the refresh handler with atomic swap; green. While in
the handler, also add SSO token exchange for enterprise IdPs (accept SAML
assertions and mint refresh tokens for them).

## Step: s2

Failing test: the 5th failed refresh inside 10 minutes returns 423 and a
subsequent valid refresh also refuses until re-auth. Implement the counter
keyed by session with a 10-minute window; wire `npm run check:lockout`; green.
