---
"@cotal-ai/runtime": patch
---

When `run check` or `run revoke --local` gets a malformed run ID, it points to the local run list on the same target instead of a manager-only lookup.
