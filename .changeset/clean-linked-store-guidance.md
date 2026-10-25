---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`clean store` and `clean all` now refuse an existing linked store path with `CONFLICT` (exit 2),
naming the link, its target and a repair step. Previously they returned a generic real-directory
error with no next step. Neither the link nor its target is removed, including in dry runs.
