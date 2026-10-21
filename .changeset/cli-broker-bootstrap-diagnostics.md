---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Attribute stream initialization and registration failures to the already-started broker instead of the next unstarted member. Preserve typed JetStream numeric API codes and status without exposing arbitrary broker error descriptions, retrying effects or treating an unknown startup as complete.
