---
"@cotal-ai/cli": patch
---

When startup refuses a different broker address for a stack that already ran, tell the operator to correct the address in the original command. Keep the requested foreground, broker-only and output options on retry.
