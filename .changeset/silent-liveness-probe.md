---
"@cotal-ai/core": patch
---

Make credential-less `isReachable` a silent plaintext TCP+`INFO` liveness probe so it no longer logs a broker `authentication error` on every check (e.g. every `cotal supervise` start and registry prune sweep against an auth broker). It reads the server's unprompted pre-auth `INFO` greeting over a plain socket and closes before authenticating, so a live broker (open or auth) reports reachable with no auth-error/auth-timeout log line. The boolean result is unchanged for every caller; only the mechanism changes. `pruneStaleMeshes` uses the same silent probe; `probeConnect` and the with-creds `auth-required` classification are untouched. Limitation: the credless probe is plaintext-only — it returns false for a TLS-first (`handshake_first`) listener; the creds path stays a real authenticated connect.
