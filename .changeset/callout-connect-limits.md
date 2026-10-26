---
"@cotal-ai/auth": patch
---

The auth callout limits connects: 60 a minute per actor and 600 per owner, with a bearer that does
not verify charged to its client host at 60 a minute. A reconnect loop now settles at one connect a
second instead of spending the callout, the ledger and the issuance writes of everyone else in the
space. A limited connect gets a signed `RATE_LIMITED retry-after <n>s` denial that the auth service
logs with the actor and owner, and the exchange for a limited actor answers 429 with
`{code: "RATE_LIMITED", retryAfterSeconds, error}` and `Retry-After`. A hosted composition sets
other limits with `startAuthService`'s `connectLimits`. The connect-load harness takes
`--connect-limits <actor>,<owner>,<host>` for capacity runs.
