---
"@cotal-ai/connector-opencode": patch
"@cotal-ai/pi": patch
---

A failed OpenCode or pi turn now sets the presence `condition`, so observers no longer read it as plain `idle` or `waiting`. OpenCode relays its own error kind as `source` and its message, mapped to `auth`, `rate_limit`, `budget`, `request`, `model`, `server`, `context` or `failed`. pi relays `failed` with its error message. A turn someone stopped sets none.
