---
"@cotal-ai/cli": patch
---

`backup verify` and `backup inspect` now read an artifact named through a linked folder at its real
path, as `backup create` and `backup restore` do. They refused it as missing, unreadable or changed,
though the same artifact matched by its real path.
