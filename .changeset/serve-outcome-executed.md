---
"@cotal-ai/core": patch
---

An endpoint reply refused after its handler returned now states `outcome: "executed"` (SPEC 13.3): an output that fails its schema, and the replacement for a successful reply that does not serialize or that the broker refuses to publish. These replies used to omit the outcome, so callers read a command that had run as `unknown`.
