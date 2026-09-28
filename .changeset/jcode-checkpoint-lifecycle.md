---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-jcode": patch
---

Keep Jcode seats alive when session checkpoints interrupt tool observations or temporarily remove the journal. Validate the session snapshot, preserve pending journal reads, restore tool brackets from the event WAL, and publish explicit discontinuities without weakening event validation.
