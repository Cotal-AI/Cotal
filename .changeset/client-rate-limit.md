---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/auth": patch
---

Clients now treat the exchange's rate limit as one. The 429 names the bucket that ran out as `limit`,
`actor` or `owner`. A CLI command prints the auth service's sentence and exits 2 as
`DEPENDENCY_UNAVAILABLE`, with a remedy saying whether only that actor or the whole account is
limited and `RATE_LIMITED`, the seconds and the `limit` in its JSON cause, where it used to report
`PERMISSION_DENIED`. `cotal agent-bearer` prints `retry-after <n>` on stdout and exits 2, and an
endpoint asks a bearer source again when a `retryAfterSeconds` it was given has passed, not before.
When the broker refuses an endpoint's bearer, the warning says so and names where the reason is, and
the reconnect backoff is randomized so endpoints refused together spread their retries.
