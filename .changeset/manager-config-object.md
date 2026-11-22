---
"@cotal-ai/manager": patch
---

Move the manager's construction-time settings (space, broker, workspace root, secret store, lifecycle id, seat and session ceilings, and the readiness and retry timings) into one internal config object that every manager part reads directly, instead of reading each through its own accessor. Exports, commands and wire behaviour are unchanged.
