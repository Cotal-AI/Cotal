---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/delivery": patch
---

Resolve `supervise` and `deliver` through the registered mesh, preserving `--server` overrides and naming an unreachable recorded broker instead of falling back to loopback.
