## Motivation

Weak passwords are the largest account-takeover vector (g1).

## Behavior

A password is accepted only if it satisfies every rule: at least 12
characters (ac-min); at least one uppercase letter (ac-upper); at least one
digit (ac-digit); not present in the top-1000 common-passwords list shipped
at `data/common-passwords.txt` (ac-common). The full policy suite runs as one
filtered command (ac-suite).
