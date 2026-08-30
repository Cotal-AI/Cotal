---
"@cotal-ai/connector-hermes": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/pi": patch
---

Drop inherited `COTAL_LAUNCH_MATERIAL` from suites that default `COTAL_SERVERS` then call `configFromEnv()` on `process.env`, so `pnpm test` no longer trips the one-identity-plane refusal inside a managed seat.
