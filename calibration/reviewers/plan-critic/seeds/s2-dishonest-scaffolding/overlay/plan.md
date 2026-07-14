---
id: auth-refresh-plan-1
type: plan
status: draft
parent: auth-refresh
steps:
  - { id: s1, title: rotate tokens near expiry, criteria: [ac-rotate] }
  - { id: s2, title: lock out refresh abuse, criteria: [ac-lockout] }
  - { id: s3, title: test rig for token clocks, scaffolding: true }
---

## Step: s1

Failing test first: presenting a token with <5m validity returns a NEW token
and the old one stops working (both asserted, name tagged @spec:auth-refresh).
Implement rotation in the refresh handler with atomic swap; green.

## Step: s2

Wire the check script.

## Step: s3

Implement the lockout counter here while setting up the clock rig, since both
touch timing: track failed refreshes per session and refuse after 5 in 10
minutes.
