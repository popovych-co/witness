## Motivation

Receivers need to trust that a webhook actually came from us (g1).

## Behavior

Every outbound webhook carries an `X-Hook-Signature` header: hex-encoded
HMAC-SHA256 of the raw request body, keyed by `WEBHOOK_SIGNING_KEY` (ac-sign).
A receiver recomputing the same HMAC over the same body and key must match
byte-for-byte, and a tampered body must fail verification (ac-verify).
