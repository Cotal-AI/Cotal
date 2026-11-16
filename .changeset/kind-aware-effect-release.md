---
"@cotal-ai/lang": patch
"@cotal-ai/runtime": patch
---

Let workflow hosts release a run before a chosen live effect kind.
The optional `beforeEffect` policy runs before counting, journaling or dispatch on both
language engines, skips replayed effects, and permits a later resume under unchanged pins.
