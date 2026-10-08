---
"@cotal-ai/core": patch
---

The spawn-name actor-token smoke reads the CLI's `spawnNameError` import from the named specifiers of its `@cotal-ai/core` import declarations. The cell used to search a fixed 400-character window before the first such import's closing brace, so it failed whenever the import list grew and pushed the name out of that window.
