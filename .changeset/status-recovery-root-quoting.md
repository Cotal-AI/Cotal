---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

Quote the root in status restart commands after an interrupted stop or deleted space streams.
Roots containing spaces, apostrophes or shell variables stay one literal argument when the
printed command is copied into a shell. Recovery ordering, flags and lifecycle checks are unchanged.
