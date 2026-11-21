---
"@cotal-ai/cli": patch
---

Move the restore path's per-stream restore and validation out of `lib/restore.ts` into an internal `lib/restore-streams.ts`. `lib/restore.ts` keeps every name it exported before, so the module surface is unchanged.
