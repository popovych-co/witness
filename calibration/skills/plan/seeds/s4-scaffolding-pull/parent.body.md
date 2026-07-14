## Motivation

Long-lived access tokens widen the theft window (g1).

## Behavior

An access token issued at time T is rejected by every endpoint from T+15
minutes onward (ac-expiry). Testing this without real sleeps requires a
controllable clock the test suite can advance deterministically.
