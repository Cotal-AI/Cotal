---
"@cotal-ai/core": patch
---

The spawn-name actor-token smoke parses the CLI's `spawn.ts` and reads `spawnNameError` from the value imports of its `@cotal-ai/core` import declarations, so import-shaped text in a string or comment does not count. The cell used to search a fixed 400-character window before the first such import's closing brace, so it failed whenever the import list grew and pushed the name out of that window.
