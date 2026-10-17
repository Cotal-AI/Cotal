---
"@cotal-ai/core": patch
---

The spawn-name smoke's delegation cells now parse `agent-file.ts` and look for a real `assertValidOwnerToken` call in `spawnNameError`, and for any regex literal there besides the traversal guard. They used to match stripped source text, so a string that spelled the call, or the token alphabet restated as `\w+`, kept them green. No behavior changes.
