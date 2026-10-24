---
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

The `cotal run` verbs that read a program file now refuse one that is not valid UTF-8 with `SCHEMA_INVALID`. Before, its bytes were replaced with U+FFFD, so a Latin-1 checkpoint question was stored and shown corrupted, with no warning.
