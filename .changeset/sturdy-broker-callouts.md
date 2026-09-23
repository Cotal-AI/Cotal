---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
---

Preload every persisted per-space auth-callout account when a shared broker starts, and refuse incomplete user-auth state before writing its resolver config.
