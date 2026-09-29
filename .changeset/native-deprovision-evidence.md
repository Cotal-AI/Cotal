---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/auth": patch
---

Distinguish native consumer deletion acknowledgments and observed disappearance from uniquely attributable removals. Refuse live KV CAS successors, preserve exact-target INFO grants, and propagate unknown uniqueness through Manager reconciliation.
