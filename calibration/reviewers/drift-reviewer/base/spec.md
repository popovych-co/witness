---
id: auth-refresh
type: spec
status: live
summary: Refresh tokens rotate before expiry; failures refuse, never retry
criteria:
  - id: ac-rotate
    test: "@spec:auth-refresh"
---

## Motivation

Stolen tokens must age out; silent retries hide compromise.

## Behavior

A refresh token presented with less than five minutes of validity remaining is
rotated: a new token is issued and the old one invalidated. A rotation failure
returns HTTP 401 to the caller immediately — no retry, no stale token reuse.
