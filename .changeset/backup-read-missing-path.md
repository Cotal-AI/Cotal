---
"@cotal-ai/cli": patch
---

`backup verify` and `backup inspect` of a path that names nothing now refuse `TARGET_NOT_FOUND`
(exit 2), naming the path and whether its folder or the artifact is missing, as `backup restore`
does. They refused `SCHEMA_INVALID` (exit 1) with one generic sentence that named neither.
