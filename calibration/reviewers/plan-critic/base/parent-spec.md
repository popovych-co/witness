---
id: auth-refresh
type: spec
status: approved
summary: Refresh tokens rotate before expiry and lock out abuse
depends: []
criteria:
  - id: ac-rotate
    test: "@spec:auth-refresh"
  - id: ac-lockout
    cmd: "npm run check:lockout"
---

## Motivation

Stolen refresh tokens must age out fast; brute-forced refresh must lock.

## Behavior

A session's refresh token is rotated whenever it is presented with less than
five minutes of validity remaining; the old token is invalidated atomically.
Five failed refresh attempts within ten minutes lock the session and require
re-authentication (ac-lockout asserts the 5-in-10 threshold).
